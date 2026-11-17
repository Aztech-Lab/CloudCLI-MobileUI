import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  codexAppServerRuntime,
  mapCodexAppServerItem,
  resolveCodexRuntimeMode,
} from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import {
  CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE,
  CODEX_THREAD_ACTIVE_WRITER_MESSAGE,
  codexRuntime,
} from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

/**
 * [local] The Codex app-server runtime (stage 1), driven through
 * `codexRuntime` exactly as a chat message is, against a fake
 * `codex app-server`: a node script speaking newline-delimited JSON-RPC that
 * plays a scripted turn per `turn/start` and logs every line it receives. It
 * is installed through `codexAppServer.resolveLauncher`, so no Codex binary
 * starts and no model is called. Message shapes follow the protocol generated
 * from Codex 0.169 (`v2/ThreadItem`, `TurnCompletedNotification`, …), and the
 * lifecycle details (writer error text, interrupt reply, unknown-method error)
 * were seen against the real 0.169 binary with a throwaway CODEX_HOME.
 */

type Step =
  | 'complete'
  | 'wait'
  | ['notify', string, Record<string, unknown>]
  | ['fail', string]
  | ['exit', number]
  | ['request', string, Record<string, unknown>];

type FakeConfig = {
  turns?: Step[][];
  lockedThreads?: string[];
  missing?: string[];
  initFail?: boolean;
  ignoreInterrupt?: boolean;
  /** Delay between the interrupt reply and the interrupted turn/completed. */
  interruptDelayMs?: number;
  newThreadId?: string;
  reviewer?: string;
};

