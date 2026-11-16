import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import { ADOPT_UNAVAILABLE_ERROR_CODE, AppError } from '@/shared/utils.js';

/**
 * [local] A message queued while a Claude turn runs over background work
 * carries `adoptHeld` when the composer would adopt the held process. Such a
 * message only waits for the turn, not for the background work: the runtime
 * writes it into the live process, which keeps the work running. When the
 * runtime cannot adopt it (ADOPT_UNAVAILABLE), the message goes back in the
 * queue and waits for the work like any other queued message.
 */

const SESSION_ID = 'scheduled-adopt-session';
const MESSAGE_ID = '5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b';

async function withIsolatedDatabase(runTest: (userId: number) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-adopt-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const user = userDb.createUser('adopter', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Adopt session');
    await runTest(Number(user.id));
  } finally {
    closeScheduledMessageDispatcher();
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { command: string; options: Record<string, unknown> };

function createRuntime(
  runs: RunCall[],
  { backgroundWork = () => true, refuseAdoption = false }: { backgroundWork?: () => boolean; refuseAdoption?: boolean } = {},
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: (sessionId: string) => sessionId === SESSION_ID && backgroundWork(),
    run: async (_provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ command, options });
      if (refuseAdoption && options.adoptHeld === true) {
        throw new AppError('Background work is still running.', {
          code: ADOPT_UNAVAILABLE_ERROR_CODE,
          statusCode: 409,
          details: { messageId: options.messageId },
        });
      }
    },
    abort: async () => true,
  } as never;
}

/** Lets the run-settled microtask and the detached turn it starts finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function startTurn(userId: number) {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId,
  });
  assert.ok(run);
  return run;
}

test('required 17: a queued adoptHeld message goes when the turn ends, while background work still runs', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    await settle();

    const turn = startTurn(userId);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send when this turn ends', options: { adoptHeld: true, messageId: MESSAGE_ID } },
    });
    await settle();
    assert.equal(runs.length, 0, 'the turn is still running');

    turn.writer.sendComplete({ exitCode: 0 });
    await settle();
    assert.equal(runs.length, 1, 'background work does not hold it back');
    assert.equal(runs[0].command, 'send when this turn ends');
    assert.equal(runs[0].options.adoptHeld, true);
    assert.equal(runs[0].options.adoptable, true);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('required 17: a queued message without adoptHeld still waits for the background work', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    await settle();

    const turn = startTurn(userId);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the work' },
    });
    turn.writer.sendComplete({ exitCode: 0 });
    await settle();
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'send after the work' });
  });
});

test('required 16: a queued adoptHeld message the runtime cannot adopt is put back to wait for the work', async () => {
  await withIsolatedDatabase(async (userId) => {
    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, { backgroundWork: () => backgroundWork, refuseAdoption: true });
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'continue', options: { adoptHeld: true, messageId: MESSAGE_ID } },
    });

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
    const restored = sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage as Record<string, unknown> | undefined;
    assert.ok(restored, 'the message is back in the queue');
    assert.equal(restored.content, 'continue');
    assert.equal((restored.options as Record<string, unknown>).adoptHeld, false, 'it no longer asks to adopt');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    // It now waits for the work instead of retrying the adoption in a loop.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 1);

    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].options.adoptHeld, false);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});
