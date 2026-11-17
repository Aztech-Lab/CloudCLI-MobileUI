import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

/** [local] One folder the Files tab can show for a session (index 0 is the project folder). */
export type WorkspaceRoot = { index: number; name: string; path: string; exists: boolean };

/**
 * [local] Which root a File Tree request works in. The server resolves the
 * index against the session's recorded roots; no path is ever sent.
 */
export type WorkspaceRootScope = { sessionId: string; root: number };

type UseWorkspaceRootsResult = {
  /** Every root, project folder first. Holds one entry when there is nothing to switch to. */
  roots: WorkspaceRoot[];
  selectedRoot: number;
  selectRoot: (index: number) => void;
  /** Scope for requests, `null` while the project folder is selected (requests stay as before). */
  scope: WorkspaceRootScope | null;
};

/**
 * [local] Loads the workspace roots a Codex conversation recorded (a Codex
 * project with several folders) and keeps which one the Files tab shows.
 * Other sessions never ask the server and keep the project folder only.
 */
export function useWorkspaceRoots(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  enabled: boolean,
): UseWorkspaceRootsResult {
  // Kept with the project/session they belong to, so a switch never shows the
  // previous session's roots while the new ones load.
  const [loaded, setLoaded] = useState<{ key: string; roots: WorkspaceRoot[] }>({ key: '', roots: [] });
  const [selection, setSelection] = useState<{ key: string; root: number }>({ key: '', root: 0 });
  const key = `${projectId ?? ''}|${sessionId ?? ''}`;
  const roots = enabled && loaded.key === key ? loaded.roots : [];

  useEffect(() => {
    if (!enabled || !projectId || !sessionId) {
      return;
    }

    let active = true;
    void (async () => {
      try {
        const response = await api.getWorkspaceRoots(projectId, sessionId);
        if (!response.ok) return;
        const body = (await response.json()) as { roots?: WorkspaceRoot[] };
        if (active && Array.isArray(body.roots)) {
          setLoaded({ key: `${projectId}|${sessionId}`, roots: body.roots });
        }
      } catch {
        // No switcher: the tree keeps showing the project folder.
      }
    })();

    return () => {
      active = false;
    };
  }, [enabled, projectId, sessionId]);

  // A different session or project starts at its project folder again.
  const selectedRoot = selection.key === key && selection.root < roots.length ? selection.root : 0;
  const selectRoot = useCallback((index: number) => setSelection({ key, root: index }), [key]);

  return {
    roots,
    selectedRoot,
    selectRoot,
    scope: sessionId && selectedRoot > 0 ? { sessionId, root: selectedRoot } : null,
  };
}