function fakeAppServerSource(config: FakeConfig, files: { log: string; pids: string; counter: string }): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
const CFG = ${JSON.stringify({ lockedThreads: [], missing: [], turns: [], newThreadId: 'thread-new', reviewer: 'user', ...config })};
const FILES = ${JSON.stringify(files)};
fs.appendFileSync(FILES.pids, process.pid + '\\n');
setTimeout(() => process.exit(0), 30000);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
let waiting = null;
// Interrupts that arrived before the scripted turn reached its 'wait' step.
const interrupted = new Set();
const completeInterrupted = (threadId, turnId) => setTimeout(() => notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } }), CFG.interruptDelayMs || 0);
const answers = new Map();
function nextTurn() {
  let n = 0;
  try { n = Number(fs.readFileSync(FILES.counter, 'utf8')) || 0; } catch {}
  fs.writeFileSync(FILES.counter, String(n + 1));
  return n;
}
async function play(steps, threadId, turnId) {
  for (const step of steps) {
    await new Promise((r) => setTimeout(r, 5));
    if (step === 'complete') { notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } }); continue; }
    if (step === 'wait') {
      if (interrupted.has(turnId)) { completeInterrupted(threadId, turnId); return; }
      waiting = { threadId, turnId };
      return;
    }
    const [kind, a, b] = step;
    if (kind === 'notify') notify(a, { threadId, turnId, ...b });
    if (kind === 'fail') notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', items: [], error: { message: a, codexErrorInfo: null, additionalDetails: null } } });
    if (kind === 'exit') process.exit(a);
    if (kind === 'request') {
      const id = 900 + Math.floor(Math.random() * 1000);
      await new Promise((resolve) => { answers.set(id, resolve); send({ jsonrpc: '2.0', id, method: a, params: { threadId, turnId, ...b } }); });
    }
  }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  fs.appendFileSync(FILES.log, JSON.stringify({ ...m, at: Date.now() }) + '\\n');
  if (!m.method) { const resolve = answers.get(m.id); if (resolve) { answers.delete(m.id); resolve(); } return; }
  if (m.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  if (CFG.missing.includes(m.method)) return fail(-32600, 'Invalid request: unknown variant \`' + m.method + '\`, expected one of \`initialize\`');
  switch (m.method) {
    case 'initialize':
      if (CFG.initFail) process.exit(2);
      return reply({ userAgent: 'fake' });
    case 'thread/start':
      return reply({ thread: { id: CFG.newThreadId }, approvalsReviewer: CFG.reviewer });
    case 'thread/resume':
      if (CFG.lockedThreads.includes(m.params.threadId)) return fail(-32600, 'thread ' + m.params.threadId + ' already has an active writer');
      return reply({ thread: { id: m.params.threadId }, approvalsReviewer: CFG.reviewer });
    case 'turn/start': {
      const n = nextTurn();
      const turnId = 'turn-' + (n + 1);
      reply({ turn: { id: turnId, status: 'inProgress', items: [], error: null } });
      play(CFG.turns[n] || ['complete'], m.params.threadId, turnId);
      return;
    }
    case 'turn/interrupt':
      reply({});
      if (CFG.ignoreInterrupt) return;
      if (waiting && waiting.turnId === m.params.turnId) {
        completeInterrupted(waiting.threadId, waiting.turnId);
        waiting = null;
      } else {
        interrupted.add(m.params.turnId);
      }
      return;
    case 'thread/unsubscribe':
      return reply({ status: 'unsubscribed' });
    default:
      return fail(-32601, 'unknown method');
  }
});
`;
}

type Logged = { at: number; id?: number; method?: string; params?: Record<string, any>; result?: any; error?: any };
type Sent = Record<string, any>;

type Fake = {
  dir: string;
  requests: () => Promise<Logged[]>;
  pids: () => Promise<number[]>;
};

const sessionsProvider = new CodexSessionsProvider();
const defaultSettings = { ...codexAppServerRuntime.settings };

function makeContext(overrides: Partial<ProviderRuntimeContext> & { providerSessionId?: string | null } = {}): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => overrides.providerSessionId ?? null,
    resolveResumeModel: async (_sessionId, requested) => requested || 'gpt-test',
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'gpt-test', label: 'gpt-test', effort: { values: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }] } }],
      DEFAULT: 'gpt-test',
    }) as never,
    normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

function makeWriter() {
  const sent: Sent[] = [];
  const sessionIds: string[] = [];
  return {
    sent,
    sessionIds,
    writer: {
      isWebSocketWriter: true,
      send: (message: unknown) => sent.push(message as Sent),
      setSessionId: (id: string) => sessionIds.push(id),
    },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withFake(config: FakeConfig, run: (fake: Fake) => Promise<void>, runtimeMode: string | null = 'appserver') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-appserver-'));
  const files = { log: path.join(dir, 'requests.log'), pids: path.join(dir, 'pids.log'), counter: path.join(dir, 'turns.txt') };
  await writeFile(files.log, '', 'utf8');
  await writeFile(files.pids, '', 'utf8');
  const script = path.join(dir, 'fake-app-server.cjs');
  await writeFile(script, fakeAppServerSource(config, files), 'utf8');

  const appServer = codexAppServer as unknown as { resolveLauncher: () => string };
  const originalLauncher = appServer.resolveLauncher;
  const originalMode = process.env.CLOUDCLI_CODEX_RUNTIME;
  appServer.resolveLauncher = () => script;
  if (runtimeMode === null) {
    delete process.env.CLOUDCLI_CODEX_RUNTIME;
  } else {
    process.env.CLOUDCLI_CODEX_RUNTIME = runtimeMode;
  }
  Object.assign(codexAppServerRuntime.settings, defaultSettings, { idleReleaseMs: 60_000, restartBackoffMs: 0 });

  const fake: Fake = {
    dir,
    requests: async () => (await readFile(files.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Logged),
    pids: async () => (await readFile(files.pids, 'utf8')).split('\n').filter(Boolean).map(Number),
  };
  try {
    await run(fake);
  } finally {
    codexAppServerRuntime.shutdown();
    for (const pid of await fake.pids()) {
      await waitFor(() => !isAlive(pid), `fake app-server ${pid} to exit`).catch(() => {
        try {
          process.kill(pid);
        } catch {
          // Gone already.
        }
      });
    }
    appServer.resolveLauncher = originalLauncher;
    if (originalMode === undefined) {
      delete process.env.CLOUDCLI_CODEX_RUNTIME;
    } else {
      process.env.CLOUDCLI_CODEX_RUNTIME = originalMode;
    }
    Object.assign(codexAppServerRuntime.settings, defaultSettings);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const byMethod = (requests: Logged[], method: string) => requests.filter((request) => request.method === method);
const kinds = (sent: Sent[]) => sent.map((message) => message.kind);

function execThread(onRun?: () => void): Thread {
  return {
    id: 'exec-thread',
    async runStreamed() {
      onRun?.();
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'exec-thread' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })() };
    },
  } as unknown as Thread;
}

const agentMessage = (id: string, text: string) => ['notify', 'item/completed', {
  item: { type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null, moderation: null },
  completedAtMs: 0,
}] as Step;

test('the runtime switch defaults to exec', () => {
  assert.equal(resolveCodexRuntimeMode(undefined), 'exec');
  assert.equal(resolveCodexRuntimeMode(''), 'exec');
  assert.equal(resolveCodexRuntimeMode('exec'), 'exec');
  assert.equal(resolveCodexRuntimeMode('nonsense'), 'exec');
  assert.equal(resolveCodexRuntimeMode('appserver'), 'appserver');
  assert.equal(resolveCodexRuntimeMode(' AppServer '), 'appserver');
  assert.equal(resolveCodexRuntimeMode('app-server'), 'appserver');
});

test('with the flag off a message runs through codex exec and never starts the app-server', async (t) => {
  await withFake({}, async (fake) => {
    let execRuns = 0;
    t.mock.method(Codex.prototype, 'startThread', () => execThread(() => { execRuns += 1; }));
    const { sent, writer } = makeWriter();

    await codexRuntime.run('hello', { cwd: process.cwd() }, writer, makeContext());

    assert.equal(execRuns, 1);
    assert.deepEqual(await fake.pids(), [], 'no app-server child was spawned');
    assert.ok(sent.some((message) => message.kind === 'complete' && message.exitCode === 0));
    assert.equal(codexAppServerRuntime.isAppServerRunning(), false);
  }, null);
});

test('a new conversation starts a thread, streams a normal turn and completes like exec', async () => {
  await withFake({
    turns: [[
      ['notify', 'turn/started', { turn: { id: 'turn-1', status: 'inProgress', items: [] } }],
      ['notify', 'item/started', { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] } }],
      ['notify', 'item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Thinking about it'], content: [] } }],
      ['notify', 'item/agentMessage/delta', { itemId: 'm1', delta: 'Hi' }],
      agentMessage('m1', 'Hi there'),
      ['notify', 'thread/tokenUsage/updated', { tokenUsage: {
        total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 },
        last: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 },
        modelContextWindow: 258000,
      } }],
      'complete',
    ]],
  }, async (fake) => {
    const { sent, sessionIds, writer } = makeWriter();

    await codexRuntime.run('hello', { cwd: fake.dir, model: 'gpt-test', effort: 'high' }, writer, makeContext());

    const requests = await fake.requests();
    const initialize = byMethod(requests, 'initialize')[0];
    assert.equal(initialize.params?.clientInfo?.name, 'cloudcli');
    assert.deepEqual(initialize.params?.capabilities, { experimentalApi: true });
    assert.equal(byMethod(requests, 'initialized').length, 1);
    const start = byMethod(requests, 'thread/start')[0];
    assert.deepEqual(start.params, { cwd: fake.dir, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'gpt-test' });
    const turn = byMethod(requests, 'turn/start')[0];
    assert.deepEqual(turn.params, {
      threadId: 'thread-new',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      cwd: fake.dir,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      model: 'gpt-test',
      effort: 'high',
    });

    assert.deepEqual(sessionIds, ['thread-new']);
    // Reasoning goes through the same event shape as exec's `reasoning` item,
    // so it renders exactly as it does there today.
    assert.deepEqual(kinds(sent), ['session_created', 'text', 'text', 'status', 'complete']);
    assert.equal(sent[0].newSessionId, 'thread-new');
    assert.equal(sent[1].content, 'Thinking about it');
    assert.equal(sent[2].content, 'Hi there');
    assert.equal(sent[2].role, 'assistant');
    assert.equal(sent[3].text, 'token_budget');
    assert.deepEqual(sent[3].tokenBudget, { used: 150, total: 258000, inputTokens: 100, outputTokens: 50, breakdown: { input: 100, output: 50 } });
    assert.equal(sent[4].exitCode, 0);
    assert.equal(sent[4].actualSessionId, 'thread-new');
    assert.deepEqual(codexAppServerRuntime.loadedThreadIds(), ['thread-new'], 'the thread stays loaded until it idles');
  });
});

test('a continued conversation resumes once with its roots and settings, then reuses the loaded thread', async () => {
  await withFake({ reviewer: 'user' }, async (fake) => {
    const cwd = path.join(fake.dir, 'project');
    const extra = path.join(fake.dir, 'data');
    await mkdir(cwd);
    await mkdir(extra);
    const context = makeContext({ providerSessionId: 'thread-old', getSessionWorkspaceRoots: () => [extra] });

    await codexRuntime.run('first', { sessionId: 'app-1', cwd, permissionMode: 'approveForMe', effort: 'low' }, makeWriter().writer, context);
    await codexRuntime.run('second', { sessionId: 'app-1', cwd, permissionMode: 'bypassPermissions' }, makeWriter().writer, context);
    await codexRuntime.run('third', { sessionId: 'app-1', cwd, permissionMode: 'default', effort: 'bogus' }, makeWriter().writer, context);

    const requests = await fake.requests();
    assert.equal(byMethod(requests, 'initialize').length, 1, 'one shared child');
    const resumes = byMethod(requests, 'thread/resume');
    assert.equal(resumes.length, 1, 'later messages reuse the loaded thread');
    assert.deepEqual(resumes[0].params, {
      threadId: 'thread-old',
      excludeTurns: true,
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-test',
      runtimeWorkspaceRoots: [cwd, extra],
    });
    assert.equal(byMethod(requests, 'thread/start').length, 0);

    const [first, second, third] = byMethod(requests, 'turn/start').map((request) => request.params!);
    // "Approve for me" routes approvals to Codex's automatic reviewer.
    assert.equal(first.approvalsReviewer, 'auto_review');
    assert.equal(first.effort, 'low');
    assert.deepEqual(first.runtimeWorkspaceRoots, [cwd, extra]);
    assert.equal('sandboxPolicy' in first, false);
    // Bypass changes the sandbox of the loaded thread explicitly.
    assert.equal(second.approvalPolicy, 'never');
    assert.deepEqual(second.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.equal(second.approvalsReviewer, 'user', 'back to the reviewer the thread had on load');
    // Back to the default mode; an effort the model does not offer is not sent.
    assert.equal(third.approvalPolicy, 'on-request');
    assert.equal(third.sandboxPolicy?.type, 'workspaceWrite');
    assert.equal('effort' in third, false);
  });
});

test('tool calls map to the same rows as exec: command (with streamed output), file change, MCP, plan', async () => {
  await withFake({
    turns: [[
      ['notify', 'item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/', status: 'inProgress', aggregatedOutput: null, exitCode: null } }],
      ['notify', 'item/commandExecution/outputDelta', { itemId: 'c1', delta: 'a.txt\n' }],
      ['notify', 'item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/', status: 'completed', aggregatedOutput: 'a.txt\nb.txt\n', exitCode: 0 } }],
      ['notify', 'item/completed', { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [
        { path: '/p/new.ts', kind: { type: 'add' }, diff: '+x' },
        { path: '/p/old.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+b' },
      ] } }],
      ['notify', 'item/started', { item: { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', status: 'inProgress', arguments: { q: 'x' }, result: null, error: null } }],
      ['notify', 'item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'x' },
        result: { content: [{ type: 'text', text: 'found' }], structuredContent: null, _meta: null }, error: null } }],
      ['notify', 'turn/plan/updated', { explanation: null, plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }] }],
      ['notify', 'item/completed', { item: { type: 'webSearch', id: 'w1', query: 'codex docs', action: null, results: null } }],
      ['notify', 'item/completed', { item: { type: 'contextCompaction', id: 'x1' } }],
      'complete',
    ]],
  }, async () => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('do it', { cwd: process.cwd() }, writer, makeContext());

    const rows = sent.filter((message) => message.kind === 'tool_use' || message.kind === 'tool_result');
    const bash = rows.filter((message) => message.toolId === 'c1' && message.kind === 'tool_use');
    assert.ok(bash.length >= 2, 'started and completed rows for the command');
    assert.ok(bash.every((message) => message.toolName === 'Bash' && message.toolInput?.command === 'ls'));
    const bashResults = rows.filter((message) => message.kind === 'tool_result' && message.toolId === 'c1');
    assert.equal(bashResults.at(-1)?.content, 'a.txt\nb.txt\n');
    assert.equal(bashResults.at(-1)?.isError, false);

    const files = rows.filter((message) => String(message.toolId).startsWith('f1_'));
    assert.deepEqual(files.map((message) => [message.toolName, message.toolInput?.file_path]), [['Write', '/p/new.ts'], ['Edit', '/p/old.ts']]);

    const mcp = rows.filter((message) => message.toolId === 'm1');
    assert.equal(mcp[0].toolName, 'mcp__docs__search');
    const mcpResult = mcp.find((message) => message.kind === 'tool_result');
    assert.equal(mcpResult?.content, JSON.stringify({ content: [{ type: 'text', text: 'found' }], structured_content: null }));

    const plan = sent.find((message) => message.toolName === 'TodoWrite');
    assert.deepEqual(plan?.toolInput, { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'pending' }] });
    assert.ok(sent.some((message) => message.toolName === 'WebSearch' && message.toolInput?.query === 'codex docs'));
    assert.equal(sent.at(-1)?.kind, 'complete');
  });
});

test('approval requests are declined, as exec has no one to ask', async () => {
  await withFake({
    turns: [[
      ['request', 'item/commandExecution/requestApproval', { itemId: 'c1', command: 'curl x' }],
      ['request', 'item/fileChange/requestApproval', { itemId: 'f1' }],
      ['request', 'item/tool/requestUserInput', { itemId: 'q1', questions: [] }],
      'complete',
    ]],
  }, async (fake) => {
    await codexRuntime.run('hi', { cwd: process.cwd() }, makeWriter().writer, makeContext());
    const answers = (await fake.requests()).filter((line) => !line.method && line.id !== undefined && line.id >= 900);
    assert.deepEqual(answers.map((line) => line.result ?? line.error?.code), [{ decision: 'decline' }, { decision: 'decline' }, -32601]);
  });
});

test('a failed turn shows one error row and completes with exit code 1; retries are not errors', async () => {
  await withFake({
    turns: [[
      ['notify', 'error', { error: { message: 'Reconnecting... 1/5', codexErrorInfo: null, additionalDetails: null }, willRetry: true }],
      ['notify', 'error', { error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized', additionalDetails: null }, willRetry: false }],
      ['fail', 'unexpected status 401 Unauthorized'],
    ]],
  }, async () => {
    const { sent, writer } = makeWriter();
    t_mockConsoleError();
    await codexRuntime.run('hi', { cwd: process.cwd() }, writer, makeContext());

    const errors = sent.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].content, 'unexpected status 401 Unauthorized');
    assert.equal(sent.at(-1)?.kind, 'complete');
    assert.equal(sent.at(-1)?.exitCode, 1);
  });
});

let restoreConsoleError: (() => void) | null = null;
function t_mockConsoleError() {
  const original = console.error;
  console.error = () => {};
  restoreConsoleError = () => {
    console.error = original;
  };
}
test.afterEach(() => {
  restoreConsoleError?.();
  restoreConsoleError = null;
});

test('a thread held by another writer gets the clear conflict row and is not retried through exec', async (t) => {
  await withFake({ lockedThreads: ['thread-desktop'] }, async (fake) => {
    let execRuns = 0;
    t.mock.method(Codex.prototype, 'resumeThread', () => execThread(() => { execRuns += 1; }));
    t_mockConsoleError();
    const { sent, writer } = makeWriter();

    await codexRuntime.run('hi', { sessionId: 'app-2', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-desktop' }));

    const errors = sent.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].errorCode, CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE);
    assert.equal(errors[0].content, CODEX_THREAD_ACTIVE_WRITER_MESSAGE);
    assert.equal(sent.at(-1)?.kind, 'complete');
    assert.equal(sent.at(-1)?.exitCode, 1);
    assert.equal(execRuns, 0);
    assert.equal(byMethod(await fake.requests(), 'turn/start').length, 0);
    await waitFor(() => !codexAppServerRuntime.isAppServerRunning(), 'the unused child to stop');
  });
});

test('Stop interrupts only the turn and leaves the completion to the abort path', async () => {
  await withFake({ turns: [['wait'], ['complete']] }, async (fake) => {
    const { sent, writer } = makeWriter();
    const context = makeContext({ providerSessionId: 'thread-old' });
    const run = codexRuntime.run('long task', { sessionId: 'app-3', cwd: process.cwd() }, writer, context);
    await waitFor(() => codexAppServerRuntime.isRunning('app-3'), 'the turn to start');
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');

    assert.equal(await codexRuntime.abort('app-3'), true);
    await run;

    const interrupt = byMethod(await fake.requests(), 'turn/interrupt');
    assert.deepEqual(interrupt.map((request) => request.params), [{ threadId: 'thread-old', turnId: 'turn-1' }]);
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'chat.abort sends the completion');
    assert.equal(codexAppServerRuntime.isRunning('app-3'), false);
    assert.equal(await codexRuntime.abort('app-3'), false, 'nothing left to stop');
    // The thread is still loaded: the next message does not resume again.
    await codexRuntime.run('next', { sessionId: 'app-3', cwd: process.cwd() }, makeWriter().writer, context);
    assert.equal(byMethod(await fake.requests(), 'thread/resume').length, 1);
  });
});

test('a message sent right after Stop waits for the stopped turn to end instead of joining it', async () => {
  await withFake({ turns: [['wait'], ['complete']], interruptDelayMs: 200 }, async (fake) => {
    const context = makeContext({ providerSessionId: 'thread-old' });
    const stopped = makeWriter();
    const first = codexRuntime.run('long task', { sessionId: 'app-3b', cwd: process.cwd() }, stopped.writer, context);
    await waitFor(() => codexAppServerRuntime.isRunning('app-3b'), 'the turn to start');
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');
    assert.equal(await codexRuntime.abort('app-3b'), true);

    // chat.abort has already ended the chat run; the user sends again at once.
    const next = makeWriter();
    await codexRuntime.run('next', { sessionId: 'app-3b', cwd: process.cwd() }, next.writer, context);
    await first;

    const requests = await fake.requests();
    const interrupt = byMethod(requests, 'turn/interrupt')[0];
    const secondTurn = byMethod(requests, 'turn/start')[1];
    assert.ok(secondTurn.at - interrupt.at >= 150, 'turn/start waited for the interrupted turn to complete');
    assert.equal(byMethod(requests, 'thread/resume').length, 1);
    assert.equal(stopped.sent.some((message) => message.kind === 'complete'), false);
    assert.deepEqual(kinds(next.sent), ['complete']);
    assert.equal(next.sent[0].exitCode, 0);
  });
});

test('a turn that ignores the interrupt is given up on after the timeout', async () => {
  await withFake({ turns: [['wait']], ignoreInterrupt: true }, async (fake) => {
    codexAppServerRuntime.settings.interruptTimeoutMs = 100;
    const run = codexRuntime.run('stuck', { sessionId: 'app-4', cwd: process.cwd() }, makeWriter().writer, makeContext());
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');
    await waitFor(() => codexAppServerRuntime.isRunning('app-4'), 'the run');
    assert.equal(await codexRuntime.abort('app-4'), true);
    await run;
    // Nothing else used the child, so it was stopped to end the turn for sure.
    assert.equal(codexAppServerRuntime.isAppServerRunning(), false);
  });
});

test('an idle thread is released: unsubscribed, then the unused child stops', async () => {
  await withFake({}, async (fake) => {
    codexAppServerRuntime.settings.idleReleaseMs = 50;
    await codexRuntime.run('hi', { sessionId: 'app-5', cwd: process.cwd() }, makeWriter().writer, makeContext({ providerSessionId: 'thread-5' }));
    await waitFor(async () => byMethod(await fake.requests(), 'thread/unsubscribe').length === 1, 'thread/unsubscribe');
    assert.deepEqual(byMethod(await fake.requests(), 'thread/unsubscribe')[0].params, { threadId: 'thread-5' });
    await waitFor(() => !codexAppServerRuntime.isAppServerRunning(), 'the child to stop');
    const [pid] = await fake.pids();
    await waitFor(() => !isAlive(pid), 'the child process to exit');
    assert.deepEqual(codexAppServerRuntime.loadedThreadIds(), []);

    // The next message loads the thread again in a fresh child.
    await codexRuntime.run('again', { sessionId: 'app-5', cwd: process.cwd() }, makeWriter().writer, makeContext({ providerSessionId: 'thread-5' }));
    assert.equal(byMethod(await fake.requests(), 'thread/resume').length, 2);
    assert.equal((await fake.pids()).length, 2);
  });
});

test('closing (archiving) a session releases its thread at once', async () => {
  await withFake({}, async (fake) => {
    await codexRuntime.run('hi', { sessionId: 'app-6', cwd: process.cwd() }, makeWriter().writer, makeContext({ providerSessionId: 'thread-6' }));
    assert.deepEqual(codexAppServerRuntime.loadedThreadIds(), ['thread-6']);
    codexRuntime.releaseSession('app-6');
    await waitFor(async () => byMethod(await fake.requests(), 'thread/unsubscribe').length === 1, 'thread/unsubscribe');
    await waitFor(() => !codexAppServerRuntime.isAppServerRunning(), 'the child to stop');
  });
});

test('a crash mid-turn fails that turn; the child restarts with a backoff, falling back to exec meanwhile', async (t) => {
  await withFake({ turns: [[agentMessage('m1', 'partial'), ['exit', 3]], ['complete']] }, async (fake) => {
    t_mockConsoleError();
    t.mock.method(console, 'warn', () => {});
    let execRuns = 0;
    t.mock.method(Codex.prototype, 'resumeThread', () => execThread(() => { execRuns += 1; }));
    codexAppServerRuntime.settings.restartBackoffMs = 300;
    const context = makeContext({ providerSessionId: 'thread-7' });

    const first = makeWriter();
    await codexRuntime.run('hi', { sessionId: 'app-7', cwd: process.cwd() }, first.writer, context);
    assert.deepEqual(kinds(first.sent), ['text', 'error', 'complete']);
    assert.match(first.sent[1].content, /Codex stopped before the turn finished/);
    assert.equal(first.sent[2].exitCode, 1);
    assert.equal(codexAppServerRuntime.isRunning('app-7'), false);

    // Inside the backoff: this message runs through exec instead.
    const second = makeWriter();
    await codexRuntime.run('again', { sessionId: 'app-7', cwd: process.cwd() }, second.writer, context);
    assert.equal(execRuns, 1);
    assert.equal((await fake.pids()).length, 1);

    // After it: a fresh child resumes the thread.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const third = makeWriter();
    await codexRuntime.run('once more', { sessionId: 'app-7', cwd: process.cwd() }, third.writer, context);
    assert.equal(execRuns, 1);
    assert.equal((await fake.pids()).length, 2);
    assert.equal(byMethod(await fake.requests(), 'thread/resume').length, 2);
    assert.equal(third.sent.at(-1)?.exitCode, 0);
  });
});

test('an app-server that cannot start, or lacks a method, hands the message to exec', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let execRuns = 0;
  t.mock.method(Codex.prototype, 'resumeThread', () => execThread(() => { execRuns += 1; }));
  t.mock.method(Codex.prototype, 'startThread', () => execThread(() => { execRuns += 1; }));

  await withFake({ initFail: true }, async () => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('hi', { sessionId: 'app-8', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-8' }));
    assert.equal(execRuns, 1);
    assert.equal(sent.filter((message) => message.kind === 'error').length, 0);
    assert.equal(sent.at(-1)?.exitCode, 0);
  });

  await withFake({ missing: ['thread/resume'] }, async (fake) => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('hi', { sessionId: 'app-9', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-9' }));
    assert.equal(execRuns, 2);
    assert.equal(byMethod(await fake.requests(), 'turn/start').length, 0);
    assert.equal(sent.filter((message) => message.kind === 'error').length, 0);
    await waitFor(() => !codexAppServerRuntime.isAppServerRunning(), 'the unused child to stop');
  });

  await withFake({ missing: ['turn/start'] }, async () => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('hi', { cwd: process.cwd() }, writer, makeContext());
    assert.equal(execRuns, 3, 'a new conversation starts its exec thread through startThread');
    assert.equal(sent.filter((message) => message.kind === 'session_created' && message.newSessionId === 'thread-new').length, 0,
      'the abandoned app-server thread was never announced');
  });
});

test('items exec never shows (the user\'s own message, compaction) are not forwarded', () => {
  assert.equal(mapCodexAppServerItem({ type: 'userMessage', id: 'u', content: [] }, 'completed'), null);
  assert.equal(mapCodexAppServerItem({ type: 'contextCompaction', id: 'c' }, 'completed'), null);
  assert.equal(mapCodexAppServerItem({ type: 'agentMessage', id: 'a', text: 'x' }, 'started'), null, 'prose arrives once, completed');
  assert.deepEqual(mapCodexAppServerItem({ type: 'commandExecution', id: 'c', command: 'x', status: 'declined', aggregatedOutput: null, exitCode: null }, 'completed'), {
    type: 'item', itemType: 'command_execution', itemId: 'c', command: 'x', output: '', exitCode: undefined, status: 'failed',
  });
});
