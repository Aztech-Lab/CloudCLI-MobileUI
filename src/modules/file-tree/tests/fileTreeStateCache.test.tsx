import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type { FileTreeNode, Project } from '@/shared/types';

/**
 * [local] The Files tab unmounts whenever another tab opens. Coming back must
 * show the tree exactly as it was left (opened folders, folders loaded on
 * demand, search, scroll position) without the loading screen, and still pick
 * up changes from a quiet background refresh.
 */

const ROOT = '/work/project';

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
  FILE_TREE_CACHE_LIMIT,
  clearFileTreeCache,
  mergeRefreshedTree,
  readFileTreeCache,
  writeFileTreeCache,
} = await import('@/modules/file-tree/utils/fileTreeStateCache');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT, path: ROOT };

const file = (name: string, dir = ROOT): FileTreeNode => ({ type: 'file', name, path: `${dir}/${name}` });

const tree = (...extra: FileTreeNode[]): FileTreeNode[] => [
  { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [file('index.ts', `${ROOT}/src`)] },
  // Cut off by the server's entry budget: listed on demand when opened.
  { type: 'directory', name: 'vendor', path: `${ROOT}/vendor`, incomplete: true },
  file('notes.md'),
  ...extra,
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });

let rootListing: FileTreeNode[];
let vendorListing: FileTreeNode[];

// jsdom keeps no scroll position; give elements a writable one.
const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return (this as { _scrollTop?: number })._scrollTop ?? 0; },
    set(value: number) { (this as { _scrollTop?: number })._scrollTop = value; },
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  if (scrollTopDescriptor) Object.defineProperty(Element.prototype, 'scrollTop', scrollTopDescriptor);
});

beforeEach(() => {
  localStorage.clear();
  rootListing = tree();
  vendorListing = [file('lib.js', `${ROOT}/vendor`)];
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, directoryPath?: string) =>
    jsonResponse(directoryPath === `${ROOT}/vendor` ? vendorListing : rootListing));
});

afterEach(() => {
  clearFileTreeCache();
  getFiles.mockReset();
  localStorage.clear();
});

const rootFetches = () => getFiles.mock.calls.filter((call) => call[2] === undefined).length;
const vendorFetches = () => getFiles.mock.calls.filter((call) => call[2] === `${ROOT}/vendor`).length;

test('the first visit shows the loading screen; a return shows the remembered tree at once', async () => {
  const first = render(<FileTree selectedProject={project} />);
  assert.ok(screen.getByText('Loading files...'));
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  first.unmount();

  render(<FileTree selectedProject={project} />);
  // Synchronously, before any response: no loading screen, same entries.
  assert.ok(!screen.queryByText('Loading files...'));
  assert.ok(screen.getByText('notes.md'));
  // ...and still refreshed in the background.
  await waitFor(() => assert.equal(rootFetches(), 2));
});

test('the background refresh picks up new and removed entries', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  first.unmount();

  rootListing = tree(file('added.txt')).filter((node) => node.name !== 'notes.md');
  render(<FileTree selectedProject={project} />);
  assert.ok(screen.getByText('notes.md'));
  await waitFor(() => assert.ok(screen.getByText('added.txt')));
  assert.ok(!screen.queryByText('notes.md'));
});

test('opened folders, folders loaded on demand and the search come back', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('src')));
  fireEvent.click(screen.getByText('src'));
  fireEvent.click(screen.getByText('vendor'));
  await waitFor(() => assert.ok(screen.getByText('lib.js')));
  assert.ok(screen.getByText('index.ts'));
  first.unmount();

  vendorListing = [file('lib.js', `${ROOT}/vendor`), file('extra.js', `${ROOT}/vendor`)];
  const second = render(<FileTree selectedProject={project} />);
  assert.ok(screen.getByText('index.ts'));
  assert.ok(screen.getByText('lib.js'));
  // The open folder loaded on demand is listed again quietly after the refresh.
  await waitFor(() => assert.ok(screen.getByText('extra.js')));
  assert.equal(vendorFetches(), 2);

  fireEvent.change(screen.getByPlaceholderText('Search files and folders...'), { target: { value: 'lib' } });
  second.unmount();

  render(<FileTree selectedProject={project} />);
  assert.equal((screen.getByPlaceholderText('Search files and folders...') as HTMLInputElement).value, 'lib');
  assert.ok(screen.getByText('lib.js'));
  assert.ok(!screen.queryByText('notes.md'));
});

test('the scroll position comes back', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  const scroller = screen.getByText('notes.md').closest('.overflow-auto') as HTMLElement;
  scroller.scrollTop = 240;
  fireEvent.scroll(scroller);
  first.unmount();

  render(<FileTree selectedProject={project} />);
  const restored = screen.getByText('notes.md').closest('.overflow-auto') as HTMLElement;
  assert.notEqual(restored, scroller);
  assert.equal(restored.scrollTop, 240);
});

test('the refresh button refreshes quietly and keeps opened folders', async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('src')));
  fireEvent.click(screen.getByText('src'));

  rootListing = tree(file('fresh.md'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  assert.ok(!screen.queryByText('Loading files...'));
  await waitFor(() => assert.ok(screen.getByText('fresh.md')));
  assert.ok(screen.getByText('index.ts'));
});

test('a failed refresh forgets the remembered tree', async () => {
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  first.unmount();

  vi.spyOn(console, 'error').mockImplementation(() => {});
  getFiles.mockImplementation(async () => ({ ok: false, status: 500, text: async () => '{"error":"boom"}' }));
  const second = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('boom')));
  assert.equal(readFileTreeCache('p1')?.files, undefined);
  second.unmount();

  render(<FileTree selectedProject={project} />);
  assert.ok(screen.getByText('Loading files...'));
  await waitFor(() => assert.ok(!screen.queryByText('Loading files...')));
});

test('each project keeps its own tree', async () => {
  const other: Project = { projectId: 'p2', displayName: 'other', fullPath: '/work/other', path: '/work/other' };
  const first = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  first.unmount();

  rootListing = [file('other.md', '/work/other')];
  render(<FileTree selectedProject={other} />);
  assert.ok(screen.getByText('Loading files...'));
  await waitFor(() => assert.ok(screen.getByText('other.md')));
  assert.ok(!screen.queryByText('notes.md'));
});

test('only the most recently used trees are kept', () => {
  act(() => {
    for (let index = 0; index <= FILE_TREE_CACHE_LIMIT; index += 1) {
      writeFileTreeCache(`project-${index}`, { files: [] });
    }
  });
  assert.equal(readFileTreeCache('project-0'), undefined);
  assert.ok(readFileTreeCache(`project-${FILE_TREE_CACHE_LIMIT}`));
});

test('merging a refreshed tree keeps folders loaded on demand, flagged for a quiet reload', () => {
  const loaded = { type: 'directory', name: 'vendor', path: `${ROOT}/vendor`, incomplete: false, children: [file('lib.js', `${ROOT}/vendor`)] } as FileTreeNode;
  const previous = [loaded, file('gone.md')];
  const fresh = tree();
  const merged = mergeRefreshedTree(previous, fresh);

  const vendor = merged.find((node) => node.name === 'vendor');
  assert.deepEqual(vendor?.children, loaded.children);
  assert.equal(vendor?.incomplete, true);
  assert.equal(merged.some((node) => node.name === 'gone.md'), false);
  // Nothing to carry over: the fresh tree is used as is.
  assert.equal(mergeRefreshedTree([file('a.md')], fresh), fresh);
});
