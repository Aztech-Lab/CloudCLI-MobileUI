import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { mergeTranscriptNotes, transcriptNotes } from '@/modules/providers/services/transcript-notes.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * [local] Rows the user saw live that the provider's transcript does not
 * record (Codex: background work reporting back, automatic review decisions,
 * the thread being open in another program) are kept in CloudCLI's database
 * and placed by time when the history is read.
 */

const PROJECT_PATH = '/tmp/transcript-notes-project';

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'transcript-notes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(directory);
  } finally {
    chatRunRegistry.clearAll();
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
  provider: 'codex',
  kind: 'text',
  role: 'assistant',
  content: id,
});

const report = (id: string, timestamp: string): NormalizedMessage => ({
  id,
  sessionId: 'thread-1',
  timestamp,
  provider: 'codex',
  kind: 'task_notification',
  status: 'completed',
  summary: `Background command finished: ${id}`,
  notice: { code: 'codex_background_command_finished', params: { command: id } },
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

test('notes are placed before the first row written after them, once each', () => {
  const rows = [row('a', at(0)), row('b', at(10)), row('c', at(20))];
  const merged = mergeTranscriptNotes(rows, [report('n1', at(5)), report('n2', at(15)), report('n3', at(15)), report('n4', at(30))]);
  assert.deepEqual(merged.map((message) => message.id), ['a', 'n1', 'b', 'n2', 'n3', 'c', 'n4']);
  // Nothing to add: the same array.
  assert.equal(mergeTranscriptNotes(rows, []), rows);
  // A note the rows already hold (the same id) is not added twice.
  assert.equal(mergeTranscriptNotes(rows, [row('b', at(10))]), rows);
});

test('notes are kept per app session and transcript, replaced by id, and deleted with the session', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    transcriptNotes.record({ sessionId: 'app-1', providerSessionId: 'thread-1', message: { ...report('n1', at(5)), seq: 7 } as NormalizedMessage });
    transcriptNotes.record({ sessionId: 'app-1', providerSessionId: 'thread-1', message: report('n2', at(6)) });
    // Sent again (a reannounced report): kept once, with its latest content.
    transcriptNotes.record({ sessionId: 'app-1', providerSessionId: 'thread-1', message: { ...report('n1', at(5)), summary: 'again' } });
    transcriptNotes.record({ sessionId: 'app-1', providerSessionId: 'thread-old', message: report('n9', at(1)) });

    const notes = transcriptNotes.list('app-1', 'thread-1');
    assert.deepEqual(notes.map((note) => [note.id, note.summary, note.sessionId]), [['n1', 'again', 'app-1'], ['n2', 'Background command finished: n2', 'app-1']]);
    assert.deepEqual(notes[0].notice, { code: 'codex_background_command_finished', params: { command: 'n1' } });
    assert.equal((notes[0] as NormalizedMessage & { seq?: number }).seq, undefined, 'the live seq is not kept');
    assert.deepEqual(transcriptNotes.list('app-1', 'thread-old').map((note) => note.id), ['n9']);
    assert.deepEqual(transcriptNotes.list('app-2', 'thread-1'), []);
    assert.deepEqual(transcriptNotes.list('app-1', null), []);

    // The table is additive: applying the schema and migrations again changes nothing.
    await initializeDatabase();
    assert.equal(transcriptNotes.list('app-1', 'thread-1').length, 2);

    transcriptNotes.deleteSession('app-1');
    assert.deepEqual(transcriptNotes.list('app-1', 'thread-1'), []);
    assert.deepEqual(transcriptNotes.list('app-1', 'thread-old'), []);
  });
});

test('a Codex session\'s history carries its notes at their time, counted in its total', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const threadId = '019a0000-0000-7000-8000-00000000n0te';
    const transcriptPath = path.join(directory, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
    const lines = [
      { timestamp: at(0), type: 'session_meta', payload: { id: threadId, cwd: PROJECT_PATH } },
      { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'start the dev server', images: [] } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is running.' }] } },
      { timestamp: at(20), type: 'event_msg', payload: { type: 'user_message', message: 'and now?', images: [] } },
      { timestamp: at(21), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
    ];
    await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    sessionsDb.createSession('app-notes', 'codex', PROJECT_PATH, 'Notes', at(0), at(21), transcriptPath);
    sessionsDb.assignProviderSessionId('app-notes', threadId);

    const before = await sessionsService.fetchHistory('app-notes');
    assert.ok(before.messages.length > 0, 'the rollout is read');

    transcriptNotes.record({ sessionId: 'app-notes', providerSessionId: threadId, message: report('bgterm_1_report', at(10)) });
    // A note of another transcript of the session (one an edit branched off) is not this one's.
    transcriptNotes.record({ sessionId: 'app-notes', providerSessionId: 'thread-before-edit', message: report('elsewhere', at(11)) });

    const after = await sessionsService.fetchHistory('app-notes');
    const ids = after.messages.map((message) => message.id);
    assert.equal(after.total, before.total + 1);
    assert.equal(ids.includes('elsewhere'), false);
    const noteIndex = ids.indexOf('bgterm_1_report');
    assert.ok(noteIndex > 0, 'the note is in the history');
    const note = after.messages[noteIndex];
    assert.equal(note.kind, 'task_notification');
    assert.equal(note.sessionId, 'app-notes');
    assert.deepEqual(note.notice, { code: 'codex_background_command_finished', params: { command: 'bgterm_1_report' } });
    // Between the first turn's reply and the next prompt.
    assert.equal(after.messages[noteIndex - 1].content, 'It is running.');
    assert.equal(after.messages[noteIndex + 1].content, 'and now?');

    // A page of the history is cut after the notes are in.
    const lastPage = await sessionsService.fetchHistory('app-notes', { limit: 3, offset: 0 });
    assert.deepEqual(lastPage.messages.map((message) => message.id), ids.slice(-3));
  });
});
