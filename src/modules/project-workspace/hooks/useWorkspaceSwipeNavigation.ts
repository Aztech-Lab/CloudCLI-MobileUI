import { useEffect, useRef } from 'react';

import type { AppTab } from '@/shared/types';

/**
 * [local] Mobile swipe navigation between workspace tabs.
 *
 * A horizontal swipe anywhere in the workspace content switches tabs: finger moving
 * left goes to the next tab (to the right in the tab strip), finger moving right goes
 * to the previous one, and on the first tab it opens the menu drawer instead.
 *
 * It deliberately stays out of the way of everything else:
 * - touches that start next to the left/right screen edge belong to the system
 *   (iOS back gesture), so they are ignored;
 * - content that can still scroll horizontally in the swipe direction (code blocks,
 *   tables, the tab strip) scrolls first;
 * - text inputs, editable content, fixed overlays and `[data-no-swipe-nav]` subtrees
 *   are never treated as a swipe;
 * - an active text selection, a mostly vertical or slow drag, or a second finger
 *   cancels the gesture.
 */

/** Touches starting this close to the left/right screen edge are left to the OS. */
export const SWIPE_EDGE_GUARD_PX = 24;
/** Minimum horizontal travel, in px, and as a fraction of the container width. */
export const SWIPE_MIN_DISTANCE_PX = 56;
export const SWIPE_MIN_DISTANCE_RATIO = 0.12;
/** Horizontal travel must exceed vertical travel by this factor. */
export const SWIPE_DIRECTION_RATIO = 1.8;
/** Longer presses are drags/selections, not swipes. */
export const SWIPE_MAX_DURATION_MS = 900;

export type SwipeDirection = 'next' | 'previous';

export type SwipeAction =
  | { type: 'tab'; tab: AppTab }
  | { type: 'menu' };

/**
 * What a completed swipe in `direction` should do from `activeTab`. With no tabs
 * (the home screen, before a project is chosen) swiping back opens the menu and
 * swiping forward does nothing.
 */
export function resolveSwipeAction(
  tabIds: readonly AppTab[],
  activeTab: AppTab,
  direction: SwipeDirection,
): SwipeAction | null {
  if (tabIds.length === 0) return direction === 'previous' ? { type: 'menu' } : null;

  const index = tabIds.indexOf(activeTab);
  if (index === -1) return null;

  if (direction === 'next') {
    const nextTab = tabIds[index + 1];
    return nextTab ? { type: 'tab', tab: nextTab } : null;
  }

  if (index === 0) return { type: 'menu' };
  return { type: 'tab', tab: tabIds[index - 1] };
}

/** Classifies a finished touch movement, or returns null when it is not a swipe. */
export function classifySwipe(
  dx: number,
  dy: number,
  durationMs: number,
  containerWidth: number,
): SwipeDirection | null {
  const minDistance = Math.max(SWIPE_MIN_DISTANCE_PX, containerWidth * SWIPE_MIN_DISTANCE_RATIO);
  if (durationMs > SWIPE_MAX_DURATION_MS) return null;
  if (Math.abs(dx) < minDistance) return null;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTION_RATIO) return null;
  // Finger moving left reveals what is to the right: the next tab.
  return dx < 0 ? 'next' : 'previous';
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Whether anything between `target` and `container` should keep the touch for itself
 * when the finger moves in `direction`.
 */
export function isSwipeBlockedByTarget(
  target: EventTarget | null,
  container: Element,
  direction: SwipeDirection,
): boolean {
  let element = target instanceof Element ? target : null;

  while (element && element !== container) {
    if (EDITABLE_TAGS.has(element.tagName)) return true;
    if (element instanceof HTMLElement && element.isContentEditable) return true;
    if (element.hasAttribute('data-no-swipe-nav')) return true;

    const style = window.getComputedStyle(element);
    if (style.position === 'fixed') return true;

    const canScrollX = (style.overflowX === 'auto' || style.overflowX === 'scroll')
      && element.scrollWidth > element.clientWidth + 1;
    if (canScrollX) {
      // Finger moving left scrolls content towards its right end, and vice versa.
      const atRightEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
      const atLeftEnd = element.scrollLeft <= 1;
      if (direction === 'next' && !atRightEnd) return true;
      if (direction === 'previous' && !atLeftEnd) return true;
    }

    element = element.parentElement;
  }

  return false;
}

function hasTextSelection(): boolean {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

type SwipeStart = { x: number; y: number; time: number; target: EventTarget | null };

type UseWorkspaceSwipeNavigationOptions = {
  enabled: boolean;
  /** The workspace content element; null until it is mounted. */
  container: HTMLElement | null;
  tabIds: readonly AppTab[];
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onOpenMenu: () => void;
};

/** Attaches the swipe gesture to `container` while `enabled` (mobile layout). */
export function useWorkspaceSwipeNavigation({
  enabled,
  container,
  tabIds,
  activeTab,
  onSelectTab,
  onOpenMenu,
}: UseWorkspaceSwipeNavigationOptions) {
  // Read through a ref so the listeners are attached once per container, not per render.
  const latest = useRef({ tabIds, activeTab, onSelectTab, onOpenMenu });
  useEffect(() => {
    latest.current = { tabIds, activeTab, onSelectTab, onOpenMenu };
  }, [tabIds, activeTab, onSelectTab, onOpenMenu]);

  useEffect(() => {

    if (!enabled || !container) return undefined;

    let start: SwipeStart | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      const viewportWidth = window.innerWidth;
      if (touch.clientX < SWIPE_EDGE_GUARD_PX || touch.clientX > viewportWidth - SWIPE_EDGE_GUARD_PX) {
        start = null;
        return;
      }
      start = { x: touch.clientX, y: touch.clientY, time: Date.now(), target: event.target };
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (start && event.touches.length > 1) start = null;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const origin = start;
      start = null;
      if (!origin) return;
      const touch = event.changedTouches[0];
      if (!touch) return;

      const direction = classifySwipe(
        touch.clientX - origin.x,
        touch.clientY - origin.y,
        Date.now() - origin.time,
        container.clientWidth || window.innerWidth,
      );
      if (!direction) return;
      if (hasTextSelection()) return;
      if (isSwipeBlockedByTarget(origin.target, container, direction)) return;

      const { tabIds: currentTabs, activeTab: currentTab } = latest.current;
      const action = resolveSwipeAction(currentTabs, currentTab, direction);
      if (!action) return;
      if (action.type === 'menu') latest.current.onOpenMenu();
      else latest.current.onSelectTab(action.tab);
    };

    const handleTouchCancel = () => {
      start = null;
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchCancel, { passive: true });
    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [container, enabled]);
}
