import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { WorkspaceRoot } from '@/modules/file-tree/hooks/useWorkspaceRoots';

type FileTreeRootSwitcherProps = {
  roots: WorkspaceRoot[];
  selectedRoot: number;
  onSelectRoot: (index: number) => void;
};

/**
 * [local] Picks which workspace root of a Codex conversation the Files tab
 * shows: the project folder first, then the other folders of its Codex
 * project, by folder name. The full path is in the tooltip and under each
 * name in the list. Renders nothing when there is only one root, so every
 * other session looks exactly as before.
 */
export default function FileTreeRootSwitcher({ roots, selectedRoot, onSelectRoot }: FileTreeRootSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (roots.length < 2) {
    return null;
  }

  const current = roots.find((root) => root.index === selectedRoot) ?? roots[0];

  return (
    <div ref={containerRef} className="relative" data-testid="file-tree-root-switcher">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={current.path}
        aria-label={t('fileTree.roots.switch', 'Workspace folder: {{name}}', { name: current.name })}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-sm transition-colors hover:bg-accent"
      >
        <FolderOpen className="h-4 w-4 flex-shrink-0 text-blue-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{current.name}</span>
        <span className="flex-shrink-0 text-xs text-muted-foreground">
          {t('fileTree.roots.position', '{{current}}/{{total}}', { current: current.index + 1, total: roots.length })}
        </span>
        <ChevronDown className={cn('h-4 w-4 flex-shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('fileTree.roots.title', 'Workspace folders')}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {roots.map((root) => {
            const selected = root.index === current.index;
            return (
              <li key={root.index} role="option" aria-selected={selected}>
                <button
                  type="button"
                  title={root.path}
                  onClick={() => {
                    onSelectRoot(root.index);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex min-h-11 w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent',
                    selected && 'bg-accent/60',
                  )}
                >
                  <Check className={cn('mt-0.5 h-4 w-4 flex-shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {root.name}
                      {root.index === 0 && (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {t('fileTree.roots.primary', 'working folder')}
                        </span>
                      )}
                      {!root.exists && (
                        <span className="ml-1.5 text-xs font-normal text-red-600 dark:text-red-400">
                          {t('fileTree.roots.missing', 'not found')}
                        </span>
                      )}
                    </span>
                    <span className="block break-all text-xs leading-4 text-muted-foreground">{root.path}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
