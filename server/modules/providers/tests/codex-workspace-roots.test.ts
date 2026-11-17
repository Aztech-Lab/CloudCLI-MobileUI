import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import {
  createCodexWorkspaceRootsReader,
  extractTurnContextWorkspaceRoots,
  filterCodexWorkspaceRoots,
  resolveRunnableWorkspaceRoots,
} from '@/modules/providers/list/codex/codex-workspace-roots.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

/**
 * [local] Codex projects in the desktop app / VS Code extension can have
 * several root folders. The rollout records them per turn; CloudCLI keeps
 * them per session, passes them back to Codex on its own turns, and lets the
 * Files tab switch between them.
 */

type Row = Record<string, unknown>;

const encode = (rows: Row[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

const CODEX_HOME = 'C:\\Users\\someone\\.codex';

test('turn_context roots: \\\\?\\ is stripped, cwd and Codex artifact folders are left out', () => {
  const roots = extractTurnContextWorkspaceRoots({
    cwd: 'E:\\work\\enc\\app',
    workspace_roots: [
      '\\\\?\\E:\\work\\enc\\app',
      'E:\\work\\enc',
      '\\\\?\\E:\\work\\img\\sparse',
      'e:\\work\\enc',
      `${CODEX_HOME}\\visualizations\\2026\\10\\02\\thread`,
      'relative\\folder',
    ],
  }, 'e:\\work\\enc\\app', CODEX_HOME);

  assert.deepEqual(roots, ['E:\\work\\enc', 'E:\\work\\img\\sparse']);
});

test('turn_context roots fall back to sandbox_policy.writable_roots', () => {
  const roots = extractTurnContextWorkspaceRoots({
    cwd: 'E:\\work\\paper',
    sandbox_policy: {
      type: 'workspace-write',
      writable_roots: ['F:\\data\\bench', `${CODEX_HOME}\\visualizations\\2026\\08\\24\\thread`],
    },
  }, 'E:\\work\\paper', CODEX_HOME);
  assert.deepEqual(roots, ['F:\\data\\bench']);

  // A turn that records no roots at all is "unknown", not "none".
  assert.equal(extractTurnContextWorkspaceRoots({ cwd: 'E:\\work\\paper', sandbox_policy: { type: 'read-only' } }, 'E:\\work\\paper', CODEX_HOME), null);
});

test('filterCodexWorkspaceRoots dedupes case-insensitively and drops the cwd', () => {
  assert.deepEqual(
    filterCodexWorkspaceRoots(['D:\\A', 'd:\\a\\', 'D:\\B', 'D:\\Work'], 'd:\\work', ''),
    ['D:\\A', 'D:\\B'],
  );
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-roots-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const turnContext = (cwd: string, extra: Row): Row => ({
  timestamp: '2026-11-15T22:47:54.923Z',
  type: 'turn_context',
  payload: { cwd, ...extra },
});

test('the reader takes the latest turn that records extra roots and reads appended turns only', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, '.codex');
    const cwd = path.join(dir, 'project');
    const filePath = path.join(dir, 'rollout.jsonl');
    const extraA = path.join(dir, 'data-a');
    const extraB = path.join(dir, 'data-b');
    await writeFile(filePath, encode([
      { type: 'session_meta', payload: { id: 't', cwd, runtime_workspace_roots: [cwd, path.join(dir, 'meta-root')] } },
      turnContext(cwd, { workspace_roots: [cwd, extraA] }),
      { type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(2000) } },
      turnContext(cwd, { workspace_roots: [cwd, extraB, path.join(codexHome, 'visualizations', 'v')] }),
      // A later turn run without the extra roots (`codex exec` without --add-dir).
      turnContext(cwd, { sandbox_policy: { type: 'workspace-write' } }),
      turnContext(cwd, { sandbox_policy: { type: 'workspace-write', writable_roots: [path.join(codexHome, 'visualizations', 'v')] } }),
    ]), 'utf8');

    const reader = createCodexWorkspaceRootsReader(codexHome);
    assert.deepEqual(await reader.read(filePath, cwd), [extraB]);

    // Appended turns are scanned; one with other roots replaces them.
    await appendFile(filePath, encode([turnContext(cwd, { workspace_roots: [cwd, extraA] })]), 'utf8');
    assert.deepEqual(await reader.read(filePath, cwd), [extraA]);

    // Appended turns without roots keep what was found before.
    await appendFile(filePath, encode([turnContext(cwd, { sandbox_policy: { type: 'read-only' } })]), 'utf8');
    assert.deepEqual(await reader.read(filePath, cwd), [extraA]);

    // A rollout without such turns falls back to session_meta; a missing one has none.
    const metaOnly = path.join(dir, 'meta-only.jsonl');
    await writeFile(metaOnly, encode([
      { type: 'session_meta', payload: { id: 'm', cwd, runtime_workspace_roots: [`\\\\?\\${cwd}`, path.join(dir, 'meta-root')] } },
      turnContext(cwd, { sandbox_policy: { type: 'workspace-write' } }),
    ]), 'utf8');
    assert.deepEqual(await reader.read(metaOnly, cwd), [path.join(dir, 'meta-root')]);
    assert.deepEqual(await reader.read(path.join(dir, 'missing.jsonl'), cwd), []);
  });
});

test('only recorded roots that exist as folders are runnable', async () => {
  await withTempDir(async (dir) => {
    const cwd = path.join(dir, 'project');
    const existing = path.join(dir, 'data');
    const file = path.join(dir, 'file.txt');
    await mkdir(cwd);
    await mkdir(existing);
    await writeFile(file, 'x', 'utf8');
    assert.deepEqual(
      await resolveRunnableWorkspaceRoots([existing, path.join(dir, 'gone'), file, cwd, 'relative'], cwd),
      [existing],
    );
  });
});

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withCodexDatabase(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-roots-db-'));
  const restoreHomeDir = patchHomeDir(root);
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await run(root);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    restoreHomeDir();
    await rm(root, { recursive: true, force: true });
  }
}

