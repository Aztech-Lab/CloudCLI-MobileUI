import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  userDb,
} from '@/modules/database/index.js';
import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  claudeRuntime,
  isClaudeSDKSessionActive,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  resolveToolApproval,
  steerClaudeSDKSession,
  stopAllClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { AnyRecord, LLMProvider, ProviderRuntimeContext } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * [local] Adopting a held Claude process for a new send.
 *
 * A turn that ends with background work still running leaves its CLI process
 * held with stdin open. A `chat.send` carrying `adoptHeld` writes the new
 * message into that live process instead of stopping the work and spawning a
 * `--resume` process. These drive `queryClaudeSDK` with scripted SDK streams
 * (the seam is `context.createQuery`, as in claude-runtime-hold.test.ts,
 * claude-steer.test.ts and claude-side-question-hold.test.ts) and watch what
 * reaches each process's stdin, which control requests it receives, and what
 * each run's writer is sent.
 */

const SESSION_ID = 'app-adopt-session';
const NATIVE_ID = 'native-adopt-session';
const MSG_ID = '1f0c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const MSG_ID_2 = '2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const STEER_ID = '4c3d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ----------------------------------------------------------------------------
// Scripted SDK query
// ----------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Behaviour of the control requests a test wants to steer; unset ones resolve at once. */
type Controls = {
  setModel?: (model?: string) => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
  applyFlagSettings?: (settings: AnyRecord) => Promise<void>;
  /** Resolves whether the CLI cancelled the queued message; default false. */
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
  /** Resolves the interrupt receipt; default undefined (an older CLI). */
  interrupt?: () => Promise<unknown>;
  askSideQuestion?: (question: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

type Scripted = {
  emit: (message: AnyRecord) => void;
  end: () => void;
  released: () => boolean;
  /** How many emitted messages the runtime has finished handling. */
  consumed: () => number;
  /** Every message the runtime wrote to the CLI's stdin, in order. */
  stdin: AnyRecord[];
  /** The options the query was started with; null until it is. */
  options: () => AnyRecord | null;
  stopped: string[];
  /** Every control request and stdin write, in the order they happened. */
  log: Array<{ method: string; args: unknown[] }>;
  controls: Controls;
  count: (method: string) => number;
};

function createScriptedQuery(controls: Controls = {}): {
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>;
  script: Scripted;
} {
  const queue: Array<AnyRecord | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let consumed = 0;
  let startedWith: AnyRecord | null = null;
  const stdin: AnyRecord[] = [];
  const stopped: string[] = [];
  const log: Array<{ method: string; args: unknown[] }> = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    consumed: () => consumed,
    stdin,
    options: () => startedWith,
    stopped,
    log,
    controls,
    count: (method) => log.filter((entry) => entry.method === method).length,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    startedWith = options;
    void (async () => {
      for await (const message of prompt) {
        stdin.push(message as AnyRecord);
        log.push({ method: 'stdin', args: [message] });
      }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
        consumed += 1;
      }
    })();

    const instance = Object.assign(iterator, {
      interrupt: async () => {
        log.push({ method: 'interrupt', args: [] });
        return script.controls.interrupt ? script.controls.interrupt() : undefined;
      },
      stopTask: async (taskId: string) => {
        stopped.push(taskId);
        log.push({ method: 'stopTask', args: [taskId] });
      },
      setModel: async (model?: string) => {
        log.push({ method: 'setModel', args: [model] });
        await script.controls.setModel?.(model);
      },
      setPermissionMode: async (mode: string) => {
        log.push({ method: 'setPermissionMode', args: [mode] });
        await script.controls.setPermissionMode?.(mode);
      },
      applyFlagSettings: async (settings: AnyRecord) => {
        log.push({ method: 'applyFlagSettings', args: [settings] });
        await script.controls.applyFlagSettings?.(settings);
      },
      // Untyped in SDK 0.3.311, present at runtime (cancel_async_message).
      cancelAsyncMessage: async (uuid: string) => {
        log.push({ method: 'cancelAsyncMessage', args: [uuid] });
        return script.controls.cancelAsyncMessage ? script.controls.cancelAsyncMessage(uuid) : false;
      },
    });
    if (controls.askSideQuestion) {
      Object.assign(instance, {
        askSideQuestion(this: unknown, question: string, options?: { signal?: AbortSignal }) {
          if (this !== instance) {
            throw new TypeError('askSideQuestion was called without its query as `this`');
          }
          return controls.askSideQuestion!(question, options);
        },
      });
    }
    return instance;
  };

  return { createQuery, script };
}

// ----------------------------------------------------------------------------
// Writers, context, waiting
// ----------------------------------------------------------------------------

type TestWriter = {
  sent: AnyRecord[];
  sessionIds: string[];
  userId: number | null;
  send: (message: unknown) => void;
  setSessionId: (sessionId: string) => void;
};

function createWriter(userId: number | null = null): TestWriter {
  const writer: TestWriter = {
    sent: [],
    sessionIds: [],
    userId,
    send: (message) => { writer.sent.push(message as AnyRecord); },
    setSessionId: (sessionId) => { writer.sessionIds.push(sessionId); },
  };
  return writer;
}

const completes = (writer: TestWriter) => writer.sent.filter((message) => message.kind === 'complete');
const userTexts = (writer: TestWriter) => writer.sent.filter((message) => message.kind === 'text' && message.role === 'user');
const sentText = (writer: TestWriter, text: string) => JSON.stringify(writer.sent).includes(text);

const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });

function makeContext(
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>,
  overrides: Partial<ProviderRuntimeContext> = {},
): ProviderRuntimeContext {
  return {
    // The session row names the held process's own id, so the two match.
    resolveProviderSessionId: () => NATIVE_ID,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
    ...overrides,
  };
}

/**
 * Real `setImmediate` rounds rather than `setTimeout`, so the same helpers work
 * in the tests that mock `setTimeout` to drive the runtime's timers.
 */
const nextRound = () => new Promise<void>((resolve) => { setImmediate(resolve); });

async function waitFor(condition: () => boolean, label = 'condition', timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      assert.fail(`${label} never became true within ${timeoutMs}ms`);
    }
    await nextRound();
  }
}

/** A short pause before a negative assertion, after a predicate already confirmed the preceding event. */
async function settle(rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await nextRound();
  }
}

async function emitAndFlush(script: Scripted, message: AnyRecord): Promise<void> {
  const before = script.consumed();
  script.emit(message);
  await waitFor(() => script.consumed() > before, `message ${String(message.type)}/${String(message.subtype ?? '')} handled`);
}

async function withCwd(runTest: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-adopt-held-'));
  try {
    await runTest(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// Stream fixtures
// ----------------------------------------------------------------------------

const init = (sessionId = NATIVE_ID) => ({ type: 'system', subtype: 'init', session_id: sessionId });
const toolUse = (id: string, name: string, input: AnyRecord) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: AnyRecord) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType = 'local_agent') => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
/** The CLI's echo of a stdin message, written when it reads it. */
const echo = (uuid: string, content: unknown) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null, isReplay: true, uuid,
  message: { role: 'user', content },
});
const result = (subtype = 'success') => ({ type: 'result', subtype, session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });

// ----------------------------------------------------------------------------
// Run helpers
// ----------------------------------------------------------------------------

type HeldKind = 'agent' | 'static' | 'none';

/**
 * Starts run 1 and ends its turn so the process is held:
 * - `agent`: a background agent `a1` the tracker knows about;
 * - `static`: a ScheduleWakeup, which reports no task (held by the launch rule only);
 * - `none`: nothing backgrounded (only useful with a deferred release).
 */
