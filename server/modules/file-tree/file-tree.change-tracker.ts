import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

/**
 * [local] Lets the Files tab hear "unchanged" without the server walking the
 * project again.
 *
 * A listing is remembered as its ETag, the metadata it shows for each entry,
 * and the recursive filesystem watch that was running before the walk began.
 * When the request comes back with that ETag, the watch decides:
 *
 * - An entry appeared, disappeared or was renamed (a `rename` event), the OS
 *   reported a change without naming it, the watch failed, or the root's
 *   `.gitignore` changed: the watch is closed and the folder is walked again.
 * - Only metadata changed (a `change` event): the entries named are looked up
 *   again and compared with what the remembered listing shows for them (size,
 *   time, permissions, link flag). Windows reports a mere read as a change
 *   (last-access time), including the walk's own directory reads, so a blanket
 *   rule would make every walk invalidate itself. An entry the listing does not
 *   show (inside a gitignored folder, beyond the entry cap) cannot change it.
 * - Events strictly inside a version-control folder (`.git/...`), which the
 *   tree never lists, are skipped.
 *
 * Deliberately conservative:
 * - The answer is trusted only for `maxSnapshotAgeMs`: a file appended through
 *   a handle that stays open changes size without an event on Windows until
 *   the handle is flushed or closed, so after this age the folder is walked
 *   again (the ETag still spares the transfer when the listing is the same).
 * - The watched folder's identity is checked on every answer, so a project
 *   folder that was replaced (or a junction pointed elsewhere) is walked again.
 * - Before answering, pending watch events get a moment to arrive.
 */

/** Stops one watch. */
export type FileTreeWatchHandle = { close(): void };

/**
 * Starts a recursive watch of `rootPath`. `filename` is relative to the root
 * and null when the OS reported a change without naming it. May throw.
 */
export type FileTreeWatchFactory = (
  rootPath: string,
  onEvent: (eventType: string, filename: string | null) => void,
  onError: (error: unknown) => void,
) => FileTreeWatchHandle;

/**
 * What a listing shows about one entry besides its name and children, as a
 * comparable string; null when it cannot be read. Supplied by the caller,
 * which knows how it renders an entry.
 */
export type FileTreeEntryStamp = (absolutePath: string) => Promise<string | null>;

export type FileTreeChangeTrackerOptions = {
  watch: FileTreeWatchFactory;
  /** A value that changes when the folder at `rootPath` is replaced (device + inode), or null when unreadable. */
  identify(rootPath: string): Promise<string | null>;
  /** How long a remembered listing may be answered without a walk. */
  maxSnapshotAgeMs: number;
  /** Wait before answering "unchanged", so events already queued are seen. */
  settleDelayMs?: number;
  maxWatches?: number;
  maxSnapshots?: number;
  /** More entries with changed metadata than this and the watch gives up. */
  maxChangedEntries?: number;
  now?: () => number;
};

export type FileTreeChangeTracker = {
  /**
   * Makes sure `rootPath` is watched and returns a token naming the current
   * watch, or null when it cannot be watched. Call before walking.
   */
  arm(rootPath: string): Promise<string | null>;
  /**
   * Remember that listing `key` under `rootPath` had `etag` and showed
   * `stamps` (`fileTreeEntryKey` of each entry → stamp) while watch `token`
   * was running.
   */
  remember(key: string, rootPath: string, token: string, etag: string, stamps: ReadonlyMap<string, string>): void;
  /**
   * The remembered ETag of `key` when it is one of `candidateEtags` and nothing
   * it shows changed since; null means "walk the folder".
   */
  unchangedEtag(
    key: string,
    rootPath: string,
    candidateEtags: readonly string[],
    stampOf: FileTreeEntryStamp,
  ): Promise<string | null>;
  /** End every watch, e.g. after the server changed files itself. */
  invalidateAll(): void;
  close(): void;
};

const VERSION_CONTROL_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg']);
const STAMP_LOOKUP_BATCH_SIZE = 64;

