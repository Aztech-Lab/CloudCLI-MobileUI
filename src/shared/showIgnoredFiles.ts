import { useCallback, useSyncExternalStore } from 'react';

// [local] Whether the Files tab shows gitignored entries (dimmed). Remembered per device,
// under the same localStorage key as before. One shared value: the file-tree header button and Settings > MobileUI > Files both
// change it, and every mounted user follows (same tab via an event, other tabs via the
// storage event).
const SHOW_IGNORED_FILES_STORAGE_KEY = 'file-tree-show-ignored';
const SHOW_IGNORED_FILES_CHANGED_EVENT = 'file-tree-show-ignored:changed';

// Only used when localStorage cannot be written (private mode, full quota), so the
// choice still holds for this page load.
let unsavedShowIgnored: boolean | null = null;

function getShowIgnored(): boolean {
  try {
    const stored = localStorage.getItem(SHOW_IGNORED_FILES_STORAGE_KEY);
    if (stored !== null) return stored !== 'false';
  } catch {
    // Fall through to the unsaved value.
  }
  return unsavedShowIgnored ?? true;
}

/** Changes the setting for this device; used by the header button and by Settings. */
export function setShowIgnoredFiles(next: boolean): void {
  try {
    localStorage.setItem(SHOW_IGNORED_FILES_STORAGE_KEY, String(next));
    unsavedShowIgnored = null;
  } catch {
    // Keep the runtime state even when persistence fails.
    unsavedShowIgnored = next;
  }
  window.dispatchEvent(new Event(SHOW_IGNORED_FILES_CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SHOW_IGNORED_FILES_STORAGE_KEY) onChange();
  };
  window.addEventListener(SHOW_IGNORED_FILES_CHANGED_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SHOW_IGNORED_FILES_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useShowIgnoredFiles(): {
  showIgnored: boolean;
  toggleShowIgnored: () => void;
  setShowIgnored: (next: boolean) => void;
} {
  const showIgnored = useSyncExternalStore(subscribe, getShowIgnored, () => true);
  const toggleShowIgnored = useCallback(() => setShowIgnoredFiles(!getShowIgnored()), []);
  return { showIgnored, toggleShowIgnored, setShowIgnored: setShowIgnoredFiles };
}