async function startHeld(
  cwd: string,
  {
    kind = 'agent',
    options = {},
    writer = createWriter(),
    controls = {},
    sessionId = SESSION_ID,
  }: { kind?: HeldKind; options?: AnyRecord; writer?: TestWriter; controls?: Controls; sessionId?: string } = {},
) {
  const first = createScriptedQuery(controls);
  const done = queryClaudeSDK('start the work', { sessionId, cwd, adoptable: true, ...options }, writer as never, makeContext(first.createQuery));
  await waitFor(() => first.script.stdin.length > 0, 'run 1 started');
  await emitAndFlush(first.script, init());
  if (kind === 'agent') {
    first.script.emit(toolUse('toolu_a1', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_a1'));
    await emitAndFlush(first.script, ack('toolu_a1', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
  } else if (kind === 'static') {
    first.script.emit(toolUse('toolu_wake', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'check back' }));
    await emitAndFlush(first.script, ack('toolu_wake', 'Scheduled', {}));
  }
  await emitAndFlush(first.script, result());
  await waitFor(() => completes(writer).length === 1, 'run 1 complete');
  return { first, done, writer };
}

/** A `chat.send` with adoptHeld for the same session, the way dispatchRun hands it over. */
function adoptSend(
  cwd: string,
  writer: TestWriter,
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>,
  options: AnyRecord = {},
  {
    content = 'Continue',
    contextOverrides = {},
    sessionId = SESSION_ID,
  }: { content?: string; contextOverrides?: Partial<ProviderRuntimeContext>; sessionId?: string } = {},
): Promise<void> {
  return queryClaudeSDK(
    content,
    { sessionId, cwd, adoptable: true, adoptHeld: true, messageId: MSG_ID, ...options },
    writer as never,
    makeContext(createQuery, contextOverrides),
  );
}

/** Tracks whether a run's promise has resolved. */
function track(promise: Promise<unknown>): { promise: Promise<unknown>; resolved: () => boolean } {
  let resolved = false;
  const tracked = promise.then((value) => { resolved = true; return value; });
  return { promise: tracked, resolved: () => resolved };
}

/** Runs one adopted turn to its end: init, echo, a reply, result. */
async function playAdoptedTurn(script: Scripted, messageId: string, content = 'Continue'): Promise<void> {
  await emitAndFlush(script, init());
  await emitAndFlush(script, echo(messageId, content));
  await emitAndFlush(script, assistantText(`Reply to ${content}`));
  await emitAndFlush(script, result());
}

async function endRuns(scripts: Scripted[], runs: Array<Promise<unknown>>): Promise<void> {
  for (const script of scripts) {
    script.end();
  }
  await Promise.all(runs.map((run) => run.catch(() => {})));
}

const isAdoptUnavailable = (messageId: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, 'an AppError');
  assert.equal(error.code, 'ADOPT_UNAVAILABLE');
  assert.equal((error.details as AnyRecord).messageId, messageId);
  return true;
};

// ----------------------------------------------------------------------------
// Notifications (desktop channel), for the tests that count them
// ----------------------------------------------------------------------------

type DesktopPayload = { body: string; data: { code: string; provider: string; sessionId: string | null } };

async function withDesktopListener(
  runTest: (context: { userId: number; payloads: DesktopPayload[]; cwd: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-adopt-held-db-'));
  const payloads: DesktopPayload[] = [];
  const fakeSocket = {
    OPEN: 1,
    readyState: 1,
    send: (message: string) => { payloads.push(JSON.parse(message).payload as DesktopPayload); },
    close: () => {},
  } as unknown as WebSocket;

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const userId = Number(userDb.createUser('adopt-user', 'x').id);
    notificationPreferencesDb.updatePreferences(userId, {
      channels: { desktop: true },
      events: { actionRequired: true, stop: true, error: true },
    });
    registerDesktopNotificationClient({ userId, deviceId: 'adopt-device', ws: fakeSocket });
    await runTest({ userId, payloads, cwd: directory });
  } finally {
    unregisterDesktopNotificationClient(fakeSocket);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

// ============================================================================
// Design tests a-l
// ============================================================================

test('a/j/k: an adoptHeld send is written into the held process, with the work left running', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done, writer: w1 } = await startHeld(cwd);
    assert.equal(first.script.options()?.perTaskStopAffordance, true, 'k: Stop spares background tasks unless the runtime stops them itself');
    const w1Count = w1.sent.length;
    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = track(adoptSend(cwd, w2, second.createQuery));

    await waitFor(() => first.script.stdin.length === 2, 'the message reaches the held process');
    const pushed = first.script.stdin[1];
    assert.equal(pushed.uuid, MSG_ID);
    assert.equal(pushed.priority, undefined, 'no priority: the CLI default starts a new turn');
    assert.deepEqual(pushed.message, { role: 'user', content: 'Continue' });
    assert.equal(second.script.options(), null, 'no new process');
    assert.deepEqual(first.script.stopped, [], 'nothing is stopped');
    assert.equal(first.script.released(), false);

    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, assistantText('Working on it.'));
    assert.ok(sentText(w2, 'Working on it.'), 'the adopted turn streams to the new run');
    assert.equal(userTexts(w2).length, 0, 'j: the adopted echo is not shown (the client already has the row)');
    assert.equal(completes(w2).length, 0, 'no complete before the result');
    assert.equal(run2.resolved(), false);

    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved, 'the adopting run resolves');
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].exitCode, 0);
    assert.deepEqual(completes(w2)[0].pendingPermissions, [], 'an adopted complete carries the pending approvals');
    assert.equal(w1.sent.length, w1Count, 'run 1 writer is sent nothing after the hand-off');
    assert.equal(first.script.released(), false, 'still held for a1');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['a1']]]);

    await endRuns([first.script], [done, run2.promise]);
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('k: every Claude query declares the per-task stop affordance', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const only = createScriptedQuery();
    const writer = createWriter();
    const run = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, makeContext(only.createQuery));
    await waitFor(() => only.script.options() !== null);
    assert.equal(only.script.options()?.perTaskStopAffordance, true);
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, result());
    await endRuns([only.script], [run]);
  });
});

test('b: a relay turn that ends before the CLI reads the adopted message does not complete it', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);

    // a1 reports back; the CLI relays it in a turn of its own first.
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'completed'));
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('The agent finished.'));
    await emitAndFlush(first.script, result());
    await settle();
    assert.equal(completes(w2).length, 0, 'the relay result is not the adopted turn');
    assert.equal(run2.resolved(), false);
    assert.equal(first.script.released(), false, 'stdin stays open for the adopted message');

    await playAdoptedTurn(first.script, MSG_ID);
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    await waitFor(() => first.script.released(), 'released once nothing is outstanding');
    await endRuns([first.script], [done, run2.promise]);
  });
});

test('c: adoptHeld with a resume anchor (edit) keeps the stop-and-respawn path', { concurrency: false }, async () => {
  for (const extra of [{ resumeAnchorId: '9e9e9e9e-0000-4000-8000-000000000000' }, { resumeFromScratch: true }]) {
    await withCwd(async (cwd) => {
      const { first, done } = await startHeld(cwd);
      const w2 = createWriter();
      const second = createScriptedQuery();
      const run2 = adoptSend(cwd, w2, second.createQuery, extra);
      await waitFor(() => second.script.options() !== null, 'a new process is spawned');
      assert.deepEqual(first.script.stopped, ['a1']);
      assert.equal(first.script.released(), true);
      assert.equal(first.script.stdin.length, 1, 'nothing is written into the held process');

      first.script.end();
      await done;
      await emitAndFlush(second.script, init());
      await emitAndFlush(second.script, result());
      await waitFor(() => completes(w2).length === 1);
      await endRuns([second.script], [run2]);
    });
  }
});

test('d: adoptHeld with no held process spawns normally', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const w = createWriter();
    const only = createScriptedQuery();
    const run = adoptSend(cwd, w, only.createQuery);
    await waitFor(() => only.script.stdin.length === 1);
    assert.deepEqual(only.script.stdin[0].message, { role: 'user', content: 'Continue' });
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, result());
    await waitFor(() => completes(w).length === 1);
    await endRuns([only.script], [run]);
  });
});

test('e: the last task stopping during the adopted turn does not release; the adopted result does', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));

    const stopping = stopClaudeSDKTask(SESSION_ID, 'a1');
    await waitFor(() => first.script.stopped.includes('a1'));
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'stopped'));
    assert.equal(await stopping, true);
    await settle();
    assert.equal(first.script.released(), false, 'the adopted turn is still running');

    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    await waitFor(() => first.script.released(), 'released after the adopted result');
    await endRuns([first.script], [done]);
  });
});

test('f: changed model, effort and permission mode are applied to the live process before the push', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery, { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }));
    await waitFor(() => first.script.stdin.length === 2);

    const methods = first.script.log.map((entry) => entry.method);
    const pushAt = methods.indexOf('stdin', methods.indexOf('stdin') + 1);
    for (const method of ['setPermissionMode', 'setModel', 'applyFlagSettings']) {
      const at = methods.indexOf(method);
      assert.ok(at >= 0 && at < pushAt, `${method} is sent before the message`);
    }
    assert.deepEqual(first.script.log.find((entry) => entry.method === 'setPermissionMode')?.args, ['acceptEdits']);
    assert.deepEqual(first.script.log.find((entry) => entry.method === 'setModel')?.args, ['opus']);
    assert.deepEqual(first.script.log.find((entry) => entry.method === 'applyFlagSettings')?.args, [{ effortLevel: 'high', ultracode: false }]);

    await playAdoptedTurn(first.script, MSG_ID);
    await waitFor(run2.resolved);
    await endRuns([first.script], [done]);
  });
});

