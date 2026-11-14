import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerSendMenu from '@/modules/chat/composer/ComposerSendMenu';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { NormalizedMessage, PermissionMode, Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * [local] The client side of sending into a session's running process, end to
 * end: the activity map, the realtime handler and the composer wired together
 * as ChatInterface wires them, driven by the frames the server sends.
 *
 * 1. A Stop that ended only the turn written into the process
 *    (`complete` with `aborted` and `backgroundContinues`) leaves the session
 *    in background, not idle.
 * 2. Enter afterwards sends `chat.send` with `adoptHeld` and no dialog.
 * 3. `ADOPT_UNAVAILABLE` takes the message out of the transcript, puts it back
 *    in the composer and opens the dialog, without idling the session.
 * 4. An edit sent over background work offers "Send anyway — this stops the
 *    background work" and asks before sending.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Frame = { type: string; content?: string; options?: Record<string, unknown> };

const renderSession = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const rows: NormalizedMessage[] = [];
  const sent: Frame[] = [];
  const store = {
    appendRealtime: (_sessionId: string, message: NormalizedMessage) => { rows.push(message); },
    removeRealtime: (_sessionId: string, messageId: string) => {
      const index = rows.findIndex((row) => row.id === messageId);
      if (index >= 0) rows.splice(index, 1);
    },
    getMessages: () => rows,
    updateStreaming: () => {},
    finalizeStreaming: () => {},
  };

  const view = renderHook(() => {
    const protection = useSessionProtection();
    const activity = protection.processingSessions.get(SESSION.id as string);
    const isProcessing = Boolean(activity && !activity.background);
    const composer = useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id as string,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: isProcessing,
      processingSessions: protection.processingSessions,
      canAbortSession: isProcessing,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as Frame); },
      supportsBackgroundAdoption: true,
      onSessionProcessing: protection.markSessionProcessing,
      onSessionBackground: protection.markSessionBackground,
      removeOptimisticMessage: store.removeRealtime,
      scrollToBottom: () => undefined,
      // The optimistic echo, stored the way useChatSessionState stores it.
      addMessage: (message) => {
        store.appendRealtime(SESSION.id as string, {
          id: message.optimisticId ?? `local_${rows.length}`,
          sessionId: SESSION.id,
          provider: 'claude',
          timestamp: new Date().toISOString(),
          kind: message.type === 'error' ? 'error' : 'text',
          role: message.type === 'user' ? 'user' : 'assistant',
          content: message.content ?? '',
        } as NormalizedMessage);
      },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    });
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = null; };
      },
      provider: 'claude',
      selectedSession: SESSION,
      currentSessionId: SESSION.id as string,
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      streamTimerRef: { current: null },
      accumulatedStreamRef: { current: '' },
      lastSeqRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() },
      onSessionProcessing: protection.markSessionProcessing,
      onSessionIdle: protection.markSessionIdle,
      onSessionBackground: protection.markSessionBackground,
      getSessionActivity: protection.getSessionActivity,
      requestLatestMessages: async () => {},
      sessionStore: store as unknown as SessionStore,
      onSteerOutcome: composer.handleSteerOutcome,
      onAdoptRefused: composer.handleAdoptRefused,
    });
    return { activity, composer };
  });

  const dispatch = (fields: Record<string, unknown>) => {
    act(() => {
      listener?.({
        id: `event-${Math.random()}`,
        sessionId: SESSION.id,
        provider: 'claude',
        timestamp: '2026-08-21T10:32:10.000Z',
        ...fields,
      } as unknown as ServerEvent);
    });
  };
  const sends = () => sent.filter((frame) => frame.type === 'chat.send');
  return { view, dispatch, rows, sent, sends };
};

type Session = ReturnType<typeof renderSession>;

