import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { PendingPermissionRequest } from '@/shared/types';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import { getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';

/**
 * [local] Stage 3 of the Codex parity plan: on the app-server runtime, Codex's
 * approval requests and its automatic reviewer's denials reach the same banner
 * as Claude's and OpenCode's, as their own cards. The answers keep Codex's
 * vocabulary: "Allow for this session" is `rememberEntry: 'session'`, never a
 * Claude allow rule, and "Allow anyway" overrides a denial.
 */

type Decision = { ids: string | string[]; decision: Record<string, unknown> };

// Element checks compare booleans: a failing `assert.equal(element, null)` makes
// node:assert print the jsdom element, whose object graph exhausts memory.
const renderBanner = (requests: PendingPermissionRequest[]) => {
  const decisions: Decision[] = [];
  const grants: unknown[] = [];
  const view = render(
    <PermissionRequestsBanner
      pendingPermissionRequests={requests}
      providerLabel="Codex"
      handlePermissionDecision={(ids, decision) => decisions.push({ ids, decision })}
      handleGrantToolPermission={(suggestion) => {
        grants.push(suggestion);
        return { success: true };
      }}
    />,
  );
  return { ...view, decisions, grants };
};

const commandRequest: PendingPermissionRequest = {
  requestId: 'codex-1',
  toolName: 'CodexCommandApproval',
  input: { command: 'rm -rf build', cwd: '/p', reason: 'needs to write outside the sandbox', kind: 'command', network: null, additionalPermissions: null },
  context: { provider: 'codex', choices: ['accept', 'acceptForSession', 'decline'] },
};

test('a Codex command approval shows the command and answers once, for the session, or no', () => {
  const { getByText, queryByText, decisions, grants } = renderBanner([commandRequest]);

  assert.ok(getByText('Codex wants to run a command'));
  assert.ok(getByText('rm -rf build'));
  assert.ok(getByText('needs to write outside the sandbox'));
  assert.ok(getByText('/p'));
  // Not Claude's generic card with its allow rule.
  assert.equal(queryByText('Permission required') === null, true);
  assert.equal(queryByText(/Allow rule/) === null, true);

  fireEvent.click(getByText('Allow once'));
  fireEvent.click(getByText('Allow for this session'));
  fireEvent.click(getByText('Deny'));
  assert.deepEqual(decisions, [
    { ids: 'codex-1', decision: { allow: true } },
    { ids: 'codex-1', decision: { allow: true, rememberEntry: 'session' } },
    { ids: 'codex-1', decision: { allow: false } },
  ]);
  assert.deepEqual(grants, [], 'nothing is saved in Claude\'s allowed tools');
});

test('the buttons are large tap targets and follow the choices Codex offers', () => {
  const { getByText, queryByText } = renderBanner([{
    ...commandRequest,
    input: { ...(commandRequest.input as object), network: { host: 'example.com', protocol: 'https' } },
    context: { provider: 'codex', choices: ['accept', 'decline'] },
  }]);

  assert.ok(getByText('Codex wants network access'));
  assert.ok(getByText('example.com'));
  assert.equal(queryByText('Allow for this session') === null, true);
  const allow = getByText('Allow once');
  assert.match(allow.className, /\bh-11\b/, 'at least 44px tall on a phone');
  assert.match(allow.className, /\bw-full\b/);
});

test('a file change approval lists the files and shows the diff on tap', () => {
  const { getByText, container, decisions } = renderBanner([{
    requestId: 'codex-2',
    toolName: 'CodexFileChangeApproval',
    input: { reason: 'outside the workspace', grantRoot: null, changes: [{ path: '/tmp/out.txt', kind: 'add', diff: '+hello' }] },
    context: { provider: 'codex', choices: ['accept', 'acceptForSession', 'decline'] },
  }]);

  assert.ok(getByText('Codex wants to change files'));
  assert.ok(getByText('/tmp/out.txt'));
  const details = container.querySelector('details');
  assert.equal(details !== null, true);
  assert.equal(details?.open, false);
  fireEvent.click(getByText('Show changes'));
  assert.match(container.querySelector('pre')?.textContent ?? '', /\+hello/);

  fireEvent.click(getByText('Allow once'));
  assert.deepEqual(decisions, [{ ids: 'codex-2', decision: { allow: true } }]);
});

test('a permissions request shows network and paths', () => {
  const { getByText } = renderBanner([{
    requestId: 'codex-3',
    toolName: 'CodexPermissionsApproval',
    input: { reason: 'download the dataset', cwd: '/p', network: true, read: [], write: ['/data'] },
    context: { provider: 'codex', choices: ['accept', 'acceptForSession', 'decline'] },
  }]);
  assert.ok(getByText('Codex asks for more access'));
  assert.ok(getByText('/data'));
  assert.ok(getByText('download the dataset'));
});

test('a review denial shows the reason and offers Allow anyway or Keep denied', () => {
  const { getByText, queryByText, decisions } = renderBanner([{
    requestId: 'codex-4',
    toolName: 'CodexAutoReviewDenial',
    input: { reviewId: 'rev-1', status: 'denied', riskLevel: 'high', rationale: 'Deletes files outside the workspace', actionKind: 'command', action: 'rm -rf /tmp/x', cwd: '/p' },
    context: { provider: 'codex' },
  }]);

  assert.ok(getByText('Auto-review blocked an action'));
  assert.ok(getByText('rm -rf /tmp/x'));
  assert.ok(getByText('Deletes files outside the workspace'));
  assert.ok(getByText('high'));
  assert.ok(getByText(/The retry is still reviewed/));
  assert.equal(queryByText('Allow once') === null, true);

  fireEvent.click(getByText('Keep denied'));
  fireEvent.click(getByText('Allow anyway'));
  assert.deepEqual(decisions, [
    { ids: 'codex-4', decision: { allow: false } },
    { ids: 'codex-4', decision: { allow: true } },
  ]);
});

test('the cards are translated (zh-CN)', async () => {
  await i18n.changeLanguage('zh-CN');
  try {
    const { getByText } = renderBanner([commandRequest]);
    assert.ok(getByText('Codex 想运行一条命令'));
    assert.ok(getByText('本会话内允许'));
    assert.ok(getByText('允许一次'));
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('an auto-review row in the transcript names the decision and keeps the reason in its body', () => {
  const config = getToolConfig('CodexAutoReview');
  const input = { status: 'denied', action: 'rm -rf /tmp/x', rationale: 'Too risky', riskLevel: 'high' };
  assert.equal(typeof config.input.title === 'function' ? config.input.title(input) : config.input.title, 'Auto-review denied: rm -rf /tmp/x');
  assert.equal(
    typeof config.input.title === 'function' ? config.input.title({ status: 'approved', action: 'ls' }) : '',
    'Auto-review approved: ls',
  );
  assert.equal(config.input.getContentProps?.(input).content, 'Reviewer: Too risky\nRisk: high');
  assert.equal(config.result?.hidden, true);
});
