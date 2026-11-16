import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import type * as ChatDrafts from '@/shared/chatDrafts';
import type { BackgroundTaskSummary, ChatMessage, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * [local] Sending while a session's background work runs, for a provider whose
 * runtime can add the message to the process that work runs under
 * (`supportsBackgroundAdoption`). Such a send stops nothing, so it goes out at
 * once as `chat.send` with `adoptHeld` and its own message id, without the
 * "this stops the background work" dialog. An edit and a slash command still
 * replace the process, so they still ask. When the server cannot add the
 * message after all (`ADOPT_UNAVAILABLE`), the message comes back: out of the
 * transcript, into the composer, and the dialog asks again — this time its
 * "send" really does stop the work. Without the capability nothing changes.
 */

const { appendQueuedMessage } = vi.hoisted(() => ({ appendQueuedMessage: vi.fn() }));

vi.mock('@/shared/chatDrafts', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatDrafts>();
  return {
    ...actual,
    appendQueuedMessage: (...args: Parameters<typeof actual.appendQueuedMessage>) => {
      appendQueuedMessage(...args);
      return actual.appendQueuedMessage(...args);
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
const UPLOADED = { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TASKS: BackgroundTaskSummary[] = [
  { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
];

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: TASKS },
]]);

// What the activity map holds once the composer's own send marked the session
// processing: the entry keeps the tasks, without the background flag.
const processingOverBackground: SessionActivityMap = new Map([[
  'session-1',
  { statusText: null, canInterrupt: true, startedAt: 10, tasks: TASKS },
]]);

type Frame = { type: string; sessionId?: string; content?: string; options?: Record<string, unknown> };

type Props = {
  supportsBackgroundAdoption: boolean;
  isLoading: boolean;
  processingSessions: SessionActivityMap;
};

const render = (initialProps: Partial<Props> = {}) => {
  const sent: Frame[] = [];
  const added: ChatMessage[] = [];
  const processing: string[] = [];
  const background: Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> = [];
  const removed: Array<{ sessionId: string; messageId: string }> = [];
  const view = renderHook(
    ({ supportsBackgroundAdoption, isLoading, processingSessions }: Props) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as Frame); },
      supportsBackgroundAdoption,
      supportsSteering: true,
      onSessionProcessing: (sessionId) => { processing.push(String(sessionId)); },
      onSessionBackground: (sessionId, tasks) => { background.push({ sessionId, tasks }); },
      removeOptimisticMessage: (sessionId, messageId) => { removed.push({ sessionId, messageId }); },
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    {
      initialProps: {
        supportsBackgroundAdoption: true,
        isLoading: false,
        processingSessions: backgroundOnly,
        ...initialProps,
      },
    },
  );
  const sends = () => sent.filter((frame) => frame.type === 'chat.send');
  return { view, sent, sends, added, processing, background, removed };
};

type View = ReturnType<typeof render>['view'];

const enter = () => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  nativeEvent: { isComposing: false },
  preventDefault: () => undefined,
}) as unknown as KeyboardEvent<HTMLTextAreaElement>;