test('the synchronizer records roots, backfills old rows, and never clears recorded roots', async () => {
  await withCodexDatabase(async (root) => {
    const cwd = path.join(root, 'project');
    const extra = path.join(root, 'data');
    const sessionsDir = path.join(root, '.codex', 'sessions', '2026', '11', '15');
    await mkdir(sessionsDir, { recursive: true });
    const multiRoot = path.join(sessionsDir, 'rollout-a.jsonl');
    await writeFile(multiRoot, encode([
      { type: 'session_meta', payload: { id: 'thread-a', cwd, timestamp: '2026-11-15T10:00:00.000Z' } },
      turnContext(cwd, {
        workspace_roots: [cwd, extra, path.join(root, '.codex', 'visualizations', '2026', '11', '15', 'thread-a')],
      }),
    ]), 'utf8');
    const singleRoot = path.join(sessionsDir, 'rollout-b.jsonl');
    await writeFile(singleRoot, encode([
      { type: 'session_meta', payload: { id: 'thread-b', cwd, timestamp: '2026-11-15T10:00:00.000Z' } },
      turnContext(cwd, { workspace_roots: [cwd] }),
    ]), 'utf8');

    const synchronizer = new CodexSessionSynchronizer();
    await synchronizer.synchronize();
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-a'), [extra]);
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-b'), []);
    const raw = (id: string) => (getConnection()
      .prepare('SELECT workspace_roots FROM sessions WHERE session_id = ?')
      .get(id) as { workspace_roots: string | null }).workspace_roots;
    assert.equal(raw('thread-b'), '[]');

    // A row indexed before the column existed is filled on the next scan,
    // even though the incremental cursor no longer lists its file.
    getConnection().prepare('UPDATE sessions SET workspace_roots = NULL').run();
    await synchronizer.synchronize(new Date(Date.now() + 60_000));
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-a'), [extra]);
    assert.equal(raw('thread-b'), '[]');

    // A turn without the extra roots does not take them away.
    await appendFile(multiRoot, encode([turnContext(cwd, { workspace_roots: [cwd] })]), 'utf8');
    await synchronizer.synchronizeFile(multiRoot);
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-a'), [extra]);
  });
});

function fakeThread(): Thread {
  return {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'native-thread' };
      })() };
    },
  } as unknown as Thread;
}

for (const recorded of [true, false]) {
  test(`a Codex turn ${recorded ? 'gets' : 'does not get'} additionalDirectories (${recorded ? 'roots recorded' : 'none recorded'})`, async (t) => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, 'project');
      const extra = path.join(dir, 'data');
      await mkdir(cwd);
      await mkdir(extra);
      let captured: ThreadOptions | undefined;
      t.mock.method(Codex.prototype, 'resumeThread', (_id: string, options?: ThreadOptions) => {
        captured = options;
        return fakeThread();
      });
      const asked: unknown[] = [];
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => 'native-thread',
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
        getSessionWorkspaceRoots: (sessionId) => {
          asked.push(sessionId);
          return recorded ? [extra, path.join(dir, 'deleted-since')] : [];
        },
      };

      await codexRuntime.run('hi', { sessionId: 'app-session', cwd }, { isWebSocketWriter: true, send: () => {} }, context);

      assert.deepEqual(asked, ['app-session']);
      assert.equal(captured?.workingDirectory, cwd);
      if (recorded) {
        assert.deepEqual(captured?.additionalDirectories, [extra]);
      } else {
        assert.equal('additionalDirectories' in (captured ?? {}), false);
      }
    });
  });
}

/** A fake `codex app-server` that answers `thread/fork` and logs every request. */
function fakeForkServerSource(logFile: string, forkPath: string): string {
  return `
const fs = require('fs');
const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(message) + '\\n');
  if (typeof message.id !== 'number') return;
  const result = message.method === 'thread/fork'
    ? { thread: { id: 'fork-thread', path: ${JSON.stringify(forkPath)} } }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`;
}

for (const withRoots of [true, false]) {
  test(`thread/fork ${withRoots ? 'sends' : 'omits'} runtimeWorkspaceRoots`, async () => {
    await withTempDir(async (dir) => {
      const logFile = path.join(dir, 'requests.log');
      const forkPath = path.join(dir, 'fork.jsonl');
      const script = path.join(dir, 'fake-app-server.cjs');
      await writeFile(forkPath, '', 'utf8');
      await writeFile(logFile, '', 'utf8');
      await writeFile(script, fakeForkServerSource(logFile, forkPath), 'utf8');

      const appServer = codexAppServer as unknown as { resolveLauncher: () => string };
      const original = appServer.resolveLauncher;
      appServer.resolveLauncher = () => script;
      try {
        await codexAppServer.forkThread({
          threadId: 'source-thread',
          cwd: 'E:\\work\\paper',
          ...(withRoots ? { workspaceRoots: ['F:\\data\\bench'] } : {}),
        });
      } finally {
        appServer.resolveLauncher = original;
      }

      const requests = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const fork = requests.find((request) => request.method === 'thread/fork');
      if (withRoots) {
        assert.deepEqual(fork.params.runtimeWorkspaceRoots, ['E:\\work\\paper', 'F:\\data\\bench']);
      } else {
        assert.equal('runtimeWorkspaceRoots' in fork.params, false);
      }
    });
  });
}
