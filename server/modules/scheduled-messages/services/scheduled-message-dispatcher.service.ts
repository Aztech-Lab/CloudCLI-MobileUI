import { scheduledMessagesDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { providerCapabilitiesService } from '@/modules/providers/index.js';
import { announceScheduledMessagesChanged } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, onRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { ADOPT_UNAVAILABLE_ERROR_CODE, readQueuedChatMessage } from '@/shared/utils.js';

/** [local] Recorded on a scheduled message the held process could not take. */
const ADOPT_REFUSED_REASON = 'Not sent: Claude was running background work, and this message could not join that '
  + 'session without stopping it. Send it again when the work has finished.';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 *
 * Queued messages do not wait for this: they are also dispatched the moment
 * the run that blocked them settles (see `unsubscribeRunSettled` below). The
 * poll remains their safety net for the cases no run-settled event covers —
 * a message queued while nothing was running, or one left behind by a server
 * restart.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeRunSettled: (() => void) | null = null;
/**
 * Sessions whose scheduled sends are still going, from this pass or an
 * earlier one. Their next due rows stay pending (and keep their banner) until
 * those sends finish, so they neither overtake nor interrupt them.
 */
const sessionsSending = new Set<string>();

/**
 * [local] Whether a session's provider can take a new turn into the process
 * its background work runs in (Claude). Such a session is never interrupted or
 * restarted by the dispatcher: due and queued messages wait for the turn being
 * written and then join the live process, whatever background work it holds.
 */
function adoptsHeldProcess(sessionId: string): boolean {
  const provider = sessionsDb.getSessionById(sessionId)?.provider;
  if (!provider) {
    return false;
  }
  return providerCapabilitiesService.getProviderCapabilities(provider as LLMProvider)?.supportsBackgroundAdoption === true;
}

/**
 * [local] Whether a queued message goes into the held process. The composer
 * marks it (`adoptHeld`); a message it did not mark (queued over background
 * work, or before the mark existed) joins too when the provider can adopt,
 * as the official client answers a message while background work runs. A
 * message marked `adoptHeld: false` was refused by the held process once and
 * waits for the work instead; a slash command is a turn of its own.
 */
function queuedMessageAdopts(candidate: QueuedSessionMessageRecord): boolean {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  const flag = message?.options?.adoptHeld;
  if (flag === true) {
    return true;
  }
  if (flag === false || !message || message.content.trimStart().startsWith('/')) {
    return false;
  }
  return adoptsHeldProcess(candidate.sessionId);
}

/**
 * [local] Waits for a send until the turn it started ends, not for the whole
 * provider run: a Claude run that leaves background work running stays open
 * for as long as that work (hours), and a session's next due or queued
 * message would otherwise wait all that time instead of joining the process.
 * The session was idle when the send started (see `adoptsHeldProcess`), so
 * the first run that settles for it is this send's own turn.
 */
function untilTurnEnds(sessionId: string, send: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      unsubscribe?.();
      unsubscribe = null;
      resolve();
    };
    unsubscribe = onRunSettled((settledSessionId) => {
      if (settledSessionId === sessionId) {
        finish();
      }
    });
    send.then(finish, finish);
  });
}

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
  adopts = false,
): Promise<void> {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      // [local] See queuedMessageAdopts.
      options: { ...message.options, ...(adopts ? { adoptHeld: true } : {}), attachments: message.attachments },
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  // [local] Either refusal of a busy session (see RUN_IN_PROGRESS).
  if (!result.started && result.code === 'RUN_IN_PROGRESS') {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  // [local] The message asked to go into the held process, which could not
  // take it while its background work was still running; nothing ran. Put it
  // back without `adoptHeld`, so it waits for that work like any queued
  // message instead of being retried (and refused) every time a run settles.
  if (result.code === ADOPT_UNAVAILABLE_ERROR_CODE) {
    const waiting = { ...message, options: { ...message.options, adoptHeld: false } };
    sessionDraftsDb.restoreQueuedMessage({ ...candidate, queuedMessage: waiting, claimToken: JSON.stringify(waiting) });
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 *
 * [local] Except a turn that joins the held process (see queuedMessageAdopts):
 * the runtime writes that turn into the live process and the work keeps
 * running, so it only waits for the turn. `sessionsSending` lasts only until a
 * scheduled send's turn ends for such a session (see untilTurnEnds).
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway, adoptsHeldProcess = false): boolean {
  if (adoptsHeldProcess) {
    return chatRunRegistry.isProcessing(sessionId) || sessionsSending.has(sessionId);
  }
  // sessionsSending too: a scheduled turn can complete before its send settles,
  // and the session's next due row would then interrupt this queued turn.
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId) || sessionsSending.has(sessionId);
}

/**
 * Sends every persisted queued turn whose session is currently idle.
 *
 * With a `sessionId`, only that session's queued turn is looked at: a run that
 * settles can only have unblocked its own session.
 */
export async function dispatchQueuedMessages(
  runtime: ProviderRuntimeGateway,
  sessionId?: string,
): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages(sessionId);
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    // [local] A12: see isSessionBusy.
    const adopts = queuedMessageAdopts(candidate);
    if (isSessionBusy(candidate.sessionId, runtime, adopts)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime, adopts);
  }));

  return claimed;
}

