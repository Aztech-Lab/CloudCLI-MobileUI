import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import {
  CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE,
  CODEX_THREAD_ACTIVE_WRITER_MESSAGE,
  codexRuntime,
  isCodexThreadActiveWriterError,
  mapPermissionModeToCodexOptions,
} from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'approveForMe', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedConfig: unknown;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      // The SDK keeps `CodexOptions.config` on its exec wrapper, which turns
      // it into `--config key=value` arguments.
      const configOf = (codex: Codex) => (codex as unknown as { exec: { configOverrides?: unknown } }).exec.configOverrides;
      const start = t.mock.method(Codex.prototype, 'startThread', function (this: Codex, options?: ThreadOptions) {
        capturedOptions = options;
        capturedConfig = configOf(this);
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', function (this: Codex, id: string, options?: ThreadOptions) {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        capturedConfig = configOf(this);
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      // Only "Approve for me" routes approvals to Codex's automatic reviewer;
      // every other mode spawns the CLI without config overrides, as before.
      assert.deepEqual(capturedConfig, permissionMode === 'approveForMe' ? { approvals_reviewer: 'auto_review' } : undefined);
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async (t) => {
    let capturedPrompt: unknown;
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    const thread = {
      id: 'native-thread',
      async runStreamed(prompt: unknown) {
        capturedPrompt = prompt;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;

    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };

    await codexRuntime.run(command, {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: () => {} }, context);

    assert.deepEqual(capturedPrompt, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: imagePath },
    ]);
  });
}

test('"Approve for me" maps to what `codex exec --approve-for-me` sets', () => {
  // Verified against Codex CLI 0.169.0: a session started with
  // `--approve-for-me` records approval_policy "on-request" and
  // approvals_reviewer "auto_review" in its rollout.
  assert.deepEqual(mapPermissionModeToCodexOptions('approveForMe'), {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    config: { approvals_reviewer: 'auto_review' },
  });
  // An id the runtime does not know still falls back to the default mode.
  assert.deepEqual(mapPermissionModeToCodexOptions('approve-for-me'), mapPermissionModeToCodexOptions('default'));
  assert.equal(mapPermissionModeToCodexOptions('default').config, undefined);
});

// What Codex CLI 0.169.0 printed when a thread was already open in another
// app-server, wrapped the way the SDK reports a failed exec.
const ACTIVE_WRITER_STDERR = 'Codex Exec exited with code 1: '
  + 'ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: '
  + 'thread 01a1e3c3-a012-72b1-b40a-e6022a26d8d5 already has an active writer\n'
  + 'Error: thread/resume: thread/resume failed: thread 01a1e3c3-a012-72b1-b40a-e6022a26d8d5 '
  + 'already has an active writer (code -32600)';

test('the active-writer conflict is recognized in both of its spellings', () => {
  assert.equal(isCodexThreadActiveWriterError(ACTIVE_WRITER_STDERR), true);
  assert.equal(isCodexThreadActiveWriterError('thread-store conflict: thread abc already has an active writer'), true);
  assert.equal(isCodexThreadActiveWriterError('Codex Exec exited with code 1: unauthorized'), false);
  assert.equal(isCodexThreadActiveWriterError(undefined), false);
});

type SentMessage = { kind?: string; content?: string; errorCode?: string; exitCode?: number };

const failingContext = (): ProviderRuntimeContext => ({
  resolveProviderSessionId: () => 'native-thread',
  resolveResumeModel: async () => 'test-model',
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
  normalizeMessage: (event) => [
    { kind: 'error', content: String((event as { message?: unknown }).message ?? ''), provider: 'codex' } as never,
  ],
  isProviderInstalled: async () => true,
});

const runResumed = async (thread: Thread) => {
  const messages: SentMessage[] = [];
  await codexRuntime.run('hey there', { sessionId: 'app-session', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message as SentMessage) }, failingContext());
  return messages;
};

test('a thread open in the Codex app gets one clear error row, not the raw exec failure', async (t) => {
  let runs = 0;
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      runs += 1;
      throw new Error(ACTIVE_WRITER_STDERR);
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'resumeThread', () => thread);
  t.mock.method(console, 'error', () => {});

  const messages = await runResumed(thread);

  const errors = messages.filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE);
  assert.equal(errors[0].content, CODEX_THREAD_ACTIVE_WRITER_MESSAGE);
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
  // Not retried: the user decides where the conversation continues.
  assert.equal(runs, 1);
});

test('the same conflict reported as a stream error event is rewritten too', async (t) => {
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'error', message: 'thread/resume failed: thread native-thread already has an active writer (code -32600)' };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'resumeThread', () => thread);

  const errors = (await runResumed(thread)).filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE);
});

test('other Codex failures keep their own message', async (t) => {
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      throw new Error('Codex Exec exited with code 1: unauthorized');
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'resumeThread', () => thread);
  t.mock.method(console, 'error', () => {});

  const errors = (await runResumed(thread)).filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, undefined);
  assert.equal(errors[0].content, 'Codex Exec exited with code 1: unauthorized');
});
