import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { FileTreeNode, Project } from '@/shared/types';

/**
 * [local] The Files tab lists gitignored entries too, dimmed, so it matches
 * the folder on disk. A toolbar toggle (remembered per device) hides them, and
 * search only finds them while they are shown.
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
const { withoutIgnoredEntries } = await import('@/modules/file-tree/utils/fileTreeUtils');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT, path: ROOT };

const tree: FileTreeNode[] = [
  { type: 'directory', name: 'dist', path: `${ROOT}/dist`, ignored: true, incomplete: true },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [
      { type: 'file', name: 'index.ts', path: `${ROOT}/src/index.ts` },
      { type: 'file', name: 'generated.ts', path: `${ROOT}/src/generated.ts`, ignored: true },
    ],
  },
  { type: 'file', name: 'debug.log', path: `${ROOT}/debug.log`, ignored: true },
  { type: 'file', name: 'notes.md', path: `${ROOT}/notes.md` },
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
const row = (name: string) => screen.getByText(name).closest('[class*="cursor-pointer"]') as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  getFiles.mockImplementation(async () => jsonResponse(tree));
});

afterEach(() => {
  getFiles.mockReset();
  localStorage.clear();
});

test('ignored entries are requested and rendered dimmed by default', async () => {
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('debug.log')));
  assert.equal(getFiles.mock.calls[0]?.[4], true);
  assert.match(row('debug.log').className, /opacity-50/);
  assert.match(row('dist').className, /opacity-50/);
  assert.doesNotMatch(row('notes.md').className, /opacity-50/);
  assert.equal(screen.getByTestId('file-tree-show-ignored').getAttribute('aria-pressed'), 'true');
  assert.equal(screen.getByTestId('file-tree-show-ignored').getAttribute('aria-label'), 'Show ignored files');
});

test('the toggle hides ignored entries and is remembered', async () => {
  const { unmount } = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('debug.log')));

  fireEvent.click(screen.getByTestId('file-tree-show-ignored'));

  assert.equal(screen.queryByText('debug.log'), null);
  assert.equal(screen.queryByText('dist'), null);
  assert.ok(screen.getByText('notes.md'));
  assert.equal(screen.getByTestId('file-tree-show-ignored').getAttribute('aria-pressed'), 'false');
  assert.equal(localStorage.getItem('file-tree-show-ignored'), 'false');
  unmount();

  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('notes.md')));
  assert.equal(screen.queryByText('debug.log'), null);
});

test('search finds ignored entries only while they are shown', async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('debug.log')));

  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'generated' } });
  await waitFor(() => assert.ok(screen.getByText('generated.ts')));

  fireEvent.click(screen.getByTestId('file-tree-show-ignored'));
  await waitFor(() => assert.equal(screen.queryByText('generated.ts'), null));
  assert.ok(screen.getByText(/No matches/i));
});

test('withoutIgnoredEntries drops ignored nodes at every level', () => {
  const visible = withoutIgnoredEntries(tree);
  assert.deepEqual(visible.map((node) => node.name), ['src', 'notes.md']);
  assert.deepEqual(visible[0]?.children?.map((node) => node.name), ['index.ts']);
});
