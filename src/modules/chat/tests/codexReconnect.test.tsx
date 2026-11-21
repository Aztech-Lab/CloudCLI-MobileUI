import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { i18n } from '@/modules/i18n';
import zhCNChat from '@/modules/i18n/locales/zh-CN/chat.json';
import zhTWChat from '@/modules/i18n/locales/zh-TW/chat.json';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ThreadHeldElsewhereStatus from '@/modules/chat/transcript/ThreadHeldElsewhereStatus';
import { isThreadHeldElsewhere } from '@/modules/chat/utils/threadHeldElsewhere';
import {
  historyCardDedupeKey,
  reconcileLiveCardsWithHistory,
} from '@/modules/chat/utils/sessionMessageReconciliation';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/**
 * [local] Stage 5 of the Codex parity plan, on the client: a reload never
 * shows a card twice when the live card and the rollout's name a call
 * differently, the report rows read in the user's language, and a thread open
 * in the Codex app says so at the top of the conversation.
 */

const at = (minute: number, second = 0) => `2026-11-20T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const base = { sessionId: 's1', provider: 'codex' as const };

// What the history reader builds from the rollout (ids are its call ids).
const historyAgentCard: NormalizedMessage = {
  ...base,
  id: 'hist-task',
  timestamp: at(0, 1),
  kind: 'tool_use',
  toolName: 'Task',
  toolInput: JSON.stringify({ description: 'Survey B' }),
  toolId: 'call_spawn',
  subagent: { id: 'child-1', description: 'Survey B', status: 'running' },
};
const historyCommand = (toolId: string, minute: number, command = 'npm run dev'): NormalizedMessage => ({
  ...base,
  id: `hist-${toolId}`,
  timestamp: at(minute, 1),
  kind: 'tool_use',
  toolName: 'Bash',
  toolInput: JSON.stringify({ command }),
  toolId,
});

// What the app-server runtime sent live (ids are the protocol's item ids).
const liveAgentCard = (status: 'running' | 'completed'): NormalizedMessage => ({
  ...base,
  id: 'item-spawn',
  timestamp: at(0, 2),
  kind: 'tool_use',
  toolName: 'Task',
  toolInput: { description: 'Survey B' },
  toolId: 'item-spawn',
  dedupeKey: 'agent:child-1',
  subagent: { id: 'child-1', description: 'Survey B', status },
});
const liveAgentResult: NormalizedMessage = {
  ...base, id: 'item-spawn_result', timestamp: at(0, 30), kind: 'tool_result', toolId: 'item-spawn', content: 'B has 7 files.',
};
const liveAgentStatus: NormalizedMessage = {
  ...base, id: 'bgagent_item-spawn_notification_completed', timestamp: at(0, 30), kind: 'task_status',
  event: 'notification', status: 'completed', toolUseId: 'item-spawn', taskType: 'local_agent',
};
const liveAgentActivity: NormalizedMessage = {
  ...base, id: 'item-spawn_cc1', timestamp: at(0, 10), kind: 'tool_use', toolName: 'Bash',
  toolInput: { command: 'ls B' }, toolId: 'cc1', parentToolUseId: 'item-spawn',
};
const liveCommand = (toolId: string, minute: number, command = 'npm run dev'): NormalizedMessage => ({
  ...base,
  id: toolId,
  timestamp: at(minute, 3),
  kind: 'tool_use',
  toolName: 'Bash',
  toolInput: { command },
  toolId,
  status: 'in_progress',
  dedupeKey: `bash:${command}`,
});
const liveCommandStatus = (toolId: string): NormalizedMessage => ({
  ...base, id: `bgterm_1001_started_running`, timestamp: at(0, 4), kind: 'task_status',
  event: 'started', status: 'running', taskId: '1001', toolUseId: toolId, taskType: 'local_bash',
});

describe('live cards the history holds under another id', () => {
  it('keys a history card by its agent thread or its command', () => {
    expect(historyCardDedupeKey(historyAgentCard)).toBe('agent:child-1');
    expect(historyCardDedupeKey(historyCommand('call_1', 0))).toBe('bash:npm run dev');
    expect(historyCardDedupeKey({ ...historyCommand('call_1', 0), toolName: 'Read' })).toBeNull();
  });

  it('drops the live agent card and points its result, status and activity at the history card', () => {
    const live = [liveAgentCard('running'), liveAgentActivity, liveAgentCard('completed'), liveAgentResult, liveAgentStatus];
    const reconciled = reconcileLiveCardsWithHistory([historyAgentCard], live);
    expect(reconciled.some((message) => message.kind === 'tool_use' && message.toolId === 'item-spawn')).toBe(false);
    expect(reconciled.find((message) => message.kind === 'tool_result')?.toolId).toBe('call_spawn');
    expect(reconciled.find((message) => message.kind === 'task_status')?.toolUseId).toBe('call_spawn');
    expect(reconciled.find((message) => message.id === 'item-spawn_cc1')?.parentToolUseId).toBe('call_spawn');

    // Drawn as one card, with the live result and status.
    const rows = normalizedToChatMessages([historyAgentCard, ...reconciled]);
    const cards = rows.filter((row) => row.isToolUse && row.toolName === 'Task');
    expect(cards).toHaveLength(1);
    expect(cards[0].toolId).toBe('call_spawn');
    expect(cards[0].toolResult?.content).toBe('B has 7 files.');
    expect(cards[0].taskStatus?.status).toBe('completed');
  });

  it('a live result is dropped when the history already has the card\'s result', () => {
    const historyResult: NormalizedMessage = { ...base, id: 'hist-result', timestamp: at(0, 31), kind: 'tool_result', toolId: 'call_spawn', content: 'B has 7 files.' };
    const reconciled = reconcileLiveCardsWithHistory([historyAgentCard, historyResult], [liveAgentCard('completed'), liveAgentResult]);
    expect(reconciled).toEqual([]);
  });

  it('matches a live command card to the history card of the same command stamped nearest, not an earlier run', () => {
    // `npm run dev` ran five minutes earlier too; only the run seconds away is this card.
    const server = [historyCommand('call_old', 0), historyCommand('call_new', 5)];
    const reconciled = reconcileLiveCardsWithHistory(server, [liveCommand('item-cmd', 5), liveCommandStatus('item-cmd')]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].toolUseId).toBe('call_new');
  });

  it('keeps a live command card the history does not hold yet', () => {
    const server = [historyCommand('call_old', 0)];
    const live = [liveCommand('item-cmd', 5)];
    expect(reconcileLiveCardsWithHistory(server, live)).toBe(live);
  });

  it('leaves rows without a key alone (Claude, Codex exec): the same array', () => {
    const live: NormalizedMessage[] = [{ ...historyCommand('toolu_1', 0), provider: 'claude', id: 'toolu_1' }];
    expect(reconcileLiveCardsWithHistory([historyCommand('call_x', 0)], live)).toBe(live);
  });

  it('a live card with the history card\'s own id is left to the id match', () => {
    const sameId = { ...liveCommand('call_new', 5) };
    const live = [sameId];
    expect(reconcileLiveCardsWithHistory([historyCommand('call_new', 5)], live)).toBe(live);
  });
});

const reportRow = (notice: NormalizedMessage['notice'], summary: string): NormalizedMessage => ({
  ...base,
  id: 'bgterm_1001_report',
  timestamp: at(1),
  kind: 'task_notification',
  status: 'completed',
  summary,
  notice,
});

const renderRow = (message: ChatMessage, provider: 'codex' | 'claude' = 'codex') =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider={provider} />
    </UiPreferencesProvider>,
  );

describe('report rows', () => {
  it('read in the user\'s language, with the English text as the fallback', async () => {
    const [row] = normalizedToChatMessages([reportRow(
      { code: 'codex_agent_finished_result', params: { name: 'Survey B', result: 'B has 7 files.' } },
      'Agent finished: Survey B — B has 7 files.',
    )]);
    expect(row.taskNotificationNotice?.code).toBe('codex_agent_finished_result');
    const english = renderRow(row);
    expect(english.container.textContent).toContain('Agent finished: Survey B — B has 7 files.');
    english.unmount();

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    try {
      const chinese = renderRow(row);
      expect(chinese.container.textContent).toContain('代理已完成：Survey B — B has 7 files.');
      chinese.unmount();
      const [command] = normalizedToChatMessages([reportRow(
        { code: 'codex_background_command_finished', params: { command: 'npm run dev <x>' } },
        'Background command finished: npm run dev <x>',
      )]);
      const commandRow = renderRow(command);
      // Values are shown as written, not HTML-escaped.
      expect(commandRow.container.textContent).toContain('后台命令已结束：npm run dev <x>');
      commandRow.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('an unknown code, or a row without one (Claude), shows the text the server sent', () => {
    const [unknown] = normalizedToChatMessages([reportRow({ code: 'not_a_code', params: {} }, 'Something finished.')]);
    const first = renderRow(unknown);
    expect(first.container.textContent).toContain('Something finished.');
    first.unmount();
    const [claude] = normalizedToChatMessages([{ ...reportRow(undefined, 'Agent "x" completed'), provider: 'claude' }]);
    expect(claude.taskNotificationNotice).toBeUndefined();
    const second = renderRow(claude, 'claude');
    expect(second.container.textContent).toContain('Agent "x" completed');
    second.unmount();
  });

  it('has every code in zh-CN and zh-TW', () => {
    for (const code of ['codex_background_command_finished', 'codex_agent_finished', 'codex_agent_finished_result', 'codex_agent_failed', 'codex_agent_stopped']) {
      expect((zhCNChat.taskNotices as Record<string, string>)[code]).toBeTruthy();
      expect((zhTWChat.taskNotices as Record<string, string>)[code]).toBeTruthy();
    }
  });
});

const heldError: NormalizedMessage = {
  ...base, id: 'err-1', timestamp: at(2), kind: 'error', content: 'This conversation is open in the Codex app…', errorCode: 'codex_thread_active_writer',
};
const userEcho: NormalizedMessage = { ...base, id: 'local_1', timestamp: at(2), kind: 'text', role: 'user', content: 'hi' };
const reply: NormalizedMessage = { ...base, id: 'r1', timestamp: at(3), kind: 'text', role: 'assistant', content: 'Hello' };

describe('a thread open in the Codex app', () => {
  it('is read from the last refused send, until the conversation moves on', () => {
    expect(isThreadHeldElsewhere(normalizedToChatMessages([userEcho, heldError]))).toBe(true);
    expect(isThreadHeldElsewhere(normalizedToChatMessages([heldError, userEcho]))).toBe(true);
    expect(isThreadHeldElsewhere(normalizedToChatMessages([heldError, { ...userEcho, id: 'u2', timestamp: at(3) }, reply]))).toBe(false);
    expect(isThreadHeldElsewhere(normalizedToChatMessages([reply]))).toBe(false);
    expect(isThreadHeldElsewhere([])).toBe(false);
  });

  it('shows a status at the top only where the provider can say so, and not while a turn runs', async () => {
    const messages = normalizedToChatMessages([userEcho, heldError]);
    const { rerender, unmount } = render(<ThreadHeldElsewhereStatus enabled isProcessing={false} messages={messages} />);
    expect(screen.getByTestId('thread-held-elsewhere').textContent).toContain('Open in the Codex app');
    rerender(<ThreadHeldElsewhereStatus enabled isProcessing messages={messages} />);
    expect(screen.queryByTestId('thread-held-elsewhere')).toBeNull();
    rerender(<ThreadHeldElsewhereStatus enabled={false} isProcessing={false} messages={messages} />);
    expect(screen.queryByTestId('thread-held-elsewhere')).toBeNull();
    unmount();

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    try {
      const chinese = render(<ThreadHeldElsewhereStatus enabled isProcessing={false} messages={messages} />);
      expect(chinese.container.textContent).toContain(zhCNChat.threadHeldElsewhere.label);
      chinese.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });
});
