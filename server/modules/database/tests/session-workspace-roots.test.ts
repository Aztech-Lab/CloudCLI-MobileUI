import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

// [local] `sessions.workspace_roots` holds a Codex conversation's extra
// workspace roots. The migration only adds the column; running it again
// changes nothing, and recorded roots survive it.
test('the workspace_roots migration is additive and idempotent', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'workspace-roots-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const db = getConnection();
    const columns = () => (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .filter((column) => column.name === 'workspace_roots');
    assert.equal(columns().length, 1);

    sessionsDb.createSession('thread-1', 'codex', path.join(tempDirectory, 'p'), 'Name', undefined, undefined, null);
    sessionsDb.createSession('thread-2', 'codex', path.join(tempDirectory, 'p'), 'Other', undefined, undefined, null);
    sessionsDb.setSessionWorkspaceRoots('thread-1', ['D:\Data']);

    // A database from before the column existed gets it added, NULL everywhere.
    db.exec('ALTER TABLE sessions DROP COLUMN workspace_roots');
    assert.equal(columns().length, 0);
    runMigrations(db);
    assert.equal(columns().length, 1);
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-1'), []);
    sessionsDb.setSessionWorkspaceRoots('thread-1', ['D:\Data']);

    runMigrations(db);
    runMigrations(db);
    assert.equal(columns().length, 1);
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-1'), ['D:\Data']);
    assert.equal(sessionsDb.getSessionById('thread-1')?.custom_name, 'Name');

    // An empty list only marks an unread row; it never clears recorded roots.
    sessionsDb.setSessionWorkspaceRoots('thread-1', []);
    sessionsDb.setSessionWorkspaceRoots('thread-2', []);
    assert.deepEqual(sessionsDb.getSessionWorkspaceRoots('thread-1'), ['D:\Data']);
    const raw = db.prepare('SELECT workspace_roots FROM sessions WHERE session_id = ?').get('thread-2') as { workspace_roots: string | null };
    assert.equal(raw.workspace_roots, '[]');
    assert.deepEqual(sessionsDb.getSessionsMissingWorkspaceRoots('codex'), []);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
