import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-writes-lost-1';

/**
 * [local] SDK 0.3.332 reports transcript or settings writes the CLI could not
 * make (disk full or over quota) as a `session_writes_lost` system message.
 * Other `system` events normalize to nothing; this one is shown as an error
 * row, because a later resume may miss what was not saved.
 */
test('lost transcript writes become one error row naming the reason', () => {
  const rows = provider.normalizeMessage({
    type: 'system',
    subtype: 'session_writes_lost',
    uuid: 'u-1',
    session_id: SESSION_ID,
    error_code: 'ENOSPC',
    lost: ['transcript'],
    transcript_session_ids: [SESSION_ID],
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'error');
  assert.match(String(rows[0].content), /could not save part of this conversation because the disk is full \(ENOSPC\)/);
});

test('lost settings writes and a used-up quota are named as such', () => {
  const [row] = provider.normalizeMessage({
    type: 'system',
    subtype: 'session_writes_lost',
    uuid: 'u-2',
    session_id: SESSION_ID,
    error_code: 'EDQUOT',
    lost: ['global_config'],
  }, SESSION_ID);

  assert.equal(row.kind, 'error');
  assert.match(String(row.content), /its settings \(~\/\.claude\.json\) because the disk quota is used up \(EDQUOT\)/);
});
