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
  // Codex reads the messages steered into this turn: a userMessage item each.
  | 'deliver'
  // Codex considers the turn over (a steer is refused from here) before it says so.
  | 'detach'
  | ['sleep', number]
  | ['notify', string, Record<string, unknown>]
  | ['fail', string]
  | ['exit', number]
  | ['request', string, Record<string, unknown>]
  // A request Codex withdraws itself shortly after (serverRequest/resolved); the turn goes on.
  | ['requestThenResolve', string, Record<string, unknown>];

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
  /** A turn waiting at 'wait' goes on with its remaining steps once a message is steered into it. */
  resumeOnSteer?: boolean;
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
// The turn Codex would steer into (as with the real app-server, one per thread here).
let activeTurn = null;
const steered = new Map();
const endTurn = (turnId) => { if (activeTurn && activeTurn.turnId === turnId) activeTurn = null; };
// Interrupts that arrived before the scripted turn reached its 'wait' step.
const interrupted = new Set();
const completeInterrupted = (threadId, turnId) => setTimeout(() => { endTurn(turnId); notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } }); }, CFG.interruptDelayMs || 0);
const userMessage = (threadId, turnId, clientId, content) => {
  const item = { type: 'userMessage', id: 'um-' + Math.random().toString(36).slice(2), clientId, content };
  notify('item/started', { threadId, turnId, item });
  notify('item/completed', { threadId, turnId, item });
};
const answers = new Map();
let nextRequestId = 900;
function nextTurn() {
  let n = 0;
  try { n = Number(fs.readFileSync(FILES.counter, 'utf8')) || 0; } catch {}
  fs.writeFileSync(FILES.counter, String(n + 1));
  return n;
}
async function play(steps, threadId, turnId) {
  for (const step of steps) {
    await new Promise((r) => setTimeout(r, 5));
    if (step === 'complete') { endTurn(turnId); notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } }); continue; }
    if (step === 'wait') {
      if (interrupted.has(turnId)) { completeInterrupted(threadId, turnId); return; }
      // A steer that arrived before the turn got here resumes it at once.
      if (CFG.resumeOnSteer && (steered.get(turnId) || []).length > 0) continue;
      waiting = { threadId, turnId, rest: steps.slice(steps.indexOf(step) + 1) };
      return;
    }
    if (step === 'deliver') { for (const s of steered.get(turnId) || []) userMessage(threadId, turnId, s.clientId, s.input); steered.delete(turnId); continue; }
    if (step === 'detach') { endTurn(turnId); continue; }
    const [kind, a, b] = step;
    if (kind === 'sleep') { await new Promise((r) => setTimeout(r, a)); continue; }
    if (kind === 'notify') notify(a, { threadId, turnId, ...b });
    if (kind === 'fail') endTurn(turnId);
    if (kind === 'fail') notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', items: [], error: { message: a, codexErrorInfo: null, additionalDetails: null } } });
    if (kind === 'exit') process.exit(a);
    if (kind === 'request') {
      const id = nextRequestId++;
      await new Promise((resolve) => { answers.set(id, resolve); send({ jsonrpc: '2.0', id, method: a, params: { threadId, turnId, ...b } }); });
    }
    if (kind === 'requestThenResolve') {
      const id = nextRequestId++;
      send({ jsonrpc: '2.0', id, method: a, params: { threadId, turnId, ...b } });
      await new Promise((r) => setTimeout(r, 30));
      notify('serverRequest/resolved', { threadId, requestId: id });
      await new Promise((r) => setTimeout(r, 30));
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
      // As Codex 0.169 does: on a running turn the input joins that turn.
      if (activeTurn && activeTurn.threadId === m.params.threadId) return reply({ turn: { id: activeTurn.turnId, status: 'inProgress', items: [], error: null } });
      const n = nextTurn();
      const turnId = 'turn-' + (n + 1);
      activeTurn = { threadId: m.params.threadId, turnId };
      reply({ turn: { id: turnId, status: 'inProgress', items: [], error: null } });
      // The turn's own prompt, as Codex reports it (with the client's id, if any).
      userMessage(m.params.threadId, turnId, m.params.clientUserMessageId || null, m.params.input);
      play(CFG.turns[n] || ['complete'], m.params.threadId, turnId);
      return;
    }
    case 'turn/steer': {
      if (!activeTurn || activeTurn.threadId !== m.params.threadId) return fail(-32600, 'no active turn to steer');
      if (activeTurn.turnId !== m.params.expectedTurnId) return fail(-32600, 'expected active turn id \`' + m.params.expectedTurnId + '\` but found \`' + activeTurn.turnId + '\`');
      const list = steered.get(activeTurn.turnId) || [];
      list.push({ clientId: m.params.clientUserMessageId, input: m.params.input });
      steered.set(activeTurn.turnId, list);
      reply({ turnId: activeTurn.turnId });
      if (CFG.resumeOnSteer && waiting && waiting.turnId === activeTurn.turnId) {
        const resumed = waiting;
        waiting = null;
        play(resumed.rest, resumed.threadId, resumed.turnId);
      }
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
    case 'thread/approveGuardianDeniedAction':
      return reply({});
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

test('requests the chat cannot answer are declined, as exec has no one to ask', async () => {
  await withFake({
    turns: [[
      ['request', 'mcpServer/elicitation/request', { serverName: 'docs', mode: 'form', message: 'Token?' }],
      ['request', 'item/tool/call', { callId: 'x', tool: 'dyn', arguments: {} }],
      'complete',
    ]],
  }, async (fake) => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('hi', { cwd: process.cwd() }, writer, makeContext());
    const answers = (await fake.requests()).filter((line) => !line.method && line.id !== undefined && line.id >= 900);
    assert.deepEqual(answers.map((line) => line.result ?? line.error?.code), [{ action: 'decline', content: null, _meta: null }, -32601]);
    assert.equal(sent.some((message) => message.kind === 'permission_request'), false);
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

// ---------------------------------------------------------------------------
// Stage 2: steering and "Send now"

const STEER_ID = '7d0c1a52-3f4e-4b8a-9c1d-2e3f4a5b6c7d';
const NOW_ID = '0f9e8d7c-6b5a-4948-8a7b-6c5d4e3f2a1b';
const userRows = (sent: Sent[]) => sent.filter((message) => message.kind === 'text' && message.role === 'user');

test('a message sent while a turn runs is steered into it and shown when Codex reads it', async () => {
  await withFake({ resumeOnSteer: true, turns: [['wait', 'deliver', agentMessage('m1', 'Noted, adding that'), 'complete']] }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('long task', { sessionId: 'app-s1', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-s1' }));
    await waitFor(() => codexAppServerRuntime.isRunning('app-s1'), 'the turn to start');

    // Sent at once, before turn/start has even answered: it waits for the turn.
    assert.equal(await codexRuntime.steer('app-s1', 'also check the logs', { messageId: STEER_ID, images: [], files: [] }), true);
    await run;

    const steers = byMethod(await fake.requests(), 'turn/steer');
    assert.deepEqual(steers.map((request) => request.params), [{
      threadId: 'thread-s1',
      input: [{ type: 'text', text: 'also check the logs', text_elements: [] }],
      expectedTurnId: 'turn-1',
      clientUserMessageId: STEER_ID,
    }]);
    // Only the steered message is echoed (under its own id), not the turn's
    // own prompt, and it comes before the reply that read it.
    const users = userRows(sent);
    assert.equal(users.length, 1);
    assert.equal(users[0].id, STEER_ID);
    assert.equal(users[0].content, 'also check the logs');
    assert.equal(users[0].transcriptAnchorId, undefined, 'read mid-turn: no edit anchor');
    const order = sent.map((message) => message.id === STEER_ID ? 'steer' : message.kind);
    assert.deepEqual(order, ['steer', 'text', 'complete']);
    assert.equal(sent.at(-1)?.exitCode, 0);
    assert.equal(byMethod(await fake.requests(), 'turn/start').length, 1, 'no new turn');
  });
});

test('a steer is refused once the turn is over, so the client sends it as the next turn', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await withFake({ turns: [['detach', ['sleep', 150], 'complete'], ['complete']] }, async (fake) => {
    const context = makeContext({ providerSessionId: 'thread-s2' });
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('task', { sessionId: 'app-s2', cwd: process.cwd() }, writer, context);
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');
    await waitFor(() => codexAppServerRuntime.isRunning('app-s2'), 'the run');

    // CloudCLI still runs the turn, but Codex has just finished it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await codexRuntime.steer('app-s2', 'one more thing', { messageId: STEER_ID }), false);
    await run;
    assert.equal(userRows(sent).length, 0);
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);

    // After the run: refused without asking Codex.
    assert.equal(await codexRuntime.steer('app-s2', 'one more thing', { messageId: STEER_ID }), false);
    assert.equal(byMethod(await fake.requests(), 'turn/steer').length, 1);

    // The client's fallback, a normal send, starts the next turn with it.
    await codexRuntime.run('one more thing', { sessionId: 'app-s2', cwd: process.cwd() }, makeWriter().writer, context);
    const turns = byMethod(await fake.requests(), 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[1].params?.input?.[0]?.text, 'one more thing');
  });
});

test('Send now stops the current step and starts a new turn with the message, in the same run', async () => {
  await withFake({ turns: [['wait'], [agentMessage('m2', 'Switching to that'), 'complete']], interruptDelayMs: 100 }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('long task', { sessionId: 'app-s3', cwd: process.cwd(), model: 'gpt-test', effort: 'high' }, writer, makeContext({ providerSessionId: 'thread-s3' }));
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');
    await waitFor(() => codexAppServerRuntime.isRunning('app-s3'), 'the run');

    assert.equal(await codexRuntime.steer('app-s3', 'stop, do this instead', { messageId: NOW_ID, urgent: true }), true);
    await run;

    const requests = await fake.requests();
    const interrupt = byMethod(requests, 'turn/interrupt');
    assert.deepEqual(interrupt.map((request) => request.params), [{ threadId: 'thread-s3', turnId: 'turn-1' }]);
    const turns = byMethod(requests, 'turn/start');
    assert.equal(turns.length, 2);
    assert.ok(turns[1].at - interrupt[0].at >= 80, 'the new turn waited for the stopped one to end (it would join it otherwise)');
    assert.equal(turns[1].params?.clientUserMessageId, NOW_ID);
    assert.deepEqual(turns[1].params?.input, [{ type: 'text', text: 'stop, do this instead', text_elements: [] }]);
    // Same settings as the turn it replaces.
    assert.equal(turns[1].params?.model, 'gpt-test');
    assert.equal(turns[1].params?.effort, 'high');
    assert.equal(byMethod(requests, 'turn/steer').length, 0);

    // One run: the message where Codex read it, the reply, one completion.
    const order = sent.map((message) => message.id === NOW_ID ? 'now' : message.kind);
    assert.deepEqual(order, ['now', 'text', 'complete']);
    assert.equal(sent.at(-1)?.exitCode, 0);
    assert.equal(codexAppServerRuntime.isRunning('app-s3'), false);
  });
});

test('a message steered while Send now is stopping the step goes into the new turn', async () => {
  await withFake({ resumeOnSteer: true, turns: [['wait'], ['wait', 'deliver', agentMessage('m2', 'Both noted'), 'complete']], interruptDelayMs: 100 }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('long task', { sessionId: 'app-s5', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-s5' }));
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');
    await waitFor(() => codexAppServerRuntime.isRunning('app-s5'), 'the run');

    assert.equal(await codexRuntime.steer('app-s5', 'do this instead', { messageId: NOW_ID, urgent: true }), true);
    assert.equal(await codexRuntime.steer('app-s5', 'and this', { messageId: STEER_ID }), true);
    await run;

    const requests = await fake.requests();
    assert.equal(byMethod(requests, 'turn/start').length, 2);
    const steers = byMethod(requests, 'turn/steer');
    assert.deepEqual(steers.map((request) => [request.params?.expectedTurnId, request.params?.clientUserMessageId]), [['turn-2', STEER_ID]]);
    assert.deepEqual(userRows(sent).map((message) => message.id), [NOW_ID, STEER_ID]);
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('Stop right after Send now ends the run without starting the new turn', async () => {
  await withFake({ turns: [['wait'], ['complete']], interruptDelayMs: 150 }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('long task', { sessionId: 'app-s4', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-s4' }));
    await waitFor(async () => byMethod(await fake.requests(), 'turn/start').length === 1, 'turn/start');
    await waitFor(() => codexAppServerRuntime.isRunning('app-s4'), 'the run');

    assert.equal(await codexRuntime.steer('app-s4', 'now', { messageId: NOW_ID, urgent: true }), true);
    assert.equal(await codexRuntime.abort('app-s4'), true);
    await run;

    assert.equal(byMethod(await fake.requests(), 'turn/start').length, 1);
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'chat.abort sends the completion');
    assert.equal(userRows(sent).length, 0, 'never read: the composer gets it back');
  });
});

test('under exec a steer is refused without starting the app-server', async () => {
  await withFake({}, async (fake) => {
    assert.equal(await codexRuntime.steer('app-exec', 'hi', { messageId: STEER_ID }), false);
    assert.deepEqual(await fake.pids(), []);
  }, null);
});

// ---------------------------------------------------------------------------
// Stage 3: approvals, questions and automatic review

const prompts = (sent: Sent[]) => sent.filter((message) => message.kind === 'permission_request');
const answersTo = async (fake: Fake) => (await fake.requests()).filter((line) => !line.method && line.id !== undefined && line.id >= 900);

async function nthPrompt(sent: Sent[], n: number): Promise<Sent> {
  await waitFor(() => prompts(sent).length >= n, `prompt ${n}`);
  return prompts(sent)[n - 1];
}

const commandApproval = (itemId: string) => ['request', 'item/commandExecution/requestApproval', {
  itemId,
  kind: 'command',
  startedAtMs: 0,
  environmentId: null,
  command: 'rm -rf build',
  cwd: '/p',
  reason: 'needs to write outside the sandbox',
  availableDecisions: ['accept', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } }, 'decline', 'cancel'],
}] as Step;

test('a command approval reaches the chat, and each answer goes back as the matching decision', async () => {
  await withFake({ turns: [[commandApproval('c1'), commandApproval('c2'), commandApproval('c3'), 'complete']] }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('clean up', { sessionId: 'app-a1', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a1' }));

    const first = await nthPrompt(sent, 1);
    assert.equal(first.toolName, 'CodexCommandApproval');
    assert.deepEqual(first.input, {
      command: 'rm -rf build',
      cwd: '/p',
      reason: 'needs to write outside the sandbox',
      kind: 'command',
      network: null,
      additionalPermissions: null,
    });
    // Policy amendments and "cancel" are not offered from the chat.
    assert.deepEqual(first.context.choices, ['accept', 'acceptForSession', 'decline']);
    codexRuntime.permissions.resolve(first.requestId, { allow: true });

    const second = await nthPrompt(sent, 2);
    codexRuntime.permissions.resolve(second.requestId, { allow: true, rememberEntry: 'session' });
    const third = await nthPrompt(sent, 3);
    codexRuntime.permissions.resolve(third.requestId, { allow: false, message: 'no' });
    await run;

    assert.deepEqual((await answersTo(fake)).map((line) => line.result), [
      { decision: 'accept' },
      { decision: 'acceptForSession' },
      { decision: 'decline' },
    ]);
    const resolved = sent.filter((message) => message.kind === 'permission_resolved').map((message) => message.requestId);
    assert.deepEqual(resolved, [first.requestId, second.requestId, third.requestId]);
    assert.equal(sent.at(-1)?.kind, 'complete');
    assert.equal(sent.at(-1)?.pendingPermissions, undefined, 'nothing left open');
  });
});

test('file change, permissions and question requests show what they ask and map the answers', async () => {
  await withFake({
    turns: [[
      ['notify', 'item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/tmp/out.txt', kind: { type: 'add' }, diff: '+hello' }] } }],
      ['request', 'item/fileChange/requestApproval', { itemId: 'f1', startedAtMs: 0, reason: 'outside the workspace', grantRoot: null }],
      ['request', 'item/permissions/requestApproval', {
        itemId: 'p1', environmentId: null, startedAtMs: 0, cwd: '/p', reason: 'download the dataset',
        permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/data'] } },
      }],
      ['request', 'item/tool/requestUserInput', {
        itemId: 'q1', isBlocking: true, autoResolutionMs: null,
        questions: [
          { id: 'color', header: 'Color', question: 'Which color?', isOther: false, isSecret: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
          { id: 'name', header: 'Name', question: 'What name?', isOther: false, isSecret: false, options: null },
        ],
      }],
      'complete',
    ]],
  }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('write it', { sessionId: 'app-a2', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a2' }));

    const file = await nthPrompt(sent, 1);
    assert.equal(file.toolName, 'CodexFileChangeApproval');
    assert.deepEqual(file.input, { reason: 'outside the workspace', grantRoot: null, changes: [{ path: '/tmp/out.txt', kind: 'add', diff: '+hello' }] });
    codexRuntime.permissions.resolve(file.requestId, { allow: true });

    const permissions = await nthPrompt(sent, 2);
    assert.equal(permissions.toolName, 'CodexPermissionsApproval');
    assert.deepEqual(permissions.input, { reason: 'download the dataset', cwd: '/p', network: true, read: [], write: ['/data'] });
    codexRuntime.permissions.resolve(permissions.requestId, { allow: true, rememberEntry: 'session' });

    const question = await nthPrompt(sent, 3);
    assert.equal(question.toolName, 'AskUserQuestion');
    assert.equal(question.context.answerFormat, 'label-lists');
    assert.deepEqual(question.input.questions, [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiSelect: false, custom: false },
      { question: 'What name?', header: 'Name', options: [], multiSelect: false },
    ]);
    codexRuntime.permissions.resolve(question.requestId, { allow: true, updatedInput: { answers: [['Blue'], ['Ada']] } });
    await run;

    assert.deepEqual((await answersTo(fake)).map((line) => line.result), [
      { decision: 'accept' },
      { permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/data'] } }, scope: 'session' },
      { answers: { color: { answers: ['Blue'] }, name: { answers: ['Ada'] } } },
    ]);
  });
});

test('an unanswered approval is declined when the approval timeout runs out; a question gets no answers', async () => {
  await withFake({
    turns: [[
      commandApproval('c1'),
      ['request', 'item/tool/requestUserInput', { itemId: 'q1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'x', header: 'X', question: 'X?', isOther: true, isSecret: false, options: null }] }],
      ['request', 'item/permissions/requestApproval', { itemId: 'p1', environmentId: null, startedAtMs: 0, cwd: '/p', reason: null, permissions: { network: { enabled: true }, fileSystem: null } }],
      'complete',
    ]],
  }, async (fake) => {
    codexAppServerRuntime.settings.approvalTimeoutMs = 60;
    codexAppServerRuntime.settings.questionTimeoutMs = 60;
    const { sent, writer } = makeWriter();
    await codexRuntime.run('go', { sessionId: 'app-a3', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a3' }));

    assert.deepEqual((await answersTo(fake)).map((line) => line.result), [
      { decision: 'decline' },
      { answers: {} },
      { permissions: {}, scope: 'turn' },
    ]);
    const cancelled = sent.filter((message) => message.kind === 'permission_cancelled');
    assert.deepEqual(cancelled.map((message) => message.reason), ['timeout', 'timeout', 'timeout']);
    assert.deepEqual(codexRuntime.permissions.listPending('app-a3'), []);
  });
});

test('the approval timeout defaults to CLAUDE_TOOL_APPROVAL_TIMEOUT_MS', async () => {
  await withFake({ turns: [[commandApproval('c1'), 'complete']] }, async (fake) => {
    const original = process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS;
    process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS = '80';
    try {
      const { sent, writer } = makeWriter();
      const started = Date.now();
      await codexRuntime.run('go', { sessionId: 'app-a3b', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a3b' }));
      assert.ok(Date.now() - started < 5_000);
      assert.deepEqual((await answersTo(fake)).map((line) => line.result), [{ decision: 'decline' }]);
      assert.equal(sent.find((message) => message.kind === 'permission_cancelled')?.reason, 'timeout');
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS;
      } else {
        process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS = original;
      }
    }
  });
});

test('Stop withdraws a waiting approval (declined) and ends the turn', async () => {
  await withFake({ turns: [[commandApproval('c1'), 'wait']] }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('go', { sessionId: 'app-a4', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a4' }));
    const prompt = await nthPrompt(sent, 1);
    assert.equal(codexRuntime.permissions.listPending('app-a4').length, 1);

    assert.equal(await codexRuntime.abort('app-a4'), true);
    await run;

    assert.deepEqual(sent.filter((message) => message.kind === 'permission_cancelled').map((message) => [message.requestId, message.reason]), [[prompt.requestId, 'cancelled']]);
    assert.deepEqual((await answersTo(fake)).map((line) => line.result), [{ decision: 'decline' }]);
    assert.equal(byMethod(await fake.requests(), 'turn/interrupt').length, 1);
    assert.deepEqual(codexRuntime.permissions.listPending('app-a4'), []);
    // A late answer from another tab changes nothing.
    codexRuntime.permissions.resolve(prompt.requestId, { allow: true });
    assert.equal((await answersTo(fake)).length, 1);
  });
});

test('a waiting approval is listed for a reconnecting client and can be answered from it', async () => {
  const { providerRuntimeService } = await import('@/modules/providers/services/provider-runtime.service.js');
  await withFake({ turns: [[commandApproval('c1'), 'complete']] }, async (fake) => {
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('go', { sessionId: 'app-a5', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a5' }));
    const prompt = await nthPrompt(sent, 1);

    // What `chat.subscribe` puts in its ack as `pendingPermissions` after a reload.
    const pending = providerRuntimeService.getPendingApprovalsForSession('app-a5') as Sent[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, prompt.requestId);
    assert.equal(pending[0].toolName, 'CodexCommandApproval');
    assert.equal(pending[0].input.command, 'rm -rf build');
    assert.equal(pending[0].sessionId, 'app-a5');
    assert.ok(pending[0].receivedAt instanceof Date);
    assert.deepEqual(providerRuntimeService.getPendingApprovalsForSession('another-session'), []);

    // The reloaded page answers through `chat.permission-response`.
    providerRuntimeService.resolveToolApproval(prompt.requestId, { allow: true });
    await run;
    assert.deepEqual((await answersTo(fake)).map((line) => line.result), [{ decision: 'accept' }]);
    assert.deepEqual(providerRuntimeService.getPendingApprovalsForSession('app-a5'), []);
  });
});

test('a request Codex resolves itself leaves the chat without an answer', async () => {
  await withFake({ turns: [[['requestThenResolve', 'item/commandExecution/requestApproval', { itemId: 'c1', command: 'ls', startedAtMs: 0, kind: 'command', environmentId: null }], 'complete']] }, async (fake) => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('go', { sessionId: 'app-a6', cwd: process.cwd() }, writer, makeContext({ providerSessionId: 'thread-a6' }));

    const [prompt] = prompts(sent);
    assert.ok(prompt);
    assert.deepEqual(sent.filter((message) => message.kind === 'permission_cancelled').map((message) => [message.requestId, message.reason]), [[prompt.requestId, 'resolved']]);
    assert.deepEqual(await answersTo(fake), [], 'no reply to a request Codex already settled');
  });
});

const review = (reviewId: string, status: string, action: Record<string, unknown>, rationale: string) => ['notify', 'item/autoApprovalReview/completed', {
  reviewId,
  targetItemId: `${reviewId}-item`,
  startedAtMs: 1,
  completedAtMs: 2,
  decisionSource: 'agent',
  review: { status, riskLevel: 'high', userAuthorization: 'low', rationale },
  action,
}] as Step;

test('automatic review decisions show in the transcript; a denial offers Allow anyway', async () => {
  await withFake({
    turns: [[
      review('rev-1', 'denied', { type: 'command', source: 'unifiedExec', command: 'rm -rf /tmp/x', cwd: '/p' }, 'Deletes files outside the workspace'),
      review('rev-2', 'approved', { type: 'applyPatch', cwd: '/p', files: ['/p/a.ts'] }, 'Edits inside the workspace'),
      'complete',
    ]],
  }, async (fake) => {
    const { sent, writer } = makeWriter();
    await codexRuntime.run('go', { sessionId: 'app-g1', cwd: process.cwd(), permissionMode: 'approveForMe' }, writer, makeContext({ providerSessionId: 'thread-g1' }));

    const rows = sent.filter((message) => message.toolName === 'CodexAutoReview');
    assert.deepEqual(rows.map((message) => [message.toolId, message.toolInput.status, message.toolInput.action]), [
      ['autoreview_rev-1', 'denied', 'rm -rf /tmp/x'],
      ['autoreview_rev-2', 'approved', '/p/a.ts'],
    ]);
    const results = sent.filter((message) => message.kind === 'tool_result' && String(message.toolId).startsWith('autoreview_'));
    assert.deepEqual(results.map((message) => [message.content, message.isError]), [
      ['Deletes files outside the workspace', true],
      ['Edits inside the workspace', false],
    ]);

    // Only the denial asks; it outlives the turn, and the completion lists it
    // so the chat keeps showing it.
    const [denial] = prompts(sent);
    assert.equal(prompts(sent).length, 1);
    assert.equal(denial.toolName, 'CodexAutoReviewDenial');
    assert.equal(denial.input.rationale, 'Deletes files outside the workspace');
    const complete = sent.at(-1)!;
    assert.equal(complete.kind, 'complete');
    assert.deepEqual(complete.pendingPermissions.map((entry: Sent) => entry.requestId), [denial.requestId]);
    assert.equal(codexRuntime.permissions.listPending('app-g1').length, 1);

    codexRuntime.permissions.resolve(denial.requestId, { allow: true });
    await waitFor(async () => byMethod(await fake.requests(), 'thread/approveGuardianDeniedAction').length === 1, 'thread/approveGuardianDeniedAction');
    assert.deepEqual(byMethod(await fake.requests(), 'thread/approveGuardianDeniedAction')[0].params, {
      threadId: 'thread-g1',
      // Codex's core event: snake case, as checked against 0.169.
      event: {
        id: 'rev-1',
        turn_id: 'turn-1',
        target_item_id: 'rev-1-item',
        status: 'denied',
        risk_level: 'high',
        user_authorization: 'low',
        rationale: 'Deletes files outside the workspace',
        decision_source: 'agent',
        started_at_ms: 1,
        completed_at_ms: 2,
        action: { type: 'command', source: 'unified_exec', command: 'rm -rf /tmp/x', cwd: '/p' },
      },
    });
    assert.deepEqual(codexRuntime.permissions.listPending('app-g1'), []);
  });
});

test('Allow anyway after the thread was released loads it again first; Keep denied sends nothing', async () => {
  await withFake({
    turns: [[
      review('rev-1', 'denied', { type: 'networkAccess', target: 'https://example.com', host: 'example.com', protocol: 'socks5Tcp', port: 443 }, 'Network is off'),
      review('rev-2', 'denied', { type: 'command', source: 'shell', command: 'curl example.com', cwd: '/p' }, 'Network is off'),
      'complete',
    ]],
  }, async (fake) => {
    codexAppServerRuntime.settings.idleReleaseMs = 30;
    const { sent, writer } = makeWriter();
    await codexRuntime.run('fetch', { sessionId: 'app-g2', cwd: '/p', permissionMode: 'approveForMe' }, writer, makeContext({ providerSessionId: 'thread-g2' }));
    await waitFor(() => !codexAppServerRuntime.isAppServerRunning(), 'the idle child to stop');

    const [network, command] = prompts(sent);
    codexRuntime.permissions.resolve(command.requestId, { allow: false });
    codexRuntime.permissions.resolve(network.requestId, { allow: true });
    await waitFor(async () => byMethod(await fake.requests(), 'thread/approveGuardianDeniedAction').length === 1, 'the approval');

    const requests = await fake.requests();
    const resumes = byMethod(requests, 'thread/resume');
    assert.equal(resumes.length, 2, 'loaded again in a new child');
    assert.deepEqual(resumes[1].params, resumes[0].params, 'with the settings it was loaded with');
    const approval = byMethod(requests, 'thread/approveGuardianDeniedAction');
    assert.equal(approval.length, 1, 'Keep denied sends nothing');
    assert.ok(approval[0].at >= resumes[1].at);
    assert.deepEqual(approval[0].params?.event?.action, { type: 'network_access', target: 'https://example.com', host: 'example.com', protocol: 'socks5_tcp', port: 443 });
    assert.equal((await fake.pids()).length, 2);
    // Released again once done.
    await waitFor(() => !codexAppServerRuntime.isAppServerRunning(), 'the child to stop again');
    assert.deepEqual(codexRuntime.permissions.listPending('app-g2'), []);
  });
});

test('Stop also withdraws the review denials of its turn; archiving withdraws one left from a finished turn', async () => {
  await withFake({
    turns: [
      [review('rev-1', 'denied', { type: 'command', source: 'shell', command: 'a', cwd: '/p' }, 'no'), 'wait'],
      [review('rev-2', 'denied', { type: 'command', source: 'shell', command: 'b', cwd: '/p' }, 'no'), 'complete'],
    ],
  }, async () => {
    const context = makeContext({ providerSessionId: 'thread-g3' });
    const { sent, writer } = makeWriter();
    const run = codexRuntime.run('go', { sessionId: 'app-g3', cwd: process.cwd() }, writer, context);
    await nthPrompt(sent, 1);
    await codexRuntime.abort('app-g3');
    await run;
    assert.deepEqual(codexRuntime.permissions.listPending('app-g3'), []);

    await codexRuntime.run('again', { sessionId: 'app-g3', cwd: process.cwd() }, makeWriter().writer, context);
    assert.equal(codexRuntime.permissions.listPending('app-g3').length, 1);
    codexRuntime.releaseSession('app-g3');
    assert.deepEqual(codexRuntime.permissions.listPending('app-g3'), []);
  });
});

test('under exec nothing is ever listed as waiting', async () => {
  await withFake({}, async (fake) => {
    assert.deepEqual(codexRuntime.permissions.listPending('app-exec'), []);
    codexRuntime.permissions.resolve('codex-unknown', { allow: true });
    assert.deepEqual(await fake.pids(), []);
  }, null);
});
