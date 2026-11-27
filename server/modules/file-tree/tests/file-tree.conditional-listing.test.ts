import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import express, { type RequestHandler } from 'express';

import {
  createFileSystemChangeTracker,
  createFileTreeChangeTracker,
  fileTreeEntryKey,
  type FileTreeChangeTracker,
} from '@/modules/file-tree/file-tree.change-tracker.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type { FileTreeFileSystem, FileTreeListingResult, FileTreeServices } from '@/shared/types.js';

/**
 * [local] The Files tab sends the ETag of the tree it holds; the server answers
 * 304 when nothing changed. A filesystem watch armed before the last walk lets
 * it say so without walking the folder again; without one (or once the watch
 * saw anything) the folder is walked and the ETag, a hash of the listing,
 * decides. Never "unchanged" when something changed.
 */

// ---------------------------------------------------------------------------
// The change tracker on a fake watch.

type FakeWatch = {
  rootPath: string;
  emit(eventType: string, filename: string | null): void;
  fail(): void;
  closed: boolean;
};

const ROOT = path.resolve('/projects/demo');

function createFakeTracker(overrides: { maxSnapshotAgeMs?: number } = {}) {
  const watches: FakeWatch[] = [];
  const identities = new Map<string, string>();
  /** What each entry looks like now (absolute path to stamp); missing means unreadable. */
  const current = new Map<string, string>();
  const stampOf = async (absolutePath: string) => current.get(absolutePath) ?? null;
  let clock = 1_000;
  const tracker = createFileTreeChangeTracker({
    maxSnapshotAgeMs: overrides.maxSnapshotAgeMs ?? 60_000,
    settleDelayMs: 0,
    now: () => clock,
    watch(rootPath, onEvent, onError) {
      const watch: FakeWatch = {
        rootPath,
        emit: (eventType, filename) => onEvent(eventType, filename),
        fail: () => onError(new Error('watch failed')),
        closed: false,
      };
      watches.push(watch);
      return { close: () => { watch.closed = true; } };
    },
    identify: async (rootPath) => identities.get(rootPath) ?? 'dev:1',
  });
  return {
    tracker,
    watches,
    identities,
    current,
    advance: (milliseconds: number) => { clock += milliseconds; },
    unchanged: (etags: string[] = ['W/"a"'], key = 'k') => tracker.unchangedEtag(key, ROOT, etags, stampOf),
  };
}

const rel = (...segments: string[]) => path.join(...segments);

/** A listing showing `src/a.ts` and the folder `src`. */
async function rememberListing(fake: ReturnType<typeof createFakeTracker>, etag = 'W/"a"', key = 'k') {
  const token = await fake.tracker.arm(ROOT);
  assert.ok(token);
  const stamps = new Map([[rel('src'), 'dir-v1'], [rel('src', 'a.ts'), 'file-v1']]);
  for (const [relativePath, stamp] of stamps) fake.current.set(path.join(ROOT, relativePath), stamp);
  fake.tracker.remember(key, ROOT, token, etag, stamps);
  return token;
}

test('an untouched folder is confirmed unchanged without a walk', async () => {
  const fake = createFakeTracker();
  await rememberListing(fake);
  assert.equal(await fake.unchanged(), 'W/"a"');
  // Only for the ETag that was remembered, and only for that listing.
  assert.equal(await fake.unchanged(['W/"b"']), null);
  assert.equal(await fake.unchanged(['W/"a"'], 'other'), null);
});

test('an entry added, removed or renamed anywhere ends the watch, including ignored folders', async () => {
  for (const filename of [rel('src', 'new.ts'), rel('node_modules', 'pkg', 'index.js'), rel('dist', 'out.js'), rel('beyond-the-cap', 'deep', 'x'), '.git']) {
    const fake = createFakeTracker();
    await rememberListing(fake);
    fake.watches[0].emit('rename', filename);
    assert.equal(fake.watches[0].closed, true, filename);
    assert.equal(await fake.unchanged(), null, filename);
  }
});