const enter = () => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  nativeEvent: { isComposing: false },
  preventDefault: () => undefined,
}) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const typeAndEnter = async ({ view }: Session, text: string) => {
  await act(async () => { view.result.current.composer.setInput(text); });
  await act(async () => {
    view.result.current.composer.handleKeyDown(enter());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

// A turn that launched a background agent and ended: the session is left
// with the agent running.
const launchAgentAndEndTurn = ({ dispatch }: Session) => {
  dispatch({ kind: 'tool_use', toolId: 'toolu_agent_1', toolName: 'Agent', toolInput: { description: 'Survey the repo', prompt: 'look', run_in_background: true } });
  dispatch({ kind: 'tool_result', toolId: 'toolu_agent_1', content: 'Async agent launched', toolUseResult: { status: 'async_launched', agentId: 'a1' } });
  dispatch({ kind: 'task_status', event: 'started', taskId: 'a1', toolUseId: 'toolu_agent_1', taskType: 'local_agent', description: 'Survey the repo' });
  dispatch({ kind: 'complete', exitCode: 0, success: true });
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  resetChatDrafts();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('Stop on a turn sent into the running process keeps the session in background, and Enter then sends into it again', async () => {
  const session = renderSession();
  const { view, dispatch, sends } = session;
  launchAgentAndEndTurn(session);
  assert.equal(view.result.current.activity?.background, true);

  // A follow-up joins the running process; the session is processing it.
  await typeAndEnter(session, 'first follow-up');
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].options?.adoptHeld, true);
  assert.equal(view.result.current.activity?.background, undefined, 'processing the follow-up');

  // Stop ended only that turn: the agent keeps running.
  dispatch({ kind: 'complete', exitCode: 0, aborted: true, backgroundContinues: true });
  assert.equal(view.result.current.activity?.background, true, 'back to background, not idle');
  assert.deepEqual(view.result.current.activity?.tasks?.map((task) => task.taskId), ['a1']);

  // Enter afterwards: straight into the process again, no dialog.
  await typeAndEnter(session, 'second follow-up');
  assert.equal(view.result.current.composer.backgroundSendPrompt, null);
  assert.equal(sends().length, 2);
  assert.equal(sends()[1].content, 'second follow-up');
  assert.equal(sends()[1].options?.adoptHeld, true);
  assert.match(String(sends()[1].options?.messageId), UUID_V4);
});

test('ADOPT_UNAVAILABLE puts the message back in the composer and opens the dialog without idling the session', async () => {
  const session = renderSession();
  const { view, dispatch, rows, sends } = session;
  launchAgentAndEndTurn(session);

  await typeAndEnter(session, 'please continue');
  const messageId = String(sends()[0].options?.messageId);
  assert.ok(rows.some((row) => row.id === `local_adopt_${messageId}`), 'the optimistic row is shown');

  dispatch({
    kind: 'protocol_error',
    code: 'ADOPT_UNAVAILABLE',
    error: 'The message could not join the running session',
    messageId,
  });

  assert.ok(!rows.some((row) => row.id === `local_adopt_${messageId}`), 'the optimistic row is withdrawn');
  assert.ok(!rows.some((row) => row.kind === 'error'), 'no error row');
  assert.equal(view.result.current.composer.input, 'please continue', 'the text is back in the composer');
  assert.equal(view.result.current.activity?.background, true, 'the session is back to its background work, not idle');
  await waitFor(() => assert.notEqual(view.result.current.composer.backgroundSendPrompt, null));
  assert.equal(view.result.current.composer.backgroundSendPrompt?.adoptRefused, true);

  // The run's end follows the refusal; the agent still runs.
  dispatch({ kind: 'complete', exitCode: 1, success: false });
  assert.equal(view.result.current.activity?.background, true);
  assert.notEqual(view.result.current.composer.backgroundSendPrompt, null, 'the dialog stays open');

  // Send anyway now stops the work, and says so to the server.
  await act(async () => {
    view.result.current.composer.resolveBackgroundSendPrompt('send');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(sends().length, 2);
  assert.equal(sends()[1].content, 'please continue');
  assert.equal(sends()[1].options?.adoptHeld, false);
});

test('an edit sent over background work offers Send anyway, which stops the work, and asks first', async () => {
  const session = renderSession();
  const { view, sent } = session;
  launchAgentAndEndTurn(session);

  await act(async () => {
    view.result.current.composer.beginEditMessage({ type: 'user', content: 'old question', transcriptAnchorId: 'anchor-1', timestamp: new Date() });
  });
  await act(async () => { view.result.current.composer.setInput('better question'); });
  assert.equal(view.result.current.composer.adoptsBackground, false);

  // The menu the composer draws for this state and this message.
  render(
    <ComposerSendMenu
      state="background"
      hasInput
      adoptsBackground={view.result.current.composer.adoptsBackground}
      onSelect={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  const rows = Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  const last = rows[rows.length - 1];
  assert.match(last.textContent ?? '', /^Send anyway/);
  assert.match(last.textContent ?? '', /Send now; this stops the background work/);

  // Enter asks before replacing the process.
  await act(async () => {
    view.result.current.composer.handleKeyDown(enter());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => assert.notEqual(view.result.current.composer.backgroundSendPrompt, null));
  assert.equal(sent.filter((frame) => frame.type === 'chat.edit-send' || frame.type === 'chat.send').length, 0);
  await act(async () => { view.result.current.composer.resolveBackgroundSendPrompt('cancel'); });
});
