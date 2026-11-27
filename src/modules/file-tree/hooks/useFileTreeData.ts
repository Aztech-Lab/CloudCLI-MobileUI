import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';
import type { WorkspaceRootScope } from '@/modules/file-tree/hooks/useWorkspaceRoots';
import { useFileTreeCachedState } from '@/modules/file-tree/hooks/useFileTreeCachedState';
import {
  fileTreeCacheKey,
  findDirectoryNode,
  markLoadedDirectoriesStale,
  mergeRefreshedTree,
  readFileTreeCache,
  writeFileTreeCache,
} from '@/modules/file-tree/utils/fileTreeStateCache';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  /** [local] A remembered tree is shown while a fresh copy is fetched in the background. */
  refreshing: boolean;
  /** [local] Key of the Files tab state cache for this project and root (null without a project). */
  cacheKey: string | null;
  error: string | null;
  /** [local] Set instead of a raw message when the listed folder no longer exists. */
  missingFolder: string | null;
  refreshFiles: () => void;
  /** [local] Directories whose contents are being fetched on demand. */
  loadingDirs: Set<string>;
  /** [local] Fetch one directory flagged `incomplete` and splice it into the tree. */
  loadDirectory: (directoryPath: string) => Promise<void>;
};

// [local] Stable stand-in while no tree is stored, so dependents do not re-run every render.
const NO_FILES: FileTreeNode[] = [];

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

// [local] The ETag a listing response carries (mocked responses may have no headers).
function readEtag(response: Response): string | undefined {
  return response.headers?.get('ETag') ?? undefined;
}

// [local] Asks "changed since?" with the ETag of what the tree already holds.
function conditionalHeaders(etag: string | undefined): { headers?: Record<string, string> } {
  return etag ? { headers: { 'If-None-Match': etag } } : {};
}

// [local] Replace the children of the node at `directoryPath` (or, with `children`
// undefined, keep them and just clear `incomplete`), returning a new tree.
// `listingEtag` names the listing new children came from.
function replaceDirectoryChildren(
  nodes: FileTreeNode[],
  directoryPath: string,
  children: FileTreeNode[] | undefined,
  listingEtag?: string,
): FileTreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type !== 'directory') return node;
    if (node.path === directoryPath) {
      changed = true;
      if (!children) return { ...node, incomplete: false };
      const { listingEtag: _previousEtag, ...rest } = node;
      return listingEtag
        ? { ...rest, children, incomplete: false, listingEtag }
        : { ...rest, children, incomplete: false };
    }
    if (node.children && directoryPath.startsWith(node.path)) {
      const updated = replaceDirectoryChildren(node.children, directoryPath, children, listingEtag);
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
  const scopeSessionId = rootScope?.sessionId ?? null;
  const scopeRoot = rootScope?.root ?? 0;
  // [local] The tree lives in a module-level cache, so reopening the Files tab shows
  // it at once (no spinner) and only refreshes it in the background.
  const cacheKey = fileTreeCacheKey(selectedProject?.projectId, scopeSessionId, scopeRoot);
  const [files, setFiles] = useFileTreeCachedState(cacheKey, 'files', NO_FILES);
  const [loading, setLoading] = useState(() => Boolean(cacheKey) && readFileTreeCache(cacheKey)?.files === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingFolder, setMissingFolder] = useState<string | null>(null);
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
    let listingEtag: string | undefined;
    // [local] Children loaded before are kept when the server says they did not change (304).
    const loadedBefore = findDirectoryNode(readFileTreeCache(cacheKey)?.files, directoryPath);
    const knownEtag = loadedBefore?.children ? loadedBefore.listingEtag : undefined;
    try {
      const response = await api.getFiles(
        projectId,
        conditionalHeaders(knownEtag),
        directoryPath,
        scopeSessionId && scopeRoot > 0 ? { sessionId: scopeSessionId, root: scopeRoot } : null,
        true, // [local] gitignored entries come back flagged; the toolbar toggle hides them client-side
      );
      if (response.status === 304) {
        // Unchanged: keep the children on screen.
      } else if (response.ok) {
        children = (await response.json()) as FileTreeNode[];
        listingEtag = readEtag(response);
      } else {
        console.error('Directory fetch failed:', response.status, await response.text());
      }
    } catch (loadError) {
      console.error('Error fetching directory:', loadError);
    } finally {
      // Clear `incomplete` even on failure so the expand effect does not retry in a loop.
      setFiles((previous) => replaceDirectoryChildren(previous, directoryPath, children, listingEtag));
      setLoadingDirs((previous) => {
        const next = new Set(previous);
        next.delete(directoryPath);
        return next;
      });
    }
  }, [projectId, scopeSessionId, scopeRoot, cacheKey, setFiles]);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    if (!projectId || !cacheKey) {
      setLoading(false);
      setRefreshing(false);
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
    // [local] With a remembered tree on screen, refresh quietly instead of showing the spinner.
    const rememberedEntry = readFileTreeCache(cacheKey);
    const hasRememberedTree = rememberedEntry?.files !== undefined;
    // [local] ...and only ask whether it changed: the server answers 304 without the tree.
    const knownEtag = hasRememberedTree ? rememberedEntry?.etag : undefined;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(!hasRememberedTree);
        setRefreshing(hasRememberedTree);
        setError(null);
        setMissingFolder(null);
      }
      try {
        const response = await api.getFiles(
          projectId,
          { signal: abortControllerRef.current!.signal, ...conditionalHeaders(knownEtag) },
          undefined,
          scopeSessionId && scopeRoot > 0 ? { sessionId: scopeSessionId, root: scopeRoot } : null,
          true, // [local] see loadDirectory
        );

        // [local] Unchanged: keep the tree. Folders loaded on demand are not
        // covered by that answer and get asked again on their own.
        if (response.status === 304) {
          if (isActive) {
            if (readFileTreeCache(cacheKey)?.files === undefined) {
              // The remembered tree was dropped meanwhile: fetch it in full.
              setRefreshKey((previous) => previous + 1);
            } else {
              setFiles((previous) => markLoadedDirectoriesStale(previous));
            }
          }
          return;
        }

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            writeFileTreeCache(cacheKey, { etag: undefined }, false);
            setFiles(undefined); // [local] forget the remembered tree
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
            setMissingFolder(readMissingFolderPath(errorText));
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          // [local] Keep folders loaded on demand instead of collapsing them to "Loading…".
          setFiles((previous) => mergeRefreshedTree(previous, data));
          writeFileTreeCache(cacheKey, { etag: readEtag(response) }, false);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          writeFileTreeCache(cacheKey, { etag: undefined }, false);
          setFiles(undefined); // [local] forget the remembered tree
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [projectId, refreshKey, scopeSessionId, scopeRoot, cacheKey, setFiles]);

  return {
    files,
    loading,
    refreshing,
    cacheKey,
    error,
    missingFolder,
    refreshFiles,
    loadingDirs,
    loadDirectory,
  };
}
