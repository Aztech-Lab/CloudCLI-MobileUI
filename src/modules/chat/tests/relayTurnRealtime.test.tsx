import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { BackgroundTaskSummary, NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * [local] Stage 5 on the client: a turn Claude starts on its own to report
 * finished background work (`turn_started`) is a running reply; a subscribe
 * ack for a session with background work restores that state at once; and a
 * send refused because such a turn had just started goes into it.
 */

const TASKS: BackgroundTaskSummary[] = [
  { taskId: 'a1', toolUseId: 'toolu_a1', taskType: 'local_agent', description: 'Survey', startedAt: 5 },
];

const renderHandlers = (overrides: { onRunInProgress?: (sessionId: string, messageId: string) => boolean } = {}) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const log: string[] = [];
  const processing: Array<{ sessionId: string; activity: unknown }> = [];
  const background: Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sessionId, activity) => {
      processing.push({ sessionId: String(sessionId), activity });
      log.push('processing');
    },
    onSessionIdle: () => { log.push('idle'); },
    onSessionBackground: (sessionId, tasks) => {
      background.push({ sessionId, tasks });
      log.push('background');
    },
    getSessionActivity: () => undefined,
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
    onRunInProgress: overrides.onRunInProgress,
  }));

  const dispatch = (event: Record<string, unknown>) => listener?.({ sessionId: 'viewed-session', ...event } as ServerEvent);
  return { dispatch, log, processing, background, stored };
};

test('a turn Claude starts on its own shows as a running, stoppable reply and is no transcript row', () => {
  const { dispatch, processing, stored } = renderHandlers();
  dispatch({ kind: 'turn_started', origin: 'background', provider: 'claude', seq: 7 });
  assert.deepEqual(processing, [{ sessionId: 'viewed-session', activity: { statusText: null, canInterrupt: true } }]);
  assert.equal(stored.length, 0);
});

test('a subscribe ack for a session with background work restores it at once instead of idling', () => {
  const { dispatch, log, background } = renderHandlers();
  dispatch({ kind: 'chat_subscribed', isProcessing: false, background: true, tasks: TASKS, pendingPermissions: [] });
  assert.deepEqual(log, ['background']);
  assert.deepEqual(background, [{ sessionId: 'viewed-session', tasks: TASKS }]);
});

test('a subscribe ack with nothing running still idles the session', () => {
  const { dispatch, log } = renderHandlers();
  dispatch({ kind: 'chat_subscribed', isProcessing: false, pendingPermissions: [] });
  assert.deepEqual(log, ['idle']);
});

test('RUN_IN_PROGRESS naming a message the composer sent is handed over, without idling or an error row', () => {
  const handed: Array<[string, string]> = [];
  const { dispatch, log, stored } = renderHandlers({
    onRunInProgress: (sessionId, messageId) => { handed.push([sessionId, messageId]); return true; },
  });
  dispatch({ kind: 'protocol_error', code: 'RUN_IN_PROGRESS', messageId: 'm-1', error: 'busy' });
  assert.deepEqual(handed, [['viewed-session', 'm-1']]);
  assert.deepEqual(log, []);
  assert.equal(stored.length, 0);
});

test('RUN_IN_PROGRESS the composer did not send is reported as before', () => {
  const { dispatch, log, stored } = renderHandlers({ onRunInProgress: () => false });
  dispatch({ kind: 'protocol_error', code: 'RUN_IN_PROGRESS', messageId: 'm-2', error: 'busy' });
  assert.deepEqual(log, ['idle']);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'error');
});
