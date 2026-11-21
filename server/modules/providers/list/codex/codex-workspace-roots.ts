import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { extractFirstValidJsonlData, normalizeProjectPath, projectIdentityKey } from '@/shared/utils.js';

/**
 * [local] Workspace roots of a Codex conversation.
 *
 * The Codex desktop app and the VS Code extension group threads into projects
 * that can have several root folders. Every turn runs with all of them as
 * workspace roots and writable roots, but a thread's `cwd` is only the first
 * one. Codex records the roots per turn in the rollout:
 *
 * - `turn_context.workspace_roots`: every root, `cwd` included;
 * - `turn_context.sandbox_policy.writable_roots`: the extra writable roots
 *   (older or differently configured clients write only this one);
 * - `session_meta.runtime_workspace_roots`: the roots the rollout started with.
 *
 * Both lists also carry Codex's own artifact folders under `~/.codex` (for
 * example `visualizations/<date>/<thread>`), which are not user folders.
 *
 * The roots returned here are the *extra* roots: normalized, deduplicated,
 * without `cwd` and without anything under the Codex home.
 */

/** How far back from the end of a rollout to look for a turn that records roots. */
const MAX_REVERSE_SCAN_BYTES = 64 * 1024 * 1024;
/** Overlap kept when only the appended part of a rollout is scanned again. */
const INCREMENTAL_OVERLAP_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const TURN_CONTEXT_MARKER = '"type":"turn_context"';

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;

/** Case-insensitive on Windows-style paths, the way the file system compares them. */
const comparablePath = (value: string): string => {
  const key = projectIdentityKey(value);
  return /^[A-Za-z]:/.test(key) || key.startsWith('\\\\') ? key.toLowerCase() : key;
};

const isSameOrInside = (candidate: string, parent: string): boolean => {
  const child = comparablePath(candidate);
  const root = comparablePath(parent).replace(/[\\/]+$/, '');
  if (!root) {
    return false;
  }
  return child === root || child.startsWith(`${root}\\`) || child.startsWith(`${root}/`);
};

/**
 * Keeps the absolute paths that are real extra roots: normalized (`\\?\`
 * stripped), not `cwd`, not under the Codex home, each folder once.
 */
export function filterCodexWorkspaceRoots(roots: string[], cwd: string, codexHome: string): string[] {
  const cwdKey = cwd ? comparablePath(cwd) : '';
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawRoot of roots) {
    const root = normalizeProjectPath(rawRoot);
    if (!root || !(path.win32.isAbsolute(root) || path.posix.isAbsolute(root))) {
      continue;
    }
    const key = comparablePath(root);
    if (key === cwdKey || seen.has(key)) {
      continue;
    }
    if (codexHome && isSameOrInside(root, codexHome)) {
      continue;
    }
    seen.add(key);
    result.push(root);
  }

  return result;
}

/**
 * The extra roots one `turn_context` payload records, or `null` when it
 * records no roots at all.
 */
export function extractTurnContextWorkspaceRoots(
  payload: unknown,
  cwd: string,
  codexHome: string,
): string[] | null {
  if (!isRecord(payload)) {
    return null;
  }

  const turnCwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : cwd;
  const workspaceRoots = readStringArray(payload.workspace_roots);
  const sandboxPolicy = isRecord(payload.sandbox_policy) ? payload.sandbox_policy : null;
  const writableRoots = readStringArray(sandboxPolicy?.writable_roots);
  const recorded = workspaceRoots ?? writableRoots;
  if (!recorded) {
    return null;
  }

  // The turn's own cwd and the session's cwd are both the primary root.
  return filterCodexWorkspaceRoots(recorded, turnCwd, codexHome)
    .filter((root) => !cwd || comparablePath(root) !== comparablePath(cwd));
}

/**
 * Yields the complete lines of `[lowerBound, size)` from the end backwards.
 * A line that starts before `lowerBound` is dropped unless the bound is 0,
 * because it may be cut.
 */
