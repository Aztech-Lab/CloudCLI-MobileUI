import type { FileTreeNode } from '@/shared/types';

/**
 * [local] What the Files tab showed for one project folder (or one workspace
 * root of a session). The tab unmounts whenever another tab is opened, so
 * without this every return to Files fetched the whole tree again behind a
 * spinner and forgot the opened folders, the search and the scroll position.
 * The tab now shows the remembered state at once and refreshes it quietly.
 */
export type FileTreeCacheEntry = {
  /** The last tree, including folders loaded on demand. Unset: never loaded. */
  files?: FileTreeNode[];
  expandedDirs?: Set<string>;
  searchQuery?: string;
  scrollTop?: number;
};

/** Trees can hold tens of thousands of entries, so only the last few are kept. */
export const FILE_TREE_CACHE_LIMIT = 4;

// Map iteration order is insertion order: the first key is the least recently used.
const entries = new Map<string, FileTreeCacheEntry>();
const listeners = new Set<() => void>();

/** The cache key, or null when there is no project to list. */
export function fileTreeCacheKey(
  projectId: string | null | undefined,
  scopeSessionId: string | null,
  scopeRoot: number,
): string | null {
  if (!projectId) return null;
  return scopeSessionId && scopeRoot > 0 ? `${projectId}|${scopeSessionId}|${scopeRoot}` : projectId;
}

export function readFileTreeCache(key: string | null): FileTreeCacheEntry | undefined {
  return key ? entries.get(key) : undefined;
}

/**
 * Merge `patch` into the entry and mark it most recently used. `notify: false`
 * skips re-rendering subscribers, for values nobody renders (scroll position).
 */
export function writeFileTreeCache(key: string, patch: FileTreeCacheEntry, notify = true): void {
  const entry = { ...entries.get(key), ...patch };
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > FILE_TREE_CACHE_LIMIT) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
  if (notify) listeners.forEach((listener) => listener());
}

/** Forget every remembered tree whose key belongs to `projectId`, or all of them. */
export function clearFileTreeCache(projectId?: string): void {
  for (const key of [...entries.keys()]) {
    if (projectId === undefined || key === projectId || key.startsWith(`${projectId}|`)) {
      entries.delete(key);
    }
  }
  listeners.forEach((listener) => listener());
}

export function subscribeFileTreeCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Combine a freshly fetched tree with the one on screen. The fresh tree decides
 * which entries exist; a folder the server left `incomplete` keeps the children
 * loaded on demand earlier, so opened folders do not collapse to "Loading…".
 * It stays flagged `incomplete`, so an open folder is fetched again quietly and
 * a closed one when it is next opened.
 */
export function mergeRefreshedTree(previous: FileTreeNode[], next: FileTreeNode[]): FileTreeNode[] {
  if (previous.length === 0) return next;
  const previousByPath = new Map<string, FileTreeNode>();
  for (const node of previous) {
    if (node.type === 'directory' && node.children) previousByPath.set(node.path, node);
  }
  if (previousByPath.size === 0) return next;

  let changed = false;
  const merged = next.map((node) => {
    if (node.type !== 'directory') return node;
    const earlier = previousByPath.get(node.path);
    if (!earlier?.children) return node;
    if (node.incomplete && !node.children) {
      changed = true;
      return { ...node, children: earlier.children };
    }
    if (node.children) {
      const children = mergeRefreshedTree(earlier.children, node.children);
      if (children === node.children) return node;
      changed = true;
      return { ...node, children };
    }
    return node;
  });
  return changed ? merged : next;
}