test('f: a failing model change does not stop the adoption', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { controls: { setModel: async () => { throw new Error('control request failed'); } } });
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery, { model: 'opus', effort: 'high' }));
    await waitFor(() => first.script.stdin.length === 2, 'adopted anyway');
    assert.equal(first.script.count('setModel'), 1);
    assert.equal(first.script.count('applyFlagSettings'), 1, 'the effort still follows');
    assert.deepEqual(first.script.stopped, []);

    await playAdoptedTurn(first.script, MSG_ID);
    await waitFor(run2.resolved);
    await endRuns([first.script], [done]);
  });
});

test('g: Stop during the adopted turn only interrupts it; the work survives and the session adopts again', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, assistantText('Starting.'));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved, 'the adopting run ends with the Stop');
    assert.equal(first.script.count('interrupt'), 1);
    assert.deepEqual(first.script.stopped, [], 'a1 existed before the adoption and is spared');
    assert.equal(first.script.released(), false);
    assert.equal(isClaudeSDKSessionActive(SESSION_ID), true, 'the held process is still registered');
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].aborted, true);
    assert.equal(completes(w2)[0].backgroundContinues, true);
    assert.ok(Array.isArray(completes(w2)[0].pendingPermissions));

    // The CLI ends the interrupted turn.
    await emitAndFlush(first.script, result('error_during_execution'));
    await settle();
    assert.equal(completes(w2).length, 1, 'no second complete');
    assert.equal(first.script.released(), false, 'still held for a1');

    const w3 = createWriter();
    const run3 = track(adoptSend(cwd, w3, createScriptedQuery().createQuery, { messageId: MSG_ID_2 }));
    await waitFor(() => first.script.stdin.length === 3, 'adopts again');
    assert.equal(first.script.stdin[2].uuid, MSG_ID_2);
    await playAdoptedTurn(first.script, MSG_ID_2);
    await waitFor(run3.resolved);
    assert.equal(completes(w3).length, 1);
    assert.equal(completes(w3)[0].aborted, false);
    await endRuns([first.script], [done]);
  });
});

test('h: the process exiting mid adopted turn completes the adopting run', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, assistantText('Halfway.'));

    first.script.end();
    await done;
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].exitCode, 0);
  });
});

test('i: a message steered into the adopted turn joins it', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, toolUse('toolu_b1', 'Bash', { command: 'sleep 4' }));

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'skip the rest', { messageId: STEER_ID }), true);
    await waitFor(() => first.script.stdin.length === 3);
    assert.equal(first.script.stdin[2].priority, 'next');
    assert.equal(first.script.stdin[2].uuid, STEER_ID);

    await emitAndFlush(first.script, ack('toolu_b1', 'done', {}));
    await emitAndFlush(first.script, echo(STEER_ID, 'skip the rest'));
    assert.equal(userTexts(w2).length, 1, 'the steered message is shown where Claude read it');
    assert.equal(userTexts(w2)[0].id, STEER_ID);
    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    await endRuns([first.script], [done]);
  });
});

test('l / required 2: a relay result before the echo, then silence, fails the adopted turn after the watchdog', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done, writer: w1 } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);

    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('A relay turn.'));
    await emitAndFlush(first.script, result());
    await settle();
    assert.equal(completes(w2).length, 0);

    t.mock.timers.tick(59_000);
    await settle();
    assert.equal(completes(w2).length, 0, 'the watchdog measures silence, not total time');

    t.mock.timers.tick(1_000);
    await waitFor(run2.resolved, 'the adopting run ends');
    assert.equal(first.script.count('cancelAsyncMessage'), 1);
    assert.deepEqual(first.script.log.find((entry) => entry.method === 'cancelAsyncMessage')?.args, [MSG_ID]);
    const failure = w2.sent.find((message) => message.kind === 'error');
    assert.ok(failure, 'an error is shown');
    assert.match(String(failure?.content), /not picked up/);
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].exitCode, 1);
    assert.equal(first.script.released(), false, 'still held for a1');

    const w1Count = w1.sent.length;
    const w2Count = w2.sent.length;
    await endRuns([first.script], [done]);
    // No timer of the dead run may fire afterwards.
    t.mock.timers.tick(3 * 60 * 60 * 1000);
    await settle();
    assert.equal(w1.sent.length, w1Count);
    assert.equal(w2.sent.length, w2Count);
  });
});

// ============================================================================
// Required tests 1-17, 19-23 (runtime side)
// ============================================================================

test('required 1: a steer the CLI drops ends the adopted turn after the grace, and releases when nothing is outstanding', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    // a1 is stopped mid-turn, so nothing is outstanding by the end.
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'stopped'));

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'one more thing', { messageId: STEER_ID }), true);
    await waitFor(() => first.script.stdin.length === 3);
    await emitAndFlush(first.script, result());
    await settle();
    assert.equal(completes(w2).length, 0, 'waits for the steer follow-up');

    t.mock.timers.tick(30_000);
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    await waitFor(() => first.script.released(), 'released: nothing is outstanding');
    await endRuns([first.script], [done]);
  });
});

test('required 1: after a dropped steer with work outstanding, the session adopts again', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'one more thing', { messageId: STEER_ID }), true);
    await waitFor(() => first.script.stdin.length === 3);
    await emitAndFlush(first.script, result());

    t.mock.timers.tick(30_000);
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    assert.equal(first.script.released(), false, 'held for a1');

    const w3 = createWriter();
    const run3 = track(adoptSend(cwd, w3, createScriptedQuery().createQuery, { messageId: MSG_ID_2 }));
    await waitFor(() => first.script.stdin.length === 4, 'not refused');
    assert.equal(first.script.stdin[3].uuid, MSG_ID_2);
    await playAdoptedTurn(first.script, MSG_ID_2);
    await waitFor(run3.resolved);
    assert.equal(completes(w3).length, 1);
    await endRuns([first.script], [done]);
  });
});

test('required 3: an adoption attempt that throws clears its state, replays a release it held back, and falls back to a spawn', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    // Held by the launch rule only: nothing tracked, so no ADOPT_UNAVAILABLE.
    const { first, done } = await startHeld(cwd, { kind: 'static' });
    const gate = deferred<string | undefined>();
    let lookups = 0;
    const resolveResumeModel = async () => {
      lookups += 1;
      return lookups === 1 ? gate.promise : undefined;
    };
    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = adoptSend(cwd, w2, second.createQuery, {}, { contextOverrides: { resolveResumeModel } });
    await waitFor(() => lookups === 1, 'the attempt is in flight');

    // A turn the CLI pushes on its own ends with nothing outstanding: that
    // would release the process, but the attempt holds the release back.
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, result());
    await settle();
    assert.equal(first.script.released(), false, 'the release waits for the attempt');

    gate.reject(new Error('model lookup failed'));
    await waitFor(() => first.script.released(), 'the held-back release is replayed');
    await waitFor(() => second.script.options() !== null, 'falls back to a new process');
    assert.equal(first.script.stdin.length, 1, 'nothing was pushed');

    await emitAndFlush(second.script, init());
    await emitAndFlush(second.script, result());
    await waitFor(() => completes(w2).length === 1);
    await endRuns([first.script, second.script], [done, run2]);
    await run2; // resolves, no ADOPT_UNAVAILABLE
  });
});

test('required 4: Stop while the adoption waits on a control request pushes nothing and spares the work', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const gate = deferred<void>();
    const { first, done } = await startHeld(cwd, { controls: { setModel: () => gate.promise } });
    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = track(adoptSend(cwd, w2, second.createQuery, { model: 'opus' }));
    await waitFor(() => first.script.count('setModel') === 1);

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved, 'the adopting run ends without waiting on the control request');
    gate.resolve();
    await settle();
    assert.equal(first.script.stdin.length, 1, 'nothing was pushed');
    assert.deepEqual(first.script.stopped, []);
    assert.equal(first.script.count('interrupt'), 0, 'the CLI may be running a relay that is not the user\'s');
    assert.equal(second.script.options(), null);
    assert.equal(first.script.released(), false);
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].aborted, true);
    assert.equal(completes(w2)[0].backgroundContinues, true);
    await endRuns([first.script], [done]);
  });
});

