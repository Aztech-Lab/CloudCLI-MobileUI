import { useCallback, useState } from 'react';

// [local] Whether the Files tab shows gitignored entries (dimmed). Remembered per device.
const SHOW_IGNORED_FILES_STORAGE_KEY = 'file-tree-show-ignored';

function readStoredShowIgnored(): boolean {
  try {
    return localStorage.getItem(SHOW_IGNORED_FILES_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useShowIgnoredFiles(): { showIgnored: boolean; toggleShowIgnored: () => void } {
  const [showIgnored, setShowIgnored] = useState<boolean>(readStoredShowIgnored);

  const toggleShowIgnored = useCallback(() => {
    setShowIgnored((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(SHOW_IGNORED_FILES_STORAGE_KEY, String(next));
      } catch {
        // Keep the runtime state even when persistence fails.
      }
      return next;
    });
  }, []);

  return { showIgnored, toggleShowIgnored };
}
