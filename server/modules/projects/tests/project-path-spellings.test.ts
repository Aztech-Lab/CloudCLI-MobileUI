import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import {
  getArchivedProjectsWithSessions,
  getProjectSessionsPage,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { sessionsService } from '@/modules/providers/index.js';
import { projectIdentityKey } from '@/shared/utils.js';

// [local] One workspace stored under two drive-letter spellings is listed as
// one project, without rewriting any stored row. A drive letter no machine is
// likely to have keeps the display-name lookup off the real disk.
const UPPER = 'Q:\\Projekt\\VLA';
const LOWER = 'q:\\Projekt\\VLA';

async function withDatabase(run: () => Promise<void>) {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'project-path-spellings-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

function insertProject(projectId: string, projectPath: string, customName: string | null = null): void {
  getConnection().prepare(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    VALUES (?, ?, ?, 0, 0)
  `).run(projectId, projectPath, customName);
}

function insertSession(sessionId: string, provider: string, projectPath: string, updatedAt: string): void {
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_path, custom_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, provider, sessionId, projectPath, sessionId, updatedAt, updatedAt);
}

/** `Q:\Projekt\VLA` with 6 codex sessions, `q:\Projekt\VLA` with 1 codex + 1 claude. */
function seedSplitProject(): Map<string, string> {
  insertProject('upper', UPPER);
  insertProject('lower', LOWER);
  const storedPaths = new Map<string, string>();
  for (let index = 0; index < 6; index += 1) {
    const id = `upper-codex-${index}`;
    insertSession(id, 'codex', UPPER, `2026-10-0${index + 1}T10:00:00.000Z`);
    storedPaths.set(id, UPPER);
  }
  insertSession('lower-codex', 'codex', LOWER, '2026-10-20T10:00:00.000Z');
  insertSession('lower-claude', 'claude', LOWER, '2026-10-21T10:00:00.000Z');
  storedPaths.set('lower-codex', LOWER);
  storedPaths.set('lower-claude', LOWER);
  return storedPaths;
}

function readStoredState() {
  const db = getConnection();
  return {
    projects: db.prepare('SELECT project_id, project_path FROM projects ORDER BY project_id').all(),
    sessions: db.prepare('SELECT session_id, project_path FROM sessions ORDER BY session_id').all(),
  };
}

function vlaEntries<T extends { fullPath: string }>(projects: T[]): T[] {
  return projects.filter((project) => projectIdentityKey(project.fullPath) === UPPER);
}

test('two spellings of one path are listed as one project holding every session', async () => {
  await withDatabase(async () => {
    const storedPaths = seedSplitProject();
    const storedBefore = readStoredState();

    const entries = vlaEntries(await getProjectsWithSessions({ skipSynchronization: true, sessionsLimit: 50 }));
    assert.equal(entries.length, 1);
    const [project] = entries;
    assert.equal(project.projectId, 'upper');
    assert.equal(project.fullPath, UPPER);
    assert.deepEqual(project.sessionMeta, { total: 8, hasMore: false });
    assert.equal(project.sessions.length, 8);
    // Newest first across both spellings, each session with its own stored path.
    assert.deepEqual(project.sessions.slice(0, 2).map((session) => session.id), ['lower-claude', 'lower-codex']);
    for (const session of project.sessions) {
      assert.equal(session.projectPath, storedPaths.get(session.id));
    }

    // The default page size applies to the union, not per spelling.
    const [firstPage] = vlaEntries(await getProjectsWithSessions({ skipSynchronization: true, sessionsLimit: 5 }));
    assert.equal(firstPage.sessions.length, 5);
    assert.deepEqual(firstPage.sessionMeta, { total: 8, hasMore: true });

    assert.deepEqual(readStoredState(), storedBefore);
  });
});

test('either row id addresses the merged project for session pages', async () => {
  await withDatabase(async () => {
    seedSplitProject();

    for (const projectId of ['upper', 'lower']) {
      const page = await getProjectSessionsPage(projectId, { limit: 5, offset: 5 });
      assert.equal(page.projectId, 'upper');
      assert.deepEqual(page.sessionMeta, { total: 8, hasMore: false });
      assert.equal(page.sessions.length, 3);
    }
  });
});

test('star, rename, archive and restore apply to every row of the merged project', async () => {
  await withDatabase(async () => {
    seedSplitProject();
    const sessionsBefore = readStoredState().sessions;

    assert.deepEqual(toggleProjectStar('lower'), { isStarred: true });
    assert.equal(projectsDb.getProjectById('upper')?.isStarred, 1);
    assert.equal(projectsDb.getProjectById('lower')?.isStarred, 1);
    const [starred] = vlaEntries(await getProjectsWithSessions({ skipSynchronization: true }));
    assert.equal(starred.isStarred, true);
    assert.equal(starred.projectId, 'upper');

    assert.deepEqual(toggleProjectStar('upper'), { isStarred: false });
    assert.equal(projectsDb.getProjectById('lower')?.isStarred, 0);

    updateProjectDisplayName('upper', 'Vision Language Action');
    assert.equal(projectsDb.getProjectById('upper')?.custom_project_name, 'Vision Language Action');
    assert.equal(projectsDb.getProjectById('lower')?.custom_project_name, 'Vision Language Action');
    const [renamed] = vlaEntries(await getProjectsWithSessions({ skipSynchronization: true }));
    assert.equal(renamed.displayName, 'Vision Language Action');

    await deleteOrArchiveProject('lower', false);
    assert.equal(projectsDb.getProjectById('upper')?.isArchived, 1);
    assert.equal(projectsDb.getProjectById('lower')?.isArchived, 1);
    assert.equal(vlaEntries(await getProjectsWithSessions({ skipSynchronization: true })).length, 0);
    const archived = vlaEntries(await getArchivedProjectsWithSessions({ skipSynchronization: true }));
    assert.equal(archived.length, 1);
    assert.equal(archived[0].sessions.length, 8);

    restoreArchivedProject('upper');
    assert.equal(projectsDb.getProjectById('lower')?.isArchived, 0);
    assert.equal(vlaEntries(await getProjectsWithSessions({ skipSynchronization: true })).length, 1);

    assert.deepEqual(readStoredState().sessions, sessionsBefore);
  });
});

test('a named lower-case row represents the merged project', async () => {
  await withDatabase(async () => {
    insertProject('upper', UPPER);
    insertProject('lower', LOWER, 'Named on the lower spelling');
    insertSession('a', 'codex', UPPER, '2026-10-01T10:00:00.000Z');
    insertSession('b', 'claude', LOWER, '2026-10-02T10:00:00.000Z');

    const [project] = vlaEntries(await getProjectsWithSessions({ skipSynchronization: true }));
    assert.equal(project.projectId, 'lower');
    assert.equal(project.fullPath, LOWER);
    assert.equal(project.displayName, 'Named on the lower spelling');
    assert.equal(project.sessions.length, 2);
  });
});

test('session details name the merged project while the session keeps its stored path', async () => {
  await withDatabase(async () => {
    seedSplitProject();

    const details = sessionsService.getSessionDetailsById('lower-claude');
    assert.equal(details.project?.projectId, 'upper');
    assert.equal(details.project?.fullPath, UPPER);
    assert.equal(
      (getConnection().prepare('SELECT project_path FROM sessions WHERE session_id = ?').get('lower-claude') as { project_path: string }).project_path,
      LOWER,
    );

    const archivedFeed = sessionsService.listRecentSessions(20, 0);
    const recent = archivedFeed.conversations.find((conversation) => conversation.sessionId === 'lower-claude');
    assert.equal(recent?.projectId, 'upper');
  });
});