test('required 4: Stop during setup with nothing outstanding takes the full path and spawns nothing', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const gate = deferred<void>();
    const { first, done } = await startHeld(cwd, { kind: 'static', controls: { setModel: () => gate.promise } });
    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = track(adoptSend(cwd, w2, second.createQuery, { model: 'opus' }));
    await waitFor(() => first.script.count('setModel') === 1);

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    gate.resolve();
    await waitFor(() => first.script.released(), 'the full path lets the process go');
    assert.equal(first.script.count('interrupt'), 1);
    assert.equal(first.script.stdin.length, 1, 'nothing was pushed');
    assert.equal(second.script.options(), null, 'no second process');
    assert.equal(isClaudeSDKSessionActive(SESSION_ID), false);
    assert.equal(completes(w2).length, 0, 'the gateway sends the aborted complete on this path');
    await endRuns([first.script], [done]);
  });
});

test('required 5: Stop while the adopted message waits behind a relay turn cancels it without interrupting', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { controls: { cancelAsyncMessage: async () => true } });
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    // A relay turn is running; our message is queued behind it.
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('Relaying.'));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    assert.deepEqual(first.script.log.filter((entry) => entry.method === 'cancelAsyncMessage').map((entry) => entry.args[0]), [MSG_ID]);
    assert.equal(first.script.count('interrupt'), 0, 'the relay turn is not the user\'s to stop');
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].backgroundContinues, true);

    await emitAndFlush(first.script, result());
    await settle();
    assert.equal(completes(w2).length, 1);
    assert.equal(first.script.released(), false);
    await endRuns([first.script], [done]);
  });
});

test('required 5: a queued message the CLI will not cancel is interrupted again when it starts, and shows nothing', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, {
      controls: {
        cancelAsyncMessage: async () => false,
        interrupt: async () => ({ still_queued: [MSG_ID] }),
      },
    });
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('Relaying.'));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    assert.equal(first.script.count('interrupt'), 1);
    assert.equal(first.script.count('cancelAsyncMessage'), 2, 'tried before and after the interrupt');

    // The interrupted relay ends; then the CLI starts our message anyway.
    await emitAndFlush(first.script, result('error_during_execution'));
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    assert.equal(first.script.count('interrupt'), 2, 'interrupted the moment it starts');
    await emitAndFlush(first.script, assistantText('SHOULD NOT SHOW'));
    await emitAndFlush(first.script, result('error_during_execution'));
    await settle();
    assert.equal(sentText(w2, 'SHOULD NOT SHOW'), false);
    assert.equal(completes(w2).length, 1);
    assert.equal(first.script.released(), false);
    await endRuns([first.script], [done]);
  });
});

test('required 6: Stop with an unread steer cancels it, and the interrupted result does not wait for it', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { controls: { cancelAsyncMessage: async () => true } });
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'also this', { messageId: STEER_ID }), true);
    await waitFor(() => first.script.stdin.length === 3);

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    assert.deepEqual(first.script.log.filter((entry) => entry.method === 'cancelAsyncMessage').map((entry) => entry.args[0]), [STEER_ID]);
    assert.equal(first.script.count('interrupt'), 1, 'the adopted turn itself is running and is interrupted');

    await emitAndFlush(first.script, result('error_during_execution'));
    await settle();
    assert.equal(completes(w2).length, 1);

    // No steer is pending any more, so the session adopts again at once.
    const w3 = createWriter();
    const run3 = track(adoptSend(cwd, w3, createScriptedQuery().createQuery, { messageId: MSG_ID_2 }));
    await waitFor(() => first.script.stdin.length === 4, 'adopts again');
    await playAdoptedTurn(first.script, MSG_ID_2);
    await waitFor(run3.resolved);
    await endRuns([first.script], [done]);
  });
});

test('required 7 [local]: Stop on a turn that was never adopted ends only the turn while background work runs', { concurrency: false }, async () => {
  // Esc in the official client: the turn stops, background agents keep going.
  // What the turn was blocking on (a foreground agent) is part of the turn.
  await withDesktopListener(async ({ userId, payloads, cwd }) => {
    const sessionId = 'app-adopt-plain-stop';
    const writer = createWriter(userId);
    const only = createScriptedQuery();
    const run = track(queryClaudeSDK('start agents', { sessionId, cwd, adoptable: true }, writer as never, makeContext(only.createQuery)));
    await waitFor(() => only.script.stdin.length === 1);
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, toolUse('toolu_b1', 'Agent', { prompt: 'wait', subagent_type: 'general-purpose', run_in_background: true }));
    await emitAndFlush(only.script, taskStarted('b1', 'toolu_b1'));
    await emitAndFlush(only.script, toolUse('toolu_f1', 'Agent', { prompt: 'look', subagent_type: 'general-purpose', run_in_background: false }));
    await emitAndFlush(only.script, taskStarted('f1', 'toolu_f1'));

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    const calls = only.script.log.filter((entry) => entry.method !== 'stdin').map((entry) => `${entry.method}:${String(entry.args[0] ?? '')}`);
    assert.deepEqual(calls, ['stopTask:f1', 'interrupt:'], 'only the foreground agent is stopped, before the interrupt');
    assert.equal(only.script.released(), false, 'the process stays up for b1');
    assert.equal(isClaudeSDKSessionActive(sessionId), true);
    assert.equal(completes(writer).length, 1, 'the turn reports its own Stop');
    assert.equal(completes(writer)[0].aborted, true);
    assert.equal(completes(writer)[0].backgroundContinues, true);
    assert.ok(Array.isArray(completes(writer)[0].pendingPermissions));

    // The CLI ends the interrupted turn and reports the stopped foreground agent.
    await emitAndFlush(only.script, taskNotification('f1', 'toolu_f1', 'stopped'));
    await emitAndFlush(only.script, result('error_during_execution'));
    await settle();
    assert.equal(completes(writer).length, 1, 'no second complete');
    assert.equal(only.script.released(), false, 'held for b1');
    assert.deepEqual(listClaudeSDKBackgroundWork().find((entry) => entry.sessionId === sessionId)?.tasks.map((task) => task.taskId), ['b1']);
    await waitFor(() => payloads.length > 0, 'the stop is reported');
    assert.deepEqual(payloads.map((payload) => payload.data.code), ['run.stopped']);
    assert.match(payloads[0].body, /aborted$/);

    // b1 finishes and the CLI relays it; then the process is let go.
    await emitAndFlush(only.script, taskNotification('b1', 'toolu_b1', 'completed'));
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, assistantText('b1 is done.'));
    await emitAndFlush(only.script, result());
    await waitFor(() => only.script.released(), 'released after the relay');
    assert.equal(run.resolved(), false);
    only.script.end();
    await run.promise;
  });
});

test('required 7: Stop on a turn with only foreground work stops it, interrupts, releases and reports once', { concurrency: false }, async () => {
  await withDesktopListener(async ({ userId, payloads, cwd }) => {
    const sessionId = 'app-adopt-plain-stop-fg';
    const writer = createWriter(userId);
    const only = createScriptedQuery();
    const run = queryClaudeSDK('look around', { sessionId, cwd, adoptable: true }, writer as never, makeContext(only.createQuery));
    await waitFor(() => only.script.stdin.length === 1);
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, toolUse('toolu_f1', 'Agent', { prompt: 'look', subagent_type: 'general-purpose', run_in_background: false }));
    await emitAndFlush(only.script, taskStarted('f1', 'toolu_f1'));

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    const calls = only.script.log.filter((entry) => entry.method !== 'stdin').map((entry) => `${entry.method}:${String(entry.args[0] ?? '')}`);
    assert.deepEqual(calls, ['stopTask:f1', 'interrupt:']);
    await waitFor(() => only.script.released());
    assert.equal(isClaudeSDKSessionActive(sessionId), false);

    only.script.end();
    await run;
    await waitFor(() => payloads.length > 0, 'the stop is reported');
    await settle();
    assert.deepEqual(payloads.map((payload) => payload.data.code), ['run.stopped']);
    assert.match(payloads[0].body, /aborted$/);
    assert.equal(completes(writer).length, 0, 'the gateway sends the aborted complete');
  });
});

