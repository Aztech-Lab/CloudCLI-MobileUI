import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it — relative to the project
 * root — while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet.
 */

const ROOT = '/home/odoo/workspace/personal';

const tree = [
  {
    type: 'directory',
    name: 'decisions',
    path: `${ROOT}/decisions`,
    children: [{ type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` }],
  },
];

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: async () => ({ ok: true, json: async () => tree }),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');
const { clearFileTreeCache } = await import('@/modules/file-tree/utils/fileTreeStateCache');

// The Files tab remembers opened folders across mounts; each case starts fresh.
afterEach(() => clearFileTreeCache());

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a folder nobody asked for stays closed', async () => {
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
});

test('[local] a served reveal is not repeated when the Files tab is opened again', async () => {
  const request = { path: 'decisions/' };
  const first = render(<FileTree selectedProject={project} revealDirectory={request} />);
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
  fireEvent.click(screen.getByText('decisions')); // the user folds it again
  assert.ok(!screen.queryByText('0001-first.md'));
  first.unmount();

  render(<FileTree selectedProject={project} revealDirectory={request} />);
  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.ok(!screen.queryByText('0001-first.md'));
});
