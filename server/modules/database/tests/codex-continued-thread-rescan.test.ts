import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, scanStateDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

// [local] The Codex indexer used to refuse every rollout file of a thread a
// session was edited off. A newer file of such a thread may already sit behind
// the incremental scan cursor, so the fix comes with one full rescan.
test('migrations clear the scan cursor exactly once for the continued-thread rescan', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'continued-thread-rescan-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const db = getConnection();

    // A database migrated with this change already has the rescan recorded.
    scanStateDb.updateLastScannedAt(new Date('2026-07-01T00:00:00.000Z'));
    runMigrations(db);
    assert.ok(scanStateDb.getLastScannedAt());

    // A database from before the change gets one full scan...
    db.prepare("DELETE FROM app_config WHERE key = 'local.rescan.codex_continued_threads'").run();
    runMigrations(db);
    assert.equal(scanStateDb.getLastScannedAt(), null);

    // ...and only one.
    scanStateDb.updateLastScannedAt(new Date('2026-07-02T00:00:00.000Z'));
    runMigrations(db);
    assert.ok(scanStateDb.getLastScannedAt());
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
