import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeSdkEnv, resolveBackgroundMaxHoldMs } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude Code turns the Artifact tools off for SDK-driven sessions unless
// CLAUDE_CODE_ARTIFACT is set, so a UI session would lose them mid-conversation.
test('SDK sessions opt into the Artifact tools by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ARTIFACT, '1');
});

test('a host CLAUDE_CODE_ARTIFACT value wins over the default', () => {
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0');
});

test('SDK sessions are labeled claudecodeui, and a host value wins', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ENTRYPOINT, 'claudecodeui');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ENTRYPOINT: 'x' }).CLAUDE_CODE_ENTRYPOINT, 'x');
});

test('host env vars are still forwarded', () => {
  assert.equal(buildClaudeSdkEnv({ ANTHROPIC_BASE_URL: 'http://proxy' }).ANTHROPIC_BASE_URL, 'http://proxy');
});

// [local] The CLI waits for its background agents as long as the server holds
// the process for them, so it never gives up on an agent before we do.
test('the CLI is told the background hold bound, 12 hours by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(12 * 60 * 60 * 1000));
  assert.equal(buildClaudeSdkEnv({ CLOUDCLI_BG_MAX_HOLD_MS: '7200000' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '7200000');
});

test('CLOUDCLI_BG_MAX_HOLD_MS falls back to the default unless it is a whole number of at least 30 minutes', () => {
  const twelveHours = 12 * 60 * 60 * 1000;
  assert.equal(resolveBackgroundMaxHoldMs({}), twelveHours);
  assert.equal(resolveBackgroundMaxHoldMs({ CLOUDCLI_BG_MAX_HOLD_MS: ' 3600000 ' }), 3600000);
  assert.equal(resolveBackgroundMaxHoldMs({ CLOUDCLI_BG_MAX_HOLD_MS: '60000' }), twelveHours, 'shorter than the idle ceiling');
  assert.equal(resolveBackgroundMaxHoldMs({ CLOUDCLI_BG_MAX_HOLD_MS: '2h' }), twelveHours);
  assert.equal(resolveBackgroundMaxHoldMs({ CLOUDCLI_BG_MAX_HOLD_MS: '-5' }), twelveHours);
  assert.equal(resolveBackgroundMaxHoldMs({ CLOUDCLI_BG_MAX_HOLD_MS: '' }), twelveHours);
  assert.equal(resolveBackgroundMaxHoldMs({ CLOUDCLI_BG_MAX_HOLD_MS: '99999999999' }), 2 ** 31 - 1, 'capped at the timer limit');
});