test('[local] the CLI\'s is_backgrounded decides what a Stop stops, over the launching call\'s input', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const sessionId = 'app-adopt-is-backgrounded';
    const writer = createWriter();
    const only = createScriptedQuery();
    const run = queryClaudeSDK('start agents', { sessionId, cwd, adoptable: true }, writer as never, makeContext(only.createQuery));
    await waitFor(() => only.script.stdin.length === 1);
    await emitAndFlush(only.script, init());
    // No run_in_background: the input reads as background, the CLI ran it in the foreground.
    await emitAndFlush(only.script, toolUse('toolu_f1', 'Agent', { prompt: 'look', subagent_type: 'general-purpose' }));
    await emitAndFlush(only.script, { ...taskStarted('f1', 'toolu_f1'), is_backgrounded: false });
    // Started in the foreground, then moved to the background (Ctrl+B).
    await emitAndFlush(only.script, toolUse('toolu_m1', 'Bash', { command: 'npm test' }));
    await emitAndFlush(only.script, { ...taskStarted('m1', 'toolu_m1', 'local_bash'), is_backgrounded: false });
    await emitAndFlush(only.script, { type: 'system', subtype: 'task_updated', session_id: NATIVE_ID, task_id: 'm1', patch: { is_backgrounded: true } });

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    assert.deepEqual(only.script.stopped, ['f1']);
    assert.equal(only.script.released(), false, 'held for m1');
    assert.equal(completes(writer)[0]?.backgroundContinues, true);
    only.script.end();
    await run;
  });
});

test('[local] a non-adoptable run (agent API) keeps the full Stop with background work outstanding', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const sessionId = 'app-adopt-agent-api-stop';
    const writer = createWriter();
    const only = createScriptedQuery();
    const run = queryClaudeSDK('start agents', { sessionId, cwd }, writer as never, makeContext(only.createQuery));
    await waitFor(() => only.script.stdin.length === 1);
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, toolUse('toolu_b1', 'Agent', { prompt: 'wait', subagent_type: 'general-purpose', run_in_background: true }));
    await emitAndFlush(only.script, taskStarted('b1', 'toolu_b1'));

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    assert.deepEqual(only.script.stopped, ['b1']);
    await waitFor(() => only.script.released());
    assert.equal(isClaudeSDKSessionActive(sessionId), false);
    only.script.end();
    await run;
  });
});

test('[local] Stop all background work: while held, every task is stopped and the process let go', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    await emitAndFlush(first.script, taskStarted('n1', 'toolu_inner', 'local_bash'));
    assert.equal(await stopAllClaudeSDKBackgroundWork(SESSION_ID), true);
    assert.deepEqual(first.script.stopped, ['a1', 'n1']);
    await waitFor(() => first.script.released(), 'the held process is let go');
    first.script.end();
    await done;
    assert.equal(await stopAllClaudeSDKBackgroundWork(SESSION_ID), false, 'nothing left to stop');
  });
});

test('[local] Stop all background work during a turn stops the tasks and leaves the turn running', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const sessionId = 'app-adopt-stop-all-turn';
    const writer = createWriter();
    const only = createScriptedQuery();
    const run = queryClaudeSDK('start agents', { sessionId, cwd, adoptable: true }, writer as never, makeContext(only.createQuery));
    await waitFor(() => only.script.stdin.length === 1);
    await emitAndFlush(only.script, init());
    await emitAndFlush(only.script, toolUse('toolu_b1', 'Agent', { prompt: 'wait', subagent_type: 'general-purpose', run_in_background: true }));
    await emitAndFlush(only.script, taskStarted('b1', 'toolu_b1'));

    assert.equal(await stopAllClaudeSDKBackgroundWork(sessionId), true);
    assert.deepEqual(only.script.stopped, ['b1']);
    assert.equal(only.script.count('interrupt'), 0, 'the turn is not interrupted');
    assert.equal(only.script.released(), false);
    assert.equal(completes(writer).length, 0);

    await emitAndFlush(only.script, taskNotification('b1', 'toolu_b1', 'stopped'));
    await emitAndFlush(only.script, assistantText('Carrying on.'));
    await emitAndFlush(only.script, result());
    await waitFor(() => completes(writer).length === 1);
    await waitFor(() => only.script.released(), 'nothing left to hold for');
    only.script.end();
    await run;
  });
});

test('[local] Stop all background work with nothing running is refused', { concurrency: false }, async () => {
  assert.equal(await stopAllClaudeSDKBackgroundWork('app-adopt-no-such-session'), false);
});

test('required 8 [local]: Stop on an adopted turn spares background work, its own included, and stops what it blocks on', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, toolUse('toolu_a2', 'Agent', { prompt: 'more', subagent_type: 'general-purpose', run_in_background: true }));
    await emitAndFlush(first.script, taskStarted('a2', 'toolu_a2'));
    await emitAndFlush(first.script, toolUse('toolu_f2', 'Agent', { prompt: 'look', subagent_type: 'general-purpose', run_in_background: false }));
    await emitAndFlush(first.script, taskStarted('f2', 'toolu_f2'));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    assert.deepEqual(first.script.stopped, ['f2']);
    const calls = first.script.log.filter((entry) => entry.method === 'stopTask' || entry.method === 'interrupt').map((entry) => entry.method);
    assert.deepEqual(calls, ['stopTask', 'interrupt'], 'stopped before the interrupt');

    await emitAndFlush(first.script, taskNotification('f2', 'toolu_f2', 'stopped'));
    await emitAndFlush(first.script, result('error_during_execution'));
    await settle();
    assert.equal(first.script.released(), false, 'held for a1 and a2');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId).sort()), [['a1', 'a2']]);
    await endRuns([first.script], [done]);
  });
});

test('required 9: an aborted process whose loop is still winding down does not swallow the next run\'s complete', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const w1 = createWriter();
    const first = createScriptedQuery();
    const run1 = queryClaudeSDK('first', { sessionId: SESSION_ID, cwd }, w1 as never, makeContext(first.createQuery));
    await waitFor(() => first.script.stdin.length === 1);
    await emitAndFlush(first.script, init());
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    // Its stream has not ended yet.

    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = queryClaudeSDK('second', { sessionId: SESSION_ID, cwd }, w2 as never, makeContext(second.createQuery));
    await waitFor(() => second.script.stdin.length === 1);
    await emitAndFlush(second.script, init());
    await emitAndFlush(second.script, result());
    await waitFor(() => completes(w2).length === 1, 'the new run reports its own end');

    await endRuns([first.script, second.script], [run1, run2]);
    assert.equal(completes(w1).length, 0, 'the aborted run stays silent');
  });
});

test('required 10: a task that completes during the adopted turn keeps the hold for its relay, which then releases and notifies', { concurrency: false }, async () => {
  await withDesktopListener(async ({ userId, payloads, cwd }) => {
    const sessionId = 'app-adopt-relay';
    const { first, done } = await startHeld(cwd, { sessionId, writer: createWriter(userId) });
    const w2 = createWriter(userId);
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery, {}, { sessionId }));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'completed'));
    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    await settle();
    assert.equal(first.script.released(), false, 'the relay for a1 is still owed');

    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('a1 reported.'));
    await emitAndFlush(first.script, result());
    await waitFor(() => first.script.released(), 'released after the relay');
    await waitFor(() => payloads.some((payload) => payload.data.code === 'run.background_completed'), 'background completion is reported');
    await endRuns([first.script], [done]);
  });
});

test('required 10: with no relay turn at all, the hold for it ends after the relay grace', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'completed'));
    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    await settle();
    assert.equal(first.script.released(), false);

    t.mock.timers.tick(30_000);
    await waitFor(() => first.script.released(), 'released after the relay grace');
    await endRuns([first.script], [done]);
  });
});

test('required 11: a native side question\'s deferred release does not close stdin during the adopted turn', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const answer = deferred<unknown>();
    let asked = 0;
    const w1 = createWriter();
    const first = createScriptedQuery({ askSideQuestion: () => { asked += 1; return answer.promise; } });
    const run1 = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, adoptable: true }, w1 as never, makeContext(first.createQuery));
    await waitFor(() => first.script.stdin.length === 1);
    await emitAndFlush(first.script, init());

    const forkCreateQuery: NonNullable<ProviderRuntimeContext['createQuery']> = () => { throw new Error('the fork must not be used'); };
    const question = claudeRuntime.askSideQuestion(
      { appSessionId: SESSION_ID, providerSessionId: NATIVE_ID, projectPath: cwd, question: 'Which file?', model: null, signal: new AbortController().signal },
      { delta: () => {} },
      makeContext(forkCreateQuery),
    );
    await waitFor(() => asked === 1);
    await emitAndFlush(first.script, result());
    await settle();
    assert.equal(first.script.released(), false, 'the question defers the release');

    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));

    answer.resolve({ response: 'In src/router.ts.', synthetic: false });
    assert.equal((await question).status, 'done');
    await settle();
    assert.equal(first.script.released(), false, 'not during the adopted turn');

    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    await waitFor(() => first.script.released(), 'released after the adopted result');
    await endRuns([first.script], [run1]);
  });
});

