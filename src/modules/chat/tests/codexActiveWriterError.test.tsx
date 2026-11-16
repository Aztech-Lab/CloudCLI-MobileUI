import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import zhCNChat from '@/modules/i18n/locales/zh-CN/chat.json';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/**
 * Codex allows one writer per thread. When the Codex app holds the thread, the
 * server sends an error row with a stable code; the row reads in the user's
 * language, and the English text it carries is the fallback.
 */

const ENGLISH = 'This conversation is open in the Codex app, which allows only one writer at a time. '
  + 'Close it there (or continue there), then send again.';

const errorRow = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: 'error-1',
  sessionId: 'session-1',
  timestamp: '2026-11-16T12:00:00.000Z',
  provider: 'codex',
  kind: 'error',
  content: ENGLISH,
  errorCode: 'codex_thread_active_writer',
  ...overrides,
});

const renderRow = (message: ChatMessage) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex" />
    </UiPreferencesProvider>,
  );

test('the error code survives the conversion into a rendered message', () => {
  const [row] = normalizedToChatMessages([errorRow()]);
  assert.equal(row?.type, 'error');
  assert.equal(row?.errorCode, 'codex_thread_active_writer');
});

test('the active-writer error reads in the user\'s language', async () => {
  const [row] = normalizedToChatMessages([errorRow()]);
  assert.ok(row);
  const english = renderRow(row);
  assert.ok(english.container.textContent?.includes(ENGLISH));
  english.unmount();

  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  try {
    const chinese = renderRow(row);
    assert.ok(chinese.container.textContent?.includes(zhCNChat.errors.codex_thread_active_writer));
    chinese.unmount();
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }
});

test('an error code with no translation shows the text the server sent', () => {
  const [row] = normalizedToChatMessages([errorRow({ content: 'Something else failed.', errorCode: 'not_a_known_code' })]);
  assert.ok(row);
  const { container } = renderRow(row);
  assert.ok(container.textContent?.includes('Something else failed.'));
});
