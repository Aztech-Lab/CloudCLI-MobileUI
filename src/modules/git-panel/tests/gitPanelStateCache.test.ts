import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { GitPanelView, GitStatusResponse, Project } from '@/shared/types';

/**
 * [local] The Source Control tab unmounts whenever another tab opens. Coming
 * back starts from what the tab showed last time (no spinner) and refreshes it
 * in the background.
 */

let statusResponse: GitStatusResponse;
let releaseStatus: () => void = () => {};
const statusCalls = vi.fn();

const json = (body: unknown) => ({ json: async () => body });

vi.mock('@/shared/api', () => ({
  api: {
    git: {
      status: () => {
        statusCalls();
        const body = statusResponse;
        return new Promise((resolve) => {
          releaseStatus = () => resolve(json(body));
        });
      },
      diff: async (_projectId: string, filePath: string) => json({ diff: `diff of ${filePath}` }),
      branches: async () => json({ branches: ['main', 'feature'], localBranches: ['main', 'feature'], remoteBranches: [], remoteRefs: [] }),
      remoteStatus: async () => json({ hasRemote: false }),
      commits: async () => json({ commits: [] }),
    },
  },
}));

const { useGitPanelController } = await import('@/modules/git-panel/hooks/useGitPanelController');
const { clearGitPanelSnapshots, readGitPanelSnapshot } = await import('@/modules/git-panel/utils/gitPanelStateCache');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: '/work/project', path: '/work/project' };
const status = (modified: string[]): GitStatusResponse => ({ branch: 'main', hasCommits: true, modified, added: [], deleted: [], untracked: [] });

const renderController = (selectedProject: Project = project, activeView: GitPanelView = 'changes') =>
  renderHook(() => useGitPanelController({ selectedProject, activeView }));

beforeEach(() => {
  statusResponse = status(['a.ts']);
  statusCalls.mockClear();
});

afterEach(() => {
  clearGitPanelSnapshots();
});

test('the first visit loads with the spinner; a return shows the last state at once and refreshes quietly', async () => {
  const first = renderController();
  await waitFor(() => assert.equal(first.result.current.isLoading, true));
  releaseStatus();
  await waitFor(() => assert.equal(first.result.current.gitDiff['a.ts'], 'diff of a.ts'));
  await waitFor(() => assert.deepEqual(first.result.current.localBranches, ['main', 'feature']));
  first.unmount();

  statusResponse = status(['a.ts', 'b.ts']);
  const second = renderController();
  // From memory, before any response.
  assert.deepEqual(second.result.current.gitStatus?.modified, ['a.ts']);
  assert.equal(second.result.current.gitDiff['a.ts'], 'diff of a.ts');
  assert.equal(second.result.current.currentBranch, 'main');
  assert.deepEqual(second.result.current.localBranches, ['main', 'feature']);
  await waitFor(() => assert.equal(statusCalls.mock.calls.length, 2));
  assert.equal(second.result.current.isLoading, false);

  releaseStatus();
  await waitFor(() => assert.deepEqual(second.result.current.gitStatus?.modified, ['a.ts', 'b.ts']));
  await waitFor(() => assert.equal(second.result.current.gitDiff['b.ts'], 'diff of b.ts'));
});

test('each project starts from its own state', async () => {
  const first = renderController();
  releaseStatus();
  await waitFor(() => assert.ok(readGitPanelSnapshot('p1')?.gitStatus));
  first.unmount();

  const other: Project = { ...project, projectId: 'p2' };
  const second = renderController(other);
  assert.equal(second.result.current.gitStatus, null);
  await waitFor(() => assert.equal(second.result.current.isLoading, true));
  releaseStatus();
  await waitFor(() => assert.ok(readGitPanelSnapshot('p2')?.gitStatus));
  assert.deepEqual(readGitPanelSnapshot('p1')?.gitStatus?.modified, ['a.ts']);
});

test('switching projects while open never files one project under the other', async () => {
  const other: Project = { ...project, projectId: 'p2' };
  const hook = renderHook(({ selectedProject }) => useGitPanelController({ selectedProject, activeView: 'changes' }), {
    initialProps: { selectedProject: project },
  });
  releaseStatus();
  await waitFor(() => assert.ok(readGitPanelSnapshot('p1')?.gitStatus));

  statusResponse = status(['other.ts']);
  hook.rerender({ selectedProject: other });
  await waitFor(() => assert.equal(statusCalls.mock.calls.length, 2));
  assert.equal(readGitPanelSnapshot('p2')?.gitStatus ?? null, null);
  releaseStatus();
  await waitFor(() => assert.deepEqual(readGitPanelSnapshot('p2')?.gitStatus?.modified, ['other.ts']));
  assert.deepEqual(readGitPanelSnapshot('p1')?.gitStatus?.modified, ['a.ts']);
});