/** Types the message and presses Enter, letting the send finish. */
const typeAndEnter = async (view: View, text: string, files: File[] = []) => {
  await act(async () => {
    view.result.current.setInput(text);
    view.result.current.setAttachedFiles(files);
  });
  await act(async () => {
    view.result.current.handleKeyDown(enter());
    // handleKeyDown does not return the submit; let its upload settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const uploads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/assets/files'));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/api/assets/files')) {
      return new Response(JSON.stringify({ attachments: [UPLOADED] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/api/user/drafts/queued-message') && init?.method === 'POST') {
      const { queuedMessage } = JSON.parse(String(init.body)) as { queuedMessage: unknown };
      return new Response(JSON.stringify({ success: true, queuedMessage, appended: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  resetChatDrafts();
  appendQueuedMessage.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('with the capability, Enter over background work sends chat.send with adoptHeld and a uuid message id, and asks nothing', async () => {
  const { view, sends, added, processing } = render();
  assert.equal(view.result.current.adoptsBackground, true);

  await typeAndEnter(view, 'hello');

  assert.equal(view.result.current.backgroundSendPrompt, null, 'no dialog: the work keeps running');
  assert.equal(sends().length, 1);
  const options = sends()[0].options ?? {};
  assert.equal(options.adoptHeld, true);
  assert.match(String(options.messageId), UUID_V4);
  assert.equal(sends()[0].content, 'hello');
  assert.equal(appendQueuedMessage.mock.calls.length, 0, 'nothing is queued');
  // A normal send otherwise: the optimistic row and the processing mark.
  assert.equal(added.length, 1);
  assert.equal(added[0].optimisticId, `local_adopt_${String(options.messageId)}`, 'the row can be withdrawn by the message id');
  assert.deepEqual(processing, ['session-1']);
  assert.equal(view.result.current.input, '', 'the composer is cleared');
});

test('with the capability, the send menu\'s Send over background work also joins the running process', async () => {
  const { view, sends } = render();
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSendMenuChoice('send'); });

  assert.equal(sends().length, 1);
  assert.equal(sends()[0].options?.adoptHeld, true);
  assert.match(String(sends()[0].options?.messageId), UUID_V4);
});

test('with the capability, a send on an idle session still asks to join a process this client may not know about', async () => {
  const { view, sends } = render({ processingSessions: new Map() });
  await typeAndEnter(view, 'hello');

  assert.equal(view.result.current.backgroundSendPrompt, null);
  assert.equal(sends()[0].options?.adoptHeld, true);
});

test('without the capability, the dialog asks as before and its send carries no adoption fields', async () => {
  const { view, sends, added } = render({ supportsBackgroundAdoption: false });
  assert.equal(view.result.current.adoptsBackground, false);

  await act(async () => { view.result.current.setInput('hello'); });
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  assert.deepEqual(view.result.current.backgroundSendPrompt, { work: ['Agent Survey the repo'] });
  assert.equal(sends().length, 0);

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('send');
    await pending;
  });
  assert.equal(sends().length, 1);
  const options = sends()[0].options ?? {};
  assert.equal('adoptHeld' in options, false, 'the frame is exactly as before');
  assert.equal('messageId' in options, false);
  assert.equal(added[0].optimisticId, undefined);
});

test('an edit sent over background work still asks, and its edit-send carries no adoption', async () => {
  const { view, sent } = render();
  await act(async () => {
    view.result.current.beginEditMessage({ type: 'user', content: 'old', transcriptAnchorId: 'anchor-1', timestamp: new Date() });
  });
  await act(async () => { view.result.current.setInput('replacement'); });
  assert.equal(view.result.current.adoptsBackground, false, 'an edit rewinds the conversation, so it replaces the process');

  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('send');
    await pending;
  });
  const editSends = sent.filter((frame) => frame.type === 'chat.edit-send');
  assert.equal(editSends.length, 1);
  assert.equal('adoptHeld' in (editSends[0].options ?? {}), false);
  assert.equal('messageId' in (editSends[0].options ?? {}), false);
});

test('a slash command sent over background work still asks', async () => {
  const { view, sends } = render();
  await act(async () => { view.result.current.setInput('/not-a-known-command now'); });
  assert.equal(view.result.current.adoptsBackground, false, 'a slash command is a turn of its own');

  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  assert.equal(sends().length, 0);

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await pending;
  });
  assert.equal(sends().length, 0);
  assert.equal(view.result.current.input, '/not-a-known-command now');
});

test('ADOPT_UNAVAILABLE takes the row back, restores the composer, puts the session back to its work, and asks again', async () => {
  const { view, sends, removed, background } = render();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await typeAndEnter(view, 'hello', [file]);
  const messageId = String(sends()[0].options?.messageId);
  assert.equal(uploads().length, 1);
  assert.equal(view.result.current.attachedFiles.length, 0, 'the file left with the message');

  // The send marked the session processing; the server then refuses.
  view.rerender({ supportsBackgroundAdoption: true, isLoading: true, processingSessions: processingOverBackground });
  let handled = false;
  act(() => { handled = view.result.current.handleAdoptRefused('session-1', messageId); });
  assert.equal(handled, true);

  assert.deepEqual(removed, [{ sessionId: 'session-1', messageId: `local_adopt_${messageId}` }], 'the optimistic row is withdrawn');
  assert.deepEqual(background, [{ sessionId: 'session-1', tasks: TASKS }], 'the session goes back to its background work, not idle');
  assert.equal(view.result.current.input, 'hello', 'the text is back');
  assert.deepEqual(view.result.current.attachedFiles, [file], 'and so is the file');
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  assert.deepEqual(view.result.current.backgroundSendPrompt, { work: ['Agent Survey the repo'], adoptRefused: true });
  assert.equal(sends().length, 1, 'nothing is sent while the dialog is open');

  // Send anyway: this time it does not ask to join the process, and the
  // file uploaded the first time is not uploaded again.
  view.rerender({ supportsBackgroundAdoption: true, isLoading: false, processingSessions: backgroundOnly });
  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('send');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(sends().length, 2);
  assert.equal(sends()[1].content, 'hello');
  assert.equal(sends()[1].options?.adoptHeld, false);
  assert.equal('messageId' in (sends()[1].options ?? {}), false);
  assert.deepEqual(sends()[1].options?.attachments, [UPLOADED]);
  assert.equal(uploads().length, 1, 'not uploaded again');
  assert.equal(view.result.current.input, '');
  assert.equal(view.result.current.attachedFiles.length, 0);
});

test('ADOPT_UNAVAILABLE answered with cancel keeps the message in the composer', async () => {
  const { view, sends } = render();
  await typeAndEnter(view, 'hello');
  const messageId = String(sends()[0].options?.messageId);

  act(() => { view.result.current.handleAdoptRefused('session-1', messageId); });
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  await act(async () => { view.result.current.resolveBackgroundSendPrompt('cancel'); });

  assert.equal(sends().length, 1);
  assert.equal(view.result.current.input, 'hello');
});

test('ADOPT_UNAVAILABLE for a message this composer did not send is left to the caller', async () => {
  const { view, removed, background } = render();
  let handled = true;
  act(() => { handled = view.result.current.handleAdoptRefused('session-1', '00000000-0000-4000-8000-000000000000'); });

  assert.equal(handled, false);
  assert.deepEqual(removed, []);
  assert.deepEqual(background, []);
  assert.equal(view.result.current.backgroundSendPrompt, null);
});

test('a message queued during a turn, with the capability, is marked to join the running process', async () => {
  const { view, sends } = render({ isLoading: true, processingSessions: processingOverBackground });
  await typeAndEnter(view, 'next step');

  assert.equal(sends().length, 0, 'queued, not sent');
  assert.equal(appendQueuedMessage.mock.calls.length, 1);
  assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.options?.adoptHeld, true);
  assert.equal(readQueuedMessage('session-1')?.options?.adoptHeld, true);
  assert.equal(view.result.current.queuedDraft?.options?.adoptHeld, true);
});

