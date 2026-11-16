import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchDueScheduledMessages,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
  runDispatchPass,
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
type Writer = { sendComplete: (opts: { exitCode: number }) => void };

function createRuntime(
  runs: RunCall[],
  {
    backgroundWork = () => true,
    refuseAdoption = false,
    aborts = [],
    holdAfterTurn,
  }: {
    backgroundWork?: () => boolean;
    refuseAdoption?: boolean;
    aborts?: string[];
    /**
     * [local] Ends the turn (`complete`) but keeps the run open until this
     * resolves, like a Claude run whose process is held for background work.
     */
    holdAfterTurn?: Promise<void>;
  } = {},
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: (sessionId: string) => sessionId === SESSION_ID && backgroundWork(),
    run: async (_provider: string, command: string, options: Record<string, unknown>, writer: Writer) => {
      runs.push({ command, options });
      if (refuseAdoption && options.adoptHeld === true) {
        throw new AppError('Background work is still running.', {
          code: ADOPT_UNAVAILABLE_ERROR_CODE,
          statusCode: 409,
          details: { messageId: options.messageId },
        });
      }
      if (holdAfterTurn) {
        writer.sendComplete({ exitCode: 0 });
        await holdAfterTurn;
      }
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
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

test('[local] a queued message the held process refused once (adoptHeld: false) still waits for the background work', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    await settle();

    const turn = startTurn(userId);
    const queuedMessage = { content: 'send after the work', options: { adoptHeld: false } };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    turn.writer.sendComplete({ exitCode: 0 });
    await settle();
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);
  });
});

test('[local] stage 4: a queued message without the mark joins the held process instead of waiting for the work', async () => {
  // Queued over background work, or before the mark existed: Claude answers
  // it while the work keeps running, as the official client does.
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    await settle();

    const turn = startTurn(userId);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'what is the agent doing?' } });
    turn.writer.sendComplete({ exitCode: 0 });
    await settle();
    assert.equal(runs.length, 1, 'background work does not hold it back');
    assert.equal(runs[0].options.adoptHeld, true, 'it joins the held process');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('[local] stage 4: a queued slash command still waits for the background work', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: '/compact' } });
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

// ----------------------------------------------------------------------------
// [local] Stage 4: scheduled messages never interrupt a turn or stop work
// ----------------------------------------------------------------------------

function scheduleDue(userId: number, content: string, sessionId = SESSION_ID, ageMs = 1_000) {
  return scheduledMessagesDb.create({ userId, sessionId, content, options: {}, scheduledFor: new Date(Date.now() - ageMs) });
}

const statuses = (userId: number) => scheduledMessagesDb.listForSession(userId, SESSION_ID)
  .map((row) => `${row.content}:${row.status}`).sort();

test('[local] stage 4: a due message waits for the running turn instead of interrupting it, then joins the process', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    const runtime = createRuntime(runs, { aborts });
    initializeScheduledMessageDispatcher(runtime);
    await settle();

    const turn = startTurn(userId);
    scheduleDue(userId, 'nightly check');
    assert.equal(await dispatchDueScheduledMessages(runtime), 0, 'not claimed while the turn runs');
    assert.deepEqual(aborts, [], 'the turn is not interrupted');
    assert.equal(runs.length, 0);
    assert.deepEqual(statuses(userId), ['nightly check:pending'], 'still pending: the banner stays up, it can be cancelled');

    turn.writer.sendComplete({ exitCode: 0 });
    await settle();
    assert.equal(runs.length, 1, 'sent as soon as the turn ended, not on the next poll');
    assert.equal(runs[0].command, 'nightly check');
    assert.equal(runs[0].options.adoptHeld, true, 'into the held process: background work keeps running');
    assert.deepEqual(aborts, []);
    assert.deepEqual(statuses(userId), ['nightly check:sent']);

    // Delivered once: neither a poll nor another settle sends it again.
    await runDispatchPass(runtime);
    assert.equal(runs.length, 1);
  });
});

test('[local] stage 4: a due message while only background work runs is sent at once into the held process', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    startTurn(userId).writer.sendComplete({ exitCode: 0 });
    scheduleDue(userId, 'check on the agent');
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, { aborts })), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.adoptHeld, true);
    assert.deepEqual(aborts, []);
  });
});

test('[local] stage 4: a due message the held process cannot take is recorded as not sent, nothing is stopped', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    scheduleDue(userId, 'go on');
    await dispatchDueScheduledMessages(createRuntime(runs, { refuseAdoption: true, aborts }));
    assert.equal(runs.length, 1);
    assert.deepEqual(aborts, []);
    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /background work/);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('[local] stage 4: a scheduled turn that leaves background work holds back the session only until the turn ends', async () => {
  await withIsolatedDatabase(async (userId) => {
    let releaseWork: () => void = () => undefined;
    const work = new Promise<void>((resolve) => { releaseWork = resolve; });
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, { holdAfterTurn: work });
    initializeScheduledMessageDispatcher(runtime);
    await settle();
    try {
      scheduleDue(userId, 'first', SESSION_ID, 2_000);
      scheduleDue(userId, 'second', SESSION_ID, 1_000);
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'queued behind them' } });

      const pass = dispatchDueScheduledMessages(runtime);
      await settle();
      // Both scheduled turns ended while their runs stay open for the work;
      // the queued message went after them, into the same held process.
      assert.deepEqual(runs.map((run) => run.command), ['first', 'second', 'queued behind them']);
      assert.ok(runs.every((run) => run.options.adoptHeld === true));
      assert.equal(await pass, 2);
      assert.deepEqual(sessionDraftsDb.listQueuedMessages(SESSION_ID), [], 'claimed once');
    } finally {
      releaseWork();
      await settle();
    }
  });
});

test('[local] stage 4: a due message for another provider still interrupts the run (unchanged)', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionsDb.createAppSession('codex-session', 'codex', '/tmp', 'Codex');
    chatRunRegistry.startRun({ appSessionId: 'codex-session', provider: 'codex', providerSessionId: null, connection: null, userId });
    scheduleDue(userId, 'codex now', 'codex-session');
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, { aborts })), 1);
    assert.deepEqual(aborts, ['codex-session']);
    assert.equal(runs[0].options.adoptHeld, undefined);
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

test('[local] stage 4: a turn that starts between the claim and the send puts the due message back to wait for it', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    const base = createRuntime(runs, { aborts }) as Record<string, unknown>;
    let userTurn: ReturnType<typeof startTurn> | null = null;
    const runtime = {
      ...base,
      // Looked up after the claim: the user's own send starts its turn here.
      hasRuntime: () => {
        userTurn ??= startTurn(userId);
        return true;
      },
    } as never;
    scheduleDue(userId, 'later please');
    await dispatchDueScheduledMessages(runtime);
    assert.equal(runs.length, 0, 'nothing ran');
    assert.deepEqual(aborts, [], 'the user turn is not interrupted');
    assert.deepEqual(statuses(userId), ['later please:pending']);

    userTurn!.writer.sendComplete({ exitCode: 0 });
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.equal(runs.length, 1);
    assert.deepEqual(statuses(userId), ['later please:sent']);
  });
});
