import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

/**
 * [local] A CloudCLI edit moves a session onto a forked thread and retires the
 * original thread. Codex itself can later continue that original thread — an
 * edit or rollback in the Codex app writes a *new* rollout file that keeps the
 * thread id and points back at the old file through `history_base`. That
 * continuation is a live conversation and must be indexed; only the file the
 * session actually left stays hidden.
 */

type Row = Record<string, unknown>;

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

function turn(turnId: string, prompt: string): Row[] {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    { type: 'event_msg', payload: { type: 'agent_message', message: `answer to ${prompt}` } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
}

function encode(rows: Row[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

type Context = { root: string; workspacePath: string; sessionsRoot: string };

async function withCodexHome(run: (context: Context) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-continued-'));
  const workspacePath = path.join(root, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(root);
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  try {
    await run({ root, workspacePath, sessionsRoot: path.join(root, '.codex', 'sessions') });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    restoreHomeDir();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRollout(sessionsRoot: string, day: string, name: string, meta: Row, rows: Row[]): Promise<string> {
  const directory = path.join(sessionsRoot, '2026', '07', day);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await writeFile(filePath, encode([{ type: 'session_meta', payload: meta }, ...rows]), 'utf8');
  return filePath;
}

/**
 * The original thread, indexed, then edited in CloudCLI onto `thread-fork`.
 * Both the fork and Codex's continuation reference the original file by byte
 * offset, as real paginated rollouts do.
 */
async function editedThenContinuedInCodex({ workspacePath, sessionsRoot }: Context) {
  const originalPath = await writeRollout(
    sessionsRoot,
    '01',
    'rollout-2026-07-01T10-00-00-thread-1.jsonl',
    { id: 'thread-1', cwd: workspacePath, timestamp: '2026-07-01T10:00:00.000Z' },
    [...turn('turn-a', 'first prompt'), ...turn('turn-b', 'second prompt'), ...turn('turn-c', 'third prompt')],
  );
  const synchronizer = new CodexSessionSynchronizer();
  await synchronizer.synchronize();
  assert.equal(sessionsDb.getSessionById('thread-1')?.jsonl_path, originalPath);

  const original = await readFile(originalPath, 'utf8');
  const throughTurnB = original.split('\n').slice(0, 9).join('\n') + '\n';
  const historyBase = { thread_id: 'thread-1', end_ordinal_exclusive: 9, end_byte_offset: Buffer.byteLength(throughTurnB) };

  const forkPath = await writeRollout(
    sessionsRoot,
    '08',
    'rollout-2026-07-08T10-00-00-thread-fork.jsonl',
    {
      id: 'thread-fork',
      cwd: workspacePath,
      timestamp: '2026-07-08T10:00:00.000Z',
      history_mode: 'paginated',
      forked_from_id: 'thread-1',
      history_base: historyBase,
    },
    turn('turn-f', 'edited third prompt'),
  );
  const realForkThread = codexAppServer.forkThread;
  codexAppServer.forkThread = async () => ({ threadId: 'thread-fork', path: forkPath });
  try {
    await new CodexSessionsProvider().rewindSession('thread-1', 'turn-b');
  } finally {
    codexAppServer.forkThread = realForkThread;
  }

  // Codex continues thread-1 itself: same id, new file, history by reference.
  const continuedPath = await writeRollout(
    sessionsRoot,
    '08',
    'rollout-2026-07-08T10-05-00-thread-1_segment-1.jsonl',
    {
      id: 'thread-1',
      session_id: 'thread-1',
      cwd: workspacePath,
      timestamp: '2026-07-08T10:05:00.000Z',
      history_mode: 'paginated',
      history_base: historyBase,
    },
    turn('turn-x', 'third prompt rewritten in codex'),
  );

  // Codex appends a row to its name index on every rename.
  await writeFile(
    path.join(sessionsRoot, '..', 'session_index.jsonl'),
    encode([
      { id: 'thread-1', thread_name: 'first name' },
      { id: 'thread-1', thread_name: 'renamed in codex' },
    ]),
    'utf8',
  );

  return { synchronizer, originalPath, forkPath, continuedPath };
}

const codexRowsFor = (threadId: string) =>
  getConnection()
    .prepare('SELECT session_id, provider_session_id, jsonl_path FROM sessions WHERE provider_session_id = ?')
    .all(threadId) as Array<{ session_id: string; provider_session_id: string; jsonl_path: string }>;

test('a thread Codex continued after a CloudCLI edit comes back as its own session', { concurrency: false }, async () => {
  await withCodexHome(async (context) => {
    const { synchronizer, forkPath, continuedPath } = await editedThenContinuedInCodex(context);

    await synchronizer.synchronize();

    // The edited session stays on the branch it was edited onto.
    const edited = sessionsDb.getSessionById('thread-1');
    assert.equal(edited?.provider_session_id, 'thread-fork');
    assert.equal(edited?.jsonl_path, forkPath);

    // The continued thread is indexed under a fresh app id, on its new file.
    const rows = codexRowsFor('thread-1');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].session_id, 'thread-1');
    assert.equal(rows[0].jsonl_path, continuedPath);
    const restored = sessionsDb.getSessionById(rows[0].session_id);
    assert.equal(restored?.project_path, edited?.project_path);
    // Named after the thread's current Codex name, not the edited session's.
    assert.equal(restored?.custom_name, 'renamed in codex');

    // A second scan finds the same row instead of adding another.
    await synchronizer.synchronize();
    assert.deepEqual(codexRowsFor('thread-1'), rows);
  });
});

test('the file the session was edited off stays hidden', { concurrency: false }, async () => {
  await withCodexHome(async (context) => {
    const { synchronizer, originalPath, continuedPath } = await editedThenContinuedInCodex(context);

    // Before Codex continued the thread, the retired file is refused...
    assert.equal(await synchronizer.synchronizeFile(originalPath), null);
    assert.equal(codexRowsFor('thread-1').length, 0);

    // ...and after, it can neither add a row nor take the continuation's row.
    const continuedSessionId = await synchronizer.synchronizeFile(continuedPath);
    assert.ok(continuedSessionId);
    assert.equal(await synchronizer.synchronizeFile(originalPath), null);
    assert.deepEqual(codexRowsFor('thread-1'), [
      { session_id: continuedSessionId, provider_session_id: 'thread-1', jsonl_path: continuedPath },
    ]);
  });
});

test('the continued thread and the edit fork both read their inherited history from the original file', { concurrency: false }, async () => {
  await withCodexHome(async (context) => {
    const { synchronizer } = await editedThenContinuedInCodex(context);
    await synchronizer.synchronize();
    const provider = new CodexSessionsProvider();
    const userPrompts = async (sessionId: string) =>
      (await provider.fetchHistory(sessionId)).messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content);

    // thread-1's row now points at the continuation, which must not be taken
    // as the base the fork's byte offset refers to.
    assert.deepEqual(await userPrompts('thread-1'), ['first prompt', 'second prompt', 'edited third prompt']);
    const continued = codexRowsFor('thread-1')[0];
    assert.deepEqual(await userPrompts(continued.session_id), [
      'first prompt',
      'second prompt',
      'third prompt rewritten in codex',
    ]);
  });
});

test('a record without a transcript path still hides every file of the thread', { concurrency: false }, async () => {
  await withCodexHome(async ({ workspacePath, sessionsRoot }) => {
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'thread-legacy',
      provider: 'codex',
      sessionId: 'thread-legacy',
      jsonlPath: null,
    });
    await writeRollout(sessionsRoot, '01', 'rollout-thread-legacy.jsonl', { id: 'thread-legacy', cwd: workspacePath }, turn('t', 'a'));
    await writeRollout(
      sessionsRoot,
      '08',
      'rollout-thread-legacy_segment.jsonl',
      { id: 'thread-legacy', cwd: workspacePath, timestamp: '2026-07-08T00:00:00.000Z' },
      turn('u', 'b'),
    );

    await new CodexSessionSynchronizer().synchronize();
    assert.equal(codexRowsFor('thread-legacy').length, 0);
  });
});

test('an older rollout of a thread never takes the row from a newer one', { concurrency: false }, async () => {
  await withCodexHome(async ({ workspacePath, sessionsRoot }) => {
    const olderPath = await writeRollout(
      sessionsRoot,
      '01',
      'rollout-thread-9.jsonl',
      { id: 'thread-9', cwd: workspacePath, timestamp: '2026-07-01T00:00:00.000Z' },
      turn('t', 'a'),
    );
    const newerPath = await writeRollout(
      sessionsRoot,
      '08',
      'rollout-thread-9_segment.jsonl',
      { id: 'thread-9', cwd: workspacePath, timestamp: '2026-07-08T00:00:00.000Z' },
      turn('u', 'b'),
    );
    const synchronizer = new CodexSessionSynchronizer();
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('thread-9')?.jsonl_path, newerPath);

    // The watcher reports a change to the older file (Codex can still append
    // settings rows to it): the row must stay on the newer file.
    assert.equal(await synchronizer.synchronizeFile(olderPath), null);
    assert.equal(sessionsDb.getSessionById('thread-9')?.jsonl_path, newerPath);
  });
});

