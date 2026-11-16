import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  backgroundClaudeSDKTask,
  cancelSteerClaudeSDKSession,
  queryClaudeSDK,
  steerClaudeSDKSession,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Steering writes a user message into a running turn's stdin with priority
 * `next`. The CLI reads it at the next tool-call boundary and echoes it (with
 * `--replay-user-messages`) at that moment; a turn that ends first reads it in
 * a follow-up turn on the same process. These drive `queryClaudeSDK` with a
 * scripted SDK stream — the seam is `context.createQuery` — and record what
 * the runtime writes to the CLI's stdin and to the client.
 */

const SESSION_ID = 'app-steer-session';
const NATIVE_ID = 'native-steer-session';
const STEER_ID = '0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  /** Every message the runtime wrote to the CLI's stdin, in order. */
  stdin: AnyRecord[];
  /** The options the runtime started the query with. */
  options: () => AnyRecord | null;
  /** [local] Control requests the runtime made, in order, interleaved with stdin writes. */
  calls: string[];
};

/** [local] How the scripted CLI answers the control requests a steer may send. */
type Controls = {
  backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
};

function createScriptedQuery(controls: Controls = {}): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let startedWith: AnyRecord | null = null;
  const stdin: AnyRecord[] = [];
  const calls: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stdin,
    options: () => startedWith,
    calls,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    startedWith = options;
    void (async () => {
      for await (const message of prompt) {
        stdin.push(message as AnyRecord);
        calls.push(`stdin:${String((message as AnyRecord).priority ?? '')}`);
      }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async () => {},
      ...(controls.backgroundTasks && {
        backgroundTasks: (toolUseId?: string) => {
          calls.push(`backgroundTasks:${toolUseId ?? ''}`);
          return controls.backgroundTasks!(toolUseId);
        },
      }),
      ...(controls.cancelAsyncMessage && {
        cancelAsyncMessage: (uuid: string) => {
          calls.push(`cancelAsyncMessage:${uuid}`);
          return controls.cancelAsyncMessage!(uuid);
        },
      }),
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[] }) => Promise<void>,
  controls: Controls = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-steer-'));
  const { createQuery, script } = createScriptedQuery(controls);
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('run four commands', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await waitFor(() => script.stdin.length > 0);
    await runTest({ script, sent });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name = 'Bash', parent: string | null = null) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'sleep 4' } }] },
});
const toolResult = (id: string) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
});
/** The CLI's echo of a stdin message, written when it reads it. */
const echo = (uuid: string, content: unknown) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null, isReplay: true, uuid,
  message: { role: 'user', content },
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });

const userTexts = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'text' && message.role === 'user');

test('the run asks the CLI to echo what it reads from stdin', async () => {
  await withRun(async ({ script }) => {
    assert.deepEqual(script.options()?.extraArgs, { 'replay-user-messages': null });
    script.emit(init());
    script.emit(result());
  });
});

test('a steered message is written into the running turn and shown when Claude reads it', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1'));
    script.emit(toolResult('toolu_1'));
    await settle();

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'skip the rest', { messageId: STEER_ID }), true);
    await waitFor(() => script.stdin.length === 2);
    const written = script.stdin[1];
    assert.equal(written.priority, 'next', 'read at the next tool-call boundary, not after the turn');
    assert.equal(written.uuid, STEER_ID);
    assert.deepEqual(written.message, { role: 'user', content: 'skip the rest' });
    assert.equal(userTexts(sent).length, 0, 'nothing is shown before Claude reads it');

    // The CLI reads it after the next tool call and echoes it.
    script.emit(toolUse('toolu_2'));
    script.emit(toolResult('toolu_2'));
    script.emit(echo(STEER_ID, 'skip the rest'));
    await settle();

    const shown = userTexts(sent);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, STEER_ID, 'carries the id the transcript stores it under');
    assert.equal(shown[0].content, 'skip the rest');
    assert.equal(shown[0].transcriptAnchorId, undefined, 'a mid-turn message is no edit anchor');

    script.emit(result());
    await settle();
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.equal(script.released(), true);
  });
});

