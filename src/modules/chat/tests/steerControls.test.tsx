import assert from 'node:assert/strict';

import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import SteeredMessageCard from '@/modules/chat/composer/SteeredMessageCard';
import { ToolCardActionsContext } from '@/modules/chat/context/ToolCardActionsContext';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { NormalizedMessage, PendingSteer, ProjectSession, ServerEvent, SteerOutcome } from '@/shared/types';

/**
 * [local] The UI around a message sent into a running turn and around a
 * running foreground tool call:
 * - the steered-message card shows when it will be read and offers Withdraw
 *   while it is unread;
 * - the realtime handler turns `chat_steer_cancelled` into the composer's
 *   outcome, and a refused "Move to background" into the tool card's note
 *   without idling the session or adding an error row;
 * - a running foreground Bash or agent card offers "Move to background", and
 *   nothing else does.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const steer = (fields: Partial<PendingSteer> = {}): PendingSteer => ({
  messageId: '0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f',
  sessionKey: 'session-1',
  content: 'check the logs too',
  attachments: [],
  uploadedAttachments: [],
  status: 'accepted',
  ...fields,
});

test('an unread steered message can be withdrawn from its card', () => {
  const onWithdraw = vi.fn();
  render(<SteeredMessageCard steer={steer()} providerLabel="Claude" onWithdraw={onWithdraw} />);

  assert.ok(screen.getByText(/Claude reads it at its next tool call/));
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  assert.deepEqual(onWithdraw.mock.calls, [['0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f']]);
});

test('the card has no Withdraw before the server took the message, while withdrawing, or once too late', () => {
  for (const fields of [{ status: 'sending' as const }, { status: 'withdrawing' as const }, { withdrawFailed: true }]) {
    const { unmount } = render(<SteeredMessageCard steer={steer(fields)} providerLabel="Claude" onWithdraw={() => {}} />);
    assert.equal(screen.queryByRole('button', { name: 'Withdraw' }), null, JSON.stringify(fields));
    unmount();
  }
  render(<SteeredMessageCard steer={steer({ withdrawFailed: true })} providerLabel="Claude" onWithdraw={() => {}} />);
  assert.ok(screen.getByText(/Too late to withdraw: Claude is already reading it/));
});

test('a message sent with Send now says it is read right away', () => {
  render(<SteeredMessageCard steer={steer({ urgent: true })} providerLabel="Claude" />);
  assert.ok(screen.getByText(/Claude reads it right away/));
  assert.ok(screen.getByText('Sent now'));
});

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const idled: string[] = [];
  const outcomes: Array<[string, string, SteerOutcome]> = [];
  const refusals: Array<[string, string]> = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'session-1' } as ProjectSession,
    currentSessionId: 'session-1',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: () => {},
    onSessionIdle: (sessionId) => { if (sessionId) idled.push(sessionId); },
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
    onSteerOutcome: (sessionId, messageId, outcome) => { outcomes.push([sessionId, messageId, outcome]); },
    onBackgroundTaskRefused: (sessionId, toolUseId) => { refusals.push([sessionId, toolUseId]); },
  }));

  const dispatch = (event: Record<string, unknown>) => listener?.({ sessionId: 'session-1', ...event } as ServerEvent);
  return { dispatch, stored, idled, outcomes, refusals };
};

test('the answer to a withdraw reaches the composer as withdrawn or too late', () => {
  const { dispatch, outcomes, stored } = renderHandlers();

  dispatch({ kind: 'chat_steer_cancelled', messageId: 'm-1', cancelled: true });
  dispatch({ kind: 'chat_steer_cancelled', messageId: 'm-2', cancelled: false });

  assert.deepEqual(outcomes, [['session-1', 'm-1', 'withdrawn'], ['session-1', 'm-2', 'notWithdrawn']]);
  assert.equal(stored.length, 0, 'not a transcript row');
});

test('a refused Move to background goes to the tool card, without idling the session or an error row', () => {
  const { dispatch, refusals, idled, stored } = renderHandlers();

  dispatch({ kind: 'protocol_error', code: 'BACKGROUND_UNAVAILABLE', error: 'nothing moved', toolUseId: 'toolu_1' });

  assert.deepEqual(refusals, [['session-1', 'toolu_1']]);
  assert.deepEqual(idled, []);
  assert.equal(stored.length, 0);
});

const toolRow = (toolName: string, toolInput: Record<string, unknown>, withResult = false): NormalizedMessage[] => [
  {
    id: 'row-tool',
    sessionId: 'session-1',
    timestamp: '2026-11-16T10:00:00.000Z',
    provider: 'claude',
    kind: 'tool_use',
    toolName,
    toolId: 'toolu_1',
    toolInput,
  } as NormalizedMessage,
  ...(withResult ? [{
    id: 'row-result',
    sessionId: 'session-1',
    timestamp: '2026-11-16T10:00:01.000Z',
    provider: 'claude',
    kind: 'tool_result',
    toolId: 'toolu_1',
    content: 'done',
    isError: false,
  } as NormalizedMessage] : []),
];

const renderTool = (rows: NormalizedMessage[], moveToBackground: ((toolUseId: string) => void) | null, refusedAt = new Map<string, number>()) => {
  const [message] = normalizedToChatMessages(rows);
  return render(
    <UiPreferencesProvider>
      <ToolCardActionsContext.Provider value={{ moveToBackground, refusedAt }}>
        <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
      </ToolCardActionsContext.Provider>
    </UiPreferencesProvider>,
  );
};

test('a running foreground command offers Move to background, which names its tool call', () => {
  const move = vi.fn();
  renderTool(toolRow('Bash', { command: 'npm test' }), move);

  fireEvent.click(screen.getByRole('button', { name: 'Move to background' }));
  assert.deepEqual(move.mock.calls, [['toolu_1']]);
  assert.ok(screen.getByRole('button', { name: 'Moving…' }));
});

test('a running foreground agent offers Move to background too', () => {
  renderTool(toolRow('Agent', { description: 'Survey', prompt: 'look' }), () => {});
  assert.ok(screen.getByRole('button', { name: 'Move to background' }));
});

test('a finished call, a background launch, another tool, or no running turn offer nothing', () => {
  const cases: Array<[NormalizedMessage[], ((toolUseId: string) => void) | null]> = [
    [toolRow('Bash', { command: 'npm test' }, true), () => {}],
    [toolRow('Bash', { command: 'npm test', run_in_background: true }), () => {}],
    [toolRow('Read', { file_path: '/repo/a.ts' }), () => {}],
    [toolRow('Bash', { command: 'npm test' }), null],
  ];
  for (const [rows, move] of cases) {
    const { unmount } = renderTool(rows, move);
    assert.equal(screen.queryByRole('button', { name: 'Move to background' }), null);
    unmount();
  }
});

test('a Move to background the server refused says so and can be tried again', () => {
  const move = vi.fn();
  const { rerender } = renderTool(toolRow('Bash', { command: 'npm test' }), move);
  fireEvent.click(screen.getByRole('button', { name: 'Move to background' }));

  const [message] = normalizedToChatMessages(toolRow('Bash', { command: 'npm test' }));
  rerender(
    <UiPreferencesProvider>
      <ToolCardActionsContext.Provider value={{ moveToBackground: move, refusedAt: new Map([['toolu_1', Date.now() + 1]]) }}>
        <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
      </ToolCardActionsContext.Provider>
    </UiPreferencesProvider>,
  );

  assert.ok(screen.getByText('Could not move it to the background'));
  assert.ok(screen.getByRole('button', { name: 'Move to background' }), 'enabled again');
});
