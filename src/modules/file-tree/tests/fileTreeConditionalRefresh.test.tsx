import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { FileTreeNode, Project } from '@/shared/types';

/**
 * [local] Reopening the Files tab asks the server whether the remembered tree
 * changed (If-None-Match with the ETag it came with) instead of downloading it
 * again. On 304 the tree on screen stays; folders loaded on demand are asked
 * again with their own ETag.
 */

const ROOT = '/work/project';
const VENDOR = `${ROOT}/vendor`;

const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFiles(...args),
    getWorkspaceRoots: vi.fn(),
  },
}));

await import('@/modules/i18n');
const { default: FileTree } = await import('@/modules/file-tree/FileTree');
const {
  clearFileTreeCache,
  markLoadedDirectoriesStale,
  mergeRefreshedTree,
  readFileTreeCache,
} = await import('@/modules/file-tree/utils/fileTreeStateCache');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT, path: ROOT };

const file = (name: string, dir = ROOT): FileTreeNode => ({ type: 'file', name, path: `${dir}/${name}` });

/** A tiny server: each listing has a version, and its ETag changes with it. */
type Listing = { nodes: FileTreeNode[]; version: number };
let listings: Record<string, Listing>;
let requests: Array<{ path: string; ifNoneMatch: string | undefined }>;

const etagOf = (path: string) => `W/"${path}-${listings[path].version}"`;

function respond(path: string, ifNoneMatch: string | undefined) {
  const etag = etagOf(path);
  const headers = new Headers({ ETag: etag });
  if (ifNoneMatch === etag) {
    return { ok: false, status: 304, headers, json: async () => { throw new Error('no body'); }, text: async () => '' };
  }
  const body = listings[path].nodes;
  return { ok: true, status: 200, headers, json: async () => body, text: async () => JSON.stringify(body) };
}

function change(path: string, nodes: FileTreeNode[]) {
  listings[path] = { nodes, version: listings[path].version + 1 };
}

beforeEach(() => {
  localStorage.clear();
  requests = [];
  listings = {
    [ROOT]: {
      version: 1,
      nodes: [
        { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [file('index.ts', `${ROOT}/src`)] },
        // Cut off by the server's entry budget: listed on demand when opened.
        { type: 'directory', name: 'vendor', path: VENDOR, incomplete: true },
        file('notes.md'),
      ],
    },
    [VENDOR]: { version: 1, nodes: [file('lib.js', VENDOR)] },
  };
  getFiles.mockImplementation(async (
    _projectId: string,
    options: { headers?: Record<string, string> } | undefined,
    directoryPath?: string,
  ) => {
    const path = directoryPath ?? ROOT;
    const ifNoneMatch = options?.headers?.['If-None-Match'];
    requests.push({ path, ifNoneMatch });
    return respond(path, ifNoneMatch);
  });
});

afterEach(() => {
  clearFileTreeCache();
  getFiles.mockReset();
  localStorage.clear();
});

const rootRequests = () => requests.filter((request) => request.path === ROOT);
const vendorRequests = () => requests.filter((request) => request.path === VENDOR);

test('a reopen sends the ETag and keeps the tree on 304', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  assert.equal(rootRequests()[0].ifNoneMatch, undefined);
  assert.equal(readFileTreeCache('p1')?.etag, etagOf(ROOT));
  const filesBefore = readFileTreeCache('p1')?.files;
  first.unmount();

  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(rootRequests().length, 2));
  assert.equal(rootRequests()[1].ifNoneMatch, etagOf(ROOT));
  // The background refresh has settled (the refresh icon stops spinning).
  await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Refresh' }).querySelector('.animate-spin'), null));
  // Untouched: the very same tree object, nothing re-rendered from a download.
  assert.equal(readFileTreeCache('p1')?.files, filesBefore);
  assert.ok(screen.getByText('notes.md'));
});

test('a changed tree is downloaded and its new ETag remembered', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  first.unmount();

  change(ROOT, [...listings[ROOT].nodes, file('added.txt')]);
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('added.txt')));
  assert.equal(rootRequests()[1].ifNoneMatch, 'W/"/work/project-1"');
  assert.equal(readFileTreeCache('p1')?.etag, 'W/"/work/project-2"');
});

test('after a 304 an open folder loaded on demand is asked again with its own ETag', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('vendor')));
  fireEvent.click(screen.getByText('vendor'));
  await waitFor(() => assert.ok(screen.getByText('lib.js')));
  assert.equal(vendorRequests()[0].ifNoneMatch, undefined);
  first.unmount();

  // Unchanged root, unchanged vendor: two cheap 304s, children stay.
  const second = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(vendorRequests().length, 2));
  assert.equal(rootRequests()[1].ifNoneMatch, etagOf(ROOT));
  assert.equal(vendorRequests()[1].ifNoneMatch, etagOf(VENDOR));
  assert.ok(screen.getByText('lib.js'));
  second.unmount();

  // The root listing does not cover vendor's contents: a change there alone
  // still shows up although the root answers 304.
  change(VENDOR, [file('lib.js', VENDOR), file('extra.js', VENDOR)]);
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('extra.js')));
  assert.equal(rootRequests().length, 3);
  assert.equal(rootRequests()[2].ifNoneMatch, etagOf(ROOT));
  assert.equal(vendorRequests()[2].ifNoneMatch, 'W/"/work/project/vendor-1"');
});

test('a failed refresh forgets the ETag with the tree', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  first.unmount();

  vi.spyOn(console, 'error').mockImplementation(() => {});
  getFiles.mockImplementation(async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => '{"error":"boom"}' }));
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('boom')));
  assert.equal(readFileTreeCache('p1')?.files, undefined);
  assert.equal(readFileTreeCache('p1')?.etag, undefined);
});

test('markLoadedDirectoriesStale flags only folders loaded on demand, keeping their children', () => {
  const lib = file('lib.js', VENDOR);
  const nested: FileTreeNode = { type: 'directory', name: 'deep', path: `${VENDOR}/deep`, children: [], listingEtag: 'd1' };
  const tree: FileTreeNode[] = [
    { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [file('index.ts', `${ROOT}/src`)] },
    { type: 'directory', name: 'vendor', path: VENDOR, children: [lib, nested], listingEtag: 'v1' },
    file('notes.md'),
  ];
  const stale = markLoadedDirectoriesStale(tree);
  assert.equal(stale[0], tree[0]);
  assert.equal(stale[2], tree[2]);
  assert.equal(stale[1].incomplete, true);
  assert.equal(stale[1].listingEtag, 'v1');
  assert.equal(stale[1].children?.[0], lib);
  assert.equal(stale[1].children?.[1].incomplete, true);
  // Nothing loaded on demand: the same tree comes back.
  const plain = [tree[0], tree[2]];
  assert.equal(markLoadedDirectoriesStale(plain), plain);
});

test('mergeRefreshedTree keeps the ETag of children it keeps', () => {
  const previous: FileTreeNode[] = [
    { type: 'directory', name: 'vendor', path: VENDOR, children: [file('lib.js', VENDOR)], listingEtag: 'v1' },
  ];
  const next: FileTreeNode[] = [{ type: 'directory', name: 'vendor', path: VENDOR, incomplete: true }];
  const merged = mergeRefreshedTree(previous, next);
  assert.equal(merged[0].listingEtag, 'v1');
  assert.equal(merged[0].children, previous[0].children);
  // Children supplied by the new listing do not inherit an ETag.
  const complete: FileTreeNode[] = [{ type: 'directory', name: 'vendor', path: VENDOR, children: [] }];
  assert.equal(mergeRefreshedTree(previous, complete)[0].listingEtag, undefined);
});
