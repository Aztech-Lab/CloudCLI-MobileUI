import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifySwipe,
  isSwipeBlockedByTarget,
  resolveSwipeAction,
  useWorkspaceSwipeNavigation,
} from '@/modules/project-workspace/hooks/useWorkspaceSwipeNavigation';
import { getBuiltInTabs } from '@/modules/project-workspace/hooks/useWorkspaceTabs';
import type { AppTab } from '@/shared/types';

const TABS: AppTab[] = ['chat', 'files', 'git', 'shell'];

describe('workspace tab order', () => {
  it('puts the shell tab last, after the optional tabs', () => {
    expect(getBuiltInTabs(false, false).map((tab) => tab.id)).toEqual(['chat', 'files', 'git', 'shell']);
    expect(getBuiltInTabs(true, true).map((tab) => tab.id)).toEqual(['chat', 'files', 'git', 'browser', 'tasks', 'shell']);
  });
});

describe('resolveSwipeAction', () => {
  it('moves to the neighbouring tab', () => {
    expect(resolveSwipeAction(TABS, 'files', 'next')).toEqual({ type: 'tab', tab: 'git' });
    expect(resolveSwipeAction(TABS, 'files', 'previous')).toEqual({ type: 'tab', tab: 'chat' });
  });

  it('opens the menu when swiping back from the first tab', () => {
    expect(resolveSwipeAction(TABS, 'chat', 'previous')).toEqual({ type: 'menu' });
  });

  it('on the home screen (no tabs) only swiping back does something: it opens the menu', () => {
    expect(resolveSwipeAction([], 'chat', 'previous')).toEqual({ type: 'menu' });
    expect(resolveSwipeAction([], 'chat', 'next')).toBeNull();
  });

  it('does nothing past the last tab or for an unknown tab', () => {
    expect(resolveSwipeAction(TABS, 'shell', 'next')).toBeNull();
    expect(resolveSwipeAction(TABS, 'tasks', 'next')).toBeNull();
  });
});

describe('classifySwipe', () => {
  it('maps finger direction to tab direction', () => {
    expect(classifySwipe(-120, 10, 200, 400)).toBe('next');
    expect(classifySwipe(120, -10, 200, 400)).toBe('previous');
  });

  it('rejects short, diagonal, vertical and slow movements', () => {
    expect(classifySwipe(-40, 0, 200, 400)).toBeNull();
    expect(classifySwipe(-120, 90, 200, 400)).toBeNull();
    expect(classifySwipe(10, 300, 200, 400)).toBeNull();
    expect(classifySwipe(-120, 0, 1500, 400)).toBeNull();
  });

  it('scales the distance threshold with a wide container', () => {
    // 12% of 1000px = 120px
    expect(classifySwipe(-100, 0, 200, 1000)).toBeNull();
    expect(classifySwipe(-130, 0, 200, 1000)).toBe('next');
  });
});

function makeScrollable(element: HTMLElement, scrollLeft: number) {
  element.style.overflowX = 'auto';
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 800 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 300 });
  element.scrollLeft = scrollLeft;
  Object.defineProperty(element, 'scrollLeft', { configurable: true, value: scrollLeft, writable: true });
}