test('a metadata change counts when the listing shows that entry differently now', async () => {
  const fake = createFakeTracker();
  await rememberListing(fake);
  fake.current.set(path.join(ROOT, 'src', 'a.ts'), 'file-v2');
  fake.watches[0].emit('change', rel('src', 'a.ts'));
  assert.equal(await fake.unchanged(), null);
  // The watch itself goes on: a new listing showing the new state is confirmed.
  assert.equal(fake.watches[0].closed, false);
  const token = await fake.tracker.arm(ROOT);
  assert.ok(token);
  fake.tracker.remember('k', ROOT, token, 'W/"b"', new Map([[rel('src'), 'dir-v1'], [rel('src', 'a.ts'), 'file-v2']]));
  assert.equal(await fake.unchanged(['W/"b"']), 'W/"b"');
  // An entry that can no longer be read counts as changed.
  fake.current.delete(path.join(ROOT, 'src', 'a.ts'));
  assert.equal(await fake.unchanged(['W/"b"']), null);
});

test('an entry reported in another case (Windows) or Unicode form is still recognized', async () => {
  const fake = createFakeTracker();
  const token = await fake.tracker.arm(ROOT);
  assert.ok(token);
  // Listed as NFC "café.txt"; the OS reports the decomposed form.
  fake.tracker.remember('k', ROOT, token, 'W/"a"', new Map([[fileTreeEntryKey('café.txt'), 'v1']]));
  fake.current.set(path.join(ROOT, 'café.txt'), 'v2');
  fake.watches[0].emit('change', 'café.txt');
  assert.equal(await fake.unchanged(), null);

  if (process.platform === 'win32') {
    const other = createFakeTracker();
    await rememberListing(other);
    other.current.set(path.join(ROOT, 'SRC', 'A.ts'), 'file-v2');
    other.watches[0].emit('change', 'SRC\\A.ts');
    assert.equal(await other.unchanged(), null);
  }
});

test('a mere read (last-access time) or a change to an entry the listing does not show is not a change', async () => {
  const fake = createFakeTracker();
  await rememberListing(fake);
  // Windows reports reading a folder or file as a change; nothing shown differs.
  fake.watches[0].emit('change', rel('src'));
  fake.watches[0].emit('change', rel('src', 'a.ts'));
  // Inside a gitignored folder: not part of this listing.
  fake.watches[0].emit('change', rel('node_modules', 'pkg', 'index.js'));
  assert.equal(await fake.unchanged(), 'W/"a"');
});

test('the root .gitignore, an unnamed event, a watch error and a server-side write all count as a change', async () => {
  for (const trigger of ['gitignore', 'unnamed', 'error', 'invalidate'] as const) {
    const fake = createFakeTracker();
    await rememberListing(fake);
    if (trigger === 'gitignore') fake.watches[0].emit('change', '.gitignore');
    if (trigger === 'unnamed') fake.watches[0].emit('change', null);
    if (trigger === 'error') fake.watches[0].fail();
    if (trigger === 'invalidate') fake.tracker.invalidateAll();
    assert.equal(await fake.unchanged(), null, trigger);
  }
});

test('anything inside .git is ignored', async () => {
  const fake = createFakeTracker();
  await rememberListing(fake);
  fake.watches[0].emit('change', rel('.git', 'index'));
  fake.watches[0].emit('rename', rel('.git', 'index.lock'));
  fake.watches[0].emit('rename', rel('packages', 'app', '.git', 'HEAD'));
  // The folder's own timestamp: the listing does not show `.git`.
  fake.watches[0].emit('change', '.git');
  assert.equal(await fake.unchanged(), 'W/"a"');
});

test('a remembered listing is trusted for a bounded time only', async () => {
  const fake = createFakeTracker({ maxSnapshotAgeMs: 5_000 });
  await rememberListing(fake);
  fake.advance(4_999);
  assert.equal(await fake.unchanged(), 'W/"a"');
  fake.advance(1);
  assert.equal(await fake.unchanged(), null);
});

test('a replaced folder is never confirmed', async () => {
  const fake = createFakeTracker();
  await rememberListing(fake);
  fake.identities.set(ROOT, 'dev:2');
  assert.equal(await fake.unchanged(), null);
});