test('required 12: a stricter permission mode the CLI refuses makes the adoption unavailable; once applied, tools prompt again', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, {
      options: { permissionMode: 'bypassPermissions' },
      controls: { setPermissionMode: async () => { throw new Error('refused'); } },
    });
    const second = createScriptedQuery();
    await assert.rejects(
      adoptSend(cwd, createWriter(), second.createQuery, { permissionMode: 'default' }),
      isAdoptUnavailable(MSG_ID),
    );
    assert.equal(first.script.stdin.length, 1, 'nothing was pushed');
    assert.deepEqual(first.script.stopped, []);
    assert.equal(first.script.released(), false);
    assert.equal(second.script.options(), null);

    first.script.controls.setPermissionMode = async () => {};
    const w3 = createWriter();
    const run3 = track(adoptSend(cwd, w3, createScriptedQuery().createQuery, { permissionMode: 'default', messageId: MSG_ID_2 }));
    await waitFor(() => first.script.stdin.length === 2);

    const canUseTool = first.script.options()?.canUseTool as (name: string, input: unknown, context?: { signal?: AbortSignal }) => Promise<AnyRecord>;
    const decision = canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal });
    await waitFor(() => w3.sent.some((message) => message.kind === 'permission_request'), 'the tool is asked about, not auto-allowed');
    const request = w3.sent.find((message) => message.kind === 'permission_request');
    resolveToolApproval(String(request?.requestId), { allow: false });
    assert.equal((await decision).behavior, 'deny');

    await playAdoptedTurn(first.script, MSG_ID_2);
    await waitFor(run3.resolved);
    await endRuns([first.script], [done]);
  });
});

test('required 18: the adopted turn\'s complete lists a background agent\'s approval that is still pending', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done, writer: w1 } = await startHeld(cwd);
    // The background agent asks for a tool while the session is held.
    const canUseTool = first.script.options()?.canUseTool as (name: string, input: unknown, context?: { signal?: AbortSignal }) => Promise<AnyRecord>;
    const decision = canUseTool('Bash', { command: 'make build' }, { signal: new AbortController().signal });
    await waitFor(() => w1.sent.some((message) => message.kind === 'permission_request'), 'the agent asks');
    const requestId = String(w1.sent.find((message) => message.kind === 'permission_request')?.requestId);

    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2, 'adopted');
    await playAdoptedTurn(first.script, MSG_ID);
    await waitFor(run2.resolved, 'the adopting run resolves');

    assert.equal(completes(w2).length, 1);
    const pending = completes(w2)[0].pendingPermissions as AnyRecord[];
    assert.ok(Array.isArray(pending));
    assert.deepEqual(pending.map((entry) => entry.requestId), [requestId], 'the still-pending approval survives the complete');

    resolveToolApproval(requestId, { allow: false });
    assert.equal((await decision).behavior, 'deny');
    await endRuns([first.script], [done]);
  });
});

test('required 13: effort changes always send both keys', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { options: { model: 'opus', effort: 'high' } });
    const run2 = track(adoptSend(cwd, createWriter(), createScriptedQuery().createQuery, { model: 'opus', effort: 'default' }));
    await waitFor(() => first.script.stdin.length === 2);
    assert.deepEqual(first.script.log.filter((entry) => entry.method === 'applyFlagSettings').map((entry) => entry.args[0]), [
      { effortLevel: null, ultracode: false },
    ]);
    assert.equal(first.script.count('setModel'), 0, 'the model did not change');
    await playAdoptedTurn(first.script, MSG_ID);
    await waitFor(run2.resolved);

    const run3 = track(adoptSend(cwd, createWriter(), createScriptedQuery().createQuery, { model: 'opus', effort: 'ultracode', messageId: MSG_ID_2 }));
    await waitFor(() => first.script.stdin.length === 3);
    assert.deepEqual(first.script.log.filter((entry) => entry.method === 'applyFlagSettings').map((entry) => entry.args[0]), [
      { effortLevel: null, ultracode: false },
      { effortLevel: 'xhigh', ultracode: true, enableWorkflows: true },
    ]);
    await playAdoptedTurn(first.script, MSG_ID_2);
    await waitFor(run3.resolved);
    await endRuns([first.script], [done]);
  });
});

test('required 14: a held run that is not adoptable keeps today\'s supersede path', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    // Started without `adoptable` (not through dispatchRun), held by the launch rule.
    const { first, done } = await startHeld(cwd, { kind: 'static', options: { adoptable: undefined } });
    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = adoptSend(cwd, w2, second.createQuery);
    await waitFor(() => second.script.options() !== null, 'a new process is spawned');
    assert.equal(first.script.released(), true);
    assert.equal(first.script.stdin.length, 1);
    first.script.end();
    await done;
    await emitAndFlush(second.script, init());
    await emitAndFlush(second.script, result());
    await waitFor(() => completes(w2).length === 1);
    await endRuns([second.script], [run2]);
  });
});

test('required 14/16: an unattended (agent-API) held run with work outstanding refuses with ADOPT_UNAVAILABLE and stops nothing', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { options: { unattended: true } });
    const second = createScriptedQuery();
    await assert.rejects(adoptSend(cwd, createWriter(), second.createQuery), isAdoptUnavailable(MSG_ID));
    assert.deepEqual(first.script.stopped, []);
    assert.equal(first.script.released(), false, 'the held process is still live');
    assert.equal(isClaudeSDKSessionActive(SESSION_ID), true);
    assert.equal(second.script.options(), null);
    await endRuns([first.script], [done]);
  });
});

test('required 15: a session whose context was cleared is not adopted and keeps its new provider id', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { kind: 'static' });
    const w2 = createWriter();
    const second = createScriptedQuery();
    const run2 = adoptSend(cwd, w2, second.createQuery, {}, { contextOverrides: { resolveProviderSessionId: () => null } });
    await waitFor(() => second.script.options() !== null, 'a new process is spawned');
    assert.equal(first.script.stdin.length, 1, 'nothing written into the held process');
    first.script.end();
    await done;

    await emitAndFlush(second.script, init('native-after-clear'));
    await emitAndFlush(second.script, result());
    await waitFor(() => completes(w2).length === 1);
    assert.deepEqual(w2.sessionIds, ['native-after-clear'], 'the old provider id is never assigned');
    await endRuns([second.script], [run2]);
  });
});

test('required 16: a refusal with work outstanding throws ADOPT_UNAVAILABLE naming the message, and stops nothing', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, {
      options: { permissionMode: 'bypassPermissions' },
      controls: { setPermissionMode: () => new Promise(() => {}) },
    });
    // A pending steer makes the guard refuse outright; use the permission
    // path instead, whose control request never answers (5s timeout).
    const second = createScriptedQuery();
    await assert.rejects(adoptSend(cwd, createWriter(), second.createQuery, { permissionMode: 'plan' }), isAdoptUnavailable(MSG_ID));
    assert.deepEqual(first.script.stopped, []);
    assert.equal(first.script.released(), false);
    assert.equal(second.script.options(), null);
    await endRuns([first.script], [done]);
  });
});

test('required 20: an invalid or reused messageId is replaced, and a slash command is not adopted', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const run2 = track(adoptSend(cwd, createWriter(), createScriptedQuery().createQuery, { messageId: 'not-a-uuid' }));
    await waitFor(() => first.script.stdin.length === 2);
    const firstId = String(first.script.stdin[1].uuid);
    assert.match(firstId, UUID);
    assert.notEqual(firstId, 'not-a-uuid');
    await playAdoptedTurn(first.script, firstId);
    await waitFor(run2.resolved);

    const run3 = track(adoptSend(cwd, createWriter(), createScriptedQuery().createQuery, { messageId: firstId }));
    await waitFor(() => first.script.stdin.length === 3);
    const secondId = String(first.script.stdin[2].uuid);
    assert.match(secondId, UUID);
    assert.notEqual(secondId, firstId, 'a reused id is not used twice');
    await playAdoptedTurn(first.script, secondId);
    await waitFor(run3.resolved);

    const fourth = createScriptedQuery();
    await assert.rejects(
      adoptSend(cwd, createWriter(), fourth.createQuery, { messageId: MSG_ID_2 }, { content: '  /compact' }),
      isAdoptUnavailable(MSG_ID_2),
    );
    assert.equal(first.script.stdin.length, 3, 'the slash command is not written');
    assert.equal(fourth.script.options(), null);
    await endRuns([first.script], [done]);
  });
});

