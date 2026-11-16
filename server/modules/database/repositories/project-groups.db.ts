/**
 * [local] Project rows that are one workspace under different spellings.
 *
 * On Windows the same directory is recorded as `E:\x` by some processes and
 * `e:\x` by others, and each spelling gets its own `projects` row and its own
 * share of the sessions. Nothing here rewrites those rows: stored paths stay
 * exactly what the provider synchronizers recorded, and every CLI keeps running
 * in its session's own stored path. This module only decides which rows the UI
 * shows as one project, and which of them stands for the group.
 *
 * A group is the rows with the same `projectIdentityKey` and the same archived
 * state (the active sidebar and the archive view list different rows). Its
 * representative is, in order: a row with a custom name or a star, the row
 * already spelled like the identity key (upper-case drive), the row with the
 * most recent active session, the oldest row.
 */
import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';
import { projectIdentityKey } from '@/shared/utils.js';

export type ProjectGroup = {
  /** The row whose id, path and name the merged entry is shown with. */
  representative: ProjectRepositoryRow;
  /** Every row in the group, representative included, oldest first. */
  rows: ProjectRepositoryRow[];
  /** The stored `project_path` of every row, as stored. */
  paths: string[];
  /** Starred when any row is. */
  isStarred: boolean;
  /** The representative's custom name, else the first other row's. */
  customName: string | null;
};

function readAllProjectRows(): ProjectRepositoryRow[] {
  return getConnection().prepare(`
    SELECT project_id, project_path, custom_project_name, isStarred, isArchived
    FROM projects
    ORDER BY rowid
  `).all() as ProjectRepositoryRow[];
}

function hasCustomName(row: ProjectRepositoryRow): boolean {
  return typeof row.custom_project_name === 'string' && row.custom_project_name.trim().length > 0;
}

function pickRepresentative(rows: ProjectRepositoryRow[], identityKey: string): ProjectRepositoryRow {
  if (rows.length === 1) {
    return rows[0];
  }

  const latestActivity = new Map<string, string>();
  const readLatest = (row: ProjectRepositoryRow): string => {
    let value = latestActivity.get(row.project_id);
    if (value === undefined) {
      value = sessionsDb.getLatestSessionActivityByProjectPath(row.project_path) ?? '';
      latestActivity.set(row.project_id, value);
    }
    return value;
  };

  // Array.prototype.sort is stable, so rows that tie stay oldest first.
  return [...rows].sort((left, right) => {
    const leftMarked = hasCustomName(left) || Boolean(left.isStarred);
    const rightMarked = hasCustomName(right) || Boolean(right.isStarred);
    if (leftMarked !== rightMarked) {
      return leftMarked ? -1 : 1;
    }

    const leftCanonical = left.project_path === identityKey;
    const rightCanonical = right.project_path === identityKey;
    if (leftCanonical !== rightCanonical) {
      return leftCanonical ? -1 : 1;
    }

    const leftLatest = readLatest(left);
    const rightLatest = readLatest(right);
    if (leftLatest !== rightLatest) {
      return leftLatest > rightLatest ? -1 : 1;
    }

    return 0;
  })[0];
}

function buildGroup(rows: ProjectRepositoryRow[], identityKey: string): ProjectGroup {
  const representative = pickRepresentative(rows, identityKey);
  const customName = hasCustomName(representative)
    ? representative.custom_project_name
    : rows.find(hasCustomName)?.custom_project_name ?? null;

  return {
    representative,
    rows,
    paths: rows.map((row) => row.project_path),
    isStarred: rows.some((row) => Boolean(row.isStarred)),
    customName,
  };
}

/** Groups rows by identity key and archived state, in the order each group first appears. */
function groupRows(rows: ProjectRepositoryRow[]): ProjectGroup[] {
  const buckets = new Map<string, { identityKey: string; rows: ProjectRepositoryRow[] }>();
  for (const row of rows) {
    const identityKey = projectIdentityKey(row.project_path) || row.project_path;
    const bucketKey = `${row.isArchived ? 1 : 0}\u0000${identityKey}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.rows.push(row);
    } else {
      buckets.set(bucketKey, { identityKey, rows: [row] });
    }
  }

  return [...buckets.values()].map((bucket) => buildGroup(bucket.rows, bucket.identityKey));
}

function findGroupOf(row: ProjectRepositoryRow): ProjectGroup {
  const identityKey = projectIdentityKey(row.project_path) || row.project_path;
  const rows = readAllProjectRows().filter((candidate) =>
    Boolean(candidate.isArchived) === Boolean(row.isArchived)
    && (projectIdentityKey(candidate.project_path) || candidate.project_path) === identityKey);
  return buildGroup(rows.length > 0 ? rows : [row], identityKey);
}

export const projectGroupsDb = {
  /** Active projects, one entry per workspace. */
  getActiveProjectGroups(): ProjectGroup[] {
    return groupRows(readAllProjectRows().filter((row) => !row.isArchived));
  },

  /** Archived projects, one entry per workspace. */
  getArchivedProjectGroups(): ProjectGroup[] {
    return groupRows(readAllProjectRows().filter((row) => Boolean(row.isArchived)));
  },

  /** The group the row with this id belongs to, or null for an unknown id. */
  getProjectGroupById(projectId: string): ProjectGroup | null {
    const row = readAllProjectRows().find((candidate) => candidate.project_id === projectId);
    return row ? findGroupOf(row) : null;
  },

  /**
   * The group a stored path belongs to (a session's `project_path`), or null
   * when no project row has that path under any spelling.
   */
  getProjectGroupByPath(projectPath: string | null | undefined): ProjectGroup | null {
    const identityKey = projectIdentityKey(projectPath);
    if (!identityKey) {
      return null;
    }
    const rows = readAllProjectRows();
    const row = rows.find((candidate) => candidate.project_path === projectPath)
      ?? rows.find((candidate) => projectIdentityKey(candidate.project_path) === identityKey);
    return row ? findGroupOf(row) : null;
  },

  /**
   * The project a stored path is shown under: the group representative's id
   * and path, with the group's name and star. For labelling a session with
   * its project (sidebar upserts, archive and recent lists, search, details).
   */
  getDisplayProjectForPath(projectPath: string | null | undefined): ProjectRepositoryRow | null {
    const group = projectGroupsDb.getProjectGroupByPath(projectPath);
    if (!group) {
      return null;
    }
    return {
      ...group.representative,
      custom_project_name: group.customName,
      isStarred: group.isStarred ? 1 : 0,
    };
  },

  /**
   * Every row sharing the identity key of the row with this id, archived or
   * not, so a star, rename or archive keeps the merged entry consistent.
   */
  getRowsSharingIdentityWith(projectId: string): ProjectRepositoryRow[] {
    const rows = readAllProjectRows();
    const row = rows.find((candidate) => candidate.project_id === projectId);
    if (!row) {
      return [];
    }
    const identityKey = projectIdentityKey(row.project_path) || row.project_path;
    return rows.filter((candidate) =>
      (projectIdentityKey(candidate.project_path) || candidate.project_path) === identityKey);
  },
};