test('a closed watch is replaced by a new one on the next walk', async () => {
  const fake = createFakeTracker();
  const firstToken = await rememberListing(fake);
  // A running watch is shared by later walks.
  assert.equal(await fake.tracker.arm(ROOT), firstToken);
  fake.watches[0].emit('rename', 'b.txt');
  const secondToken = await rememberListing(fake, 'W/"b"');
  assert.notEqual(secondToken, firstToken);
  assert.equal(fake.watches.length, 2);
  // A listing remembered under the old watch cannot be confirmed by the new one.
  fake.tracker.remember('old', ROOT, firstToken, 'W/"a"', new Map());
  assert.equal(await fake.unchanged(['W/"a"'], 'old'), null);
  assert.equal(await fake.unchanged(['W/"b"']), 'W/"b"');
});

test('a folder that cannot be watched is simply walked every time', async () => {
  const tracker = createFileTreeChangeTracker({
    maxSnapshotAgeMs: 60_000,
    settleDelayMs: 0,
    watch() {
      throw new Error('ENOSPC');
    },
    identify: async () => 'dev:1',
  });
  assert.equal(await tracker.arm(ROOT), null);
});

// ---------------------------------------------------------------------------
// The service on a real folder.

const realFileSystem: FileTreeFileSystem = {
  access: (candidatePath) => fsPromises.access(candidatePath),
  stat: (candidatePath) => fsPromises.stat(candidatePath),
  lstat: (candidatePath) => fsPromises.lstat(candidatePath),
  openDirectory: async function* (directoryPath) {
    yield* await fsPromises.opendir(directoryPath);
  },
  realpath: (candidatePath) => fsPromises.realpath(candidatePath),
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
  async makeDirectory(directoryPath, recursive) {
    await fsPromises.mkdir(directoryPath, { recursive });
  },
  rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
  async removeDirectory(directoryPath) {
    await fsPromises.rm(directoryPath, { recursive: true, force: true });
  },
  unlink: (filePath) => fsPromises.unlink(filePath),
  copyFile: (sourcePath, destinationPath) => fsPromises.copyFile(sourcePath, destinationPath),
  createReadStream: (filePath) => createReadStream(filePath),
};

type Workspace = {
  project: string;
  extra: string;
  services: FileTreeServices;
  /** Directory reads since the last call. */
  takeWalks(): number;
};