async function* readLinesBackwards(filePath: string, size: number, lowerBound: number): AsyncGenerator<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    let position = size;
    let carry: Buffer = Buffer.alloc(0);
    while (position > lowerBound) {
      const length = Math.min(READ_CHUNK_BYTES, position - lowerBound);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;

      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) {
          continue;
        }
        if (end > index + 1) {
          yield combined.subarray(index + 1, end);
        }
        end = index;
      }
      carry = combined.subarray(0, end);
    }
    if (lowerBound === 0 && carry.length) {
      yield carry;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Latest extra roots recorded by a turn in `[lowerBound, size)`, or `null`
 * when no turn there records any.
 *
 * A turn that records roots but no extra ones is skipped rather than taken as
 * "the roots were removed": turns run by `codex exec` without `--add-dir`
 * (CloudCLI before this change) and some client turns record only `cwd`, and
 * reading those as authoritative would drop the extra roots for good.
 */
async function scanForRoots(
  filePath: string,
  size: number,
  lowerBound: number,
  cwd: string,
  codexHome: string,
): Promise<string[] | null> {
  for await (const line of readLinesBackwards(filePath, size, lowerBound)) {
    if (line.indexOf(TURN_CONTEXT_MARKER) === -1) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'turn_context') {
      continue;
    }
    const roots = extractTurnContextWorkspaceRoots(parsed.payload, cwd, codexHome);
    if (roots && roots.length > 0) {
      return roots;
    }
  }
  return null;
}

async function readSessionMetaRoots(filePath: string, cwd: string, codexHome: string): Promise<string[]> {
  const roots = await extractFirstValidJsonlData(filePath, (rawData) => {
    const data = rawData as AnyRecord;
    const payload = isRecord(data.payload) ? data.payload : null;
    // session_meta is the first row; an empty array (truthy) ends the read
    // there instead of walking the whole rollout.
    if (data.type !== 'session_meta' || !payload) {
      return [];
    }
    return readStringArray(payload.runtime_workspace_roots) ?? [];
  }).catch(() => null);
  return roots ? filterCodexWorkspaceRoots(roots, cwd, codexHome) : [];
}

type CachedScan = { size: number; roots: string[] };

/**
 * Reads a rollout's extra workspace roots, remembering what was found per file
 * so a rollout that grows is only scanned again from where it was last read.
 */
export function createCodexWorkspaceRootsReader(codexHome: string) {
  const cache = new Map<string, CachedScan>();

  return {
    async read(filePath: string, cwd: string): Promise<string[]> {
      let size: number;
      try {
        size = (await stat(filePath)).size;
      } catch {
        cache.delete(filePath);
        return [];
      }

      const cached = cache.get(filePath);
      if (cached && cached.size === size) {
        return cached.roots;
      }

      try {
        let roots: string[] | null = null;
        if (cached && cached.size < size) {
          const lowerBound = Math.max(0, cached.size - INCREMENTAL_OVERLAP_BYTES);
          roots = await scanForRoots(filePath, size, lowerBound, cwd, codexHome) ?? cached.roots;
        } else {
          const lowerBound = Math.max(0, size - MAX_REVERSE_SCAN_BYTES);
          roots = await scanForRoots(filePath, size, lowerBound, cwd, codexHome)
            ?? await readSessionMetaRoots(filePath, cwd, codexHome);
        }
        cache.set(filePath, { size, roots });
        return roots;
      } catch {
        return cached?.roots ?? [];
      }
    },
  };
}

/**
 * [local] The recorded extra roots a Codex run may be given: absolute folders
 * that still exist, other than `cwd`. Codex refuses to start with an
 * `--add-dir` that is missing, so a folder that has since been deleted or
 * moved is left out instead of failing the turn.
 */
export async function resolveRunnableWorkspaceRoots(roots: string[], cwd: string): Promise<string[]> {
  const candidates = filterCodexWorkspaceRoots(roots, cwd, '');
  const checks = await Promise.all(candidates.map(async (root) => {
    try {
      return (await stat(root)).isDirectory();
    } catch {
      return false;
    }
  }));
  return candidates.filter((_root, index) => checks[index]);
}
