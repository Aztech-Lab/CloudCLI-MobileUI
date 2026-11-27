import { useCallback } from 'react';

import { useFileTreeCachedState } from '@/modules/file-tree/hooks/useFileTreeCachedState';

type UseExpandedDirectoriesResult = {
  expandedDirs: Set<string>;
  toggleDirectory: (path: string) => void;
  expandDirectories: (paths: string[]) => void;
  collapseAll: () => void;
};

// [local] Stable stand-in while nothing is expanded yet.
const NONE_EXPANDED: Set<string> = new Set();

// [local] Kept in the Files tab state cache under `cacheKey`, so opened folders stay open
// when the tab is left and reopened.
export function useExpandedDirectories(cacheKey: string | null): UseExpandedDirectoriesResult {
  const [expandedDirs, setExpandedDirs] = useFileTreeCachedState(cacheKey, 'expandedDirs', NONE_EXPANDED);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirs((previous) => {
      const next = new Set(previous);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }, [setExpandedDirs]);

  const expandDirectories = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return;
    }

    setExpandedDirs((previous) => {
      const next = new Set(previous);
      paths.forEach((path) => next.add(path));
      return next;
    });
  }, [setExpandedDirs]);

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set());
  }, [setExpandedDirs]);

  return {
    expandedDirs,
    toggleDirectory,
    expandDirectories,
    collapseAll,
  };
}