async function withWorkspace(
  tracker: FileTreeChangeTracker | undefined,
  run: (workspace: Workspace) => Promise<void>,
): Promise<void> {
  const base = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-etag-')));
  const project = path.join(base, 'project');
  const extra = path.join(base, 'data');
  await fsPromises.mkdir(path.join(project, 'src', 'deep'), { recursive: true });
  await fsPromises.mkdir(path.join(project, 'node_modules', 'pkg'), { recursive: true });
  await fsPromises.mkdir(path.join(project, '.git'), { recursive: true });
  await fsPromises.mkdir(extra, { recursive: true });
  await fsPromises.writeFile(path.join(project, '.gitignore'), 'node_modules/\n', 'utf8');
  await fsPromises.writeFile(path.join(project, 'src', 'a.ts'), 'a', 'utf8');
  await fsPromises.writeFile(path.join(project, 'src', 'deep', 'b.ts'), 'b', 'utf8');
  await fsPromises.writeFile(path.join(project, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
  await fsPromises.writeFile(path.join(project, '.git', 'index'), 'i', 'utf8');
  await fsPromises.writeFile(path.join(extra, 'table.csv'), 'a,b', 'utf8');

  let walks = 0;
  const countingFileSystem: FileTreeFileSystem = {
    ...realFileSystem,
    openDirectory(directoryPath) {
      walks += 1;
      return realFileSystem.openDirectory(directoryPath);
    },
  };
  const services = createFileTreeService({
    fileSystem: countingFileSystem,
    projects: { getProjectPathById: async (projectId) => projectId === 'p1' ? project : null },
    workspace: {
      rootPath: project,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    sessions: {
      getSessionWorkspaceRoots: (sessionId) => sessionId === 'codex-multi' ? { projectPath: project, roots: [extra] } : null,
      listProjectWorkspaceRoots: () => [extra],
    },
    changeTracker: tracker,
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 8,
    logger: { error: () => undefined },
  });

  try {
    await run({
      project,
      extra,
      services,
      takeWalks: () => {
        const count = walks;
        walks = 0;
        return count;
      },
    });
  } finally {
    await fsPromises.rm(base, { recursive: true, force: true });
  }
}

const FILES_TAB = { respectGitignore: true, includeIgnored: true } as const;

function bodyOf(result: FileTreeListingResult): string {
  assert.equal(result.notModified, false);
  return (result as { body: string }).body;
}

// Watch events arrive asynchronously; real changes are made a moment before the
// next request, as they would be between two visits of the Files tab.
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

const nativeWatch = process.platform === 'win32' || process.platform === 'darwin';

test('without a watch the folder is walked and the ETag decides', async () => {
  await withWorkspace(undefined, async ({ project, services, takeWalks }) => {
    const first = await services.listProjectFilesIfChanged!('p1', FILES_TAB, []);
    assert.ok(bodyOf(first).includes('a.ts'));
    takeWalks();

    const again = await services.listProjectFilesIfChanged!('p1', FILES_TAB, [first.etag]);
    assert.deepEqual(again, { notModified: true, etag: first.etag });
    assert.ok(takeWalks() > 0);

    await fsPromises.writeFile(path.join(project, 'src', 'deep', 'b.ts'), 'bb', 'utf8');
    const changed = await services.listProjectFilesIfChanged!('p1', FILES_TAB, [first.etag]);
    assert.notEqual(changed.etag, first.etag);
    assert.ok(bodyOf(changed).includes('b.ts'));
  });
});

test('with a watch an unchanged folder is confirmed without walking it', { skip: !nativeWatch }, async () => {
  const tracker = createFileSystemChangeTracker(60_000);
  try {
    await withWorkspace(tracker, async ({ project, services, takeWalks }) => {
      const first = await services.listProjectFilesIfChanged!('p1', FILES_TAB, []);
      await pause();
      takeWalks();

      assert.deepEqual(await services.listProjectFilesIfChanged!('p1', FILES_TAB, [first.etag]), { notModified: true, etag: first.etag });
      assert.equal(takeWalks(), 0);

      // Git bookkeeping is not part of the tree.
      await fsPromises.writeFile(path.join(project, '.git', 'index'), 'i2', 'utf8');
      await pause();
      assert.equal((await services.listProjectFilesIfChanged!('p1', FILES_TAB, [first.etag])).notModified, true);
      assert.equal(takeWalks(), 0);

      // A deep file's size or time is part of the tree.
      await fsPromises.writeFile(path.join(project, 'src', 'deep', 'b.ts'), 'changed', 'utf8');
      await pause();
      const changed = await services.listProjectFilesIfChanged!('p1', FILES_TAB, [first.etag]);
      assert.equal(changed.notModified, false);
      assert.notEqual(changed.etag, first.etag);
      assert.ok(takeWalks() > 0);

      // The new listing is confirmed again without a walk.
      await pause();
      assert.equal((await services.listProjectFilesIfChanged!('p1', FILES_TAB, [changed.etag])).notModified, true);
      assert.equal(takeWalks(), 0);

      // Permissions only (read-only on Windows).
      await fsPromises.chmod(path.join(project, 'src', 'a.ts'), 0o444);
      await pause();
      const readOnly = await services.listProjectFilesIfChanged!('p1', FILES_TAB, [changed.etag]);
      assert.equal(readOnly.notModified, false);
      await fsPromises.chmod(path.join(project, 'src', 'a.ts'), 0o644);

      // A rename deep down.
      await pause();
      const beforeRename = await services.listProjectFilesIfChanged!('p1', FILES_TAB, []);
      await pause();
      await fsPromises.rename(path.join(project, 'src', 'deep', 'b.ts'), path.join(project, 'src', 'deep', 'c.ts'));
      await pause();
      const renamed = await services.listProjectFilesIfChanged!('p1', FILES_TAB, [beforeRename.etag]);
      assert.ok(bodyOf(renamed).includes('c.ts'));
    });
  } finally {
    tracker.close();
  }
});

test('changes inside a gitignored folder are never hidden by the watch', { skip: !nativeWatch }, async () => {
  const tracker = createFileSystemChangeTracker(60_000);
  try {
    await withWorkspace(tracker, async ({ project, services }) => {
      // node_modules is listed (flagged) but not walked; its own listing is fetched on demand.
      const subPath = path.join(project, 'node_modules');
      const first = await services.listProjectFilesIfChanged!('p1', { ...FILES_TAB, subPath }, []);
      await pause();
      assert.equal((await services.listProjectFilesIfChanged!('p1', { ...FILES_TAB, subPath }, [first.etag])).notModified, true);

      await fsPromises.writeFile(path.join(project, 'node_modules', 'new.js'), 'n', 'utf8');
      await pause();
      const changed = await services.listProjectFilesIfChanged!('p1', { ...FILES_TAB, subPath }, [first.etag]);
      assert.ok(bodyOf(changed).includes('new.js'));
    });
  } finally {
    tracker.close();
  }
});

test('a file the server writes itself is never answered from the watch', { skip: !nativeWatch }, async () => {
  // Watch events take a moment; the server's own writes must not depend on them.
  const tracker = createFileSystemChangeTracker(60_000);
  try {
    await withWorkspace(tracker, async ({ services }) => {
      const first = await services.listProjectFilesIfChanged!('p1', FILES_TAB, []);
      await pause();
      await services.createEntry({ projectId: 'p1', parentPath: '', type: 'file', name: 'new.md' });
      const next = await services.listProjectFilesIfChanged!('p1', FILES_TAB, [first.etag]);
      assert.ok(bodyOf(next).includes('new.md'));
    });
  } finally {
    tracker.close();
  }
});

test('the listing options and workspace roots each have their own ETag', { skip: !nativeWatch }, async () => {
  const tracker = createFileSystemChangeTracker(60_000);
  try {
    await withWorkspace(tracker, async ({ extra, services }) => {
      const withIgnored = await services.listProjectFilesIfChanged!('p1', FILES_TAB, []);
      const withoutIgnored = await services.listProjectFilesIfChanged!('p1', { respectGitignore: true }, []);
      const otherRoot = { ...FILES_TAB, scope: { sessionId: 'codex-multi', root: 1 } };
      const dataRoot = await services.listProjectFilesIfChanged!('p1', otherRoot, []);
      assert.notEqual(withIgnored.etag, withoutIgnored.etag);
      assert.notEqual(withIgnored.etag, dataRoot.etag);
      await pause();

      // An ETag of one listing never confirms another.
      assert.equal((await services.listProjectFilesIfChanged!('p1', { respectGitignore: true }, [withIgnored.etag])).notModified, false);
      assert.equal((await services.listProjectFilesIfChanged!('p1', otherRoot, [withIgnored.etag])).notModified, false);

      // A change in the extra root is seen by its own listing.
      await pause();
      assert.equal((await services.listProjectFilesIfChanged!('p1', otherRoot, [dataRoot.etag])).notModified, true);
      await fsPromises.writeFile(path.join(extra, 'more.csv'), 'c', 'utf8');
      await pause();
      assert.ok(bodyOf(await services.listProjectFilesIfChanged!('p1', otherRoot, [dataRoot.etag])).includes('more.csv'));
    });
  } finally {
    tracker.close();
  }
});

test('a tree cut off by the entry cap lists the same entries every time', async () => {
  // Directory reads finish in random order; the shared budget must not follow that order.
  const projectRoot = path.resolve('capped-project');
  const directories = Array.from({ length: 12 }, (_, index) => path.join(projectRoot, `dir-${index}`));
  const entry = (name: string, directory: boolean) => ({ name, isDirectory: () => directory });
  const fileSystem: FileTreeFileSystem = {
    ...realFileSystem,
    access: async () => undefined,
    async *openDirectory(directoryPath) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 8));
      if (directoryPath === projectRoot) {
        yield* directories.map((directory) => entry(path.basename(directory), true));
        return;
      }
      for (let index = 0; index < 1_500; index += 1) yield entry(`f-${index}.txt`, false);
    },
    lstat: async (candidatePath) => ({
      size: 1,
      mtime: new Date('2026-01-01T00:00:00.000Z'),
      mode: 0o644,
      isDirectory: () => directories.includes(candidatePath),
      isSymbolicLink: () => false,
    }),
  };
  const services = createFileTreeService({
    fileSystem,
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 16,
    logger: { error: () => undefined },
  });

  const etags = new Set<string>();
  for (let run = 0; run < 5; run += 1) {
    etags.add((await services.listProjectFilesIfChanged!('p1', { respectGitignore: false }, [])).etag);
  }
  assert.equal(etags.size, 1);
  // Directories in tree order take the budget first: the first ones are complete, the rest cut off.
  const tree = JSON.parse(bodyOf(await services.listProjectFilesIfChanged!('p1', { respectGitignore: false }, []))) as Array<{ name: string; incomplete?: boolean; children?: unknown[] }>;
  const counts = tree.map((node) => node.children?.length ?? 0);
  const total = tree.length + counts.reduce((sum, count) => sum + count, 0);
  assert.ok(total <= Number(process.env.CLOUDCLI_FILE_TREE_MAX_ENTRIES || 10_000));
  assert.equal(tree[0].incomplete, undefined);
  assert.equal(tree.at(-1)?.incomplete, true);
});