test('a message queued during a turn without the capability, or a slash command, is not marked', async () => {
  const off = render({ supportsBackgroundAdoption: false, isLoading: true, processingSessions: processingOverBackground });
  await typeAndEnter(off.view, 'next step');
  assert.equal('adoptHeld' in (appendQueuedMessage.mock.calls[0]?.[1]?.options ?? {}), false);
  off.view.unmount();

  appendQueuedMessage.mockReset();
  resetChatDrafts();
  const slash = render({ isLoading: true, processingSessions: processingOverBackground });
  await typeAndEnter(slash.view, '/compact');
  assert.equal('adoptHeld' in (appendQueuedMessage.mock.calls[0]?.[1]?.options ?? {}), false);
});

test('a steer refused because its turn had ended is queued marked to join the running process', async () => {
  const { view, sent } = render({ isLoading: true, processingSessions: processingOverBackground });
  await act(async () => { view.result.current.setInput('also check the tests'); });
  await act(async () => { await view.result.current.handleSendMenuChoice('steer'); });
  const steerFrame = sent.find((frame) => frame.type === 'chat.steer') as (Frame & { messageId: string }) | undefined;
  assert.ok(steerFrame, 'the message was steered');

  await act(async () => {
    view.result.current.handleSteerOutcome('session-1', steerFrame.messageId, 'refused');
  });
  await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
  assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'also check the tests');
  assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.options?.adoptHeld, true);
});

test('Queue over background work waits for the work, so it is not marked to join the process', async () => {
  const { view, sends } = render();
  await act(async () => { view.result.current.setInput('after the work'); });
  await act(async () => { await view.result.current.handleSendMenuChoice('queue'); });

  assert.equal(sends().length, 0);
  assert.equal(appendQueuedMessage.mock.calls.length, 1);
  assert.equal('adoptHeld' in (appendQueuedMessage.mock.calls[0]?.[1]?.options ?? {}), false);
});
