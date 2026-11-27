import { useLayoutEffect, useRef } from 'react';

import { readFileTreeCache, writeFileTreeCache } from '@/modules/file-tree/utils/fileTreeStateCache';

/**
 * [local] Remembers how far the Files tab list was scrolled, per state cache key,
 * and scrolls back there when the tab is shown again. Returns the ref for the
 * scrolling element; `ready` is false while the list is not rendered (spinner).
 */
export function useFileTreeScrollMemory(cacheKey: string | null, ready: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!ready || !cacheKey || !element) return;

    element.scrollTop = readFileTreeCache(cacheKey)?.scrollTop ?? 0;
    const remember = () => writeFileTreeCache(cacheKey, { scrollTop: element.scrollTop }, false);
    element.addEventListener('scroll', remember, { passive: true });
    return () => element.removeEventListener('scroll', remember);
  }, [cacheKey, ready]);

  return scrollRef;
}