test('the echo of the turn\'s own prompt is not shown a second time', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(echo('9a9a9a9a-0000-4000-8000-000000000000', 'run four commands'));
    script.emit(result());
    await settle();

    assert.equal(userTexts(sent).length, 0);
  });
});

test('a turn that ends before reading a steered message stays open for the follow-up turn', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'one more thing', { messageId: STEER_ID }), true);

    // No tool call came after it: the turn ends with the message unread.
    script.emit(result());
    await settle();
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'the run is not over for the client');
    assert.equal(script.released(), false, 'stdin stays open for the follow-up turn');

    // The CLI runs it as a turn of its own on the same process.
    script.emit(init());
    script.emit(echo(STEER_ID, 'one more thing'));
    script.emit(result());
    await settle();

    assert.equal(userTexts(sent).length, 1);
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(script.released(), true);
  });
});

test('a steer is refused once the turn has been reported complete', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'too late', { messageId: STEER_ID }), false);
    assert.equal(script.stdin.length, 1, 'nothing more is written to the CLI');
  });
});

test('a steer is refused for a session with no live run', async () => {
  assert.equal(await steerClaudeSDKSession('no-such-session', 'hello', { messageId: STEER_ID }), false);
});

test('history shows a message read mid-turn as the user\'s, under the id it was sent with', () => {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const row = {
    type: 'attachment',
    uuid: 'c139107b-b147-4d5f-a964-c9fee073c353',
    parentUuid: '4654fce4-daf3-4451-9658-443c3ae9411b',
    timestamp: '2026-11-07T11:41:08.552Z',
    attachment: { type: 'queued_command', prompt: 'skip the rest', source_uuid: STEER_ID, commandMode: 'prompt' },
  };

  const messages = sessions.normalizeMessage(row, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'skip the rest');
  assert.equal(messages[0].id, STEER_ID, 'matches the live echo, so the two reconcile');
  assert.equal(messages[0].transcriptAnchorId, undefined);
});

test('history leaves the CLI\'s own queued notes out', () => {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const row = {
    type: 'attachment',
    uuid: 'd139107b-b147-4d5f-a964-c9fee073c353',
    timestamp: '2026-11-07T11:41:08.552Z',
    attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification' },
  };

  assert.deepEqual(sessions.normalizeMessage(row, SESSION_ID), []);
});

// [local] "Send now", withdrawing a steered message, and "Move to background".

test('send now with no running shell or agent call goes as `now`, so the CLI reads it at once', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1', 'Read'));
    await settle();

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'stop and look here', { messageId: STEER_ID, urgent: true }), true);
    await waitFor(() => script.stdin.length === 2);
    assert.equal(script.stdin[1].priority, 'now');
    assert.equal(script.stdin[1].uuid, STEER_ID);
    assert.deepEqual(script.calls.filter((call) => call.startsWith('backgroundTasks')), [], 'nothing to move aside');

    script.emit(echo(STEER_ID, 'stop and look here'));
    script.emit(result());
  }, { backgroundTasks: async () => true });
});

test('send now during a foreground command moves it to the background and is read in the same turn', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1', 'Bash'));
    await settle();

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'meanwhile, check the logs', { messageId: STEER_ID, urgent: true }), true);
    await waitFor(() => script.stdin.length === 2);
    assert.equal(script.stdin[1].priority, 'next', 'read at the boundary the backgrounded call creates');
    assert.deepEqual(script.calls.slice(1), ['stdin:next', 'backgroundTasks:'], 'queued before the call returns');

    script.emit(echo(STEER_ID, 'meanwhile, check the logs'));
    script.emit(result());
  }, { backgroundTasks: async () => true });
});

test('send now does not count a subagent\'s own calls as the main thread\'s running work', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent'));
    script.emit(toolUse('toolu_inner', 'Bash', 'toolu_agent'));
    script.emit(toolResult('toolu_agent'));
    await settle();

    // The agent call has returned; only its subagent's Bash is still listed, which is not the main thread's.
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'one', { messageId: STEER_ID, urgent: true }), true);
    await waitFor(() => script.stdin.length === 2);
    assert.equal(script.stdin[1].priority, 'now');
    script.emit(echo(STEER_ID, 'one'));
    script.emit(result());
  }, { backgroundTasks: async () => true });
});