/** Records why a claimed message did not go, and shows it on its session's banner. */
function recordFailure(row: ScheduledMessageRow, reason: string): void {
  scheduledMessagesDb.markFailed(row.id, reason);
  announceScheduledMessagesChanged(row.session_id);
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
  adopts = false,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        // [local] Into the held process when there is one: background work
        // keeps running. A slash command is never written into it, and the
        // runtime refuses it rather than stop that work (ADOPT_UNAVAILABLE).
        options: adopts ? { ...readOptions(row.options), adoptHeld: true } : readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        // [local] Not for a provider that adopts: the message waited for the
        // turn (see claimDue's skip set) and never stops one.
        interruptActiveRun: !adopts,
      },
      { runtime },
    );

    // [local] A turn started in the moment between the claim and the send:
    // nothing ran, so the message goes back to wait for that turn.
    if (adopts && !result.started && result.code === 'RUN_IN_PROGRESS') {
      scheduledMessagesDb.markPending(row.id);
      announceScheduledMessagesChanged(row.session_id);
      return;
    }
    if (result.code === ADOPT_UNAVAILABLE_ERROR_CODE) {
      recordFailure(row, ADOPT_REFUSED_REASON);
      return;
    }

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      recordFailure(row, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(row, message);
  }
}

/**
 * Sends every message whose time has come and returns how many it handled.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  // [local] A session whose provider adopts and that is writing a turn is
  // skipped too: its due message stays pending (banner up, cancellable) and
  // goes as soon as the turn ends (see dispatchDueForSession), like a prompt
  // the official client queues at priority `later`.
  const skip = new Set(sessionsSending);
  for (const run of chatRunRegistry.listRunningRuns()) {
    if (adoptsHeldProcess(run.sessionId)) {
      skip.add(run.sessionId);
    }
  }
  const due = scheduledMessagesDb.claimDue(now, skip);
  if (due.length === 0) {
    return 0;
  }

  // The claim already recorded them as sent, so their banners come down now,
  // as the turns start, rather than once the last turn has finished.
  for (const sessionId of new Set(due.map((row) => row.session_id))) {
    announceScheduledMessagesChanged(sessionId);
  }

  // Sessions side by side, since a turn can stay open a long time (see
  // runDispatchPass). A session's rows that were due at `now` go one after
  // another in this pass, each claimed only when the earlier send ends, so
  // none is recorded as sent while it still waits and no poll gap opens
  // between them. A turn the user starts meanwhile is still interrupted, as
  // any scheduled send interrupts the active run.
  // shortcut: a session's next row waits for the whole earlier send, background work included (the runtime ends that hold after 30 idle minutes); interrupt instead if timeliness matters more.
  const sent = await Promise.all(due.map((first) => sendSessionRows(first, runtime, now)));
  return sent.reduce((total, count) => total + count, 0);
}

/**
 * Sends one session's claimed row and then each row still due behind it.
 * `sessionsSending` is set before the first await, so a queued pass started
 * right after this call already sees the session busy.
 */
