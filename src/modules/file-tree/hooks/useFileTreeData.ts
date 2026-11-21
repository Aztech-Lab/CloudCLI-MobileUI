import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';
import type { WorkspaceRootScope } from '@/modules/file-tree/hooks/useWorkspaceRoots';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  /** [local] Set instead of a raw message when the listed folder no longer exists. */
  missingFolder: string | null;
  refreshFiles: () => void;
  /** [local] Directories whose contents are being fetched on demand. */
  loadingDirs: Set<string>;
  /** [local] Fetch one directory flagged `incomplete` and splice it into the tree. */
  loadDirectory: (directoryPath: string) => Promise<void>;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

/** [local] The folder a "folder not found" refusal names, so the message can be translated. */
function readMissingFolderPath(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as { code?: unknown; path?: unknown };
    return parsedBody.code === 'PROJECT_PATH_NOT_FOUND' && typeof parsedBody.path === 'string'
      ? parsedBody.path
      : null;
  } catch {
    return null;
  }
}

// [local] Replace the children of the node at `directoryPath` (or, with `children`
// undefined, keep them and just clear `incomplete`), returning a new tree.
function replaceDirectoryChildren(
  nodes: FileTreeNode[],
  directoryPath: string,
  children: FileTreeNode[] | undefined,
): FileTreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type !== 'directory') return node;
    if (node.path === directoryPath) {
      changed = true;
      return { ...node, children: children ?? node.children, incomplete: false };
    }
    if (node.children && directoryPath.startsWith(node.path)) {
      const updated = replaceDirectoryChildren(node.children, directoryPath, children);
      if (updated !== node.children) {
        changed = true;
        return { ...node, children: updated };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

export function useFileTreeData(
  selectedProject: Project | null,
  // [local] Another workspace root of the session; null lists the project folder as before.
  rootScope: WorkspaceRootScope | null = null,
): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingFolder, setMissingFolder] = useState<string | null>(null);
  const scopeSessionId = rootScope?.sessionId ?? null;
  const scopeRoot = rootScope?.root ?? 0;
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  const projectId = selectedProject?.projectId;

  const loadDirectory = useCallback(async (directoryPath: string) => {
    if (!projectId) return;
    setLoadingDirs((previous) => new Set(previous).add(directoryPath));
    let children: FileTreeNode[] | undefined;
    try {
      const response = await api.getFiles(
        projectId,
        {},
        directoryPath,
        scopeSessionId && scopeRoot > 0 ? { sessionId: scopeSessionId, root: scopeRoot } : null,
        true, // [local] gitignored entries come back flagged; the toolbar toggle hides them client-side
      );
      if (response.ok) {
        children = (await response.json()) as FileTreeNode[];
      } else {
        console.error('Directory fetch failed:', response.status, await response.text());
      }
    } catch (loadError) {
      console.error('Error fetching directory:', loadError);
    } finally {
      // Clear `incomplete` even on failure so the expand effect does not retry in a loop.
      setFiles((previous) => replaceDirectoryChildren(previous, directoryPath, children));
      setLoadingDirs((previous) => {
        const next = new Set(previous);
        next.delete(directoryPath);
        return next;
      });
    }
  }, [projectId, scopeSessionId, scopeRoot]);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      setMissingFolder(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
        setMissingFolder(null);
      }
      try {
        const response = await api.getFiles(
          projectId,
          { signal: abortControllerRef.current!.signal },
          undefined,
          scopeSessionId && scopeRoot > 0 ? { sessionId: scopeSessionId, root: scopeRoot } : null,
          true, // [local] see loadDirectory
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
            setMissingFolder(readMissingFolderPath(errorText));
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [projectId, refreshKey, scopeSessionId, scopeRoot]);

  return {
    files,
    loading,
    error,
    missingFolder,
    refreshFiles,
    loadingDirs,
    loadDirectory,
  };
}
