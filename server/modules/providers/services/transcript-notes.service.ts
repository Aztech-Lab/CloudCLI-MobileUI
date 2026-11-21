/**
 * [local] Transcript notes: rows the user saw live that the provider's own
 * transcript does not record.
 *
 * Codex's rollout has no entry for a background command or agent reporting
 * back after its turn, for the automatic reviewer's decisions, or for a send
 * refused because the thread was open in another program. Without this they
 * vanish on the next reload. The runtime hands each such row to
 * `transcriptNotes.record` (through `ProviderRuntimeContext.recordTranscriptNote`);
 * the history read places them by time among the rows of the transcript they
 * were shown in (`withNotes`).
 *
 * Only providers that call `recordTranscriptNote` have notes, so for every
 * other provider (Claude among them) the history is unchanged.
 */
import { sessionTranscriptNotesDb } from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

function readTime(message: { timestamp?: unknown }): number | null {
  const at = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * Places notes among a transcript's rows: each before the first row written
 * after it, in the order they were noted. A note whose id the rows already
 * hold is left out. Returns the rows unchanged (the same array) when nothing
 * is added.
 */
export function mergeTranscriptNotes(messages: NormalizedMessage[], notes: NormalizedMessage[]): NormalizedMessage[] {
  if (notes.length === 0) {
    return messages;
  }
  const knownIds = new Set(messages.map((message) => message.id));
  const merged = [...messages];
  let added = false;
  for (const note of notes) {
    if (!note.id || knownIds.has(note.id)) {
      continue;
    }
    knownIds.add(note.id);
    const at = readTime(note);
    const index = at === null ? -1 : merged.findIndex((message) => {
      const messageAt = readTime(message);
      return messageAt !== null && messageAt > at;
    });
    merged.splice(index === -1 ? merged.length : index, 0, note);
    added = true;
  }
  return added ? merged : messages;
}

export const transcriptNotes = {
  /**
   * Keeps one row for the app session and provider session it was shown in.
   * Best effort: a failed write only means the row stays live only.
   */
  record({ sessionId, providerSessionId, message }: { sessionId: string; providerSessionId: string; message: NormalizedMessage }): void {
    if (!sessionId || !providerSessionId || !message?.id) {
      return;
    }
    try {
      const createdAt = typeof message.timestamp === 'string' && readTime(message) !== null
        ? message.timestamp
        : new Date().toISOString();
      // Stored as shown, minus what only the live stream carries.
      const { seq: _seq, ...stored } = message as NormalizedMessage & { seq?: unknown };
      sessionTranscriptNotesDb.upsertNote(sessionId, providerSessionId, message.id, createdAt, JSON.stringify({ ...stored, timestamp: createdAt }));
    } catch (error) {
      console.warn('[TranscriptNotes] Could not keep a transcript row:', error instanceof Error ? error.message : error);
    }
  },

  /** The notes of one transcript of a session, oldest first, as the app session's rows. */
  list(sessionId: string, providerSessionId: string | null | undefined): NormalizedMessage[] {
    if (!providerSessionId) {
      return [];
    }
    let records;
    try {
      records = sessionTranscriptNotesDb.listNotes(sessionId, providerSessionId);
    } catch (error) {
      console.warn('[TranscriptNotes] Could not read transcript notes:', error instanceof Error ? error.message : error);
      return [];
    }
    const notes: NormalizedMessage[] = [];
    for (const record of records) {
      try {
        const message = JSON.parse(record.messageJson) as NormalizedMessage;
        if (message && typeof message === 'object' && typeof message.kind === 'string') {
          notes.push({ ...message, id: record.noteId, sessionId, timestamp: record.createdAt });
        }
      } catch {
        // A row that no longer parses is skipped, not fatal to the history.
      }
    }
    return notes;
  },

  /** A transcript's rows with its notes placed among them (the same array when it has none). */
  withNotes(sessionId: string, providerSessionId: string | null | undefined, messages: NormalizedMessage[]): NormalizedMessage[] {
    return mergeTranscriptNotes(messages, transcriptNotes.list(sessionId, providerSessionId));
  },

  /** Whether a transcript has any notes (cheap enough for the history read to ask). */
  has(sessionId: string, providerSessionId: string | null | undefined): boolean {
    return transcriptNotes.list(sessionId, providerSessionId).length > 0;
  },

  deleteSession(sessionId: string): void {
    try {
      sessionTranscriptNotesDb.deleteSessionNotes(sessionId);
    } catch (error) {
      console.warn('[TranscriptNotes] Could not delete transcript notes:', error instanceof Error ? error.message : error);
    }
  },
};
