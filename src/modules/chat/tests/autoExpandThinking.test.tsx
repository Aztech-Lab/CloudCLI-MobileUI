import assert from 'node:assert/strict';

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/modules/chat/transcript/Reasoning';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

/**
 * The "auto-expand thinking" preference opens thinking blocks by default. A
 * block follows the preference live until the user opens or closes it by hand.
 */

const isOpen = (container: HTMLElement) =>
  container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true';

const renderReasoning = (props: { autoOpen?: boolean; defaultOpen?: boolean }) =>
  (
    <Reasoning {...props}>
      <ReasoningTrigger />
      <ReasoningContent>thought</ReasoningContent>
    </Reasoning>
  );

test('a Reasoning block without autoOpen keeps its upstream default (closed)', () => {
  const { container } = render(renderReasoning({ defaultOpen: false }));
  assert.equal(isOpen(container), false);
});

test('autoOpen opens the block on first render', () => {
  const { container } = render(renderReasoning({ defaultOpen: false, autoOpen: true }));
  assert.equal(isOpen(container), true);
});

test('the block follows autoOpen as the preference changes', () => {
  const { container, rerender } = render(renderReasoning({ defaultOpen: false, autoOpen: false }));
  assert.equal(isOpen(container), false);

  rerender(renderReasoning({ defaultOpen: false, autoOpen: true }));
  assert.equal(isOpen(container), true);

  rerender(renderReasoning({ defaultOpen: false, autoOpen: false }));
  assert.equal(isOpen(container), false);
});

test('a block the user collapsed stays collapsed when the preference changes', () => {
  const { container, rerender } = render(renderReasoning({ defaultOpen: false, autoOpen: true }));
  fireEvent.click(container.querySelector('button[aria-expanded]')!);
  assert.equal(isOpen(container), false);

  rerender(renderReasoning({ defaultOpen: false, autoOpen: false }));
  rerender(renderReasoning({ defaultOpen: false, autoOpen: true }));
  assert.equal(isOpen(container), false);
});

const thinkingMessage: ChatMessage = {
  type: 'assistant',
  content: 'Let me check the config first.',
  timestamp: '2026-11-27T12:00:00.000Z',
  isThinking: true,
};

const renderThinking = (message: ChatMessage, autoExpandThinking: boolean, provider = 'claude') => (
  <UiPreferencesProvider>
    <MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider={provider}
      showThinking
      autoExpandThinking={autoExpandThinking}
    />
  </UiPreferencesProvider>
);

test('a thinking message is collapsed by default, as before', () => {
  const { container } = render(renderThinking(thinkingMessage, false));
  assert.equal(isOpen(container), false);
});

test('a thinking message from Claude or Codex is expanded when the preference is on', () => {
  for (const provider of ['claude', 'codex']) {
    const { container, unmount } = render(renderThinking(thinkingMessage, true, provider));
    assert.equal(isOpen(container), true, provider);
    unmount();
  }
});

test('streaming thinking stays expanded as its text grows', () => {
  const { container, rerender } = render(renderThinking(thinkingMessage, true));
  rerender(renderThinking({ ...thinkingMessage, content: `${thinkingMessage.content} Then the tests.` }, true));
  assert.equal(isOpen(container), true);
  assert.match(container.textContent ?? '', /Then the tests\./);
});