// ---------------------------------------------------------------------------
// The route.

async function withRouter(services: Partial<FileTreeServices>, run: (baseUrl: string) => Promise<void>) {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected');
  };
  const passUpload: RequestHandler = (_request, _response, next) => next();
  const app = express();
  app.use('/api/file-tree', createFileTreeRouter({
    browseWorkspace: unexpected,
    createWorkspaceFolder: unexpected,
    readTextFile: unexpected,
    openFile: unexpected,
    saveTextFile: unexpected,
    listProjectFiles: unexpected,
    createEntry: unexpected,
    renameEntry: unexpected,
    deleteEntry: unexpected,
    storeUploadedFiles: unexpected,
    listWorkspaceRoots: unexpected,
    ...services,
  }, passUpload, { maximumFileSizeMegabytes: 1, maximumFileCount: 1 }, { error: () => undefined }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-tree/projects/p1/files`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('the route answers 304 to a matching If-None-Match and sends the tree compressed otherwise', async () => {
  const body = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ name: `file-${index}.ts`, type: 'file' })));
  const calls: Array<readonly string[]> = [];
  await withRouter({
    listProjectFilesIfChanged: async (_projectId, _options, candidateEtags) => {
      calls.push(candidateEtags);
      return candidateEtags.includes('W/"ft-1"')
        ? { notModified: true, etag: 'W/"ft-1"' }
        : { notModified: false, etag: 'W/"ft-1"', body };
    },
  }, async (url) => {
    const notModified = await fetch(`${url}?respectGitignore=true`, { headers: { 'If-None-Match': 'W/"old", W/"ft-1"' } });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers.get('etag'), 'W/"ft-1"');
    assert.equal(await notModified.text(), '');

    // Raw bytes, to see the encoding on the wire.
    for (const encoding of ['br', 'gzip'] as const) {
      const raw = await new Promise<{ headers: Record<string, unknown>; bytes: Buffer }>((resolve, reject) => {
        import('node:http').then(({ get }) => {
          get(`${url}?respectGitignore=true`, { headers: { 'Accept-Encoding': encoding === 'br' ? 'gzip, deflate, br' : 'gzip' } }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolve({ headers: response.headers, bytes: Buffer.concat(chunks) }));
          }).on('error', reject);
        }, reject);
      });
      assert.equal(raw.headers['content-encoding'], encoding);
      assert.equal(raw.headers.etag, 'W/"ft-1"');
      assert.ok(raw.bytes.length < body.length / 4);
      const decoded = encoding === 'br' ? zlib.brotliDecompressSync(raw.bytes) : zlib.gunzipSync(raw.bytes);
      assert.equal(decoded.toString('utf8'), body);
    }
  });
  assert.deepEqual(calls[0], ['W/"old"', 'W/"ft-1"']);
  assert.deepEqual(calls[1], []);
});
