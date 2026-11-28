import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterAll, afterEach, beforeAll, test } from 'vitest';

import { useGitPanelScrollMemory } from '@/modules/git-panel/hooks/useGitPanelScrollMemory';
import { clearGitPanelSnapshots } from '@/modules/git-panel/utils/gitPanelStateCache';

/**
 * [local] The Source Control tab unmounts whenever another tab opens. Coming back,
 * each view is scrolled where it was left, like the Files tab.
 */

// jsdom keeps no scroll position; give elements a writable one.
const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return (this as { _scrollTop?: number })._scrollTop ?? 0; },
    set(value: number) { (this as { _scrollTop?: number })._scrollTop = value; },
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  if (scrollTopDescriptor) Object.defineProperty(Element.prototype, 'scrollTop', scrollTopDescriptor);
});
afterEach(() => clearGitPanelSnapshots());

function Panel({ project, view, ready = true }: { project: string; view: string; ready?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useGitPanelScrollMemory(ref, `${project}:${view}`, ready);
  return (
    <div ref={ref}>
      {ready ? (
        <div key={view} data-testid="scroller" data-git-panel-scroll>
          <div className="max-h-96 overflow-y-auto" data-testid="nested" />
        </div>
      ) : (
        <div data-testid="spinner" />
      )}
    </div>
  );
}

const scrollTo = (element: HTMLElement, top: number) => {
  element.scrollTop = top;
  fireEvent.scroll(element);
};

test('the scroll position comes back when the tab is reopened', () => {
  const first = render(<Panel project="p1" view="changes" />);
  scrollTo(first.getByTestId('scroller'), 320);
  first.unmount();

  const second = render(<Panel project="p1" view="changes" />);
  assert.equal(second.getByTestId('scroller').scrollTop, 320);
});

test('each view and each project keeps its own position', () => {
  const panel = render(<Panel project="p1" view="changes" />);
  scrollTo(panel.getByTestId('scroller'), 100);

  panel.rerender(<Panel project="p1" view="history" />);
  assert.equal(panel.getByTestId('scroller').scrollTop, 0);
  scrollTo(panel.getByTestId('scroller'), 50);

  panel.rerender(<Panel project="p1" view="changes" />);
  assert.equal(panel.getByTestId('scroller').scrollTop, 100);

  panel.rerender(<Panel project="p2" view="changes" />);
  assert.equal(panel.getByTestId('scroller').scrollTop, 0);
});

test('nested scrollers do not overwrite the list position, and loading waits', () => {
  const panel = render(<Panel project="p1" view="changes" />);
  scrollTo(panel.getByTestId('scroller'), 200);
  scrollTo(panel.getByTestId('nested'), 999);
  panel.unmount();

  const loading = render(<Panel project="p1" view="changes" ready={false} />);
  loading.rerender(<Panel project="p1" view="changes" />);
  assert.equal(loading.getByTestId('scroller').scrollTop, 200);
});
