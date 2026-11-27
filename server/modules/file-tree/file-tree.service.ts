import { createHash } from 'node:crypto';
import path from 'node:path';

import ignore from 'ignore';

import { fileTreeEntryKey } from '@/modules/file-tree/file-tree.change-tracker.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeRootScope,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  projectIdentityKey,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree consumes this guard when recursively listing a project so a very
// broad workspace (for example, a user's home directory) cannot exhaust the
// server heap before the browser has a chance to switch to a narrower project.
// [local] Configurable via CLOUDCLI_FILE_TREE_MAX_ENTRIES. When the budget runs out the
// tree is returned truncated (directories flagged `incomplete`) instead of failing, and the
// browser loads an incomplete directory on demand via `?path=`.
const MAXIMUM_FILE_TREE_ENTRIES = Number(process.env.CLOUDCLI_FILE_TREE_MAX_ENTRIES) || 10_000;
const MAXIMUM_FILE_TREE_DEPTH = 10;

// [local] Extra READ-ONLY roots for the in-chat file viewer (semicolon-separated).
function readExtraReadRoots(): string[] {
  return (process.env.CLOUDCLI_EXTRA_READ_ROOTS || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// [local] Directories of one tree level read together before their share of the
// entry budget is settled; bounds what a level holds in memory at once.
const FILE_TREE_LEVEL_BATCH_SIZE = 256;

function sortFileTreeItems(items: FileTreeNode[]): void {
  items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

// [local] How the tree treats one entry: shown, shown but marked as gitignored
// (directories are then listed lazily, never walked), or left out.
type FileTreeEntryVisibility = 'visible' | 'ignored' | 'hidden';
type FileTreeEntryClassifier = (entryPath: string, isDirectory: boolean) => FileTreeEntryVisibility;

// [local] Never listed, even when the caller asks for gitignored entries.
const VERSION_CONTROL_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg']);

type VisibleDirectoryEntry = { entry: FileTreeDirectoryEntry; ignored: boolean };

function classifyByFilter(includeEntry: FileTreeEntryFilter): FileTreeEntryClassifier {
  return (entryPath, isDirectory) => (includeEntry(entryPath, isDirectory) ? 'visible' : 'hidden');
}

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

/** [local] The metadata a tree entry shows, from its `lstat`. */
function describeStats(stats: FileTreeStats): Pick<FileTreeNode, 'size' | 'modified' | 'permissions' | 'permissionsRwx' | 'isSymlink'> {
  const ownerPermissions = (stats.mode >> 6) & 7;
  const groupPermissions = (stats.mode >> 3) & 7;
  const otherPermissions = stats.mode & 7;
  return {
    size: stats.size,
    modified: stats.mtime.toISOString(),
    permissions: `${ownerPermissions}${groupPermissions}${otherPermissions}`,
    permissionsRwx: permissionBitsToRwx(ownerPermissions)
      + permissionBitsToRwx(groupPermissions)
      + permissionBitsToRwx(otherPermissions),
    ...(stats.isSymbolicLink() ? { isSymlink: true } : {}),
  };
}

/**
 * [local] What a listing shows about one entry besides name and children, as
 * a comparable string (see file-tree.change-tracker.ts). `permissionsRwx`
 * follows from `permissions`.
 */
function entryStamp(entry: Pick<FileTreeNode, 'size' | 'modified' | 'permissions' | 'isSymlink'>): string {
  return `${entry.size}|${entry.modified}|${entry.permissions}|${entry.isSymlink ? 1 : 0}`;
}


function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

/** [local] Comparable form of a folder path: Windows paths compare case-insensitively. */
function comparableRootPath(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** [local] The root among `roots` that strictly contains `absolutePath`, if any. */
function findContainingRoot(roots: string[], absolutePath: string): string | null {
  const target = comparableRootPath(absolutePath);
  for (const root of roots) {
    const prefix = comparableRootPath(root).replace(/[\\/]+$/, '') + path.sep;
    if (target.startsWith(prefix)) {
      return root;
    }
  }
  return null;
}

/**
 * [local] `resolvePathInsideProject` over several roots: an absolute path may
 * lie in any of them, a relative one is taken from `baseRoot`.
 */
function resolvePathInsideRoots(roots: string[], baseRoot: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    const root = findContainingRoot(roots, path.resolve(targetPath));
    if (root) {
      return resolvePathInsideProject(root, targetPath);
    }
  }
  return resolvePathInsideProject(baseRoot, targetPath);
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

/**
 * [local] Classifies entries against the root's `.gitignore`. With
 * `markIgnored` a matched entry is kept and flagged instead of dropped (the
 * Files tab dims it); version-control folders stay hidden either way, and
 * `node_modules` is only shown when the `.gitignore` covers it.
 */
function createGitignoreEntryClassifier(
  projectRoot: string,
  gitignoreContent: string,
  markIgnored: boolean,
): FileTreeEntryClassifier {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (isDirectory && VERSION_CONTROL_DIRECTORY_NAMES.has(path.basename(entryPath))) return 'hidden';

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    if (!gitignore.ignores(matchPath)) {
      return includeEntryByHardExclusions(entryPath, isDirectory) ? 'visible' : 'hidden';
    }
    return markIgnored ? 'ignored' : 'hidden';
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * [local] Extra roots of one session of this project, or null when the
   * session does not exist or belongs to another project. Only roots recorded
   * on the session row count; the client names a root by its index.
   */
  function readSessionRoots(projectRoot: string, sessionId: string): string[] | null {
    const record = dependencies.sessions?.getSessionWorkspaceRoots(sessionId) ?? null;
    if (!record || projectIdentityKey(record.projectPath) !== projectIdentityKey(projectRoot)) {
      return null;
    }
    return record.roots.filter((root) => path.isAbsolute(root));
  }

  /** [local] The folder a scoped request works in: the project root, or one of the session's roots. */
  function resolveScopeRoot(projectRoot: string, scope: FileTreeRootScope | null | undefined): string {
    if (!scope || scope.root === 0) {
      return projectRoot;
    }
    const roots = readSessionRoots(projectRoot, scope.sessionId);
    const root = roots && Number.isInteger(scope.root) && scope.root > 0 ? roots[scope.root - 1] : undefined;
    if (!root) {
      throw createFileTreeError('Unknown workspace root', 400, 'INVALID_WORKSPACE_ROOT');
    }
    return root;
  }

  /**
   * [local] Every folder this project's tree may touch: the project root plus
   * the extra roots recorded for its sessions. Absolute paths (tree entries,
   * the editor) are checked against these.
   */
  function projectRoots(projectRoot: string): string[] {
    const extraRoots = dependencies.sessions?.listProjectWorkspaceRoots(projectRoot) ?? [];
    return [projectRoot, ...extraRoots.filter((root) => path.isAbsolute(root))];
  }

  /**
   * Streams one directory and keeps only the entries the tree will show.
   *
   * Entries are filtered and charged against the shared budget one at a time,
   * so a pathologically large directory stops the walk at the cap instead of
   * being read into memory in full first.
   */
  async function collectVisibleEntries(
    directoryPath: string,
    classifyEntry: FileTreeEntryClassifier,
    remainingEntries: { value: number },
  ): Promise<{ entries: VisibleDirectoryEntry[]; truncated: boolean }> {
    const visibleEntries: VisibleDirectoryEntry[] = [];
    let truncated = false;

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const isDirectory = entry.isDirectory();
        const visibility = classifyEntry(path.join(directoryPath, entry.name), isDirectory);
        if (visibility === 'hidden') {
          continue;
        }

        // Charged after visibility filtering so ignored entries never consume
        // the budget. Every recursive branch shares one counter, so the cap
        // applies to the whole tree rather than per directory.
        if (remainingEntries.value <= 0) {
          // [local] Stop here and let the caller flag this directory as incomplete.
          truncated = true;
          break;
        }
        remainingEntries.value -= 1;
        visibleEntries.push({ entry, ignored: visibility === 'ignored' });
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return { entries: [], truncated: false };
    } finally {
      release();
    }

    return { entries: visibleEntries, truncated };
  }

  /**
   * [local] Walks the tree level by level (all directories at depth 1, then
   * depth 2, ...) and hands out the shared entry budget in a fixed order:
   * directories in tree order, entries in directory order. Directories are
   * still read in parallel, but which ones end up cut off no longer depends on
   * which read finished first, so walking an unchanged folder twice gives the
   * same listing (and the same ETag) even when it is truncated.
   */
  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    classifyEntry: FileTreeEntryClassifier = classifyByFilter(includeEntryByFallbackDirectoryNames),
    remainingEntries = { value: MAXIMUM_FILE_TREE_ENTRIES },
  ): Promise<FileTreeNode[]> {
    type PendingDirectory = { path: string; depth: number; node: FileTreeNode | null };
    let rootItems: FileTreeNode[] = [];
    let level: PendingDirectory[] = [{ path: directoryPath, depth: currentDepth, node: null }];

    while (level.length > 0) {
      const nextLevel: PendingDirectory[] = [];
      for (let start = 0; start < level.length; start += FILE_TREE_LEVEL_BATCH_SIZE) {
        const batch = level.slice(start, start + FILE_TREE_LEVEL_BATCH_SIZE);
        // Each read may take what is left of the budget; what it actually gets
        // is settled below, in order, once the whole batch has been read.
        const budgetAtStart = remainingEntries.value;
        const reads = await Promise.all(batch.map((directory) => (
          collectVisibleEntries(directory.path, classifyEntry, { value: budgetAtStart })
        )));

        const levelItems = await Promise.all(batch.map(async (directory, index) => {
          const read = reads[index];
          const kept = read.entries.slice(0, Math.max(0, remainingEntries.value));
          remainingEntries.value -= kept.length;
          const truncated = read.truncated || kept.length < read.entries.length;
          return { directory, truncated, items: await describeEntries(directory.path, kept) };
        }));

        for (const { directory, truncated, items } of levelItems) {
          sortFileTreeItems(items);
          if (directory.node) {
            directory.node.children = items;
            if (truncated) directory.node.incomplete = true;
          } else {
            rootItems = items;
          }
          for (const item of items) {
            if (item.type !== 'directory' || FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(item.path))) {
              // Pseudo-filesystems and other system-critical directories (e.g.
              // /proc, /sys) are never walked: /proc in particular can hold
              // thousands of virtual entries.
              continue;
            }
            // [local] A gitignored directory (node_modules, build output, ...) is listed but
            // never walked eagerly; the browser loads it like a truncated one when expanded.
            if (directory.depth < maximumDepth && !item.ignored) {
              nextLevel.push({ path: item.path, depth: directory.depth + 1, node: item });
            } else {
              // [local] Not descended into: the browser fetches it when expanded.
              item.incomplete = true;
            }
          }
        }
      }
      level = nextLevel;
    }
    return rootItems;
  }

  /** Builds the nodes of one directory's entries, with their metadata. */
  async function describeEntries(directoryPath: string, entries: VisibleDirectoryEntry[]): Promise<FileTreeNode[]> {
    return Promise.all(entries.map(async ({ entry, ignored }): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item: FileTreeNode = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
      };
      if (ignored) item.ignored = true;

      try {
        await acquire();
        try {
          Object.assign(item, describeStats(await fileSystem.lstat(itemPath)));
        } finally {
          release();
        }
      } catch {
        // Metadata failures should not hide an otherwise readable tree entry.
      }
      return item;
    }));
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(
        targetPath,
        [dependencies.workspace.rootPath, ...readExtraReadRoots()],
      );
      if (workspacePath) {
        return workspacePath;
      }
    }

    // [local] Or inside one of the project's recorded workspace roots.
    return resolvePathInsideRoots(projectRoots(projectRoot), projectRoot, targetPath);
  }

  type ListingOptions = Parameters<FileTreeServices['listProjectFiles']>[1];

  /**
   * [local] The folder a listing request walks (`listRoot`) and the root it
   * belongs to (`scopeRoot`): the project folder unless the request names
   * another root of its session; `subPath` lists one directory inside it.
   */
  async function resolveListingTarget(
    projectId: string,
    options: ListingOptions,
  ): Promise<{ scopeRoot: string; listRoot: string }> {
    const scopeRoot = resolveScopeRoot(await resolveProjectRoot(projectId), options?.scope);
    try {
      await fileSystem.access(scopeRoot);
    } catch {
      // [local] Names the folder, so a moved or deleted project is recognizable.
      throw new AppError(`Folder not found: ${scopeRoot}`, {
        statusCode: 404,
        code: 'PROJECT_PATH_NOT_FOUND',
        details: { path: scopeRoot },
      });
    }

    // [local] `subPath` lists one directory inside the project (lazy expansion of a
    // directory the full listing flagged `incomplete`), with a fresh entry budget.
    let listRoot = scopeRoot;
    if (options?.subPath) {
      const resolvedSubPath = path.resolve(scopeRoot, options.subPath);
      if (resolvedSubPath !== path.resolve(scopeRoot)) {
        listRoot = resolvePathInsideProject(scopeRoot, options.subPath);
      }
    }
    return { scopeRoot, listRoot };
  }

  async function readListingClassifier(
    scopeRoot: string,
    options: ListingOptions,
  ): Promise<FileTreeEntryClassifier | undefined> {
    if (!options?.respectGitignore) {
      return undefined;
    }
    try {
      const gitignoreContent = await fileSystem.readTextFile(path.join(scopeRoot, '.gitignore'));
      // [local] `includeIgnored` keeps gitignored entries, flagged `ignored`, instead of dropping them.
      return createGitignoreEntryClassifier(scopeRoot, gitignoreContent, options.includeIgnored === true);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        dependencies.logger.error(`Error reading .gitignore in "${scopeRoot}"`, error);
      }
      return undefined;
    }
  }

  /**
   * [local] Whether a watch of `scopeRoot` sees every change to `listRoot`:
   * false when the path to it passes through a link (a recursive watch does
   * not follow links), so such listings are always walked.
   */
  async function isWatchedThroughRoot(scopeRoot: string, listRoot: string): Promise<boolean> {
    if (path.resolve(listRoot) === path.resolve(scopeRoot)) {
      return true;
    }
    try {
      const expected = path.join(await fileSystem.realpath(scopeRoot), path.relative(scopeRoot, listRoot));
      const actual = await fileSystem.realpath(listRoot);
      return process.platform === 'win32'
        ? expected.toLowerCase() === actual.toLowerCase()
        : expected === actual;
    } catch {
      return false;
    }
  }

  /** [local] Entry key (relative to `scopeRoot`) → stamp, for every entry of a listing. */
  function collectEntryStamps(scopeRoot: string, tree: FileTreeNode[]): Map<string, string> {
    const stamps = new Map<string, string>();
    const visit = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        stamps.set(fileTreeEntryKey(path.relative(scopeRoot, node.path)), entryStamp(node));
        if (node.children) visit(node.children);
      }
    };
    visit(tree);
    return stamps;
  }

  /** [local] The stamp an entry would get if listed now; null when unreadable. */
  async function readEntryStamp(absolutePath: string): Promise<string | null> {
    await acquire();
    try {
      return entryStamp(describeStats(await fileSystem.lstat(absolutePath)));
    } catch {
      return null;
    } finally {
      release();
    }
  }

  /** [local] The server changed files itself: never confirm an older listing. */
  function invalidateListings(): void {
    dependencies.changeTracker?.invalidateAll();
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  const services: FileTreeServices = {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideRoots(projectRoots(projectRoot), projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const target = await resolveListingTarget(projectId, options);
      return buildFileTree(target.listRoot, MAXIMUM_FILE_TREE_DEPTH, 0, await readListingClassifier(target.scopeRoot, options));
    },

    // [local] The listing for a conditional request. When a filesystem watch
    // armed before the last walk of this folder saw nothing since, a matching
    // ETag is confirmed without walking again; otherwise the folder is walked
    // and the ETag (a hash of the listing) decides.
    async listProjectFilesIfChanged(projectId, options, candidateEtags) {
      const target = await resolveListingTarget(projectId, options);
      const tracker = dependencies.changeTracker;
      const snapshotKey = JSON.stringify([
        target.listRoot,
        options?.respectGitignore === true,
        options?.includeIgnored === true,
        MAXIMUM_FILE_TREE_ENTRIES,
      ]);

      if (tracker && candidateEtags.length > 0) {
        const unchangedEtag = await tracker.unchangedEtag(snapshotKey, target.scopeRoot, candidateEtags, readEntryStamp);
        if (unchangedEtag) {
          return { notModified: true, etag: unchangedEtag };
        }
      }

      // Armed before the walk, so a change made while walking is still seen.
      const token = tracker ? await tracker.arm(target.scopeRoot) : null;
      const tree = await buildFileTree(
        target.listRoot,
        MAXIMUM_FILE_TREE_DEPTH,
        0,
        await readListingClassifier(target.scopeRoot, options),
      );
      const body = JSON.stringify(tree);
      const etag = `W/"ft-${createHash('sha1').update(body).digest('base64url')}"`;

      if (tracker && token && await isWatchedThroughRoot(target.scopeRoot, target.listRoot)) {
        tracker.remember(snapshotKey, target.scopeRoot, token, etag, collectEntryStamps(target.scopeRoot, tree));
      }

      return candidateEtags.includes(etag)
        ? { notModified: true, etag }
        : { notModified: false, etag, body };
    },

    // [local] Root 0 is always the project folder; a session of this project
    // with recorded extra roots adds them as 1..N. Names only, by folder name.
    async listWorkspaceRoots(projectId, sessionId) {
      const projectRoot = await resolveProjectRoot(projectId);
      const extraRoots = sessionId ? readSessionRoots(projectRoot, sessionId) ?? [] : [];
      const roots = await Promise.all([projectRoot, ...extraRoots].map(async (rootPath, index) => {
        let exists = true;
        try {
          await fileSystem.access(rootPath);
        } catch {
          exists = false;
        }
        return { index, name: path.basename(rootPath) || rootPath, path: rootPath, exists };
      }));
      return { roots };
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const baseRoot = resolveScopeRoot(projectRoot, input.scope);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideRoots(projectRoots(projectRoot), baseRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const allowedRoots = projectRoots(projectRoot);
      const resolvedOldPath = resolvePathInsideRoots(allowedRoots, projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideRoots(allowedRoots, projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const allowedRoots = projectRoots(projectRoot);
      const resolvedPath = resolvePathInsideRoots(allowedRoots, projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (allowedRoots.some((root) => comparableRootPath(root) === comparableRootPath(resolvedPath))) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const allowedRoots = projectRoots(projectRoot);
        const baseRoot = resolveScopeRoot(projectRoot, input.scope);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(baseRoot)
          : resolvePathInsideRoots(allowedRoots, baseRoot, input.targetPath);
        // [local] Uploads stay inside the root the target folder belongs to.
        const uploadRoot = findContainingRoot(allowedRoots, path.join(resolvedTargetDirectory, 'x')) ?? baseRoot;

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(uploadRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };

  // [local] Whatever the server writes itself (even a failed, partial upload)
  // ends every remembered listing, independent of how fast watch events arrive.
  return {
    ...services,
    saveTextFile: (...input) => services.saveTextFile(...input).finally(invalidateListings),
    createEntry: (...input) => services.createEntry(...input).finally(invalidateListings),
    renameEntry: (...input) => services.renameEntry(...input).finally(invalidateListings),
    deleteEntry: (...input) => services.deleteEntry(...input).finally(invalidateListings),
    storeUploadedFiles: (...input) => services.storeUploadedFiles(...input).finally(invalidateListings),
  };
}
