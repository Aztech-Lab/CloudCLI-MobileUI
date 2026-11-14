import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { BackgroundTaskSummary, NormalizedMessage, PendingPermissionRequest, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * [local] What the realtime handler does with the frames a send into a
 * session's running process adds:
 * - a Stop that ended only that turn (`complete` with `aborted` and
 *   `backgroundContinues`) leaves the session with its background work, not
 *   idle, so the next Enter joins the process again instead of stopping it;
 * - a `complete` that lists `pendingPermissions` keeps those prompts (the
 *   background work's own requests) instead of clearing every prompt;
 * - `ADOPT_UNAVAILABLE` goes to the composer, which takes the message back,
 *   and never idles the session or adds an error row for a message it knows.
 */

type ActivityLog = Array<{ sessionId: string; tasks: BackgroundTaskSummary[] } | { sessionId: string; idle: true }>;

const renderHandlers = (onAdoptRefused?: (sessionId: string, messageId: string) => boolean) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const log: ActivityLog = [];
  const permissionUpdates: PendingPermissionRequest[][] = [];
  const activityBySession = new Map<string, SessionActivity>();

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
    setPendingPermissionRequests: (next) => {
      permissionUpdates.push(typeof next === 'function' ? next([]) : next);
    },
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: () => {},
    onSessionIdle: (sessionId) => {
      if (sessionId) {
        activityBySession.delete(sessionId);
        log.push({ sessionId, idle: true });
      }
    },
    onSessionBackground: (sessionId, tasks) => {
      if (tasks.length > 0) {
        activityBySession.set(sessionId, { statusText: null, canInterrupt: false, startedAt: tasks[0].startedAt, background: true, tasks });
      } else {
        activityBySession.delete(sessionId);
      }
      log.push({ sessionId, tasks });
    },
    getSessionActivity: (sessionId) => activityBySession.get(sessionId),
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
    onAdoptRefused,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, log, stored, permissionUpdates, activityBySession };
};

const event = (fields: Record<string, unknown>): ServerEvent => ({
  id: `event-${Math.random()}`,
  sessionId: 'viewed-session',
  provider: 'claude',
  timestamp: '2026-08-21T10:32:10.000Z',
  ...fields,
} as unknown as ServerEvent);

const agentLaunch = () => [
  event({ kind: 'tool_use', toolId: 'toolu_agent_1', toolName: 'Agent', toolInput: { description: 'Survey the repo', prompt: 'look', run_in_background: true } }),
  event({ kind: 'tool_result', toolId: 'toolu_agent_1', content: 'Async agent launched', toolUseResult: { status: 'async_launched', agentId: 'a1' } }),
  event({ kind: 'task_status', event: 'started', taskId: 'a1', toolUseId: 'toolu_agent_1', taskType: 'local_agent', description: 'Survey the repo' }),
];

const PENDING: PendingPermissionRequest = {
  requestId: 'perm-bg-1',
  toolName: 'Bash',
  input: { command: 'npm test' },
  sessionId: 'viewed-session',
  receivedAt: new Date('2026-08-21T10:32:00.000Z'),
};

test('a Stop that ended only the turn written into the running process leaves the session with its background work', () => {
  const { dispatch, log, activityBySession } = renderHandlers();
  agentLaunch().forEach(dispatch);

  dispatch(event({ kind: 'complete', exitCode: 0, aborted: true, backgroundContinues: true }));

  assert.equal(log.length, 1);
  assert.ok(!('idle' in log[0]), 'not idled');
  assert.deepEqual((log[0] as { tasks: BackgroundTaskSummary[] }).tasks.map((task) => task.taskId), ['a1']);
  assert.equal(activityBySession.get('viewed-session')?.background, true);
});

test('any other aborted complete still leaves the session idle', () => {
  const { dispatch, log } = renderHandlers();
  agentLaunch().forEach(dispatch);

  dispatch(event({ kind: 'complete', exitCode: 0, aborted: true }));

  assert.deepEqual(log, [{ sessionId: 'viewed-session', idle: true }]);
});

test('a complete that lists pending permissions keeps those prompts', () => {
  const { dispatch, permissionUpdates } = renderHandlers();

  dispatch(event({ kind: 'complete', exitCode: 0, success: true, pendingPermissions: [PENDING] }));

  assert.deepEqual(permissionUpdates, [[PENDING]]);
});

test('the interrupt-only Stop complete keeps the pending prompts too', () => {
  const { dispatch, permissionUpdates } = renderHandlers();

  dispatch(event({ kind: 'complete', exitCode: 0, aborted: true, backgroundContinues: true, pendingPermissions: [PENDING] }));

  assert.deepEqual(permissionUpdates, [[PENDING]]);
});

test('a complete without pending permissions clears every prompt, as before', () => {
  const { dispatch, permissionUpdates } = renderHandlers();

  dispatch(event({ kind: 'complete', exitCode: 0, success: true }));

  assert.deepEqual(permissionUpdates, [[]]);
});

test('ADOPT_UNAVAILABLE goes to the composer, without idling the session or adding an error row', () => {
  const refusals: Array<[string, string]> = [];
  const { dispatch, log, stored } = renderHandlers((sessionId, messageId) => {
    refusals.push([sessionId, messageId]);
    return true;
  });
  agentLaunch().forEach(dispatch);
  const rowsBefore = stored.length;

  dispatch(event({
    kind: 'protocol_error',
    code: 'ADOPT_UNAVAILABLE',
    error: 'The message could not join the running session',
    messageId: '6f1b8f4e-1c55-4d8e-9a43-0f3a2c1b7d9e',
  }));

  assert.deepEqual(refusals, [['viewed-session', '6f1b8f4e-1c55-4d8e-9a43-0f3a2c1b7d9e']]);
  assert.deepEqual(log, [], 'the session is not idled');
  assert.equal(stored.length, rowsBefore, 'no error row');
});

test('ADOPT_UNAVAILABLE for a message the composer does not know says so, still without idling the session', () => {
  const { dispatch, log, stored } = renderHandlers(() => false);

  dispatch(event({
    kind: 'protocol_error',
    code: 'ADOPT_UNAVAILABLE',
    error: 'The message could not join the running session',
    messageId: '6f1b8f4e-1c55-4d8e-9a43-0f3a2c1b7d9e',
  }));

  assert.deepEqual(log, []);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'error');
  assert.equal(stored[0].content, 'The message could not join the running session');
});

test('other protocol errors still idle the session and add an error row', () => {
  const { dispatch, log, stored } = renderHandlers(() => true);

  dispatch(event({ kind: 'protocol_error', code: 'RUN_IN_PROGRESS', error: 'busy' }));

  // A session with no processing entry is left as it is by markSessionIdle;
  // the handler still reports it idle.
  assert.deepEqual(log, [{ sessionId: 'viewed-session', idle: true }]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'error');
});
