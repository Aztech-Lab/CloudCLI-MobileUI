import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

const SESSION_ID = 'steer-session';
const MESSAGE_ID = '0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type SteerCall = { provider: string; sessionId: string; command: string; options: AnyRecord };

/**
 * A gateway whose runtime accepts or refuses every steer as `accepts` says.
 * `running` decides whether the session has a chat run in progress.
 */
async function withGateway(
  { accepts, running, cancels = false, backgrounds = false }: { accepts: boolean; running: boolean; cancels?: boolean; backgrounds?: boolean },
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; steers: SteerCall[]; calls: string[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const steers: SteerCall[] = [];
  // [local] `cancelSteer` / `backgroundTask` calls, as "<method>:<provider>:<sessionId>:<id>".
  const calls: string[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    if (running) {
      chatRunRegistry.startRun({
        appSessionId: SESSION_ID,
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: 1,
      });
    }

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          steer: async (provider: string, sessionId: string, command: string, options: AnyRecord) => {
            steers.push({ provider, sessionId, command, options });
            return accepts;
          },
          cancelSteer: async (provider: string, sessionId: string, messageId: string) => {
            calls.push(`cancelSteer:${provider}:${sessionId}:${messageId}`);
            return cancels;
          },
          backgroundTask: async (provider: string, sessionId: string, toolUseId: string) => {
            calls.push(`backgroundTask:${provider}:${sessionId}:${toolUseId}`);
            return backgrounds;
          },
        } as never,
      },
    );

    await runTest({ socket, steers, calls });
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

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.steer hands the message to the session\'s provider runtime', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.steer',
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      content: 'change course',
    }));
    await settle();

    assert.equal(steers.length, 1);
    // The provider comes from the session row, never from the frame.
    assert.equal(steers[0].provider, 'claude');
    assert.equal(steers[0].sessionId, SESSION_ID);
    assert.equal(steers[0].command, 'change course');
    assert.equal(steers[0].options.messageId, MESSAGE_ID);
    assert.deepEqual(steers[0].options.images, []);
    assert.deepEqual(steers[0].options.files, []);
    // The sender learns it was taken; the echo comes later on the run stream.
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'chat_steer_accepted');
    assert.equal(socket.frames[0].messageId, MESSAGE_ID);
    assert.equal(socket.frames[0].sessionId, SESSION_ID);
  });
});

test('a steer with no running turn is refused with STEER_UNAVAILABLE, naming the message', async () => {
  await withGateway({ accepts: true, running: false }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'hi' }));
    await settle();

    assert.equal(steers.length, 0, 'never reaches the runtime');
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
    assert.equal(socket.frames.at(-1)?.sessionId, SESSION_ID);
  });
});

test('a steer the runtime refuses (the turn just ended) is reported the same way', async () => {
  await withGateway({ accepts: false, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'hi' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
  });
});

test('a message id that is not a UUID is replaced, since it becomes the transcript uuid', async () => {
  await withGateway({ accepts: true, running: true }, async ({ steers, socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: '../etc', content: 'hi' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.match(String(steers[0].options.messageId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

test('an empty steer is refused before it reaches the runtime', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: '   ' }));
    await settle();

    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'MESSAGE_REQUIRED');
  });
});

// [local] Send now, withdraw, and move to background.

test('chat.steer passes "send now" through as urgent, and a plain steer as not urgent', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'now', urgent: true }));
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'next' }));
    await settle();

    assert.equal(steers.length, 2);
    assert.equal(steers[0].options.urgent, true);
    assert.equal(steers[1].options.urgent, false);
  });
});

test('chat.cancel-steer asks the runtime and reports whether the message was withdrawn', async () => {
  await withGateway({ accepts: true, running: true, cancels: true }, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.cancel-steer', sessionId: SESSION_ID, messageId: MESSAGE_ID }));
    await settle();

    assert.deepEqual(calls, [`cancelSteer:claude:${SESSION_ID}:${MESSAGE_ID}`]);
    assert.equal(socket.frames.at(-1)?.kind, 'chat_steer_cancelled');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
    assert.equal(socket.frames.at(-1)?.cancelled, true);
  });
});

test('chat.cancel-steer for a message already read answers cancelled: false', async () => {
  await withGateway({ accepts: true, running: true, cancels: false }, async ({ socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.cancel-steer', sessionId: SESSION_ID, messageId: MESSAGE_ID }));
    await settle();

    assert.equal(socket.frames.at(-1)?.kind, 'chat_steer_cancelled');
    assert.equal(socket.frames.at(-1)?.cancelled, false);
  });
});

test('chat.cancel-steer needs a message id that is a UUID', async () => {
  await withGateway({ accepts: true, running: true, cancels: true }, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.cancel-steer', sessionId: SESSION_ID, messageId: '../etc' }));
    await settle();

    assert.deepEqual(calls, []);
    assert.equal(socket.frames.at(-1)?.code, 'MESSAGE_ID_REQUIRED');
  });
});

test('chat.background-task moves the named tool call aside and says nothing on success', async () => {
  await withGateway({ accepts: true, running: true, backgrounds: true }, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID, toolUseId: 'toolu_1' }));
    await settle();

    assert.deepEqual(calls, [`backgroundTask:claude:${SESSION_ID}:toolu_1`]);
    assert.equal(socket.frames.length, 0, 'the tool result and task events arrive on the run stream');
  });
});

test('chat.background-task that moved nothing is reported with BACKGROUND_UNAVAILABLE, naming the call', async () => {
  await withGateway({ accepts: true, running: true, backgrounds: false }, async ({ socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID, toolUseId: 'toolu_1' }));
    await settle();

    assert.equal(socket.frames.at(-1)?.code, 'BACKGROUND_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.toolUseId, 'toolu_1');
  });
});

test('chat.background-task with no running turn never reaches the runtime', async () => {
  await withGateway({ accepts: true, running: false, backgrounds: true }, async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID, toolUseId: 'toolu_1' }));
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(calls, []);
    const codes = socket.frames.map((frame) => frame.code);
    assert.ok(codes.includes('BACKGROUND_UNAVAILABLE'));
    assert.ok(codes.includes('TOOL_USE_ID_REQUIRED'));
  });
});