async function sendSessionRows(first: ScheduledMessageRow, runtime: ProviderRuntimeGateway, now: Date): Promise<number> {
  const sessionId = first.session_id;
  sessionsSending.add(sessionId);
  let sent = 0;
  try {
    // [local] Decided once per session: see adoptsHeldProcess.
    const adopts = adoptsHeldProcess(sessionId);
    let row: ScheduledMessageRow | null = first;
    while (row) {
      const send = sendClaimedMessage(row, runtime, adopts);
      // [local] Only until its turn ends: see untilTurnEnds.
      await (adopts ? untilTurnEnds(sessionId, send) : send);
      sent += 1;
      // [local] A next row waits for a turn that started meanwhile.
      if (adopts && chatRunRegistry.isProcessing(sessionId)) {
        break;
      }
      row = scheduledMessagesDb.claimNextDue(sessionId, now);
      if (row) announceScheduledMessagesChanged(sessionId);
    }
  } catch (error) {
    logPassFailure(error);
  } finally {
    sessionsSending.delete(sessionId);
    // A run that settled while this session's sends were going was skipped
    // by the run-settled listener (isSessionBusy), so the queued turn it
    // unblocked goes now instead of waiting for the next poll.
    if (unsubscribeRunSettled) {
      void dispatchQueuedMessages(runtime, sessionId).catch(logPassFailure);
    }
  }
  return sent;
}

/**
 * [local] Sends a session's due scheduled message the moment the turn it
 * waited for ends, instead of on the next poll. Only for a provider that
 * adopts: any other provider's due message never waits (it interrupts).
 */
export async function dispatchDueForSession(
  runtime: ProviderRuntimeGateway,
  sessionId: string,
  now: Date = new Date(),
): Promise<number> {
  if (sessionsSending.has(sessionId) || chatRunRegistry.isProcessing(sessionId) || !adoptsHeldProcess(sessionId)) {
    return 0;
  }
  const first = scheduledMessagesDb.claimNextDue(sessionId, now);
  if (!first) {
    return 0;
  }
  announceScheduledMessagesChanged(sessionId);
  return sendSessionRows(first, runtime, now);
}

function logPassFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
}

/**
 * One poll's work. A send waits for its whole turn, and a Claude turn that
 * leaves background work running (a Monitor, say) stays open until that work
 * reports back, so passes must not wait on each other: claims are
 * transactional, and a queued turn skips a session that is still busy.
 *
 * Exported so a test can drive overlapping passes.
 */
export function runDispatchPass(runtime: ProviderRuntimeGateway): Promise<void> {
  return Promise.all([
    // First, so a due send that starts a run at once has registered it before
    // the queued pass checks whether that session is busy.
    dispatchDueScheduledMessages(runtime).catch(logPassFailure),
    dispatchQueuedMessages(runtime).catch(logPassFailure),
  ]).then(() => undefined);
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    void runDispatchPass(runtime);
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // A message queued during a turn is sent as soon as that turn ends. Without
  // this the only sender is the poll above, so the user watches an idle
  // session for up to POLL_INTERVAL_MS before their queued turn starts — the
  // frontend deliberately does not send it ("the VPS dispatcher owns sending",
  // useChatComposerState.ts). `dispatchQueuedMessages` re-checks `isSessionBusy`
  // (which also covers a session whose scheduled sends are still going) and
  // claims transactionally, so racing with the poll is harmless. Scoped to
  // the settled session, so several runs ending together do not each rescan
  // every queued turn.
  unsubscribeRunSettled = onRunSettled((appSessionId) => {
    // [local] A scheduled message that waited for this turn goes first; it
    // marks the session as sending before the queued pass below looks.
    void dispatchDueForSession(runtime, appSessionId).catch(logPassFailure);
    void dispatchQueuedMessages(runtime, appSessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Run-settled dispatch failed', { error: message });
    });
  });

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (unsubscribeRunSettled) {
    unsubscribeRunSettled();
    unsubscribeRunSettled = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