describe('isSwipeBlockedByTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(html: string) {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
  }

  it('lets plain content swipe', () => {
    const container = mount('<div><p id="t">hello</p></div>');
    expect(isSwipeBlockedByTarget(container.querySelector('#t'), container, 'next')).toBe(false);
  });

  it('keeps inputs, editable content and opted-out subtrees', () => {
    const container = mount(`
      <textarea id="ta"></textarea>
      <div contenteditable="true"><span id="ce">x</span></div>
      <div data-no-swipe-nav><span id="opt">x</span></div>
      <div style="position: fixed"><span id="fx">x</span></div>
    `);
    // jsdom does not derive isContentEditable from the attribute.
    const editable = container.querySelector('[contenteditable]') as HTMLElement;
    Object.defineProperty(editable, 'isContentEditable', { value: true });

    for (const id of ['ta', 'ce', 'opt', 'fx']) {
      expect(isSwipeBlockedByTarget(container.querySelector(`#${id}`), container, 'next')).toBe(true);
    }
  });

  it('lets horizontally scrollable content scroll until it reaches its end', () => {
    const container = mount('<div id="scroller"><code id="code">long line</code></div>');
    const scroller = container.querySelector('#scroller') as HTMLElement;
    const code = container.querySelector('#code');

    makeScrollable(scroller, 0);
    expect(isSwipeBlockedByTarget(code, container, 'next')).toBe(true);
    expect(isSwipeBlockedByTarget(code, container, 'previous')).toBe(false);

    makeScrollable(scroller, 500);
    expect(isSwipeBlockedByTarget(code, container, 'next')).toBe(false);
    expect(isSwipeBlockedByTarget(code, container, 'previous')).toBe(true);
  });
});

function touchEvent(type: string, x: number, y: number, fingers = 1) {
  const event = new Event(type, { bubbles: true });
  const touch = { clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : Array(fingers).fill(touch) });
  Object.defineProperty(event, 'changedTouches', { value: [touch] });
  return event;
}

describe('useWorkspaceSwipeNavigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function setup(activeTab: AppTab, enabled = true, tabIds: AppTab[] = TABS) {
    const container = document.createElement('div');
    const target = document.createElement('p');
    container.appendChild(target);
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 });

    const onSelectTab = vi.fn();
    const onOpenMenu = vi.fn();
    renderHook(() => useWorkspaceSwipeNavigation({
      enabled,
      container,
      tabIds,
      activeTab,
      onSelectTab,
      onOpenMenu,
    }));
    return { target, onSelectTab, onOpenMenu };
  }

  function swipe(target: Element, fromX: number, toX: number, fingers = 1) {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    target.dispatchEvent(touchEvent('touchstart', fromX, 300, fingers));
    target.dispatchEvent(touchEvent('touchmove', (fromX + toX) / 2, 305, fingers));
    now += 200;
    target.dispatchEvent(touchEvent('touchend', toX, 310));
  }

  it('switches to the next and previous tab', () => {
    const next = setup('files');
    swipe(next.target, 300, 150);
    expect(next.onSelectTab).toHaveBeenCalledWith('git');

    document.body.innerHTML = '';
    const previous = setup('files');
    swipe(previous.target, 100, 260);
    expect(previous.onSelectTab).toHaveBeenCalledWith('chat');
  });

  it('opens the menu when swiping back from chat', () => {
    const { target, onSelectTab, onOpenMenu } = setup('chat');
    swipe(target, 100, 260);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('on the home screen opens the menu on a back swipe and never changes the tab', () => {
    const back = setup('chat', true, []);
    swipe(back.target, 100, 260);
    expect(back.onOpenMenu).toHaveBeenCalledTimes(1);

    document.body.innerHTML = '';
    const forward = setup('chat', true, []);
    swipe(forward.target, 300, 150);
    expect(forward.onOpenMenu).not.toHaveBeenCalled();
    expect(forward.onSelectTab).not.toHaveBeenCalled();
  });

  it('leaves edge swipes to the system', () => {
    const { target, onSelectTab, onOpenMenu } = setup('chat');
    swipe(target, 10, 200);
    expect(onOpenMenu).not.toHaveBeenCalled();
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('ignores multi-finger gestures and does nothing when disabled', () => {
    const multi = setup('files');
    swipe(multi.target, 300, 150, 2);
    expect(multi.onSelectTab).not.toHaveBeenCalled();

    document.body.innerHTML = '';
    const disabled = setup('files', false);
    swipe(disabled.target, 300, 150);
    expect(disabled.onSelectTab).not.toHaveBeenCalled();
  });
});
