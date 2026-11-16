import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import enChat from '@/modules/i18n/locales/en/chat.json';
import zhCNChat from '@/modules/i18n/locales/zh-CN/chat.json';
import zhTWChat from '@/modules/i18n/locales/zh-TW/chat.json';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/**
 * [local] A server restart ends a session's background work. The session's
 * history then carries one row saying so (synthesized by the server with the
 * code `background_work_lost_on_restart`), which reads in the user's language.
 */

const ENGLISH = 'Background work was stopped by a server restart. Agents, workflows and commands that were still running did not finish.';

const notice: NormalizedMessage = {
  id: 'background_work_lost_1',
  sessionId: 'session-1',
  timestamp: '2026-11-16T12:00:00.000Z',
  provider: 'claude',
  kind: 'error',
  content: ENGLISH,
  errorCode: 'background_work_lost_on_restart',
};

const renderRow = (message: ChatMessage) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );

test('the restart notice has a text in every shipped language', () => {
  for (const locale of [enChat, zhCNChat, zhTWChat]) {
    const text = (locale as { errors?: Record<string, string> }).errors?.background_work_lost_on_restart;
    assert.ok(typeof text === 'string' && text.length > 0);
  }
  assert.equal(enChat.errors.background_work_lost_on_restart, ENGLISH, 'the server\'s fallback text matches');
});

test('the restart notice reads in the user\'s language', async () => {
  const [row] = normalizedToChatMessages([notice]);
  assert.ok(row);
  const english = renderRow(row);
  assert.ok(english.container.textContent?.includes(ENGLISH));
  english.unmount();

  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  try {
    const chinese = renderRow(row);
    assert.ok(chinese.container.textContent?.includes(zhCNChat.errors.background_work_lost_on_restart));
    chinese.unmount();
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }
});
