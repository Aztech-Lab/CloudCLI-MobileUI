/**
 * [local] Transcript notes repository.
 *
 * Rows a provider's own transcript does not record but the user saw live
 * (Codex: "Background command finished", an automatic review's decision, the
 * thread being open in another program). Kept per app session and provider
 * session (the transcript they were shown in), so the history read can place
 * them by time and a reload still shows them. Writing the same note again
 * (same id) replaces it, so a row sent live more than once is kept once.
 */

import { getConnection } from '@/modules/database/connection.js';

/** Notes kept per transcript; the oldest go first beyond this. */
const MAX_NOTES_PER_TRANSCRIPT = 1000;

export type SessionTranscriptNoteRecord = {
  noteId: string;
  createdAt: string;
  messageJson: string;
};

export const sessionTranscriptNotesDb = {
  /** Adds (or replaces) one note and keeps at most MAX_NOTES_PER_TRANSCRIPT for its transcript. */
  upsertNote(sessionId: string, providerSessionId: string, noteId: string, createdAt: string, messageJson: string): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO session_transcript_notes (session_id, provider_session_id, note_id, created_at, message_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, provider_session_id, note_id)
       DO UPDATE SET message_json = excluded.message_json`
    ).run(sessionId, providerSessionId, noteId, createdAt, messageJson);
    db.prepare(
      `DELETE FROM session_transcript_notes
       WHERE session_id = ? AND provider_session_id = ? AND note_id NOT IN (
         SELECT note_id FROM session_transcript_notes
         WHERE session_id = ? AND provider_session_id = ?
         ORDER BY created_at DESC LIMIT ?
       )`
    ).run(sessionId, providerSessionId, sessionId, providerSessionId, MAX_NOTES_PER_TRANSCRIPT);
  },

  /** The notes of one transcript of a session, oldest first. */
  listNotes(sessionId: string, providerSessionId: string): SessionTranscriptNoteRecord[] {
    const db = getConnection();
    return db.prepare(
      `SELECT note_id AS noteId, created_at AS createdAt, message_json AS messageJson
       FROM session_transcript_notes
       WHERE session_id = ? AND provider_session_id = ?
       ORDER BY created_at ASC, rowid ASC`
    ).all(sessionId, providerSessionId) as SessionTranscriptNoteRecord[];
  },

  /** Forgets every note of a session, once the session itself is gone. */
  deleteSessionNotes(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_transcript_notes WHERE session_id = ?').run(sessionId);
  },
};
