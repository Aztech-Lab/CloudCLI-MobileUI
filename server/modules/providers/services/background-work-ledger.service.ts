/**
 * [local] Background work and server restarts.
 *
 * A server restart ends every CLI process CloudCLI started, and with them every
 * agent, workflow and backgrounded command a session still had running. That is
 * not survivable, but it must not be silent: the session would otherwise look as
 * if its work had simply vanished.
 *
 * While the server runs, the sessions with background work are written to the
 * app config (only when the set changes). The next server start finds that
 * list, records for each session that its work was lost, and empties it. The
 * history of such a session then carries one notice at the point of the
 * restart, which the client shows as "background work was stopped by a server
 * restart".
 *
 * `summarizeActiveWork` is the operator's side of the same problem: the counts
 * `/health` reports, so a restart script can see that work would be lost.
 */
import { appConfigDb } from '@/modules/database/index.js';
import type { BackgroundTaskSummary, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/** Sessions with background work in the server process that wrote it. */
const RUNNING_KEY = 'background_work_running';
/** Sessions whose background work a restart ended, with when it was noticed. */
const LOST_KEY = 'background_work_lost';

/** At most this many notices per session, and sessions with notices, are kept. */
const MAX_NOTICES_PER_SESSION = 20;
const MAX_SESSIONS_WITH_NOTICES = 500;

/** The `errorCode` the client translates; `content` is the English fallback. */
export const BACKGROUND_WORK_LOST_ERROR_CODE = 'background_work_lost_on_restart';
const BACKGROUND_WORK_LOST_TEXT = 'Background work was stopped by a server restart. Agents, workflows and commands that were still running did not finish.';

type BackgroundWorkEntry = { sessionId: string; tasks: BackgroundTaskSummary[] };

type RunningRecord = { sessionId: string; tasks: number };

export type LostBackgroundWork = { lostAt: string; tasks: number };

function readJson<T>(key: string, fallback: T): T {
  const raw = appConfigDb.get(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readLost(): Record<string, LostBackgroundWork[]> {
  const value = readJson<unknown>(LOST_KEY, {});
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, LostBackgroundWork[]>
    : {};
}

/** What was last written, so an unchanged set is not written again. */
let lastWritten: string | null = null;

function toRunningRecords(entries: BackgroundWorkEntry[]): RunningRecord[] {
  return entries
    .filter((entry) => entry.tasks.length > 0)
    .map((entry) => ({ sessionId: entry.sessionId, tasks: entry.tasks.length }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export const backgroundWorkLedger = {
  /**
   * Records which sessions have background work now. Cheap to call often: it
   * writes only when the set (or a session's task count) changed.
   */
  record(entries: BackgroundWorkEntry[]): void {
    const serialized = JSON.stringify(toRunningRecords(entries));
    if (serialized === lastWritten) {
      return;
    }
    try {
      appConfigDb.set(RUNNING_KEY, serialized);
      lastWritten = serialized;
    } catch (error) {
      console.warn('[BackgroundWork] Could not record the sessions with background work:', error);
    }
  },

  /**
   * Run once at server start, before anything is recorded: every session the
   * previous server process still had background work for lost it. Returns
   * those session ids.
   */
  noteLostOnStart(now: Date = new Date()): string[] {
    const running = readJson<unknown>(RUNNING_KEY, []);
    const records = Array.isArray(running)
      ? (running as RunningRecord[]).filter((record) => record && typeof record.sessionId === 'string')
      : [];
    lastWritten = null;
    if (records.length === 0) {
      return [];
    }

    const lost = readLost();
    const lostAt = now.toISOString();
    for (const record of records) {
      const notices = Array.isArray(lost[record.sessionId]) ? lost[record.sessionId] : [];
      notices.push({ lostAt, tasks: typeof record.tasks === 'number' ? record.tasks : 0 });
      // Re-inserted, so the most recently touched sessions are the ones kept.
      delete lost[record.sessionId];
      lost[record.sessionId] = notices.slice(-MAX_NOTICES_PER_SESSION);
    }
    const sessionIds = Object.keys(lost);
    for (const sessionId of sessionIds.slice(0, Math.max(0, sessionIds.length - MAX_SESSIONS_WITH_NOTICES))) {
      delete lost[sessionId];
    }

    try {
      appConfigDb.set(LOST_KEY, JSON.stringify(lost));
      appConfigDb.set(RUNNING_KEY, '[]');
      lastWritten = '[]';
    } catch (error) {
      console.warn('[BackgroundWork] Could not record background work lost to the restart:', error);
    }
    return records.map((record) => record.sessionId);
  },

  /** The restarts that ended this session's background work, oldest first. */
  getLost(sessionId: string): LostBackgroundWork[] {
    const notices = readLost()[sessionId];
    return Array.isArray(notices) ? notices : [];
  },

  /**
   * Places one notice per restart that ended this session's background work
   * among its history rows, before the first row written after the restart.
   * Returns the rows unchanged (the same array) when there is none.
   */
  withLostNotices(sessionId: string, provider: LLMProvider, messages: NormalizedMessage[]): NormalizedMessage[] {
    const notices = backgroundWorkLedger.getLost(sessionId);
    if (notices.length === 0) {
      return messages;
    }
    const merged = [...messages];
    for (const notice of notices) {
      const lostAtMs = Date.parse(notice.lostAt);
      if (!Number.isFinite(lostAtMs)) {
        continue;
      }
      const row = createNormalizedMessage({
        // Stable across reads, so the client can tell it already has this row.
        id: `background_work_lost_${lostAtMs}`,
        sessionId,
        timestamp: notice.lostAt,
        provider,
        kind: 'error',
        content: BACKGROUND_WORK_LOST_TEXT,
        errorCode: BACKGROUND_WORK_LOST_ERROR_CODE,
      });
      const index = merged.findIndex((message) => {
        const at = Date.parse(message.timestamp);
        return Number.isFinite(at) && at > lostAtMs;
      });
      merged.splice(index === -1 ? merged.length : index, 0, row);
    }
    return merged;
  },

  /**
   * Keeps the record current while the server runs. The interval is the
   * window in which work started just before a restart can go unrecorded.
   */
  start(listBackgroundWork: () => BackgroundWorkEntry[], intervalMs = 2000): () => void {
    const tick = () => {
      try {
        backgroundWorkLedger.record(listBackgroundWork());
      } catch (error) {
        console.warn('[BackgroundWork] Could not read the sessions with background work:', error);
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },

  /** Test-only: forgets what was last written. */
  resetForTests(): void {
    lastWritten = null;
  },
};

/**
 * What a restart would end right now, as `/health` reports it: turns being
 * written, and sessions with background work and their task count. Counts
 * only, no ids, as the endpoint needs no login.
 */
export function summarizeActiveWork(
  runningTurns: unknown[],
  backgroundWork: BackgroundWorkEntry[],
): { turns: number; backgroundSessions: number; backgroundTasks: number } {
  const withWork = backgroundWork.filter((entry) => entry.tasks.length > 0);
  return {
    turns: runningTurns.length,
    backgroundSessions: withWork.length,
    backgroundTasks: withWork.reduce((total, entry) => total + entry.tasks.length, 0),
  };
}
