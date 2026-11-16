import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
// Required test 19 drives the real Claude runtime behind the real chat gateway
// (two tabs on one held process), which no barrel exposes: the runtime is
// reached only through providerRuntimeService, whose query seam a test cannot
// replace. Test-only exception to the barrel rule.
// oxlint-disable-next-line boundaries/dependencies
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
// oxlint-disable-next-line boundaries/dependencies
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
// oxlint-disable-next-line boundaries/dependencies
import { listClaudeSDKBackgroundWork, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { ADOPT_UNAVAILABLE_ERROR_CODE, AppError } from '@/shared/utils.js';

/**
 * [local] The gateway side of adopting a held Claude process: `chat.send`
 * marks every run it dispatches adoptable (a client cannot opt a run out or
 * in), reports a refused adoption as `ADOPT_UNAVAILABLE` naming the message,
 * and the run that adopts the held process takes over the sockets watching it.
 */

const SESSION_ID = 'adopt-gateway-session';
const NATIVE_ID = 'native-adopt-gateway';
const MESSAGE_ID = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';

function createFakeSocket(readyState = 1) {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = readyState;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type RunCall = { provider: string; command: string; options: AnyRecord; writer: ProviderRuntimeWriter };

async function withGateway(
  run: (call: RunCall) => Promise<unknown>,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; calls: RunCall[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-adopt-held-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const calls: RunCall[] = [];
  const socket = createFakeSocket();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        hasBackgroundWork: () => false,
        getPendingApprovalsForSession: () => [],
        run: async (provider: string, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) => {
          const call = { provider, command, options, writer };
          calls.push(call);
          return run(call);
        },
      } as never,
    });
    await runTest({ socket, calls });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

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

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.send passes adoptHeld and messageId on, and the server alone decides the run is adoptable', async () => {
  await withGateway(async ({ writer }) => {
    writer.send({ kind: 'complete', provider: 'claude', sessionId: NATIVE_ID, exitCode: 0 });
  }, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'Continue',
      // A client cannot switch adoption off (or on) for a run: the flag is overwritten.
      options: { adoptHeld: true, messageId: MESSAGE_ID, adoptable: false },
    }));
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.adoptHeld, true);
    assert.equal(calls[0].options.messageId, MESSAGE_ID);
    assert.equal(calls[0].options.adoptable, true);
  });
});

test('a refused adoption is reported as ADOPT_UNAVAILABLE naming the message, then the run ends', async () => {
  await withGateway(async () => {
    throw new AppError('Background work is still running.', {
      code: ADOPT_UNAVAILABLE_ERROR_CODE,
      statusCode: 409,
      details: { messageId: MESSAGE_ID },
    });
  }, async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'Continue',
      options: { adoptHeld: true, messageId: MESSAGE_ID },
    }));
    await settle();

    const refusalAt = socket.frames.findIndex((frame) => frame.kind === 'protocol_error');
    const completeAt = socket.frames.findIndex((frame) => frame.kind === 'complete');
    assert.ok(refusalAt >= 0, 'a protocol error is sent');
    assert.equal(socket.frames[refusalAt].code, 'ADOPT_UNAVAILABLE');
    assert.equal(socket.frames[refusalAt].messageId, MESSAGE_ID);
    assert.equal(socket.frames[refusalAt].sessionId, SESSION_ID);
    assert.ok(completeAt > refusalAt, 'followed by the run\'s end');
    assert.equal(socket.frames[completeAt].exitCode, 1);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('any other runtime failure is not reported as ADOPT_UNAVAILABLE', async () => {
  await withGateway(async () => {
    throw new Error('provider exploded');
  }, async ({ socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'hi', options: {} }));
    await settle();

    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
    assert.equal(socket.frames.find((frame) => frame.kind === 'complete')?.exitCode, 1);
  });
});

test('adoptConnectionsFrom takes over the other writer\'s open sockets only', () => {
  const makeWriter = (connection: ReturnType<typeof createFakeSocket> | null) => new ChatSessionWriter({
    connection: connection as never,
    userId: 1,
    provider: 'claude',
    providerSessionId: NATIVE_ID,
    onProviderSessionId: () => {},
    decorateOutboundEvent: (message) => message,
  });
  const tabA = createFakeSocket();
  const tabB = createFakeSocket();
  const closedTab = createFakeSocket(3);
  const previous = makeWriter(tabB);
  previous.updateWebSocket(closedTab as never);
  const adopting = makeWriter(tabA);

  adopting.adoptConnectionsFrom(previous);
  adopting.send({ kind: 'status', provider: 'claude', sessionId: NATIVE_ID, text: 'hello' });

  assert.equal(tabA.frames.length, 1);
  assert.equal(tabB.frames.length, 1, 'the tab watching the held run follows the adopted turn');
  assert.equal(closedTab.frames.length, 0);
});