test('required 21: the process exiting after the push but before the echo fails the adopted turn', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);

    first.script.end();
    await done;
    await waitFor(run2.resolved);
    assert.ok(w2.sent.some((message) => message.kind === 'error' && /not picked up/.test(String(message.content))));
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].exitCode, 1);
  });
});

test('required 22: a steer sent while the adoption is being set up joins the adopted turn', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const gate = deferred<void>();
    const { first, done } = await startHeld(cwd, { controls: { setModel: () => gate.promise } });
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery, { model: 'opus' }));
    await waitFor(() => first.script.count('setModel') === 1);

    let steered: boolean | null = null;
    const steering = steerClaudeSDKSession(SESSION_ID, 'also this', { messageId: STEER_ID }).then((value) => { steered = value; });
    await settle();
    assert.equal(steered, null, 'waits for the adoption to be decided');

    gate.resolve();
    await steering;
    assert.equal(steered, true, 'accepted, not refused');
    await waitFor(() => first.script.stdin.length === 3);
    assert.equal(first.script.stdin[1].uuid, MSG_ID);
    assert.equal(first.script.stdin[2].uuid, STEER_ID);
    assert.equal(first.script.stdin[2].priority, 'next');

    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, echo(STEER_ID, 'also this'));
    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    assert.equal(completes(w2).length, 1);
    await endRuns([first.script], [done]);
  });
});

test('required 23: a nested task event while held does not make the adopted turn ignore its own Monitor', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    // a1's own background command, started inside its transcript while held.
    await emitAndFlush(first.script, taskStarted('n1', 'toolu_inner', 'local_bash'));

    const run2 = track(adoptSend(cwd, createWriter(), createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    await emitAndFlush(first.script, taskNotification('n1', 'toolu_inner', 'stopped'));
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'stopped'));
    await emitAndFlush(first.script, toolUse('toolu_mon', 'Monitor', { command: 'tail -f log', description: 'watch' }));
    await emitAndFlush(first.script, ack('toolu_mon', 'Monitor started', {}));
    await emitAndFlush(first.script, result());
    await waitFor(run2.resolved);
    await settle();
    assert.equal(first.script.released(), false, 'held for the Monitor');
    await endRuns([first.script], [done]);
  });
});

test('[local] work held by the launch rule before the adoption keeps the process held after the adopted turn', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { kind: 'static' });
    const run2 = track(adoptSend(cwd, createWriter(), createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await playAdoptedTurn(first.script, MSG_ID);
    await waitFor(run2.resolved);
    await settle();
    assert.equal(first.script.released(), false, 'the ScheduleWakeup from before the adoption still needs the process');
    await endRuns([first.script], [done]);
  });
});

test('only Claude advertises background adoption', () => {
  const expected: Record<LLMProvider, boolean> = { claude: true, codex: false, cursor: false, opencode: false };
  for (const [provider, supported] of Object.entries(expected) as Array<[LLMProvider, boolean]>) {
    const capabilities = providerCapabilitiesService.getProviderCapabilities(provider) as unknown as AnyRecord;
    assert.equal(capabilities.supportsBackgroundAdoption, supported, provider);
  }
});

// ============================================================================
// Review findings 1-6
// ============================================================================

test('review 1: Stop on an adopted turn spares tasks launched inside work from before the adoption', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    // a1 backgrounds a command of its own while the adopted turn runs.
    await emitAndFlush(first.script, taskStarted('n1', 'toolu_inner', 'local_bash'));
    // The adopted turn starts an agent of its own.
    await emitAndFlush(first.script, toolUse('toolu_a2', 'Agent', { prompt: 'more', subagent_type: 'general-purpose', run_in_background: true }));
    await emitAndFlush(first.script, taskStarted('a2', 'toolu_a2'));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    // [local] a2 runs in the background, so a Stop of the turn spares it too.
    assert.deepEqual(first.script.stopped, [], 'no background task is stopped');
    assert.deepEqual(
      listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId).sort()),
      [['a1', 'a2', 'n1']],
      'a1 and its child keep running',
    );
    await endRuns([first.script], [done]);
  });
});

test('review 2: a full Stop withdraws an adopted message that was pushed but not read yet', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { controls: { cancelAsyncMessage: async () => false } });
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    // a1 reports in, and the CLI runs its relay turn before reading our message:
    // nothing from before the adoption is left, so the Stop takes the full path.
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'completed'));
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('Relaying a1.'));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    const calls = first.script.log.filter((entry) => entry.method === 'cancelAsyncMessage' || entry.method === 'interrupt')
      .map((entry) => `${entry.method}:${String(entry.args[0] ?? '')}`);
    assert.deepEqual(calls, [`cancelAsyncMessage:${MSG_ID}`, 'interrupt:'], 'withdrawn before the interrupt');
    assert.equal(isClaudeSDKSessionActive(SESSION_ID), false);

    // The CLI would not cancel it and starts it after the interrupted relay.
    await emitAndFlush(first.script, result('error_during_execution'));
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    assert.equal(first.script.count('interrupt'), 2, 'interrupted the moment it starts');
    await emitAndFlush(first.script, assistantText('SHOULD NOT SHOW'));
    await emitAndFlush(first.script, result('error_during_execution'));
    await settle();
    assert.equal(sentText(w2, 'SHOULD NOT SHOW'), false, 'nothing of it streams onto the stopped run');
    assert.equal(completes(w2).length, 0, 'the gateway sends the aborted complete on this path');
    assert.equal(w2.sent.some((message) => message.kind === 'error'), false);
    await endRuns([first.script], [done, run2.promise]);
    await waitFor(run2.resolved);
  });
});

test('review 3: the pickup watchdog does not count a relay turn\'s silence, only idle silence', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);

    // A relay turn with a long silent tool call.
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, toolUse('toolu_long', 'Bash', { command: 'sleep 300' }));
    t.mock.timers.tick(5 * 60 * 1000);
    await settle();
    assert.equal(completes(w2).length, 0, 'a turn the CLI is running is not silence');
    assert.equal(run2.resolved(), false);

    await emitAndFlush(first.script, ack('toolu_long', 'done', {}));
    await emitAndFlush(first.script, result());
    t.mock.timers.tick(59_000);
    await settle();
    assert.equal(completes(w2).length, 0);
    t.mock.timers.tick(1_000);
    await waitFor(run2.resolved, 'idle silence after the relay still fails it');
    assert.match(String(w2.sent.find((message) => message.kind === 'error')?.content), /not picked up/);
    await endRuns([first.script], [done]);
  });
});

test('review 3: an absolute backstop fails an adopted message a wedged CLI never reads', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    t.mock.timers.tick(10 * 60 * 1000 - 1_000);
    await settle();
    assert.equal(run2.resolved(), false);
    t.mock.timers.tick(1_000);
    await waitFor(run2.resolved, 'the backstop fires');
    assert.equal(completes(w2).length, 1);
    assert.equal(completes(w2)[0].exitCode, 1);
    await endRuns([first.script], [done]);
  });
});

test('review 4: live option changes are reverted when the adoption is cancelled', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const gate = deferred<void>();
    const { first, done } = await startHeld(cwd, { controls: { setModel: () => gate.promise } });
    const sdkOptions = first.script.options()!;
    const before = {
      hasMode: Object.prototype.hasOwnProperty.call(sdkOptions, 'permissionMode'),
      mode: sdkOptions.permissionMode,
      model: sdkOptions.model,
      allowed: [...(sdkOptions.allowedTools ?? [])],
      disallowed: [...(sdkOptions.disallowedTools ?? [])],
    };
    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery, { model: 'opus', permissionMode: 'acceptEdits', allowedTools: ['Read'] }));
    await waitFor(() => first.script.count('setModel') === 1);
    assert.equal(sdkOptions.permissionMode, 'acceptEdits', 'the mode was applied before the Stop');

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await waitFor(run2.resolved);
    gate.resolve();
    await waitFor(() => first.script.count('setPermissionMode') === 2 && first.script.count('setModel') === 2, 'the changes are reverted');
    const args = (method: string) => first.script.log.filter((entry) => entry.method === method).map((entry) => entry.args[0]);
    assert.deepEqual(args('setPermissionMode'), ['acceptEdits', typeof before.mode === 'string' ? before.mode : 'default']);
    assert.deepEqual(args('setModel'), ['opus', before.model]);
    assert.equal(Object.prototype.hasOwnProperty.call(sdkOptions, 'permissionMode'), before.hasMode);
    assert.equal(sdkOptions.permissionMode, before.mode);
    assert.deepEqual(sdkOptions.allowedTools, before.allowed);
    assert.deepEqual(sdkOptions.disallowedTools, before.disallowed);
    assert.equal(first.script.stdin.length, 1, 'nothing was pushed');
    await endRuns([first.script], [done]);
  });
});

