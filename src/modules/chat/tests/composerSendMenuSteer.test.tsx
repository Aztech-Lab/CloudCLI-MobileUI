import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerSendMenu from '@/modules/chat/composer/ComposerSendMenu';

/**
 * The send menu's Steer row: while a turn is written, a provider that can take
 * a message into the running turn gets a row for it right under Queue. It is
 * gated by the capability like the side-question row, and only a turn being
 * written has anything to steer — background-only work does not.
 */

const renderMenu = (
  state: 'responding' | 'background',
  { supportsSteering = true, hasInput = true }: { supportsSteering?: boolean; hasInput?: boolean } = {},
) => {
  const onSelect = vi.fn<(choice: string) => void>();
  render(
    <ComposerSendMenu
      state={state}
      hasInput={hasInput}
      supportsSideQuestions
      supportsSteering={supportsSteering}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
};

const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  return screen.getByRole('menu');
};

const labels = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
  .map((row) => (row.textContent ?? '').replace(/(Queue|Send now|Send anyway|Send|Side question|Stop).*/s, '$1'));

const row = (menu: HTMLElement, label: string) => {
  const found = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    .find((candidate) => (candidate.textContent ?? '').startsWith(label));
  assert.ok(found, `the menu has a "${label}" row`);
  return found;
};

afterEach(() => {
  vi.restoreAllMocks();
});

// [local] Steering is what a plain send does during a turn, so its row (named
// Send, carrying the Enter hint) comes first, then Send now, then Queue.
test('while a turn is written, Send (steer) and Send now come before Queue and report their choice', () => {
  const { onSelect } = renderMenu('responding');
  const menu = open();

  assert.deepEqual(labels(menu), ['Send', 'Send now', 'Queue', 'Side question', 'Stop']);
  assert.match(row(menu, 'Send').textContent ?? '', /Read at the next tool call/);
  assert.match(row(menu, 'Send').textContent ?? '', /↵/);
  assert.doesNotMatch(row(menu, 'Queue').textContent ?? '', /↵/, 'Enter no longer queues');
  assert.match(row(menu, 'Send now').textContent ?? '', /moves to the background/);

  fireEvent.click(row(menu, 'Send'));
  assert.deepEqual(onSelect.mock.calls, [['steer']]);
});

test('Send now reports its own choice', () => {
  const { onSelect } = renderMenu('responding');
  fireEvent.click(row(open(), 'Send now'));
  assert.deepEqual(onSelect.mock.calls, [['sendNow']]);
});

test('a provider that cannot steer gets no Steer row', () => {
  renderMenu('responding', { supportsSteering: false });

  assert.deepEqual(labels(open()), ['Queue', 'Side question', 'Stop']);
});

test('background-only work has no turn to steer, so the row is left out', () => {
  renderMenu('background');

  assert.deepEqual(labels(open()), ['Queue', 'Side question', 'Send anyway']);
});

test('without input, Send and Send now are disabled like Queue', () => {
  const { onSelect } = renderMenu('responding', { hasInput: false });
  const menu = open();

  for (const label of ['Send', 'Send now']) {
    const steer = row(menu, label) as HTMLButtonElement;
    assert.ok(steer.disabled || steer.getAttribute('aria-disabled') === 'true');
    fireEvent.click(steer);
  }
  assert.equal(onSelect.mock.calls.length, 0);
});
