import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { isSameTranscriptPath, sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /**
   * [local] App id for a new row when the thread id is already the app id of
   * a session that was edited off this thread (see `resolveThreadRow`).
   */
  appSessionId?: string;
};

type SessionMeta = {
  sessionId: string;
  projectPath: string;
  isSubagent: boolean;
  /** When Codex started writing this rollout file, from its session_meta. */
  startedAt: number | null;
};

const readMetaTimestamp = (
  data: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
): number | null => {
  const raw = typeof payload?.timestamp === 'string' ? payload.timestamp : data.timestamp;
  if (typeof raw !== 'string') {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      // [local] Not a row the thread id merely used to own (see resolveThreadRow).
      const existingSession = this.resolveThreadRow(parsed.sessionId).row;
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
        }
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        parsed.appSessionId
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      parsed.appSessionId
    );
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const meta = await this.readSessionMeta(filePath);
    if (!meta || meta.isSubagent) {
      return null;
    }
    const parsed = { sessionId: meta.sessionId, projectPath: meta.projectPath };

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    // [local] Matched on the file, not only the thread id: Codex can continue
    // the same thread id in a newer rollout file, and that one stays visible.
    if (sessionsDb.isProviderTranscriptSuperseded(parsed.sessionId, this.provider, filePath)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const { row: existingSession, idTaken } = this.resolveThreadRow(parsed.sessionId);

    // [local] One thread, several rollout files: only the newest may own the
    // row, whatever order the scan or the watcher meets them in.
    if (
      existingSession?.jsonl_path
      && !isSameTranscriptPath(existingSession.jsonl_path, filePath)
      && await this.isOlderThanIndexedRollout(meta, existingSession.jsonl_path)
    ) {
      return null;
    }

    if (!existingSession && idTaken) {
      // [local] The thread id is still the app id of the session that was
      // edited off it, so this continuation of the thread gets its own row.
      const sessionName = nameMap.get(parsed.sessionId) ?? await this.extractLastAgentMessageFromEnd(filePath);
      return {
        ...parsed,
        sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
        appSessionId: randomUUID(),
      };
    }

    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  private async readSessionMeta(filePath: string): Promise<SessionMeta | null> {
    return extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
        startedAt: readMetaTimestamp(data, payload),
      };
    });
  }

  /**
   * [local] Finds the row that holds a Codex thread.
   *
   * A thread discovered from disk is keyed by its own id, and that id stays
   * the app id of its session after a CloudCLI edit moves the session onto a
   * forked thread (or detaches it to start over). That row no longer holds
   * this thread: claiming it would pull the session back off the branch the
   * user edited onto, so `idTaken` tells the caller to give the thread a row
   * of its own instead.
   */
  private resolveThreadRow(threadId: string): {
    row: ReturnType<typeof sessionsDb.getSessionById>;
    idTaken: boolean;
  } {
    const byProviderId = sessionsDb.getSessionByProviderSessionId(threadId);
    if (byProviderId) {
      return { row: byProviderId, idTaken: false };
    }

    const byAppId = sessionsDb.getSessionById(threadId);
    if (!byAppId) {
      return { row: null, idTaken: false };
    }

    const leftThisThread = byAppId.provider_session_id !== null
      || sessionsDb.isProviderSessionSuperseded(threadId, this.provider);
    return leftThisThread ? { row: null, idTaken: true } : { row: byAppId, idTaken: false };
  }

  /**
   * [local] True when the row's current rollout of this thread was started
   * after `meta`'s file, i.e. `meta`'s file is an earlier part of the thread.
   *
   * Codex starts a new rollout file when it continues a thread after an edit
   * or rollback in its own UI, keeping the thread id; each file's session_meta
   * carries the moment that file was started, so the later file is the live
   * one. A row whose file is gone, or a file without a timestamp, keeps the
   * previous last-writer-wins behavior.
   */
  private async isOlderThanIndexedRollout(meta: SessionMeta, indexedPath: string): Promise<boolean> {
    if (meta.startedAt === null) {
      return false;
    }

    const indexed = await this.readSessionMeta(indexedPath).catch(() => null);
    if (!indexed || indexed.sessionId !== meta.sessionId || indexed.startedAt === null) {
      return false;
    }

    return meta.startedAt < indexed.startedAt;
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