// ----------------------------------------------------------------------------
// Two tabs, real runtime (required test 19)
// ----------------------------------------------------------------------------

type Scripted = { emit: (message: AnyRecord) => void; end: () => void; stdin: AnyRecord[]; consumed: () => number };

function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<AnyRecord | null> = [];
  let wake: (() => void) | null = null;
  let consumed = 0;
  const stdin: AnyRecord[] = [];
  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    stdin,
    consumed: () => consumed,
  };
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) {
        stdin.push(message as AnyRecord);
      }
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
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };
  return { createQuery, script };
}

async function emitAndFlush(script: Scripted, message: AnyRecord): Promise<void> {
  const before = script.consumed();
  script.emit(message);
  await waitFor(() => script.consumed() > before, `${String(message.type)} handled`);
}

test('required 19: a tab attached to the held run follows the adopted turn and the work that reports later', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-adopt-held-tabs-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const held = createScriptedQuery();
  const spawned: Scripted[] = [];
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: (sessionId) => (sessionId ? sessionsDb.getSessionById(sessionId)?.provider_session_id ?? null : null),
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    // The first run gets the held process; any later spawn would be a regression.
    createQuery: (input) => {
      if (spawned.length === 0) {
        spawned.push(held.script);
        return held.createQuery(input);
      }
      const extra = createScriptedQuery();
      spawned.push(extra.script);
      return extra.createQuery(input);
    },
  };
  const runtime = {
    hasRuntime: () => true,
    run: (_provider: string, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) =>
      queryClaudeSDK(command, options, writer as never, context),
    abort: async () => false,
    hasBackgroundWork: (sessionId: string) => listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === sessionId),
    getPendingApprovalsForSession: () => [],
  };

  const tabA = createFakeSocket();
  const tabB = createFakeSocket();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    // Run-stopped notifications read this user's preferences, so it must exist.
    const userId = Number(userDb.createUser('adopt-tabs-user', 'hash').id);
    handleChatConnection(tabA as never, { user: { id: userId } } as never, { runtime: runtime as never });
    handleChatConnection(tabB as never, { user: { id: userId } } as never, { runtime: runtime as never });

    // Turn 1 from tab A leaves a background agent running.
    tabA.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'start an agent', options: {} }));
    await waitFor(() => held.script.stdin.length === 1, 'turn 1 started');
    await emitAndFlush(held.script, { type: 'system', subtype: 'init', session_id: NATIVE_ID });
    await emitAndFlush(held.script, {
      type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Agent', input: { prompt: 'wait', run_in_background: true } }] },
    });
    await emitAndFlush(held.script, { type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: 'a1', tool_use_id: 'toolu_a1', description: 'wait', task_type: 'local_agent' });
    await emitAndFlush(held.script, { type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });
    await waitFor(() => tabA.frames.some((frame) => frame.kind === 'complete'), 'turn 1 complete');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.provider_session_id, NATIVE_ID);

    // Tab B opens the session during the background work and attaches to run 1.
    tabB.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();
    assert.ok(tabB.frames.some((frame) => frame.kind === 'chat_subscribed'), 'tab B attached');

    // Tab A sends into the held process.
    tabA.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'Continue',
      options: { adoptHeld: true, messageId: MESSAGE_ID },
    }));
    await waitFor(() => held.script.stdin.length === 2, 'adopted');
    assert.equal(spawned.length, 1, 'no new process');
    await emitAndFlush(held.script, { type: 'system', subtype: 'init', session_id: NATIVE_ID });
    await emitAndFlush(held.script, {
      type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null, isReplay: true, uuid: MESSAGE_ID,
      message: { role: 'user', content: 'Continue' },
    });
    await emitAndFlush(held.script, {
      type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Adopted reply' }] },
    });
    await emitAndFlush(held.script, { type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });
    await waitFor(() => tabB.frames.filter((frame) => frame.kind === 'complete').length === 1, 'tab B sees the adopted turn end');
    assert.ok(JSON.stringify(tabB.frames).includes('Adopted reply'), 'tab B sees the adopted turn');
    assert.equal(tabA.frames.filter((frame) => frame.kind === 'complete').length, 2);

    // The agent reports back later; both tabs see it.
    await emitAndFlush(held.script, { type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: 'a1', tool_use_id: 'toolu_a1', status: 'completed', summary: 'done', output_file: '' });
    await settle();
    assert.ok(tabB.frames.some((frame) => frame.kind === 'task_status'), 'tab B sees the task report');
    assert.ok(tabA.frames.some((frame) => frame.kind === 'task_status'));
  } finally {
    held.script.end();
    for (const script of spawned) {
      script.end();
    }
    await settle();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
