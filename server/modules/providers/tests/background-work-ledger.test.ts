import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  BACKGROUND_WORK_LOST_ERROR_CODE,
  backgroundWorkLedger,
  summarizeActiveWork,
} from '@/modules/providers/services/background-work-ledger.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { BackgroundTaskSummary, NormalizedMessage } from '@/shared/types.js';

/**
 * [local] A server restart ends every session's background work. The ledger
 * notes which sessions had some, so their history says so once, and `/health`
 * counts what a restart would end.
 */

const PROJECT_PATH = '/tmp/background-ledger-project';

const task = (taskId: string): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_agent',
  description: `Task ${taskId}`,
  startedAt: 1,
});

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'background-ledger-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  backgroundWorkLedger.resetForTests();
  try {
    await runTest(directory);
  } finally {
    chatRunRegistry.clearAll();
    backgroundWorkLedger.resetForTests();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const row = (id: string, timestamp: string): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: id,
});

test('the sessions with background work at a restart each get one notice; the record starts over', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    backgroundWorkLedger.record([
      { sessionId: 's1', tasks: [task('a'), task('b')] },
      { sessionId: 's2', tasks: [task('c')] },
      { sessionId: 'idle', tasks: [] },
    ]);

    // The next server start.
    backgroundWorkLedger.resetForTests();
    const lost = backgroundWorkLedger.noteLostOnStart(new Date('2026-11-16T10:00:00.000Z'));
    assert.deepEqual(lost.sort(), ['s1', 's2']);
    assert.deepEqual(backgroundWorkLedger.getLost('s1'), [{ lostAt: '2026-11-16T10:00:00.000Z', tasks: 2 }]);
    assert.deepEqual(backgroundWorkLedger.getLost('idle'), []);

    // A second start with nothing running in between adds nothing.
    backgroundWorkLedger.resetForTests();
    assert.deepEqual(backgroundWorkLedger.noteLostOnStart(new Date('2026-11-16T11:00:00.000Z')), []);
    assert.equal(backgroundWorkLedger.getLost('s1').length, 1);
  });
});

test('the record is written only when the set of sessions changes', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    backgroundWorkLedger.record([{ sessionId: 's1', tasks: [task('a')] }]);
    appConfigDb.set('background_work_running', 'tampered');
    backgroundWorkLedger.record([{ sessionId: 's1', tasks: [task('a')] }]);
    assert.equal(appConfigDb.get('background_work_running'), 'tampered', 'unchanged set: not written again');
    backgroundWorkLedger.record([]);
    assert.equal(appConfigDb.get('background_work_running'), '[]');
  });
});

test('a notice is placed before the first row written after the restart', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    backgroundWorkLedger.record([{ sessionId: 's1', tasks: [task('a')] }]);
    backgroundWorkLedger.resetForTests();
    backgroundWorkLedger.noteLostOnStart(new Date('2026-11-16T10:00:00.000Z'));

    const rows = [row('before', '2026-11-16T09:59:00.000Z'), row('after', '2026-11-16T10:05:00.000Z')];
    const merged = backgroundWorkLedger.withLostNotices('s1', 'claude', rows);
    assert.deepEqual(merged.map((message) => message.id), ['before', `background_work_lost_${Date.parse('2026-11-16T10:00:00.000Z')}`, 'after']);
    const notice = merged[1];
    assert.equal(notice.kind, 'error');
    assert.equal(notice.errorCode, BACKGROUND_WORK_LOST_ERROR_CODE);
    assert.match(String(notice.content), /server restart/);

    // Another session's history is untouched (the same array).
    assert.equal(backgroundWorkLedger.withLostNotices('other', 'claude', rows), rows);
  });
});

test('a session\'s history carries the notice, counted in its total', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const providerSessionId = 'ledger-history';
    const rows = ['question', 'answer'].map((text, ordinal) => {
      const role = ordinal === 0 ? 'user' : 'assistant';
      return {
        type: role,
        uuid: `${providerSessionId}-row-${ordinal}`,
        parentUuid: ordinal === 0 ? null : `${providerSessionId}-row-0`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
        sessionId: providerSessionId,
        cwd: PROJECT_PATH,
        message: { role, content: [{ type: 'text', text }] },
      };
    });
    const transcriptPath = path.join(directory, `${providerSessionId}.jsonl`);
    await writeFile(transcriptPath, `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    sessionsDb.createSession(providerSessionId, 'claude', PROJECT_PATH, 'Ledger', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z', transcriptPath);

    const before = await sessionsService.fetchHistory(providerSessionId);
    assert.equal(before.messages.some((message) => message.errorCode === BACKGROUND_WORK_LOST_ERROR_CODE), false);

    backgroundWorkLedger.record([{ sessionId: providerSessionId, tasks: [task('a')] }]);
    backgroundWorkLedger.resetForTests();
    backgroundWorkLedger.noteLostOnStart(new Date('2026-01-01T00:10:00.000Z'));

    const after = await sessionsService.fetchHistory(providerSessionId);
    const last = after.messages[after.messages.length - 1];
    assert.equal(last.errorCode, BACKGROUND_WORK_LOST_ERROR_CODE, 'shown after the last row before the restart');
    assert.equal(last.sessionId, providerSessionId);
    assert.equal(after.total, before.total + 1);
  });
});

test('summarizeActiveWork counts turns, sessions with background work and their tasks', () => {
  assert.deepEqual(
    summarizeActiveWork([{}, {}], [
      { sessionId: 's1', tasks: [task('a'), task('b')] },
      { sessionId: 's2', tasks: [task('c')] },
      { sessionId: 's3', tasks: [] },
    ]),
    { turns: 2, backgroundSessions: 2, backgroundTasks: 3 },
  );
  assert.deepEqual(summarizeActiveWork([], []), { turns: 0, backgroundSessions: 0, backgroundTasks: 0 });
});