test('review 5: the adopted turn\'s result landing while a Stop awaits a cancel is not counted as a relay', { concurrency: false }, async () => {
  await withCwd(async (cwd) => {
    const cancelGate = deferred<boolean>();
    const { first, done } = await startHeld(cwd, { controls: { cancelAsyncMessage: () => cancelGate.promise } });
    // A second agent from before the adoption.
    await emitAndFlush(first.script, toolUse('toolu_a3', 'Agent', { prompt: 'other', subagent_type: 'general-purpose', run_in_background: true }));
    await emitAndFlush(first.script, taskStarted('a3', 'toolu_a3'));

    const w2 = createWriter();
    const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
    await waitFor(() => first.script.stdin.length === 2);
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'also this', { messageId: STEER_ID }), true);
    await waitFor(() => first.script.stdin.length === 3);
    // a3 reports in: its relay is owed.
    await emitAndFlush(first.script, taskNotification('a3', 'toolu_a3', 'completed'));

    const stopping = track(abortClaudeSDKSession(SESSION_ID));
    await waitFor(() => first.script.count('cancelAsyncMessage') === 1, 'the Stop awaits the steer cancel');
    await waitFor(run2.resolved);
    // The adopted turn ends on its own while the cancel is out.
    await emitAndFlush(first.script, result());
    // a3's relay.
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('a3 reported.'));
    await emitAndFlush(first.script, result());
    // a1 reports in: one more relay owed.
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'completed'));
    cancelGate.resolve(true);
    await waitFor(stopping.resolved);
    assert.equal(first.script.released(), false, 'a1\'s relay is still owed');

    // a1's relay is a relay, not the interrupted turn: it pays the last debt.
    await emitAndFlush(first.script, init());
    await emitAndFlush(first.script, assistantText('a1 reported.'));
    await emitAndFlush(first.script, result());
    await waitFor(() => first.script.released(), 'released once the last relay ran');
    await endRuns([first.script], [done]);
  });
});

test('review 6: a Stop whose awaits outlive the process arms no timer afterwards', { concurrency: false }, async () => {
  const CEILING_MS = 30 * 60 * 1000;
  const MAX_HOLD_MS = 12 * 60 * 60 * 1000;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const liveCeilings = new Set<unknown>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(() => {
      liveCeilings.delete(handle);
      callback(...args);
    }, ms);
    // [local] The hold timer is the long bound while a task is still running.
    if (ms === CEILING_MS || ms === MAX_HOLD_MS) {
      liveCeilings.add(handle);
    }
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    liveCeilings.delete(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    for (const scenario of ['echoed', 'unread'] as const) {
      await withCwd(async (cwd) => {
        const cancelGate = deferred<boolean>();
        const { first, done } = await startHeld(cwd, { controls: { cancelAsyncMessage: () => cancelGate.promise } });
        const w2 = createWriter();
        const run2 = track(adoptSend(cwd, w2, createScriptedQuery().createQuery));
        await waitFor(() => first.script.stdin.length === 2);
        if (scenario === 'echoed') {
          await emitAndFlush(first.script, init());
          await emitAndFlush(first.script, echo(MSG_ID, 'Continue'));
          assert.equal(await steerClaudeSDKSession(SESSION_ID, 'also this', { messageId: STEER_ID }), true);
          await waitFor(() => first.script.stdin.length === 3);
        }

        const stopping = track(abortClaudeSDKSession(SESSION_ID));
        await waitFor(() => first.script.count('cancelAsyncMessage') === 1, `${scenario}: the Stop awaits a cancel`);
        // The process exits meanwhile.
        first.script.end();
        await done;
        await waitFor(run2.resolved);
        assert.equal(liveCeilings.size, 0, `${scenario}: the finished run holds no idle timer`);

        cancelGate.resolve(scenario === 'unread');
        await waitFor(stopping.resolved);
        await settle();
        assert.equal(liveCeilings.size, 0, `${scenario}: the Stop arms none after the process exited`);
      });
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    for (const handle of liveCeilings) {
      realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }
  }
});

// ============================================================================
// [local] Long background work: the hold bound and the level signal
// ============================================================================

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const backgroundTasksChanged = (tasks: AnyRecord[]) => ({
  type: 'system', subtype: 'background_tasks_changed', session_id: NATIVE_ID, uuid: 'level', tasks,
});

test('[local] a running task silent past the idle ceiling keeps the process held, up to the hold bound', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = process.env.CLOUDCLI_BG_MAX_HOLD_MS;
  delete process.env.CLOUDCLI_BG_MAX_HOLD_MS;
  try {
    await withCwd(async (cwd) => {
      const { first, done } = await startHeld(cwd);
      t.mock.timers.tick(31 * MINUTE);
      await settle();
      assert.equal(first.script.released(), false, 'a1 is still running: no release on 31 minutes of silence');
      assert.deepEqual(first.script.stopped, []);

      t.mock.timers.tick(12 * HOUR - 31 * MINUTE);
      await waitFor(() => first.script.released(), 'released at the hold bound');
      assert.deepEqual(first.script.stopped, ['a1'], 'the task is stopped before the release');
      await endRuns([first.script], [done]);
    });
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_BG_MAX_HOLD_MS; else process.env.CLOUDCLI_BG_MAX_HOLD_MS = previous;
  }
});

test('[local] CLOUDCLI_BG_MAX_HOLD_MS sets the hold bound', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = process.env.CLOUDCLI_BG_MAX_HOLD_MS;
  process.env.CLOUDCLI_BG_MAX_HOLD_MS = String(2 * HOUR);
  try {
    await withCwd(async (cwd) => {
      const { first, done } = await startHeld(cwd);
      t.mock.timers.tick(2 * HOUR - 1);
      await settle();
      assert.equal(first.script.released(), false);
      t.mock.timers.tick(1);
      await waitFor(() => first.script.released(), 'released at the configured bound');
      await endRuns([first.script], [done]);
    });
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_BG_MAX_HOLD_MS; else process.env.CLOUDCLI_BG_MAX_HOLD_MS = previous;
  }
});

test('[local] a hold with no tracked task still ends at the idle ceiling', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { kind: 'static' });
    t.mock.timers.tick(30 * MINUTE - 1);
    await settle();
    assert.equal(first.script.released(), false);
    t.mock.timers.tick(1);
    await waitFor(() => first.script.released(), 'released at the idle ceiling');
    await endRuns([first.script], [done]);
  });
});

test('[local] once the last task has ended, the idle ceiling applies again', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    // a1 reports in, but the CLI never runs the relay turn.
    await emitAndFlush(first.script, taskNotification('a1', 'toolu_a1', 'completed'));
    t.mock.timers.tick(30 * MINUTE);
    await waitFor(() => first.script.released(), 'released at the idle ceiling');
    assert.deepEqual(first.script.stopped, []);
    await endRuns([first.script], [done]);
  });
});

test('[local] a level that no longer lists a task drops it although its end event never came', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd);
    await emitAndFlush(first.script, backgroundTasksChanged([{ task_id: 'a1', task_type: 'local_agent', description: 'Task a1' }]));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['a1']]);

    // The task_notification for a1 is lost; the level still says it is gone.
    await emitAndFlush(first.script, backgroundTasksChanged([]));
    assert.deepEqual(listClaudeSDKBackgroundWork(), [], 'no ghost task');
    t.mock.timers.tick(30 * MINUTE);
    await waitFor(() => first.script.released(), 'no ghost hold either: released at the idle ceiling');
    await endRuns([first.script], [done]);
  });
});

test('[local] a task only the level reports keeps the process held', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withCwd(async (cwd) => {
    const { first, done } = await startHeld(cwd, { kind: 'static' });
    // Its task_started was missed.
    await emitAndFlush(first.script, backgroundTasksChanged([{ task_id: 'x1', task_type: 'local_bash', description: 'npm test' }]));
    t.mock.timers.tick(31 * MINUTE);
    await settle();
    assert.equal(first.script.released(), false, 'x1 is running');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['x1']]);
    await endRuns([first.script], [done]);
  });
});
