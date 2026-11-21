import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexServerRequestResponse,
  describeAutoReview,
  describeCodexServerRequest,
  readCodexApprovalChoice,
  toGuardianAssessmentEvent,
} from '@/modules/providers/list/codex/codex-app-server.approvals.js';

/**
 * [local] Mapping between the Codex app-server's approval requests and the
 * chat's permission prompts (stage 3). The round trips through the runtime
 * are in codex-app-server-runtime.test.ts; these cover the shapes.
 */

test('the chat offers accept, accept for the session and decline, whatever else Codex lists', () => {
  const choicesFor = (availableDecisions: unknown) => describeCodexServerRequest(
    'item/commandExecution/requestApproval',
    { command: 'ls', availableDecisions },
    new Map(),
  ).context.choices;
  assert.deepEqual(choicesFor(undefined), ['accept', 'acceptForSession', 'decline'], 'older servers list nothing');
  assert.deepEqual(choicesFor(null), ['accept', 'acceptForSession', 'decline']);
  assert.deepEqual(choicesFor(['accept', 'cancel']), ['accept', 'decline'], 'declining is always possible');
  assert.deepEqual(choicesFor([{ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'x', action: 'allow' } } }, 'decline']), ['decline']);
});

test('a network approval and extra permissions of a command are shown', () => {
  const { input } = describeCodexServerRequest('item/commandExecution/requestApproval', {
    command: 'curl https://example.com',
    networkApprovalContext: { host: 'example.com', protocol: 'https' },
    additionalPermissions: { network: { enabled: true }, fileSystem: { read: ['/r'], write: null, entries: [{ path: { type: 'path', path: '/w' }, access: 'write' }] } },
  }, new Map());
  assert.deepEqual(input.network, { host: 'example.com', protocol: 'https' });
  assert.deepEqual(input.additionalPermissions, { network: true, read: ['/r'], write: ['/w'] });
});

test('decisions map to Codex values; nothing is accepted without allow', () => {
  assert.equal(readCodexApprovalChoice({ allow: true }), 'accept');
  assert.equal(readCodexApprovalChoice({ allow: true, rememberEntry: 'session' }), 'acceptForSession');
  assert.equal(readCodexApprovalChoice({ allow: true, rememberEntry: 'Bash(ls:*)' }), 'accept', 'a Claude allow rule is not a session grant');
  assert.equal(readCodexApprovalChoice({ allow: false, rememberEntry: 'session' }), 'decline');
  assert.deepEqual(
    codexServerRequestResponse('item/permissions/requestApproval', { permissions: { network: null, fileSystem: { read: ['/a'], write: null } } }, { allow: true }),
    { permissions: { fileSystem: { read: ['/a'], write: null } }, scope: 'turn' },
  );
  assert.deepEqual(
    codexServerRequestResponse('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Q?' }] }, { allow: false }),
    { answers: {} },
    'Dismiss sends no answers',
  );
  assert.deepEqual(
    codexServerRequestResponse('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Q?' }] }, { allow: true, updatedInput: { answers: { 'Q?': 'typed' } } }),
    { answers: { q: { answers: ['typed'] } } },
    'answers keyed by question text are read too',
  );
});

test('every reviewed action kind becomes the snake-case core event Allow anyway sends', () => {
  const event = (action: Record<string, unknown>) => toGuardianAssessmentEvent({
    reviewId: 'r',
    turnId: 't',
    targetItemId: null,
    review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale: null },
    action,
  }).action;
  assert.deepEqual(event({ type: 'execve', source: 'unifiedExec', program: '/bin/rm', argv: ['rm', '-rf', 'x'], cwd: '/p' }),
    { type: 'execve', source: 'unified_exec', program: '/bin/rm', argv: ['rm', '-rf', 'x'], cwd: '/p' });
  assert.deepEqual(event({ type: 'writeStdin', approvalId: 'a', processId: '7', stdin: 'y\n', cwd: '/p' }),
    { type: 'write_stdin', approval_id: 'a', process_id: '7', stdin: 'y\n', cwd: '/p' });
  assert.deepEqual(event({ type: 'applyPatch', cwd: 'C:\\p', files: ['C:\\p\\a.ts'] }),
    { type: 'apply_patch', cwd: 'C:\\p', files: ['C:\\p\\a.ts'] }, 'paths stay as they are');
  assert.deepEqual(event({ type: 'mcpToolCall', server: 's', toolName: 't', connectorId: null, connectorName: null, toolTitle: null }),
    { type: 'mcp_tool_call', server: 's', tool_name: 't', connector_id: null, connector_name: null, tool_title: null });
  assert.deepEqual(event({ type: 'requestPermissions', reason: 'r', permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/w'], globScanMaxDepth: 2 } } }),
    { type: 'request_permissions', reason: 'r', permissions: { network: { enabled: true }, file_system: { read: null, write: ['/w'], glob_scan_max_depth: 2 } } });
  const full = toGuardianAssessmentEvent({ reviewId: 'r', turnId: 't', review: { status: 'timedOut' }, action: { type: 'command', source: 'shell', command: 'x', cwd: '/' } });
  assert.equal(full.status, 'timed_out');
  assert.equal(full.risk_level, null);
});

test('a review row names the action in one line', () => {
  assert.deepEqual(describeAutoReview({
    reviewId: 'r',
    review: { status: 'denied', riskLevel: 'medium', userAuthorization: 'low', rationale: 'Too broad' },
    action: { type: 'requestPermissions', reason: null, permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/w'] } } },
  }), {
    reviewId: 'r',
    status: 'denied',
    riskLevel: 'medium',
    userAuthorization: 'low',
    rationale: 'Too broad',
    actionKind: 'requestPermissions',
    action: 'network, write /w',
    cwd: null,
  });
  assert.equal(describeAutoReview({ reviewId: 'r', review: { status: 'approved' }, action: { type: 'mcpToolCall', server: 'docs', toolName: 'search', toolTitle: null } }).action, 'docs / search');
});
