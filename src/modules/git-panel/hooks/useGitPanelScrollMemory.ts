import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { readGitPanelScroll, rememberGitPanelScroll } from '@/modules/git-panel/utils/gitPanelStateCache';

/** Marks the main scrolling list of each Source Control sub-view. */
export const GIT_PANEL_SCROLL_ATTRIBUTE = 'data-git-panel-scroll';

/**
 * [local] Remembers how far the active Source Control sub-view was scrolled, per
 * `cacheKey` (project and view), and scrolls back there when the tab or the view is
 * shown again, the same way the Files tab does. The scroller is the element marked
 * with `data-git-panel-scroll` inside `containerRef`; `ready` is false while the
 * view shows its loading state.
 */
export function useGitPanelScrollMemory(
  containerRef: RefObject<HTMLElement | null>,
  cacheKey: string | null,
  ready: boolean,
) {
  const attached = useRef<{ element: HTMLElement; key: string; remember: () => void } | null>(null);

  // Runs after every render: the scroller is replaced when the view changes, and
  // some views only render it once their data is there.
  useLayoutEffect(() => {
    const element = containerRef.current?.querySelector<HTMLElement>(`[${GIT_PANEL_SCROLL_ATTRIBUTE}]`) ?? null;
    const current = attached.current;
    if (current && current.element === element && current.key === cacheKey) return;
    if (!ready || !cacheKey || !element) return;

    current?.element.removeEventListener('scroll', current.remember);
    element.scrollTop = readGitPanelScroll(cacheKey);
    const remember = () => rememberGitPanelScroll(cacheKey, element.scrollTop);
    element.addEventListener('scroll', remember, { passive: true });
    attached.current = { element, key: cacheKey, remember };
  });

  useLayoutEffect(() => () => {
    const current = attached.current;
    current?.element.removeEventListener('scroll', current.remember);
    attached.current = null;
  }, []);
}
