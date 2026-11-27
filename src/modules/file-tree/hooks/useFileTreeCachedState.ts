import { useCallback, useSyncExternalStore } from 'react';

import {
  readFileTreeCache,
  subscribeFileTreeCache,
  writeFileTreeCache,
  type FileTreeCacheEntry,
} from '@/modules/file-tree/utils/fileTreeStateCache';

type CachedField = 'files' | 'expandedDirs' | 'searchQuery';
type FieldValue<F extends CachedField> = NonNullable<FileTreeCacheEntry[F]>;

export type CachedStateUpdate<V> = V | undefined | ((previous: V) => V);

/**
 * [local] Like useState, but the value lives in the Files tab's state cache
 * under `cacheKey`, so it survives the tab unmounting. `fallback` (a constant)
 * stands in while nothing is stored; setting `undefined` forgets the value.
 * Without a key (no project) the value is the fallback and updates are ignored.
 */
export function useFileTreeCachedState<F extends CachedField>(
  cacheKey: string | null,
  field: F,
  fallback: FieldValue<F>,
): [FieldValue<F>, (update: CachedStateUpdate<FieldValue<F>>) => void] {
  const read = useCallback(
    () => (readFileTreeCache(cacheKey)?.[field] as FieldValue<F> | undefined) ?? fallback,
    [cacheKey, field, fallback],
  );
  const value = useSyncExternalStore(subscribeFileTreeCache, read, read);

  const setValue = useCallback((update: CachedStateUpdate<FieldValue<F>>) => {
    if (!cacheKey) return;
    const previous = read();
    const next = typeof update === 'function'
      ? (update as (previous: FieldValue<F>) => FieldValue<F>)(previous)
      : update;
    if (next === previous) return;
    writeFileTreeCache(cacheKey, { [field]: next } as FileTreeCacheEntry);
  }, [cacheKey, field, read]);

  return [value, setValue];
}