test('history of a later segment resolves a base that is itself a segment', { concurrency: false }, async () => {
  await withCodexHome(async ({ workspacePath, sessionsRoot }) => {
    const firstPath = await writeRollout(
      sessionsRoot,
      '01',
      'rollout-thread-s.jsonl',
      { id: 'thread-s', cwd: workspacePath, timestamp: '2026-07-01T00:00:00.000Z' },
      turn('t1', 'one'),
    );
    const first = await readFile(firstPath);
    const segmentPath = await writeRollout(
      sessionsRoot,
      '02',
      'rollout-thread-s_seg-a.jsonl',
      {
        id: 'thread-s',
        cwd: workspacePath,
        timestamp: '2026-07-02T00:00:00.000Z',
        history_mode: 'paginated',
        history_base: { thread_id: 'thread-s', end_ordinal_exclusive: 5, end_byte_offset: first.length },
      },
      turn('t2', 'two'),
    );
    const segment = await readFile(segmentPath);
    await writeRollout(
      sessionsRoot,
      '03',
      'rollout-thread-s_seg-b.jsonl',
      {
        id: 'thread-s',
        cwd: workspacePath,
        timestamp: '2026-07-03T00:00:00.000Z',
        history_mode: 'paginated',
        history_base: { thread_id: 'seg-a', end_ordinal_exclusive: 10, end_byte_offset: segment.length },
      },
      turn('t3', 'three'),
    );

    await new CodexSessionSynchronizer().synchronize();
    const history = await new CodexSessionsProvider().fetchHistory('thread-s');
    assert.deepEqual(
      history.messages.filter((message) => message.role === 'user').map((message) => message.content),
      ['one', 'two', 'three'],
    );
  });
});