test('send now falls back to `now` when the CLI cannot move the command to the background', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1', 'Bash'));
    await settle();

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'urgent', { messageId: STEER_ID, urgent: true }), true);
    await waitFor(() => script.stdin.length === 3);
    assert.deepEqual(script.calls.slice(1), ['stdin:next', 'backgroundTasks:', `cancelAsyncMessage:${STEER_ID}`, 'stdin:now']);
    assert.equal(script.stdin[2].uuid, STEER_ID, 'sent again under the same id');

    script.emit(echo(STEER_ID, 'urgent'));
    script.emit(result());
  }, {
    backgroundTasks: async () => { throw new Error('background tasks are disabled'); },
    cancelAsyncMessage: async () => true,
  });
});

test('a plain steer never asks the CLI to move anything to the background', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1', 'Bash'));
    await settle();

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'later is fine', { messageId: STEER_ID }), true);
    await waitFor(() => script.stdin.length === 2);
    assert.equal(script.stdin[1].priority, 'next');
    assert.deepEqual(script.calls.filter((call) => call.startsWith('backgroundTasks')), []);
    script.emit(echo(STEER_ID, 'later is fine'));
    script.emit(result());
  }, { backgroundTasks: async () => true });
});

test('an unread steered message can be withdrawn, and the turn then ends without waiting for it', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'never mind', { messageId: STEER_ID }), true);
    script.emit(result());
    await settle();
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'waiting for the follow-up turn');

    assert.equal(await cancelSteerClaudeSDKSession(SESSION_ID, STEER_ID), true);
    assert.ok(script.calls.includes(`cancelAsyncMessage:${STEER_ID}`));
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(userTexts(sent).length, 0);
    // Withdrawn once is withdrawn: a second try has nothing to cancel.
    assert.equal(await cancelSteerClaudeSDKSession(SESSION_ID, STEER_ID), false);
  }, { cancelAsyncMessage: async () => true });
});

test('a steered message the CLI has already taken cannot be withdrawn and is shown when read', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1'));
    await settle();
    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'too late to take back', { messageId: STEER_ID }), true);

    assert.equal(await cancelSteerClaudeSDKSession(SESSION_ID, STEER_ID), false);
    script.emit(toolResult('toolu_1'));
    script.emit(echo(STEER_ID, 'too late to take back'));
    script.emit(result());
    await settle();
    assert.equal(userTexts(sent).length, 1);
  }, { cancelAsyncMessage: async () => false });
});

test('withdrawing is refused for a message that was never steered', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    assert.equal(await cancelSteerClaudeSDKSession(SESSION_ID, STEER_ID), false);
    assert.deepEqual(script.calls.filter((call) => call.startsWith('cancelAsyncMessage')), [], 'the CLI is not asked');
    script.emit(result());
  }, { cancelAsyncMessage: async () => true });
});

test('move to background targets the one tool call it names', async () => {
  const asked: Array<string | undefined> = [];
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1', 'Bash'));
    await settle();

    assert.equal(await backgroundClaudeSDKTask(SESSION_ID, 'toolu_1'), true);
    assert.equal(await backgroundClaudeSDKTask(SESSION_ID, 'toolu_other'), false, 'no such foreground call');
    assert.deepEqual(asked, ['toolu_1', 'toolu_other']);
    script.emit(result());
  }, { backgroundTasks: async (toolUseId) => { asked.push(toolUseId); return toolUseId === 'toolu_1'; } });
  assert.equal(await backgroundClaudeSDKTask('no-such-session', 'toolu_1'), false);
});

test('move to background reports nothing moved when the CLI has no such request', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_1', 'Bash'));
    await settle();
    assert.equal(await backgroundClaudeSDKTask(SESSION_ID, 'toolu_1'), false);
    script.emit(result());
  });
});
