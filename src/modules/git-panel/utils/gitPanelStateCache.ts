import type { GitCommitSummary, GitDiffMap, GitPanelView, GitRemoteStatus, GitStatusResponse } from '@/shared/types';

/**
 * [local] What the Source Control tab last showed for a project. The tab
 * unmounts whenever another tab opens, so without this every return showed a
 * spinner while status, diffs, branches and remote status were fetched again.
 * The tab now starts from this snapshot and refreshes it in the background.
 */
export type GitPanelSnapshot = {
  gitStatus: GitStatusResponse | null;
  gitDiff: GitDiffMap;
  currentBranch: string;
  branches: string[];
  localBranches: string[];
  remoteBranches: string[];
  remoteRefs: string[];
  remoteStatus: GitRemoteStatus | null;
  recentCommits: GitCommitSummary[];
  hasLoadedCommits: boolean;
};

/** Only the last few projects are kept; diffs of many changed files add up. */
export const GIT_PANEL_CACHE_LIMIT = 4;

// Insertion order is use order: the first key is the least recently used.
const snapshots = new Map<string, GitPanelSnapshot>();

export function readGitPanelSnapshot(projectId: string | null | undefined): GitPanelSnapshot | undefined {
  return projectId ? snapshots.get(projectId) : undefined;
}

export function writeGitPanelSnapshot(projectId: string, snapshot: GitPanelSnapshot): void {
  snapshots.delete(projectId);
  snapshots.set(projectId, snapshot);
  while (snapshots.size > GIT_PANEL_CACHE_LIMIT) {
    snapshots.delete(snapshots.keys().next().value as string);
  }
}

export function clearGitPanelSnapshots(): void {
  snapshots.clear();
  scrollPositions.clear();
  lastView = 'changes';
}

// The sub-view (Changes, History, ...) the tab was left on.
let lastView: GitPanelView = 'changes';

export function readLastGitPanelView(): GitPanelView {
  return lastView;
}

export function rememberGitPanelView(view: GitPanelView): void {
  lastView = view;
}

// How far each sub-view was scrolled, per project (`<projectId>:<view>`), like the
// Files tab remembers its scroll position.
const scrollPositions = new Map<string, number>();

export function readGitPanelScroll(key: string): number {
  return scrollPositions.get(key) ?? 0;
}

export function rememberGitPanelScroll(key: string, scrollTop: number): void {
  scrollPositions.delete(key);
  scrollPositions.set(key, scrollTop);
  // A handful of projects times five views is plenty.
  while (scrollPositions.size > GIT_PANEL_CACHE_LIMIT * 5) {
    scrollPositions.delete(scrollPositions.keys().next().value as string);
  }
}