type Watch = {
  id: number;
  rootPath: string;
  identity: string;
  handle: FileTreeWatchHandle | null;
  dirty: boolean;
  /** Entries whose metadata changed since the watch started: entry key → relative path. */
  changed: Map<string, string>;
  /** Closes the watch once no remembered listing can use it any more. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

type Snapshot = {
  etag: string;
  rootKey: string;
  token: string;
  stamps: ReadonlyMap<string, string>;
  takenAt: number;
};

/**
 * How an entry is looked up: its path relative to the watched folder, in the
 * platform separator, Unicode NFC, and lower case on Windows, so a name the OS
 * reports in another case or composition still finds the entry. Listings must
 * key their stamps the same way.
 */
export function fileTreeEntryKey(relativePath: string): string {
  const key = relativePath.split(/[\\/]+/).filter(Boolean).join(path.sep).normalize('NFC');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function isRootGitignore(relativePath: string): boolean {
  return fileTreeEntryKey(relativePath) === '.gitignore';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function createFileTreeChangeTracker(options: FileTreeChangeTrackerOptions): FileTreeChangeTracker {
  const now = options.now ?? Date.now;
  const settleDelayMs = options.settleDelayMs ?? 20;
  const maxWatches = options.maxWatches ?? 16;
  const maxSnapshots = options.maxSnapshots ?? 16;
  const maxChangedEntries = options.maxChangedEntries ?? 5_000;

  const watches = new Map<string, Watch>();
  const arming = new Map<string, Promise<string | null>>();
  // Insertion order is recency: the first key is the least recently used.
  const snapshots = new Map<string, Snapshot>();
  let nextWatchId = 1;

  function rootKeyOf(rootPath: string): string {
    const resolved = path.resolve(rootPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function markDirty(watch: Watch): void {
    watch.dirty = true;
    watch.changed.clear();
    if (watch.handle) {
      const { handle } = watch;
      watch.handle = null;
      try {
        handle.close();
      } catch {
        // Already closed.
      }
    }
  }

  function dropWatch(rootKey: string): void {
    const watch = watches.get(rootKey);
    if (!watch) return;
    markDirty(watch);
    if (watch.expiryTimer) clearTimeout(watch.expiryTimer);
    watches.delete(rootKey);
  }

  /**
   * A watch outlives the last listing that used it by `maxSnapshotAgeMs` only.
   * Besides the handle itself, an open recursive watch makes Windows refuse to
   * rename or move a folder that contains the watched one, so it must not
   * linger.
   */
  function scheduleExpiry(rootKey: string, watch: Watch): void {
    if (watch.expiryTimer) clearTimeout(watch.expiryTimer);
    watch.expiryTimer = setTimeout(() => {
      if (watches.get(rootKey) === watch) dropWatch(rootKey);
    }, options.maxSnapshotAgeMs);
    watch.expiryTimer.unref?.();
  }

  function handleEvent(watch: Watch, eventType: string, filename: string | null): void {
    if (watch.dirty) return;
    if (!filename) {
      markDirty(watch);
      return;
    }
    const segments = filename.split(/[\\/]+/).filter(Boolean);
    const versionControlIndex = segments.findIndex((segment) => VERSION_CONTROL_DIRECTORY_NAMES.has(segment));
    if (versionControlIndex >= 0 && versionControlIndex < segments.length - 1) {
      // Strictly inside a version-control folder, which the tree never lists.
      return;
    }
    const relativePath = segments.join(path.sep);
    // The root's .gitignore decides which entries are listed and flagged, also
    // in listings that do not show the file itself (a folder loaded on demand).
    if (eventType !== 'change' || isRootGitignore(relativePath) || watch.changed.size >= maxChangedEntries) {
      markDirty(watch);
      return;
    }
    watch.changed.set(fileTreeEntryKey(relativePath), relativePath);
  }

  /** Still watching, and the same folder as when the watch started. */
  async function stillValid(watch: Watch): Promise<boolean> {
    if (watch.dirty) return false;
    const identity = await options.identify(watch.rootPath);
    if (identity === null || identity !== watch.identity) {
      markDirty(watch);
      return false;
    }
    return !watch.dirty;
  }

  /** Every changed entry the snapshot shows still looks the way it shows it. */
  async function changedEntriesMatch(watch: Watch, snapshot: Snapshot, stampOf: FileTreeEntryStamp): Promise<boolean> {
    const relevant = [...watch.changed].filter(([key]) => snapshot.stamps.has(key));
    for (let start = 0; start < relevant.length; start += STAMP_LOOKUP_BATCH_SIZE) {
      const batch = relevant.slice(start, start + STAMP_LOOKUP_BATCH_SIZE);
      const current = await Promise.all(batch.map(([, relativePath]) => stampOf(path.join(watch.rootPath, relativePath))));
      if (batch.some(([key], index) => current[index] === null || current[index] !== snapshot.stamps.get(key))) {
        return false;
      }
    }
    return true;
  }

  async function startWatch(rootPath: string, rootKey: string): Promise<string | null> {
    const identityBefore = await options.identify(rootPath);
    if (identityBefore === null) return null;

    const watch: Watch = {
      id: nextWatchId++,
      rootPath,
      identity: identityBefore,
      handle: null,
      dirty: false,
      changed: new Map(),
      expiryTimer: null,
    };
    try {
      watch.handle = options.watch(
        rootPath,
        (eventType, filename) => handleEvent(watch, eventType, filename),
        () => markDirty(watch),
      );
    } catch {
      return null;
    }

    // The folder must not have been swapped while the watch was being set up.
    const identityAfter = await options.identify(rootPath);
    if (identityAfter !== identityBefore) {
      markDirty(watch);
      return null;
    }

    dropWatch(rootKey);
    watches.set(rootKey, watch);
    scheduleExpiry(rootKey, watch);
    while (watches.size > maxWatches) {
      dropWatch(watches.keys().next().value as string);
    }
    return watch.dirty ? null : String(watch.id);
  }

  return {
    arm(rootPath) {
      const rootKey = rootKeyOf(rootPath);
      const pending = arming.get(rootKey);
      if (pending) return pending;

      // One arming per folder at a time, so concurrent requests share a watch.
      const armed = (async () => {
        const existing = watches.get(rootKey);
        if (existing) {
          if (await stillValid(existing)) {
            // Most recently used last.
            watches.delete(rootKey);
            watches.set(rootKey, existing);
            scheduleExpiry(rootKey, existing);
            return String(existing.id);
          }
          dropWatch(rootKey);
        }
        return startWatch(rootPath, rootKey);
      })().finally(() => {
        arming.delete(rootKey);
      });
      arming.set(rootKey, armed);
      return armed;
    },

    remember(key, rootPath, token, etag, stamps) {
      const rootKey = rootKeyOf(rootPath);
      const watch = watches.get(rootKey);
      if (!watch || String(watch.id) !== token || watch.dirty) return;
      scheduleExpiry(rootKey, watch);
      snapshots.delete(key);
      snapshots.set(key, { etag, rootKey, token, stamps, takenAt: now() });
      while (snapshots.size > maxSnapshots) {
        snapshots.delete(snapshots.keys().next().value as string);
      }
    },

    async unchangedEtag(key, rootPath, candidateEtags, stampOf) {
      const snapshot = snapshots.get(key);
      const rootKey = rootKeyOf(rootPath);
      if (
        !snapshot
        || snapshot.rootKey !== rootKey
        || !candidateEtags.includes(snapshot.etag)
        || now() - snapshot.takenAt >= options.maxSnapshotAgeMs
      ) {
        return null;
      }

      if (settleDelayMs > 0) await delay(settleDelayMs);

      const watch = watches.get(rootKey);
      if (!watch || String(watch.id) !== snapshot.token) return null;
      if (!(await stillValid(watch))) return null;
      if (!(await changedEntriesMatch(watch, snapshot, stampOf))) return null;
      // Events may have arrived while looking; the snapshot may have been replaced.
      if (watch.dirty || snapshots.get(key) !== snapshot) return null;
      return snapshot.etag;
    },

    invalidateAll() {
      for (const watch of watches.values()) markDirty(watch);
    },

    close() {
      for (const rootKey of [...watches.keys()]) dropWatch(rootKey);
      snapshots.clear();
    },
  };
}

/** [local] The tracker on Node's filesystem: native recursive `fs.watch`, folder identity from device + inode. */
export function createFileSystemChangeTracker(maxSnapshotAgeMs: number): FileTreeChangeTracker {
  return createFileTreeChangeTracker({
    maxSnapshotAgeMs,
    watch(rootPath, onEvent, onError) {
      const watcher = fs.watch(rootPath, { recursive: true, persistent: false }, (eventType, filename) => {
        onEvent(eventType, filename ? String(filename) : null);
      });
      watcher.on('error', onError);
      return watcher;
    },
    async identify(rootPath) {
      try {
        const stats = await fsPromises.stat(rootPath, { bigint: true });
        return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : null;
      } catch {
        return null;
      }
    },
  });
}
