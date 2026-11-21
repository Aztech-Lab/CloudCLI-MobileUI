import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * [local] A Codex conversation from a multi-root Codex project gets a root
 * switcher in the Files tab. Every other session looks exactly as before and
 * never asks for roots; the switch is sent as a root index, never a path.
 */

const ROOT = '/work/project';
const EXTRA = '/data/extra';

const getFiles = vi.fn();
const getWorkspaceRoots = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFiles(...args),
    getWorkspaceRoots: (...args: unknown[]) => getWorkspaceRoots(...args),
  },
}));

// Real English strings, so the wording is what is checked.
await import('@/modules/i18n');
const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT, path: ROOT };
const codexSession: ProjectSession = { id: 's-codex', provider: 'codex' };
const claudeSession: ProjectSession = { id: 's-claude', provider: 'claude' };

const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, _subPath?: string, scope?: { root: number } | null) =>
    jsonResponse(scope?.root === 1
      ? [{ type: 'file', name: 'table.csv', path: `${EXTRA}/table.csv` }]
      : [{ type: 'file', name: 'main.py', path: `${ROOT}/main.py` }]));
});

afterEach(() => {
  getFiles.mockReset();
  getWorkspaceRoots.mockReset();
});

test('a Codex session with extra roots shows the switcher and lists the chosen root by index', async () => {
  getWorkspaceRoots.mockResolvedValue(jsonResponse({
    roots: [
      { index: 0, name: 'project', path: ROOT, exists: true },
      { index: 1, name: 'extra', path: EXTRA, exists: true },
    ],
  }));

  render(<FileTree selectedProject={project} selectedSession={codexSession} />);

  await waitFor(() => assert.ok(screen.getByText('main.py')));
  const switcher = await screen.findByTestId('file-tree-root-switcher');
  assert.equal(getWorkspaceRoots.mock.calls[0]?.[1], 's-codex');

  fireEvent.click(switcher.querySelector('button') as HTMLButtonElement);
  fireEvent.click(await screen.findByTitle(EXTRA));

  await waitFor(() => assert.ok(screen.getByText('table.csv')));
  const scoped = getFiles.mock.calls.find((call) => call[3]);
  assert.deepEqual(scoped?.[3], { sessionId: 's-codex', root: 1 });
  // No call ever carries a folder path as the root.
  for (const call of getFiles.mock.calls) {
    assert.ok(!JSON.stringify(call[3] ?? null).includes(EXTRA));
  }
});

test('a Codex session without extra roots shows no switcher', async () => {
  getWorkspaceRoots.mockResolvedValue(jsonResponse({ roots: [{ index: 0, name: 'project', path: ROOT, exists: true }] }));

  render(<FileTree selectedProject={project} selectedSession={codexSession} />);

  await waitFor(() => assert.ok(screen.getByText('main.py')));
  await waitFor(() => assert.equal(getWorkspaceRoots.mock.calls.length, 1));
  assert.equal(screen.queryByTestId('file-tree-root-switcher'), null);
});

test('a Claude session never asks for roots and shows no switcher', async () => {
  render(<FileTree selectedProject={project} selectedSession={claudeSession} />);

  await waitFor(() => assert.ok(screen.getByText('main.py')));
  assert.equal(getWorkspaceRoots.mock.calls.length, 0);
  assert.equal(screen.queryByTestId('file-tree-root-switcher'), null);
  assert.equal(getFiles.mock.calls[0]?.[3] ?? null, null);
});

test('a missing folder is named instead of a generic error', async () => {
  getFiles.mockImplementation(async () => jsonResponse(
    { error: 'Folder not found: /gone', code: 'PROJECT_PATH_NOT_FOUND', path: '/gone' },
    false,
  ));

  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText(/\/gone/)));
  assert.ok(screen.getByText(/Folder not found/));
});
