import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type { FileTreeFileSystem, FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * [local] The Files tab can switch to the other workspace roots of a Codex
 * conversation. The client only ever names a root by index; the server takes
 * the folder from that session's row and refuses anything else.
 */

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

type Layout = {
  base: string;
  project: string;
  extra: string;
  missing: string;
  foreign: string;
  services: FileTreeServices;
};

async function withLayout(run: (layout: Layout) => Promise<void>): Promise<void> {
  const base = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-roots-'));
  const project = path.join(base, 'project');
  const extra = path.join(base, 'data');
  const missing = path.join(base, 'moved-away');
  const foreign = path.join(base, 'foreign');
  for (const directory of [project, extra, foreign]) {
    await fsPromises.mkdir(directory, { recursive: true });
  }
  await fsPromises.writeFile(path.join(project, 'main.py'), 'print(1)', 'utf8');
  await fsPromises.writeFile(path.join(extra, 'table.csv'), 'a,b', 'utf8');
  await fsPromises.writeFile(path.join(foreign, 'secret.txt'), 'no', 'utf8');

  const sessions: Record<string, { projectPath: string | null; roots: string[] }> = {
    'codex-multi': { projectPath: project, roots: [extra, missing] },
    'codex-other-project': { projectPath: foreign, roots: [path.join(foreign, 'x')] },
    'claude-session': { projectPath: project, roots: [] },
  };

  const services = createFileTreeService({
    fileSystem: realFileSystem,
    projects: { getProjectPathById: async (projectId) => projectId === 'p1' ? project : null },
    workspace: {
      rootPath: project,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    sessions: {
      getSessionWorkspaceRoots: (sessionId) => sessions[sessionId] ?? null,
      listProjectWorkspaceRoots: () => [extra, missing],
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });

  try {
    await run({ base, project, extra, missing, foreign, services });
  } finally {
    await fsPromises.rm(base, { recursive: true, force: true });
  }
}

const names = (nodes: Array<{ name: string }>) => nodes.map((node) => node.name);

async function rejectsWith(promise: Promise<unknown>, statusCode: number, code?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.statusCode, statusCode);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('the root list is the project folder first, then the session\'s recorded roots', async () => {
  await withLayout(async ({ project, extra, missing, services }) => {
    assert.deepEqual(await services.listWorkspaceRoots('p1', 'codex-multi'), {
      roots: [
        { index: 0, name: 'project', path: project, exists: true },
        { index: 1, name: 'data', path: extra, exists: true },
        { index: 2, name: 'moved-away', path: missing, exists: false },
      ],
    });
    // Sessions without extra roots, of another project, or unknown: the project folder only.
    for (const sessionId of ['claude-session', 'codex-other-project', 'nope', null]) {
      assert.deepEqual((await services.listWorkspaceRoots('p1', sessionId)).roots.map((root) => root.index), [0]);
    }
  });
});

test('a root index lists that root; foreign sessions and unknown indexes are refused', async () => {
  await withLayout(async ({ extra, foreign, services }) => {
    assert.deepEqual(names(await services.listProjectFiles('p1', { respectGitignore: false })), ['main.py']);
    assert.deepEqual(
      names(await services.listProjectFiles('p1', { respectGitignore: false, scope: { sessionId: 'codex-multi', root: 1 } })),
      ['table.csv'],
    );

    await rejectsWith(services.listProjectFiles('p1', { respectGitignore: false, scope: { sessionId: 'codex-multi', root: 3 } }), 400, 'INVALID_WORKSPACE_ROOT');
    await rejectsWith(services.listProjectFiles('p1', { respectGitignore: false, scope: { sessionId: 'codex-other-project', root: 1 } }), 400, 'INVALID_WORKSPACE_ROOT');
    await rejectsWith(services.listProjectFiles('p1', { respectGitignore: false, scope: { sessionId: 'claude-session', root: 1 } }), 400, 'INVALID_WORKSPACE_ROOT');

    // A sub-path must stay inside the selected root.
    await rejectsWith(services.listProjectFiles('p1', {
      respectGitignore: false,
      scope: { sessionId: 'codex-multi', root: 1 },
      subPath: path.join(extra, '..', 'foreign'),
    }), 403, 'PATH_OUTSIDE_PROJECT');
    await rejectsWith(services.listProjectFiles('p1', {
      respectGitignore: false,
      scope: { sessionId: 'codex-multi', root: 1 },
      subPath: foreign,
    }), 403, 'PATH_OUTSIDE_PROJECT');
  });
});

test('a missing root or project folder is reported by name', async () => {
  await withLayout(async ({ missing, services }) => {
    await assert.rejects(
      services.listProjectFiles('p1', { respectGitignore: false, scope: { sessionId: 'codex-multi', root: 2 } }),
      (error: unknown) => error instanceof AppError
        && error.statusCode === 404
        && error.code === 'PROJECT_PATH_NOT_FOUND'
        && error.message === `Folder not found: ${missing}`
        && (error.details as { path?: string }).path === missing,
    );
  });
});

test('files in a recorded root can be read and changed; other folders cannot', async () => {
  await withLayout(async ({ extra, foreign, project, services }) => {
    assert.equal((await services.readTextFile('p1', path.join(extra, 'table.csv'))).content, 'a,b');
    await services.saveTextFile('p1', path.join(extra, 'table.csv'), 'c,d');
    assert.equal(await fsPromises.readFile(path.join(extra, 'table.csv'), 'utf8'), 'c,d');

    // Created at the top of the selected root, by index.
    const created = await services.createEntry({
      projectId: 'p1',
      scope: { sessionId: 'codex-multi', root: 1 },
      parentPath: '',
      type: 'file',
      name: 'notes.md',
    });
    assert.equal(created.path, path.join(extra, 'notes.md'));

    await rejectsWith(services.readTextFile('p1', path.join(foreign, 'secret.txt')), 403);
    await rejectsWith(services.saveTextFile('p1', path.join(foreign, 'secret.txt'), 'x'), 403);
    await rejectsWith(services.renameEntry({ projectId: 'p1', oldPath: path.join(extra, 'table.csv'), newName: '..' }), 400);
    await rejectsWith(services.deleteEntry({ projectId: 'p1', targetPath: path.join(extra, '..', 'foreign', 'secret.txt') }), 403);
    // A root itself is never deleted.
    await rejectsWith(services.deleteEntry({ projectId: 'p1', targetPath: extra }), 403);
    await rejectsWith(services.deleteEntry({ projectId: 'p1', targetPath: project }), 403);
    assert.equal(await fsPromises.readFile(path.join(foreign, 'secret.txt'), 'utf8'), 'no');
  });
});

test('the routes pass a root index, never a path, and refuse anything else', async () => {
  const inputs: unknown[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected');
  };
  const services: FileTreeServices = {
    browseWorkspace: unexpected,
    createWorkspaceFolder: unexpected,
    readTextFile: unexpected,
    openFile: unexpected,
    saveTextFile: unexpected,
    createEntry: unexpected,
    renameEntry: unexpected,
    deleteEntry: unexpected,
    storeUploadedFiles: unexpected,
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
    listWorkspaceRoots: async (...input) => {
      inputs.push(input);
      return { roots: [] };
    },
  };
  const passUpload: RequestHandler = (_request, _response, next) => next();
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(services, passUpload, { maximumFileSizeMegabytes: 1, maximumFileCount: 1 }, { error: () => undefined }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-tree/projects/p1`;

  try {
    assert.equal((await fetch(`${baseUrl}/files?sessionId=s1&root=2`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/files?sessionId=s1&root=0`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/roots?sessionId=s1`)).status, 200);
    for (const bad of ['-1', '1.5', 'E%3A%5CData', '..%2F..']) {
      const response = await fetch(`${baseUrl}/files?sessionId=s1&root=${bad}`);
      assert.equal(response.status, 400, bad);
      assert.equal(((await response.json()) as { code?: string }).code, 'INVALID_WORKSPACE_ROOT');
    }
    // A root other than 0 needs its session.
    assert.equal((await fetch(`${baseUrl}/files?root=1`)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  assert.deepEqual(inputs, [
    ['p1', { respectGitignore: false, scope: { sessionId: 's1', root: 2 } }],
    ['p1', { respectGitignore: false }],
    ['p1', 's1'],
  ]);
});

// [local] Each root is matched against its own .gitignore when ignored entries are requested.
test('a workspace root marks entries from its own .gitignore', async () => {
  await withLayout(async ({ project, extra, services }) => {
    await fsPromises.writeFile(path.join(project, '.gitignore'), 'main.py\n', 'utf8');
    await fsPromises.writeFile(path.join(extra, '.gitignore'), 'out/\n', 'utf8');
    await fsPromises.mkdir(path.join(extra, 'out'));
    await fsPromises.writeFile(path.join(extra, 'out', 'result.bin'), 'x', 'utf8');

    const marked = (nodes: Array<{ name: string; ignored?: boolean }>) =>
      nodes.map((node) => [node.name, node.ignored === true]);
    assert.deepEqual(
      marked(await services.listProjectFiles('p1', { respectGitignore: true, includeIgnored: true })),
      [['.gitignore', false], ['main.py', true]],
    );
    assert.deepEqual(
      marked(await services.listProjectFiles('p1', {
        respectGitignore: true,
        includeIgnored: true,
        scope: { sessionId: 'codex-multi', root: 1 },
      })),
      [['out', true], ['.gitignore', false], ['table.csv', false]],
    );
  });
});
