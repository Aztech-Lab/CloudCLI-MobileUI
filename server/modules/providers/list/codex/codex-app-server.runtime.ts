/**
 * [local] Codex conversations over one long-lived `codex app-server`
 * (stage 1 of the Codex parity plan).
 *
 * The default Codex runtime (`codex-runtime.provider.ts`) runs every message
 * as its own `codex exec` process through the SDK, so nothing can reach a turn
 * once it runs. This runtime sends the same message as `turn/start` on a
 * thread loaded in a shared app-server child (`codex-app-server.connection.ts`)
 * and turns the app-server's notifications into the same normalized messages
 * the exec path produces: it builds the exec path's intermediate event shape
 * (`{ type: 'item', itemType: 'agent_message', … }`) and hands it to the same
 * `context.normalizeMessage`, so the transcript, tool cards, token usage,
 * errors and completion look the same.
 *
 * Selected with `CLOUDCLI_CODEX_RUNTIME=appserver` (default `exec`). When the
 * app-server cannot be used for a message before anything was shown, the
 * message runs through `codex exec` instead (CodexAppServerFallbackError).
 *
 * Stage 2: a message sent while a turn runs goes into it (`turn/steer`), and
 * "Send now" stops the current step and starts a new turn with the message
 * (`turn/interrupt`, then `turn/start`), both inside the same chat run.
 *
 * Stage 3: approval requests and Codex's questions reach the chat as
 * permission prompts (`codex-app-server.approvals.ts` maps them), and an
 * automatic review ("Approve for me") shows its decision in the transcript,
 * with "Allow anyway" for a denial (`thread/approveGuardianDeniedAction`).
 *
 * Stage 4: background terminals and subagents
 * (`codex-app-server.background.ts`). Stop ends only the turn
 * (`turn/interrupt`); background terminals keep running and are listed in the
 * chat's background strip with their own stop, subagents get live cards, and
 * a thread is not released while any of that runs. A turn Codex starts on its
 * own on a thread CloudCLI holds (a report of finished background work) is
 * followed like a turn of the user's.
 *
 * Stage 5: reconnect and reload. The chat run registry replays what a client
 * missed (this runtime writes every row through the run's writer); after a
 * turn's `complete` the live background work is announced again, so a page
 * that reloads during the background phase gets its state. Rows Codex's
 * rollout does not record (report rows, automatic review decisions, the
 * thread being open in another program) are kept in CloudCLI's database
 * (`context.recordTranscriptNote`) and come back with the history. Live cards
 * carry a `dedupeKey`, so a history card under another id replaces them.
 *
 * Threads are released after a short idle period (`thread/unsubscribe`) so the
 * Codex desktop app can take them over; when no thread is left the child
 * itself is stopped, which frees the writer lock at once (measured against
 * Codex 0.169: after `thread/unsubscribe` the app-server keeps a thread loaded
 * and locked for about 60 seconds before `thread/closed`).
 */

import { randomUUID } from 'node:crypto';

import type { ModelReasoningEffort } from '@openai/codex-sdk';

import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  createCompleteMessage,
  createNormalizedMessage,
  normalizeImageDescriptors,
} from '@/shared/index.js';
import { toImageAttachments } from '@/shared/image-attachments.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';
import type { BackgroundTaskSummary, ProviderPermissionDecision } from '@/shared/types.js';

import {
  CODEX_AUTO_REVIEW_TOOL_NAME,
  CODEX_PROMPT_TOOL_NAMES,
  codexDeclineResponse,
  codexServerRequestResponse,
  describeAutoReview,
  describeCodexServerRequest,
  isInteractiveCodexServerRequest,
  toGuardianAssessmentEvent,
} from './codex-app-server.approvals.js';
import type { CodexInteractiveServerRequest } from './codex-app-server.approvals.js';
import { CodexThreadBackground, codexCommandDedupeKey } from './codex-app-server.background.js';
import { codexAppServer } from './codex-app-server.client.js';
import {
  CODEX_APP_SERVER_NO_REPLY,
  CodexAppServerConnection,
  CodexAppServerUnavailableError,
  isCodexProtocolMismatchError,
} from './codex-app-server.connection.js';
import {
  CODEX_IMAGE_ONLY_PROMPT,
  createCodexActiveWriterErrorMessage,
  extractCodexTokenBudget,
  isCodexThreadActiveWriterError,
  mapPermissionModeToCodexOptions,
  resolveCodexRuntimeMode,
  sendMessage,
} from './codex-runtime.shared.js';
import { resolveRunnableWorkspaceRoots } from './codex-workspace-roots.js';

/**
 * Every app-server method this runtime depends on. The protocol guard test
 * checks each against the schema of the bundled Codex CLI, so an upgrade that
 * drops one fails CI instead of failing a user's message.
 */
export const CODEX_APP_SERVER_PROTOCOL_USAGE = {
  /** Client → server requests. */
  requests: [
    'initialize',
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'thread/unsubscribe',
    'thread/approveGuardianDeniedAction',
    // Stage 4: background terminals and the subagents' status.
    'thread/backgroundTerminals/list',
    'thread/backgroundTerminals/terminate',
    'thread/backgroundTerminals/clean',
    'thread/read',
  ],
  /**
   * Request parameters the runtime relies on beyond the method itself, checked
   * against the installed CLI's schema (`v2/<Name>Params.json`).
   */
  requestParams: {
    TurnStartParams: ['threadId', 'input', 'clientUserMessageId'],
    TurnSteerParams: ['threadId', 'input', 'expectedTurnId', 'clientUserMessageId'],
    TurnInterruptParams: ['threadId', 'turnId'],
    ThreadApproveGuardianDeniedActionParams: ['threadId', 'event'],
    ThreadBackgroundTerminalsListParams: ['threadId', 'cursor'],
    ThreadBackgroundTerminalsTerminateParams: ['threadId', 'processId'],
    ThreadBackgroundTerminalsCleanParams: ['threadId'],
    ThreadReadParams: ['threadId', 'includeTurns'],
  },
  /**
   * Answers the runtime sends, checked against the installed CLI's schema
   * (`<Name>.json` must mention each value): the decisions the chat offers,
   * the permission grant scopes, and the answer shape of a question.
   */
  responseValues: {
    CommandExecutionRequestApprovalResponse: ['accept', 'acceptForSession', 'decline'],
    FileChangeRequestApprovalResponse: ['accept', 'acceptForSession', 'decline'],
    PermissionsRequestApprovalResponse: ['permissions', 'scope', 'turn', 'session'],
    ToolRequestUserInputResponse: ['answers'],
  },
  /**
   * Stage 4: fields the runtime reads from responses and notifications,
   * checked against the installed CLI's schema (`v2/<Name>.json` must mention
   * each): background terminals, a thread's status and last message, and the
   * subagent items and threads.
   */
  readFields: {
    ThreadBackgroundTerminalsListResponse: ['data', 'nextCursor', 'itemId', 'processId', 'command'],
    ThreadBackgroundTerminalsTerminateResponse: ['terminated'],
    ThreadReadResponse: ['thread', 'status', 'idle', 'active', 'systemError', 'notLoaded', 'turns', 'agentMessage'],
    ItemCompletedNotification: [
      'collabAgentToolCall', 'spawnAgent', 'receiverThreadIds', 'agentsStates', 'prompt',
      'subAgentActivity', 'agentThreadId', 'agentPath', 'processId',
    ],
    ThreadStartedNotification: ['agentNickname', 'parentThreadId'],
    // [local] Stage 5: a live card's `dedupeKey` (a command's text, an
    // agent's thread), built when the item starts.
    ItemStartedNotification: ['commandExecution', 'command', 'collabAgentToolCall', 'receiverThreadIds'],
    // The send refused because another program holds the thread (its text).
    ErrorNotification: ['error', 'message', 'willRetry'],
  },
  /** Client → server notifications. */
  clientNotifications: ['initialized'],
  /** Server → client notifications this runtime reads. */
  notifications: [
    'turn/started',
    'turn/completed',
    'item/started',
    'item/completed',
    'item/commandExecution/outputDelta',
    'turn/plan/updated',
    'thread/tokenUsage/updated',
    'error',
    'thread/closed',
    'item/fileChange/patchUpdated',
    'item/autoApprovalReview/completed',
    'serverRequest/resolved',
    // Stage 4: a spawned subagent's thread (its nickname).
    'thread/started',
  ],
  /**
   * Server → client requests this runtime answers: the first four through the
   * chat (stage 3), the rest declined as exec would.
   */
  serverRequests: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'execCommandApproval',
    'applyPatchApproval',
  ],
} as const;

/** Thrown when the message should run through `codex exec` instead. Nothing was sent to the client. */
export class CodexAppServerFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerFallbackError';
  }
}

/** Which runtime `CLOUDCLI_CODEX_RUNTIME` selects (defined with the shared helpers). */
export { resolveCodexRuntimeMode };

const settings = {
  /** Idle time after a turn before its thread is released. */
  idleReleaseMs: 30_000,
  /** How long a Stop waits for `turn/completed` before giving up on the turn. */
  interruptTimeoutMs: 15_000,
  /** Minimum gap between two streamed updates of one command's output. */
  commandOutputThrottleMs: 250,
  /** How long `initialize` and every other request may take. */
  requestTimeoutMs: 30_000,
  /** First restart delay after the child dies; doubles per crash in a row, up to the ceiling. */
  restartBackoffMs: 1_000,
  maxRestartBackoffMs: 60_000,
  /**
   * How long an approval waits for the chat before it is declined; null reads
   * `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` (the setting Claude's approvals use,
   * default 55 s), 0 waits for good. Also how long a denied review offers
   * "Allow anyway".
   */
  approvalTimeoutMs: null as number | null,
  /** How long a question waits; null means the approval timeout, but at least 30 minutes. */
  questionTimeoutMs: null as number | null,
  /** How often a thread's background terminals and subagents are read while a turn runs or any of them is live. */
  backgroundPollMs: 3_000,
  /** How long the end of a turn waits for that read before it reports `complete`. */
  turnEndBackgroundReadMs: 2_000,
};

function readApprovalTimeoutMs(): number {
  if (typeof settings.approvalTimeoutMs === 'number') {
    return settings.approvalTimeoutMs;
  }
  const parsed = Number.parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 55_000;
}

function readQuestionTimeoutMs(): number {
  if (typeof settings.questionTimeoutMs === 'number') {
    return settings.questionTimeoutMs;
  }
  const approval = readApprovalTimeoutMs();
  // A question usually needs thought, not just a yes or no (as for OpenCode).
  return approval === 0 ? 0 : Math.max(approval, 30 * 60_000);
}

// The notifications module is JavaScript; these state the shapes passed.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;

/**
 * Server-to-client requests. Approvals and questions of a running turn go to
 * the chat (the run's `ask`); anything else, and anything that arrives with no
 * turn of ours running on its thread, is declined as `codex exec` would (it
 * has no channel to a person). Nothing is ever approved without the user.
 */
async function handleServerRequest(method: string, params: unknown, rpcId: number | string): Promise<unknown> {
  const record = (params ?? {}) as AnyRecord;
  const run = typeof record.threadId === 'string' ? runsByThread.get(record.threadId) : undefined;
  if (run && !run.aborted && isInteractiveCodexServerRequest(method)) {
    return run.ask(method, record, rpcId);
  }
  return codexDeclineResponse(method);
}

const connection = new CodexAppServerConnection({
  // Through the exported client object so tests swap in a fake app-server
  // script the same way they do for forks and side questions.
  resolveLauncher: () => codexAppServer.resolveLauncher(),
  handleServerRequest,
  // Getters, so a change to `settings` (tests) applies to the next request.
  get requestTimeoutMs() { return settings.requestTimeoutMs; },
  get restartBackoffMs() { return settings.restartBackoffMs; },
  get maxRestartBackoffMs() { return settings.maxRestartBackoffMs; },
});

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

type LoadedThread = {
  threadId: string;
  /** Sandbox mode the thread was started or resumed with. */
  sandboxMode: SandboxMode;
  /** The reviewer Codex chose on load (the user's config), restored when "Approve for me" is turned off. */
  baselineReviewer: string;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** Release as soon as the running turn ends (session closed meanwhile). */
  releaseWhenIdle: boolean;
};

type TurnOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; message: string | null }
  | { kind: 'interrupted' }
  | { kind: 'lost'; reason: string };

/** A message waiting for its own turn after "Send now" stopped the current step. */
type PendingRestart = { input: UserInputItem[]; messageId: string };

type ActiveRun = {
  sessionKey: string;
  threadId: string;
  turnId: string | null;
  aborted: boolean;
  settle: (outcome: TurnOutcome) => void;
  /** Resolves once the run has fully ended (listeners removed). */
  finished: Promise<void>;
  /** Working directory of the run, for the input of messages sent into it. */
  cwd: string;
  /** True from the moment the current turn ended until the next one starts. */
  turnEnded: boolean;
  /** Resolves true once the current turn is confirmed, false if it never will be. */
  turnReady: Promise<boolean>;
  /**
   * Messages sent into the run (steered, or sent with "Send now") that Codex
   * has not read yet, by the id they were sent with. Codex reports reading one
   * with a `userMessage` item carrying that id as its `clientId`.
   */
  unread: Set<string>;
  /** "Send now" messages waiting for the interrupted step to end. */
  restarts: PendingRestart[];
  /** Puts an approval or question of this turn to the chat; resolves the JSON-RPC result. */
  ask: (method: CodexInteractiveServerRequest, params: AnyRecord, rpcId: number | string) => Promise<unknown>;
  /** The run's writer and row session id, for the `complete` a Stop sends. */
  ws: ProviderRuntimeWriter;
  rowSessionId: string | null;
};

/** What the latest turn on a thread ran with: a turn Codex starts on its own is shown with it. */
type ReportTurnSetup = {
  ws: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  // As the run's options carry them (untyped, like the exec path's).
  sessionId: AnyRecord[string];
  sessionSummary: AnyRecord[string];
  sessionKey: string;
  rowSessionId: string | null;
  cwd: string;
  /** `turn/start` params without the input. */
  turnParams: AnyRecord;
};

/**
 * A prompt waiting in the chat: an approval or question Codex is blocked on
 * (`request`), or a review denial that can still be allowed (`reviewDenial`,
 * which blocks nothing and may outlive its turn).
 */
type PendingCodexPrompt = {
  requestId: string;
  kind: 'request' | 'reviewDenial';
  /** Session the chat knows it by (the app session id), and the thread it belongs to. */
  sessionKey: string;
  threadId: string;
  /** JSON-RPC id of the server request, which `serverRequest/resolved` names. */
  rpcId: number | string | null;
  toolName: string;
  input: AnyRecord;
  context: AnyRecord;
  receivedAt: Date;
  timer: ReturnType<typeof setTimeout> | null;
  answer: (decision: ProviderPermissionDecision) => void;
  /** Withdraws it from the chat without an answer from the user (timeout, turn ended, Codex resolved it). */
  cancel: (reason: string, reply?: 'decline' | 'none') => void;
};

const loadedThreads = new Map<string, LoadedThread>();
/** Running turns by app session id (or thread id for callers without one). */
const activeRuns = new Map<string, ActiveRun>();
const runsByThread = new Map<string, ActiveRun>();
/** App session id → thread id, so a closed session can release its thread. */
const sessionThreads = new Map<string, string>();
/** Unsubscribes in flight, so a new message waits instead of racing them. */
const releasing = new Map<string, Promise<void>>();
/** Messages between entering run() and registering their turn. */
let preparingRuns = 0;
/** Prompts waiting in the chat, by the request id the chat answers with. */
const pendingPrompts = new Map<string, PendingCodexPrompt>();
/** What each thread was last loaded with, so "Allow anyway" can load it again after a release. */
const threadLoadParams = new Map<string, AnyRecord>();
/** [local] Stage 4: background terminals and subagents of each loaded thread. */
const backgroundByThread = new Map<string, CodexThreadBackground>();
/** [local] Stage 4: the latest turn's setup per thread, for a turn Codex starts on its own. */
const lastTurnSetup = new Map<string, ReportTurnSetup>();

/**
 * [local] Stage 5: keeps a row Codex's rollout does not record, for the app
 * session and the thread it was shown in. A no-op without an app session or
 * without a store (tests, callers outside the chat).
 */
function noteRecorder(context: ProviderRuntimeContext, sessionId: unknown, threadId: string): (message: AnyRecord) => void {
  const record = context.recordTranscriptNote;
  if (typeof sessionId !== 'string' || !sessionId || !record) {
    return () => {};
  }
  return (message) => {
    if (message && typeof message.id === 'string') {
      record({ sessionId, providerSessionId: threadId, message: message as never });
    }
  };
}

/** [local] Stage 5: a live Bash card carries the key its history card is matched by. */
function withCommandDedupeKey(message: AnyRecord): AnyRecord {
  if (message?.kind === 'tool_use' && message.toolName === 'Bash' && !message.parentToolUseId) {
    const key = codexCommandDedupeKey((message.toolInput as AnyRecord | undefined)?.command);
    if (key) {
      return { ...message, dedupeKey: key };
    }
  }
  return message;
}

function backgroundFor(threadId: string): CodexThreadBackground {
  let tracker = backgroundByThread.get(threadId);
  if (!tracker) {
    tracker = new CodexThreadBackground(threadId, {
      request: (method, params) => connection.request(method, params),
      isConnected: () => connection.isRunning(),
      isTurnRunning: (id) => runsByThread.has(id),
      // Nothing runs any more: the thread is released after the usual idle time.
      onIdle: (id) => {
        if (!runsByThread.has(id)) {
          scheduleRelease(id);
        }
      },
      pollMs: () => settings.backgroundPollMs,
      mapItem: (item, phase) => mapCodexAppServerItem(item, phase),
    });
    backgroundByThread.set(threadId, tracker);
  }
  return tracker;
}

function dropBackground(threadId: string): void {
  backgroundByThread.get(threadId)?.dispose();
  backgroundByThread.delete(threadId);
  lastTurnSetup.delete(threadId);
}

/** One read of a thread's background work, bounded so the end of a turn is never held up for long. */
async function readBackgroundBriefly(tracker: CodexThreadBackground): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    tracker.refresh(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, settings.turnEndBackgroundReadMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

function promptsWhere(match: (prompt: PendingCodexPrompt) => boolean): PendingCodexPrompt[] {
  return [...pendingPrompts.values()].filter(match);
}

connection.onExit(() => {
  // [local] Stage 4: background terminals and subagents went with it.
  for (const tracker of backgroundByThread.values()) {
    tracker.markAllGone();
    tracker.dispose();
  }
  backgroundByThread.clear();
  lastTurnSetup.clear();
  // Every loaded thread went with the child; the next message resumes it.
  for (const thread of loadedThreads.values()) {
    if (thread.releaseTimer) {
      clearTimeout(thread.releaseTimer);
    }
  }
  loadedThreads.clear();
  // Requests of the old child can no longer be answered. Review denials stay:
  // "Allow anyway" loads the thread again.
  for (const prompt of promptsWhere((entry) => entry.kind === 'request')) {
    prompt.cancel('cancelled', 'none');
  }
});

connection.onNotification((method, params) => {
  if (method === 'serverRequest/resolved') {
    // Codex settled a request itself (the turn ended or was interrupted, or
    // another client answered): the chat's prompt goes, and no answer is sent.
    const record = (params ?? {}) as AnyRecord;
    for (const prompt of promptsWhere((entry) => entry.kind === 'request'
      && entry.threadId === record.threadId
      && entry.rpcId !== null
      && String(entry.rpcId) === String(record.requestId))) {
      prompt.cancel('resolved', 'none');
    }
    return;
  }
  routeBackgroundNotification(method, (params ?? {}) as AnyRecord);
  if (method !== 'thread/closed') {
    return;
  }
  const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
  if (typeof threadId === 'string' && !runsByThread.has(threadId)) {
    const thread = loadedThreads.get(threadId);
    if (thread?.releaseTimer) {
      clearTimeout(thread.releaseTimer);
    }
    loadedThreads.delete(threadId);
    // [local] Stage 4: what ran in the thread went with it.
    backgroundByThread.get(threadId)?.markAllGone();
    dropBackground(threadId);
  }
});

/**
 * [local] Stage 4: notifications no running turn reads.
 * - A spawned subagent's own thread: its activity goes under its card.
 * - A thread CloudCLI holds between turns: a turn Codex starts on its own is
 *   followed (a report of background work), subagent items move their cards,
 *   and a background command's late end updates its card.
 */
function routeBackgroundNotification(method: string, record: AnyRecord): void {
  if (method === 'thread/started') {
    const thread = record.thread as AnyRecord | undefined;
    const parentId = typeof thread?.parentThreadId === 'string' ? thread.parentThreadId : null;
    if (parentId) {
      backgroundByThread.get(parentId)?.onThreadStarted(thread as AnyRecord);
    }
    return;
  }
  const threadId = typeof record.threadId === 'string' ? record.threadId : null;
  if (!threadId) {
    return;
  }
  for (const tracker of backgroundByThread.values()) {
    if (tracker.isChildThread(threadId)) {
      tracker.onChildNotification(method, record);
      return;
    }
  }
  const tracker = backgroundByThread.get(threadId);
  if (!tracker || runsByThread.has(threadId) || !loadedThreads.has(threadId)) {
    // A running turn reads its own thread.
    return;
  }
  if (method === 'turn/started') {
    const turnId = typeof record.turn?.id === 'string' ? record.turn.id : null;
    if (turnId) {
      followReportTurn(threadId, turnId);
    }
    return;
  }
  if (method !== 'item/started' && method !== 'item/completed') {
    return;
  }
  const item = record.item as AnyRecord | undefined;
  if (!item) {
    return;
  }
  const phase = method === 'item/started' ? 'started' : 'completed';
  if (tracker.onParentItem(item, phase)) {
    return;
  }
  if (item.type === 'commandExecution' && phase === 'completed' && typeof item.id === 'string') {
    // A background command that ended between turns: its card gets its end.
    tracker.noteCommandCompleted(item.id);
    const sink = tracker.writerSink;
    const event = mapCodexAppServerItem(item, 'completed');
    if (sink && event) {
      for (const row of sink.normalize(event, sink.rowSessionId)) {
        sendMessage(sink.writer, row);
      }
    }
  }
}

/**
 * [local] Stage 4: a turn Codex started on its own on a thread CloudCLI
 * holds, with no message of the user's (for example to report finished
 * background work). It runs like a turn of the user's on the writer of the
 * thread's latest run; the chat run reopens on `turn_started`.
 */
function followReportTurn(threadId: string, turnId: string): void {
  const setup = lastTurnSetup.get(threadId);
  const thread = loadedThreads.get(threadId);
  if (!setup || !thread) {
    return;
  }
  cancelRelease(thread);
  const send = (message: unknown) => sendMessage(setup.ws, message);
  void driveTurn({
    ws: setup.ws,
    context: setup.context,
    sessionId: setup.sessionId,
    sessionSummary: setup.sessionSummary,
    thread,
    rowSessionId: setup.rowSessionId,
    sessionKey: setup.sessionKey,
    workingDirectory: setup.cwd,
    turnParams: setup.turnParams,
    sandboxMode: thread.sandboxMode,
    start: { kind: 'report', turnId },
    send,
    wroteToClient: () => true,
    failRun: (sessionForRow, error) => {
      send(createNormalizedMessage({ kind: 'error', content: error instanceof Error ? error.message : String(error), sessionId: sessionForRow, provider: 'codex' }));
      send(createCompleteMessage({ provider: 'codex', sessionId: sessionForRow, exitCode: 1 }));
    },
    markPrepared: () => {},
  }).catch((error) => {
    console.warn(`[Codex] Following a turn Codex started on thread ${threadId} failed:`, error instanceof Error ? error.message : error);
  });
}

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  // A crash of CloudCLI must not leave the child (and its thread locks) behind.
  process.once('exit', () => connection.stop('CloudCLI is exiting.'));
}

// ---------------------------------------------------------------------------
// Mapping app-server items to the exec path's event shape

const COMMAND_STATUS: Record<string, string> = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  declined: 'failed',
};

function mapStatus(status: unknown): string | undefined {
  return typeof status === 'string' ? COMMAND_STATUS[status] ?? status : undefined;
}

function joinText(parts: unknown): string {
  return Array.isArray(parts) ? parts.filter((part) => typeof part === 'string' && part).join('\n\n') : '';
}

/**
 * One app-server `ThreadItem` as the event `transformCodexEvent` would have
 * produced for the matching `codex exec` item, or null when exec has no such
 * item (the user's own message, compaction markers, …).
 */
export function mapCodexAppServerItem(item: AnyRecord, phase: 'started' | 'completed'): AnyRecord | null {
  const itemId = typeof item?.id === 'string' ? item.id : undefined;
  switch (item?.type) {
    case 'agentMessage':
      return phase === 'completed'
        ? { type: 'item', itemType: 'agent_message', itemId, message: { role: 'assistant', content: item.text ?? '' } }
        : null;
    case 'reasoning': {
      if (phase !== 'completed') {
        return null;
      }
      const text = joinText(item.summary) || joinText(item.content);
      return text ? { type: 'item', itemType: 'reasoning', itemId, message: { role: 'assistant', content: text, isReasoning: true } } : null;
    }
    case 'commandExecution':
      return {
        type: 'item',
        itemType: 'command_execution',
        itemId,
        command: item.command,
        output: item.aggregatedOutput ?? '',
        exitCode: item.exitCode ?? undefined,
        status: mapStatus(item.status),
      };
    case 'fileChange':
      return phase === 'completed'
        ? {
          type: 'item',
          itemType: 'file_change',
          itemId,
          changes: (Array.isArray(item.changes) ? item.changes : []).map((change: AnyRecord) => ({
            path: change?.path,
            kind: typeof change?.kind?.type === 'string' ? change.kind.type : change?.kind,
          })),
          status: mapStatus(item.status),
        }
        : null;
    case 'mcpToolCall':
      return {
        type: 'item',
        itemType: 'mcp_tool_call',
        itemId,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        // The exec SDK spells the structured part in snake case.
        result: item.result
          ? { content: item.result.content, structured_content: item.result.structuredContent ?? null }
          : undefined,
        error: item.error ?? undefined,
        status: mapStatus(item.status),
      };
    case 'webSearch':
      return phase === 'completed' ? { type: 'item', itemType: 'web_search', itemId, query: item.query } : null;
    case 'collabAgentToolCall':
      // What exec prints as a generic `collab_tool_call` row. [local] Stage 4:
      // the runtime turns a thread's own collaboration calls into subagent
      // cards before this mapping (CodexThreadBackground.onParentItem).
      return phase === 'completed' ? { type: 'item', itemType: 'collab_tool_call', itemId, item } : null;
    default:
      return null;
  }
}

/** `turn/plan/updated` as exec's `todo_list` item; one id per turn so updates replace the row. */
export function mapCodexAppServerPlan(turnId: string, plan: unknown): AnyRecord {
  return {
    type: 'item',
    itemType: 'todo_list',
    itemId: `${turnId}_plan`,
    items: (Array.isArray(plan) ? plan : []).map((step: AnyRecord) => ({
      text: String(step?.step ?? ''),
      completed: step?.status === 'completed',
    })),
  };
}

/** `thread/tokenUsage/updated` in the shape extractCodexTokenBudget reads from exec's `turn.completed`. */
function tokenBudgetFrom(tokenUsage: AnyRecord | null) {
  const total = tokenUsage?.total;
  if (!total || typeof total !== 'object') {
    return null;
  }
  return extractCodexTokenBudget({
    usage: {
      input_tokens: total.inputTokens,
      output_tokens: total.outputTokens,
      ...(typeof tokenUsage?.modelContextWindow === 'number' ? { model_context_window: tokenUsage.modelContextWindow } : {}),
    },
  });
}

type UserInputItem =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string };

/** The exec path's turn input (text, then `local_image` items) as app-server `UserInput`. */
function toUserInput(prompt: string, images: unknown, cwd: string): UserInputItem[] {
  const normalizedImages = normalizeImageDescriptors(images);
  const items = normalizedImages.length > 0
    ? buildCodexInputItems(prompt, normalizedImages, cwd)
    : [{ type: 'text', text: prompt }];
  return items.map((item) => item.type === 'local_image'
    ? { type: 'localImage', path: (item as { path: string }).path }
    : { type: 'text', text: (item as { text: string }).text, text_elements: [] });
}

/** A message's text, attached files and images as one turn's `UserInput`, as exec would send it. */
function buildTurnInput(command: string, images: unknown, files: unknown, cwd: string): UserInputItem[] {
  const promptWithFiles = appendFilesInputTag(command, files as never);
  const prompt = !promptWithFiles.trim() && normalizeImageDescriptors(images).length > 0
    ? CODEX_IMAGE_ONLY_PROMPT
    : promptWithFiles;
  return toUserInput(prompt, images, cwd);
}

/**
 * The transcript row for a message sent into a running turn, built from the
 * `userMessage` item Codex reports when it reads it, under the id the message
 * was sent with (which is how the composer knows its card was delivered).
 */
export function codexSteeredMessageEcho(item: AnyRecord, messageId: string): AnyRecord {
  const parts: AnyRecord[] = Array.isArray(item?.content) ? item.content : [];
  const text = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  const imagePaths = parts
    .filter((part) => part?.type === 'localImage' && typeof part.path === 'string')
    .map((part) => part.path as string);
  return {
    uuid: messageId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
    ...(imagePaths.length > 0 ? { images: toImageAttachments(imagePaths) } : {}),
  };
}

function sandboxPolicyFor(mode: SandboxMode): AnyRecord {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    default:
      return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}

// ---------------------------------------------------------------------------
// Thread lifecycle

function cancelRelease(thread: LoadedThread) {
  if (thread.releaseTimer) {
    clearTimeout(thread.releaseTimer);
    thread.releaseTimer = null;
  }
}

function scheduleRelease(threadId: string) {
  const thread = loadedThreads.get(threadId);
  if (!thread) {
    stopIfIdle();
    return;
  }
  cancelRelease(thread);
  if (thread.releaseWhenIdle) {
    // Closed meanwhile: its background work goes with it.
    void releaseThread(threadId, { stopWork: true });
    return;
  }
  // [local] Stage 4: background terminals or subagents still run. Releasing
  // would stop them (it stops the child); the tracker calls back once they end.
  const tracker = backgroundByThread.get(threadId);
  if (tracker?.hasLiveWork()) {
    tracker.ensurePolling();
    return;
  }
  thread.releaseTimer = setTimeout(() => {
    thread.releaseTimer = null;
    void releaseThread(threadId);
  }, settings.idleReleaseMs);
  thread.releaseTimer.unref?.();
}

/**
 * Unsubscribes an idle thread; stops the child once nothing is left on it.
 * [local] A thread whose background work still runs is kept, unless the
 * session was closed (`stopWork`): then its background terminals are stopped
 * first.
 */
async function releaseThread(threadId: string, { stopWork = false } = {}): Promise<void> {
  const thread = loadedThreads.get(threadId);
  if (!thread || runsByThread.has(threadId)) {
    return;
  }
  const tracker = backgroundByThread.get(threadId);
  if (tracker?.hasLiveWork() && !stopWork) {
    return;
  }
  if (tracker && stopWork && tracker.terminals.size > 0) {
    await tracker.stopAllTerminals().catch((error) => {
      console.warn(`[Codex] Could not stop the background terminals of thread ${threadId}:`, error instanceof Error ? error.message : error);
    });
    if (loadedThreads.get(threadId) !== thread || runsByThread.has(threadId)) {
      return;
    }
  }
  dropBackground(threadId);
  cancelRelease(thread);
  loadedThreads.delete(threadId);
  if (connection.isRunning()) {
    const unsubscribe = connection.request('thread/unsubscribe', { threadId }).then(() => {}, (error) => {
      console.warn(`[Codex] Failed to unsubscribe from thread ${threadId}:`, error instanceof Error ? error.message : error);
    });
    releasing.set(threadId, unsubscribe);
    await unsubscribe;
    if (releasing.get(threadId) === unsubscribe) {
      releasing.delete(threadId);
    }
  }
  stopIfIdle();
}

function stopIfIdle() {
  if (loadedThreads.size === 0 && activeRuns.size === 0 && preparingRuns === 0 && connection.isRunning()) {
    // Stopping the child is what frees the threads' writer locks right away.
    connection.stop('No Codex conversation is using the app-server.');
  }
}

/**
 * True when the error means the app-server cannot serve this message at all,
 * so exec should try instead (only before anything reached the client).
 */
function shouldFallBack(error: unknown): boolean {
  return error instanceof CodexAppServerUnavailableError || isCodexProtocolMismatchError(error);
}

// ---------------------------------------------------------------------------
// Running a turn

async function runAppServerTurn(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  // Counted until the turn is registered, so an idle stop of the child cannot
  // land between loading the thread and starting the turn.
  preparingRuns += 1;
  let prepared = false;
  const markPrepared = () => {
    if (!prepared) {
      prepared = true;
      preparingRuns -= 1;
    }
  };
  try {
    await runAppServerTurnInner(command, options, ws, context, markPrepared);
  } finally {
    markPrepared();
    stopIfIdle();
  }
}

async function runAppServerTurnInner(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
  markPrepared: () => void,
): Promise<void> {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default',
  } = options;

  // Resolved exactly as the exec path does.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const workingDirectory: string = cwd || projectPath || process.cwd();
  const additionalDirectories = await resolveRunnableWorkspaceRoots(
    context.getSessionWorkspaceRoots?.(sessionId) ?? [],
    workingDirectory,
  );
  const permissions = mapPermissionModeToCodexOptions(permissionMode);
  const sandboxMode: SandboxMode = permissions.sandboxMode ?? 'workspace-write';
  const { approvalPolicy, config: codexConfig } = permissions;
  const wantsAutoReview = codexConfig?.approvals_reviewer === 'auto_review';
  const catalog = await context.getProviderModels();
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort as ModelReasoningEffort
    : undefined;
  const runtimeWorkspaceRoots = additionalDirectories.length > 0 ? [workingDirectory, ...additionalDirectories] : null;

  const input = buildTurnInput(command, images, files, workingDirectory);

  // Until the first message reaches the client, any app-server failure that
  // means "unusable" hands the message to exec instead.
  let wroteToClient = false;
  const send = (message: unknown) => {
    wroteToClient = true;
    sendMessage(ws, message);
  };

  const failRun = (sessionForRow: string | null, error: unknown, heldThreadId?: string | null) => {
    const runError = error instanceof Error ? error : new Error(String(error));
    console.error('[Codex] app-server error:', runError.message);
    if (isCodexThreadActiveWriterError(runError.message)) {
      const row = createCodexActiveWriterErrorMessage(sessionForRow);
      send(row);
      // [local] Stage 5: kept, so a reload still says why nothing ran (and
      // the chat can show that the thread is open in another program).
      if (heldThreadId) {
        noteRecorder(context, sessionId, heldThreadId)(row as AnyRecord);
      }
    } else {
      send(createNormalizedMessage({ kind: 'error', content: runError.message, sessionId: sessionForRow, provider: 'codex' }));
    }
    send(createCompleteMessage({ provider: 'codex', sessionId: sessionForRow, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'codex',
      sessionId: sessionId || sessionForRow || null,
      sessionName: sessionSummary,
      error: runError,
    });
  };

  const providerThreadPendingRelease = providerSessionId ? releasing.get(providerSessionId) : undefined;
  if (providerThreadPendingRelease) {
    await providerThreadPendingRelease;
  }

  try {
    await connection.ensureStarted();
    installExitHook();
  } catch (error) {
    throw new CodexAppServerFallbackError(error instanceof Error ? error.message : String(error));
  }

  // 1. Load the thread (start, resume, or reuse while it is still loaded).
  let threadId = providerSessionId;
  let thread = threadId ? loadedThreads.get(threadId) : undefined;
  const isNewThread = !threadId;
  if (!thread) {
    const threadParams: AnyRecord = {
      cwd: workingDirectory,
      approvalPolicy,
      sandbox: sandboxMode,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
    };
    let result: AnyRecord | undefined;
    try {
      result = threadId
        ? await connection.request('thread/resume', { threadId, excludeTurns: true, ...threadParams }) as AnyRecord
        : await connection.request('thread/start', threadParams) as AnyRecord;
    } catch (error) {
      if (shouldFallBack(error)) {
        throw new CodexAppServerFallbackError(error instanceof Error ? error.message : String(error));
      }
      // Includes the active-writer conflict: the desktop app (or another
      // client) holds this thread. Never retried; the user decides.
      failRun(threadId || sessionId || null, error, threadId);
      return;
    }
    const loadedId = typeof result?.thread?.id === 'string' ? result.thread.id : threadId;
    if (!loadedId) {
      failRun(sessionId || null, new Error('Codex app-server reported a thread without an id.'));
      return;
    }
    threadId = loadedId;
    thread = {
      threadId: loadedId,
      sandboxMode,
      baselineReviewer: typeof result?.approvalsReviewer === 'string' ? result.approvalsReviewer : 'user',
      releaseTimer: null,
      releaseWhenIdle: false,
    };
    loadedThreads.set(loadedId, thread);
    threadLoadParams.set(loadedId, threadParams);
  }
  cancelRelease(thread);
  thread.releaseWhenIdle = false;
  const loadedThreadId: string = thread.threadId;
  const rowSessionId = loadedThreadId || sessionId || null;
  const sessionKey: string = sessionId || loadedThreadId;
  if (sessionId) {
    sessionThreads.set(sessionId, loadedThreadId);
  }

  // 3. Start the turn with this message's settings. They apply to this turn
  // and the ones after it, so each message sends its own.
  const turnParams: AnyRecord = {
    threadId: loadedThreadId,
    input,
    cwd: workingDirectory,
    approvalPolicy,
    approvalsReviewer: wantsAutoReview ? 'auto_review' : thread.baselineReviewer,
    ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    // The sandbox mode was set when the thread loaded; only a change in
    // between needs an explicit policy.
    ...(thread.sandboxMode !== sandboxMode ? { sandboxPolicy: sandboxPolicyFor(sandboxMode) } : {}),
  };
  const background = backgroundFor(loadedThreadId);
  background.attach({
    sessionKey,
    rowSessionId,
    writer: ws,
    normalize: (raw, sid) => context.normalizeMessage(raw, sid),
    recordNote: noteRecorder(context, sessionId, loadedThreadId),
  });
  const { input: _input, ...turnDefaults } = turnParams;
  lastTurnSetup.set(loadedThreadId, { ws, context, sessionId, sessionSummary, sessionKey, rowSessionId, cwd: workingDirectory, turnParams: turnDefaults });

  await driveTurn({
    ws,
    context,
    sessionId,
    sessionSummary,
    thread,
    rowSessionId,
    sessionKey,
    workingDirectory,
    turnParams,
    sandboxMode,
    start: { kind: 'new', isNewThread },
    send,
    wroteToClient: () => wroteToClient,
    failRun,
    markPrepared,
  });
}

/** What a turn needs once its thread is loaded; shared by a turn of the user's and one Codex started itself. */
type DriveTurnInput = {
  ws: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  // As the run's options carry them (untyped, like the exec path's).
  sessionId: AnyRecord[string];
  sessionSummary: AnyRecord[string];
  thread: LoadedThread;
  rowSessionId: string | null;
  sessionKey: string;
  workingDirectory: string;
  /** `turn/start` params (for a report turn: what the thread's last turn ran with, without input). */
  turnParams: AnyRecord;
  sandboxMode: SandboxMode;
  /** A new turn of the user's (`turn/start`), or a turn Codex started on its own (`report`). */
  start: { kind: 'new'; isNewThread: boolean } | { kind: 'report'; turnId: string };
  send: (message: unknown) => void;
  wroteToClient: () => boolean;
  failRun: (sessionForRow: string | null, error: unknown, heldThreadId?: string | null) => void;
  markPrepared: () => void;
};

async function driveTurn(d: DriveTurnInput): Promise<void> {
  const { ws, context, sessionId, sessionSummary, thread, rowSessionId, sessionKey, workingDirectory, turnParams, sandboxMode, send, failRun, markPrepared } = d;
  const loadedThreadId = thread.threadId;
  const isNewThread = d.start.kind === 'new' && d.start.isNewThread;
  const background = backgroundFor(loadedThreadId);
  // [local] Stage 5: rows the rollout does not record are kept.
  const recordNote = noteRecorder(context, sessionId, loadedThreadId);

  // A Stop ends the chat run at once, but its turn ends only when Codex
  // confirms the interrupt (bounded by interruptTimeoutMs). A message sent in
  // between must not reach that turn: on an active turn, `turn/start` adds
  // the input to it instead of starting a new one.
  const previousRun = runsByThread.get(loadedThreadId);
  if (previousRun) {
    await previousRun.finished;
  }

  // 2. Listen before turn/start: the first notifications can beat its reply.
  // They are held back until the turn is confirmed, so a fallback to exec
  // never follows rows this runtime already showed.
  let started = false;
  const held: Array<[string, AnyRecord]> = [];
  let latestTokenUsage: AnyRecord | null = null;
  let lastErrorMessage: string | null = null;
  let writerConflictShown = false;
  const commandOutput = new Map<string, { text: string; lastSentAt: number; timer: ReturnType<typeof setTimeout> | null; item: AnyRecord | null }>();

  let settleTurn!: (outcome: TurnOutcome) => void;
  let markTurnReady!: (ready: boolean) => void;

  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const run: ActiveRun = {
    sessionKey,
    threadId: loadedThreadId,
    turnId: null,
    aborted: false,
    settle: (outcome) => settleTurn(outcome),
    finished,
    cwd: workingDirectory,
    turnEnded: false,
    turnReady: Promise.resolve(false),
    unread: new Set(),
    restarts: [],
    ask: (method, params, rpcId) => askChat(method, params, rpcId),
    ws,
    rowSessionId,
  };

  // The run's `fileChange` items by id: an approval request names only the
  // item, whose paths and diffs Codex reported just before.
  const fileChanges = new Map<string, AnyRecord>();

  const notify = (event: AnyRecord) => notifyUserIfEnabled({ userId: ws?.userId ?? null, event: notificationEvent(event) });

  /**
   * Shows a prompt in the chat and holds it until the user answers, it times
   * out, or it is withdrawn. Every way out removes it from the chat
   * (`permission_resolved` for an answer, `permission_cancelled` otherwise) on
   * the run's stream, so the replay buffer and other tabs drop it as well.
   */
  const openPrompt = (prompt: {
    kind: PendingCodexPrompt['kind'];
    rpcId: number | string | null;
    toolName: string;
    input: AnyRecord;
    context: AnyRecord;
    timeoutMs: number;
    onAnswer: (decision: ProviderPermissionDecision) => void;
    onCancel: (reply: 'decline' | 'none') => void;
  }): PendingCodexPrompt => {
    const requestId = `codex-${randomUUID()}`;
    const remove = (reason?: string) => {
      if (pendingPrompts.get(requestId) !== pending) {
        return false;
      }
      pendingPrompts.delete(requestId);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      sendMessage(ws, createNormalizedMessage({
        kind: reason ? 'permission_cancelled' : 'permission_resolved',
        requestId,
        ...(reason ? { reason } : {}),
        sessionId: rowSessionId,
        provider: 'codex',
      }));
      return true;
    };
    const pending: PendingCodexPrompt = {
      requestId,
      kind: prompt.kind,
      sessionKey,
      threadId: loadedThreadId,
      rpcId: prompt.rpcId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      receivedAt: new Date(),
      timer: null,
      answer: (decision) => {
        if (remove()) {
          prompt.onAnswer(decision);
        }
      },
      cancel: (reason, reply = 'decline') => {
        if (remove(reason)) {
          prompt.onCancel(reply);
        }
      },
    };
    pendingPrompts.set(requestId, pending);
    if (prompt.timeoutMs > 0) {
      pending.timer = setTimeout(() => pending.cancel('timeout'), prompt.timeoutMs);
      pending.timer.unref?.();
    }
    send(createNormalizedMessage({
      kind: 'permission_request',
      requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId: rowSessionId,
      provider: 'codex',
    }));
    return pending;
  };

  const askChat = (method: CodexInteractiveServerRequest, params: AnyRecord, rpcId: number | string): Promise<unknown> => {
    const description = describeCodexServerRequest(method, params, fileChanges);
    const isQuestion = method === 'item/tool/requestUserInput';
    return new Promise((resolve) => {
      openPrompt({
        kind: 'request',
        rpcId,
        ...description,
        timeoutMs: isQuestion ? readQuestionTimeoutMs() : readApprovalTimeoutMs(),
        onAnswer: (decision) => resolve(codexServerRequestResponse(method, params, decision)),
        // A timeout declines, as Claude's approvals do; a request Codex
        // withdrew itself gets no answer.
        onCancel: (reply) => resolve(reply === 'none' ? CODEX_APP_SERVER_NO_REPLY : codexDeclineResponse(method)),
      });
      notify({
        provider: 'codex',
        sessionId: sessionId || loadedThreadId,
        kind: 'action_required',
        code: isQuestion ? 'agent.notification' : 'permission.required',
        meta: isQuestion
          ? { message: String(description.input.questions?.[0]?.question || 'Codex has a question for you'), sessionName: sessionSummary }
          : { toolName: description.toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `codex:${isQuestion ? 'question' : 'permission'}:${sessionId || loadedThreadId}:${rpcId}`,
      });
    });
  };

  /**
   * A finished automatic review: one row in the transcript with the
   * reviewer's decision and reason, and for a denial a prompt offering
   * "Allow anyway" (`thread/approveGuardianDeniedAction`).
   */
  const showAutoReview = (params: AnyRecord) => {
    const review = describeAutoReview(params);
    if (!review.reviewId || review.status === 'inProgress') {
      return;
    }
    const toolId = `autoreview_${review.reviewId}`;
    const reviewRows = [
      createNormalizedMessage({
        id: toolId,
        kind: 'tool_use',
        toolName: CODEX_AUTO_REVIEW_TOOL_NAME,
        toolInput: review,
        toolId,
        sessionId: rowSessionId,
        provider: 'codex',
      }),
      createNormalizedMessage({
        id: `${toolId}_result`,
        kind: 'tool_result',
        toolId,
        content: review.rationale ?? '',
        isError: review.status !== 'approved',
        sessionId: rowSessionId,
        provider: 'codex',
      }),
    ];
    for (const row of reviewRows) {
      send(row);
      // [local] Stage 5: Codex's rollout does not record reviews; kept here.
      recordNote(row as AnyRecord);
    }
    if (review.status !== 'denied') {
      return;
    }
    openPrompt({
      kind: 'reviewDenial',
      rpcId: null,
      toolName: CODEX_PROMPT_TOOL_NAMES.reviewDenial,
      input: review,
      context: { provider: 'codex' },
      timeoutMs: readApprovalTimeoutMs(),
      onAnswer: (decision) => {
        if (decision.allow) {
          void approveDeniedAction(loadedThreadId, params);
        }
      },
      onCancel: () => {},
    });
  };

  // One per turn: "Send now" starts another turn inside the same run.
  const nextTurn = () => {
    run.turnEnded = false;
    run.turnReady = new Promise<boolean>((resolve) => {
      markTurnReady = resolve;
    });
    return new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      settleTurn = (outcome) => {
        if (!settled) {
          settled = true;
          run.turnEnded = true;
          resolve(outcome);
        }
      };
    });
  };
  let turnDone = nextTurn();

  const forward = (event: AnyRecord) => {
    for (const message of context.normalizeMessage(event, rowSessionId)) {
      send(withCommandDedupeKey(message as AnyRecord));
    }
  };

  const flushCommandOutput = (itemId: string) => {
    const entry = commandOutput.get(itemId);
    if (!entry?.item) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.lastSentAt = Date.now();
    forward({ ...entry.item, output: entry.text, status: 'in_progress' });
  };

  // Codex read a message sent into the turn: show it where it was read. The
  // turn's own prompt is never echoed; the client already shows it.
  const echoIfSteered = (item: AnyRecord) => {
    const messageId = typeof item?.clientId === 'string' ? item.clientId : null;
    if (!messageId || !run.unread.delete(messageId)) {
      return;
    }
    for (const message of context.normalizeMessage(codexSteeredMessageEcho(item, messageId), rowSessionId)) {
      // Read mid-turn, so it is no anchor for editing (as with Claude).
      delete (message as AnyRecord).transcriptAnchorId;
      send(message);
    }
  };

  const handle = (method: string, params: AnyRecord) => {
    switch (method) {
      case 'turn/started': {
        if (!run.turnId && typeof params.turn?.id === 'string') {
          run.turnId = params.turn.id;
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = params.item as AnyRecord;
        if (item?.type === 'userMessage') {
          echoIfSteered(item);
          return;
        }
        if (item?.type === 'fileChange' && typeof item.id === 'string') {
          fileChanges.set(item.id, item);
        }
        const phase = method === 'item/started' ? 'started' : 'completed';
        // [local] Stage 4: a spawn is the subagent's card, the other
        // collaboration calls only move its status (as in history).
        if (background.onParentItem(item, phase)) {
          return;
        }
        if (item?.type === 'commandExecution' && phase === 'completed' && typeof item.id === 'string') {
          background.noteCommandCompleted(item.id);
        }
        const event = mapCodexAppServerItem(item, phase);
        if (!event) {
          return;
        }
        if (item?.type === 'commandExecution' && typeof item.id === 'string') {
          const entry = commandOutput.get(item.id);
          if (phase === 'started') {
            commandOutput.set(item.id, { text: entry?.text ?? '', lastSentAt: Date.now(), timer: null, item: event });
          } else if (entry) {
            if (entry.timer) {
              clearTimeout(entry.timer);
            }
            commandOutput.delete(item.id);
            if (!event.output && entry.text) {
              event.output = entry.text;
            }
          }
        }
        forward(event);
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : null;
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!itemId || !delta) {
          return;
        }
        const entry = commandOutput.get(itemId) ?? { text: '', lastSentAt: 0, timer: null, item: null };
        entry.text += delta;
        commandOutput.set(itemId, entry);
        if (!entry.item || entry.timer) {
          return;
        }
        const wait = settings.commandOutputThrottleMs - (Date.now() - entry.lastSentAt);
        if (wait <= 0) {
          flushCommandOutput(itemId);
        } else {
          entry.timer = setTimeout(() => flushCommandOutput(itemId), wait);
          entry.timer.unref?.();
        }
        return;
      }
      case 'turn/plan/updated': {
        const turnId = typeof params.turnId === 'string' ? params.turnId : run.turnId ?? 'turn';
        forward(mapCodexAppServerPlan(turnId, params.plan));
        return;
      }
      case 'thread/tokenUsage/updated':
        latestTokenUsage = (params.tokenUsage as AnyRecord) ?? null;
        return;
      case 'item/fileChange/patchUpdated': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : null;
        if (itemId && Array.isArray(params.changes)) {
          fileChanges.set(itemId, { ...(fileChanges.get(itemId) ?? { type: 'fileChange', id: itemId }), changes: params.changes });
        }
        return;
      }
      case 'item/autoApprovalReview/completed':
        showAutoReview(params);
        return;
      case 'error': {
        if (params.willRetry) {
          // "Reconnecting…": Codex retries on its own; a later error or the
          // turn's own failure is what the user sees.
          return;
        }
        const message = typeof params.error?.message === 'string' ? params.error.message : null;
        lastErrorMessage = message ?? lastErrorMessage;
        if (isCodexThreadActiveWriterError(message) && !writerConflictShown) {
          writerConflictShown = true;
          const row = createCodexActiveWriterErrorMessage(rowSessionId);
          send(row);
          recordNote(row as AnyRecord);
        }
        return;
      }
      case 'turn/completed': {
        const turn = params.turn as AnyRecord | undefined;
        if (run.turnId && typeof turn?.id === 'string' && turn.id !== run.turnId) {
          return;
        }
        const status = turn?.status;
        if (status === 'completed') {
          settleTurn({ kind: 'completed' });
        } else if (status === 'interrupted') {
          settleTurn({ kind: 'interrupted' });
        } else {
          const message = typeof turn?.error?.message === 'string' ? turn.error.message : null;
          settleTurn({ kind: 'failed', message: message ?? lastErrorMessage });
        }
        return;
      }
      default:
    }
  };

  const removeNotificationListener = connection.onNotification((method, rawParams) => {
    const params = (rawParams ?? {}) as AnyRecord;
    if (params.threadId !== loadedThreadId) {
      return;
    }
    if (!started) {
      held.push([method, params]);
      return;
    }
    handle(method, params);
  });
  const removeExitListener = connection.onExit((reason) => settleTurn({ kind: 'lost', reason }));

  activeRuns.set(sessionKey, run);
  runsByThread.set(loadedThreadId, run);
  markPrepared();

  const cleanup = () => {
    markFinished();
    markTurnReady(false);
    removeNotificationListener();
    removeExitListener();
    // Nothing of this turn waits for an answer any more. A denied review can
    // still be allowed after the turn, unless the user stopped it.
    for (const prompt of promptsWhere((entry) => entry.threadId === loadedThreadId
      && (entry.kind === 'request' || run.aborted))) {
      prompt.cancel(run.aborted ? 'cancelled' : 'turn-ended');
    }
    for (const entry of commandOutput.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    if (activeRuns.get(sessionKey) === run) {
      activeRuns.delete(sessionKey);
    }
    if (runsByThread.get(loadedThreadId) === run) {
      runsByThread.delete(loadedThreadId);
    }
  };

  if (d.start.kind === 'report') {
    // [local] Stage 4: Codex started this turn on its own (a report of
    // finished background work). It is shown and handled like a turn of the
    // user's: running, stoppable, steerable, ended by its own `complete`.
    run.turnId = d.start.turnId;
    send(createNormalizedMessage({ kind: 'turn_started', origin: 'background', sessionId: rowSessionId, provider: 'codex' }));
  } else {
    try {
      const result = await connection.request('turn/start', turnParams) as AnyRecord | undefined;
      if (!run.turnId && typeof result?.turn?.id === 'string') {
        run.turnId = result.turn.id;
      }
      thread.sandboxMode = sandboxMode;
    } catch (error) {
      cleanup();
      run.turnEnded = true;
      if (shouldFallBack(error) && !d.wroteToClient()) {
        if (isNewThread) {
          // Nothing ran on it; let it go rather than leave it loaded.
          void releaseThread(loadedThreadId);
        } else {
          scheduleRelease(loadedThreadId);
        }
        throw new CodexAppServerFallbackError(error instanceof Error ? error.message : String(error));
      }
      failRun(rowSessionId, error, loadedThreadId);
      scheduleRelease(loadedThreadId);
      return;
    }
  }

  // 4. Announce a brand-new thread the way exec does on `thread.started`.
  if (isNewThread) {
    if (typeof ws.setSessionId === 'function') {
      ws.setSessionId(loadedThreadId);
    }
    send(createNormalizedMessage({ kind: 'session_created', newSessionId: loadedThreadId, sessionId: loadedThreadId, provider: 'codex' }));
  }

  started = true;
  for (const [method, params] of held.splice(0)) {
    handle(method, params);
  }
  markTurnReady(true);
  if (run.aborted && run.turnId) {
    // Stop was pressed while turn/start was in flight.
    requestInterrupt(run);
  }
  // [local] Stage 4: background terminals and subagents are read while the turn runs.
  background.ensurePolling();

  let outcome = await turnDone;

  // "Send now" stopped the step (or the turn ended on its own meanwhile): the
  // waiting message starts the next turn, inside the same chat run, so the
  // client sees one run with no `complete` in between.
  while (run.restarts.length > 0 && !run.aborted && (outcome.kind === 'interrupted' || outcome.kind === 'completed')) {
    // Requests of the stopped step are void; Codex asks again if it needs to.
    for (const prompt of promptsWhere((entry) => entry.threadId === loadedThreadId && entry.kind === 'request')) {
      prompt.cancel('turn-ended');
    }
    run.turnId = null;
    turnDone = nextTurn();
    const [first, ...rest] = run.restarts.splice(0);
    try {
      const result = await connection.request('turn/start', {
        ...turnParams,
        input: first.input,
        clientUserMessageId: first.messageId,
      }) as AnyRecord | undefined;
      if (!run.turnId && typeof result?.turn?.id === 'string') {
        run.turnId = result.turn.id;
      }
    } catch (error) {
      // Never read: the composer gets it back when the run ends.
      settleTurn({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      outcome = await turnDone;
      break;
    }
    markTurnReady(true);
    // Sent while that turn was being started: into it, in order.
    for (const extra of rest) {
      await steerInto(run, extra.input, extra.messageId);
    }
    if (run.aborted && run.turnId) {
      requestInterrupt(run);
    }
    outcome = await turnDone;
  }
  // [local] Stage 4: what the turn left running is reported before its
  // `complete`, so the client goes to the background state with it listed.
  if (!run.aborted && outcome.kind !== 'lost') {
    await readBackgroundBriefly(background);
  }
  cleanup();

  // 5. Finish the way the exec path finishes.
  switch (outcome.kind) {
    case 'completed': {
      const tokenBudget = tokenBudgetFrom(latestTokenUsage);
      if (tokenBudget) {
        send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: rowSessionId, provider: 'codex' }));
      }
      send(withPendingPrompts(createCompleteMessage({ provider: 'codex', sessionId: rowSessionId, actualSessionId: loadedThreadId, exitCode: 0 }), sessionKey));
      notifyRunStopped({ userId: ws?.userId || null, provider: 'codex', sessionId: sessionId || loadedThreadId, sessionName: sessionSummary, stopReason: 'completed' });
      break;
    }
    case 'failed': {
      const message = outcome.message || 'Turn failed';
      if (isCodexThreadActiveWriterError(message)) {
        if (!writerConflictShown) {
          const row = createCodexActiveWriterErrorMessage(rowSessionId);
          send(row);
          recordNote(row as AnyRecord);
        }
      } else {
        forward({ type: 'turn_failed', error: { message } });
      }
      send(withPendingPrompts(createCompleteMessage({ provider: 'codex', sessionId: rowSessionId, actualSessionId: loadedThreadId, exitCode: 1 }), sessionKey));
      notifyRunFailed({ userId: ws?.userId || null, provider: 'codex', sessionId: sessionId || loadedThreadId, sessionName: sessionSummary, error: new Error(message) });
      break;
    }
    case 'interrupted': {
      if (!run.aborted) {
        // Interrupted by someone else (another client of this thread); end
        // the run here, since no Stop path will.
        send({
          ...withPendingPrompts(createCompleteMessage({ provider: 'codex', sessionId: rowSessionId, actualSessionId: loadedThreadId, exitCode: 0, aborted: true }), sessionKey),
          backgroundContinues: background.hasLiveWork(),
        });
      }
      // A Stop from CloudCLI: the abort path already sent `complete`.
      notifyRunStopped({ userId: ws?.userId || null, provider: 'codex', sessionId: sessionId || loadedThreadId, sessionName: sessionSummary, stopReason: 'aborted' });
      break;
    }
    case 'lost': {
      if (run.aborted) {
        notifyRunStopped({ userId: ws?.userId || null, provider: 'codex', sessionId: sessionId || loadedThreadId, sessionName: sessionSummary, stopReason: 'aborted' });
        break;
      }
      failRun(rowSessionId, new Error(`Codex stopped before the turn finished (${outcome.reason}).`));
      break;
    }
    default:
  }
  // [local] Stage 5: what still runs is announced again after the turn's end,
  // where a page that reloads from now on is replayed from.
  // (A Stop of ours announced it with its own `complete`.)
  if (outcome.kind !== 'lost' && !run.aborted) {
    background.reannounce();
  }

  scheduleRelease(loadedThreadId);
}

/** The prompts a session still has open, as the chat lists them (`pendingPermissions`). */
function listPendingPrompts(sessionId: string): AnyRecord[] {
  return promptsWhere((prompt) => prompt.sessionKey === sessionId || prompt.threadId === sessionId).map((prompt) => ({
    requestId: prompt.requestId,
    toolName: prompt.toolName,
    input: prompt.input,
    context: prompt.context,
    sessionId,
    receivedAt: prompt.receivedAt,
  }));
}

/**
 * A `complete` that lists the prompts still open (a denied review's "Allow
 * anyway" outlives its turn); the client keeps exactly those. Without the
 * list, `complete` clears every prompt, as before.
 */
function withPendingPrompts(message: AnyRecord, sessionKey: string): AnyRecord {
  const pending = listPendingPrompts(sessionKey);
  return pending.length > 0 ? { ...message, pendingPermissions: pending } : message;
}

/**
 * "Allow anyway" for an action the automatic reviewer denied: records the
 * user's approval in the thread (`thread/approveGuardianDeniedAction`), which
 * Codex adds to the conversation for the model's next step; the retry is
 * still reviewed. The thread is loaded again first if it was released since.
 */
async function approveDeniedAction(threadId: string, review: AnyRecord): Promise<boolean> {
  preparingRuns += 1;
  try {
    await connection.ensureStarted();
    installExitHook();
    const pendingRelease = releasing.get(threadId);
    if (pendingRelease) {
      await pendingRelease;
    }
    if (!loadedThreads.has(threadId)) {
      const loadParams = threadLoadParams.get(threadId) ?? {};
      const result = await connection.request('thread/resume', { threadId, excludeTurns: true, ...loadParams }) as AnyRecord | undefined;
      loadedThreads.set(threadId, {
        threadId,
        sandboxMode: (loadParams.sandbox as SandboxMode | undefined) ?? 'workspace-write',
        baselineReviewer: typeof result?.approvalsReviewer === 'string' ? result.approvalsReviewer : 'user',
        releaseTimer: null,
        releaseWhenIdle: false,
      });
    }
    await connection.request('thread/approveGuardianDeniedAction', { threadId, event: toGuardianAssessmentEvent(review) });
    return true;
  } catch (error) {
    console.warn(`[Codex] Could not record the approval of a denied action on thread ${threadId}:`, error instanceof Error ? error.message : error);
    return false;
  } finally {
    preparingRuns -= 1;
    if (!runsByThread.has(threadId)) {
      scheduleRelease(threadId);
    }
  }
}

function requestInterrupt(run: ActiveRun) {
  const turnId = run.turnId;
  if (!turnId) {
    return;
  }
  connection.request('turn/interrupt', { threadId: run.threadId, turnId }).catch((error) => {
    console.warn(`[Codex] turn/interrupt failed for thread ${run.threadId}:`, error instanceof Error ? error.message : error);
  });
  // A turn that ignores the interrupt is given up on: the run ends here, and
  // when no other conversation uses the child it is stopped, which ends the
  // turn for certain. Another conversation's turn is never taken down.
  const timer = setTimeout(() => {
    // Only this turn: after "Send now" the run goes on with a new one.
    if (runsByThread.get(run.threadId) !== run || run.turnId !== turnId || run.turnEnded) {
      return;
    }
    console.warn(`[Codex] Turn on thread ${run.threadId} did not stop within ${settings.interruptTimeoutMs}ms.`);
    if (activeRuns.size <= 1) {
      connection.stop('A stopped turn did not end.');
    }
    run.settle({ kind: 'interrupted' });
  }, settings.interruptTimeoutMs);
  timer.unref?.();
}

/**
 * Sends a message into the run's current turn (`turn/steer`, pinned to that
 * turn with `expectedTurnId`). Codex reads it at its next step and reports
 * that with a `userMessage` item whose `clientId` is the message id. False
 * when Codex refuses it (the turn ended, or cannot be steered); the caller
 * then sends it as a new turn.
 */
async function steerInto(run: ActiveRun, input: UserInputItem[], messageId: string): Promise<boolean> {
  if (!run.turnId || run.turnEnded) {
    return false;
  }
  // Before the request: Codex can read the message before it replies.
  run.unread.add(messageId);
  try {
    await connection.request('turn/steer', {
      threadId: run.threadId,
      input,
      expectedTurnId: run.turnId,
      clientUserMessageId: messageId,
    });
    return true;
  } catch (error) {
    run.unread.delete(messageId);
    console.warn(`[Codex] turn/steer refused on thread ${run.threadId}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * `chat.steer` for a Codex conversation on the app-server. A plain steer goes
 * into the running turn. `urgent` ("Send now") stops the current step
 * (`turn/interrupt`) and starts a new turn with the message once it has
 * ended: Codex has no way to read a message at once inside a turn, and
 * `turn/start` on a turn still running would only steer it. False when the
 * session has no turn here that can take the message (exec runtime, ended,
 * stopped); the client then sends it as the next turn.
 */
async function steerAppServerRun(sessionId: string, command: string, options: AnyRecord = {}): Promise<boolean> {
  const run = activeRuns.get(sessionId);
  const messageId = typeof options.messageId === 'string' ? options.messageId : '';
  if (!run || !messageId || run.aborted) {
    return false;
  }
  const input = buildTurnInput(command, options.images, options.files, run.cwd);
  if (run.restarts.length > 0) {
    // A step is being stopped for "Send now": this goes into the turn that follows.
    run.unread.add(messageId);
    run.restarts.push({ input, messageId });
    return true;
  }
  if (!run.turnId && !(await run.turnReady)) {
    return false;
  }
  if (activeRuns.get(sessionId) !== run || run.aborted || run.turnEnded) {
    return false;
  }
  if (options.urgent !== true) {
    return steerInto(run, input, messageId);
  }
  run.unread.add(messageId);
  run.restarts.push({ input, messageId });
  requestInterrupt(run);
  return true;
}

/** Stop: interrupts the turn only (`turn/interrupt`); the thread stays loaded. */
function abortAppServerRun(sessionId: string): boolean {
  const run = activeRuns.get(sessionId);
  if (!run) {
    return false;
  }
  if (run.aborted) {
    return true;
  }
  run.aborted = true;
  // The stopped turn asks nothing more; its prompts go at once.
  for (const prompt of promptsWhere((entry) => entry.threadId === run.threadId)) {
    prompt.cancel('cancelled');
  }
  requestInterrupt(run);
  // [local] Stage 4: Stop ends only the turn. Background terminals and
  // subagents are not stopped here; when any still runs, the `complete` says
  // so, and the chat stays in its background state with them listed. (The
  // chat handler's own `complete` that follows is dropped as a duplicate.)
  const tracker = backgroundByThread.get(run.threadId);
  const stillPending = listPendingPrompts(run.sessionKey);
  sendMessage(run.ws, {
    ...createCompleteMessage({ provider: 'codex', sessionId: run.rowSessionId, exitCode: 0, aborted: true }),
    backgroundContinues: Boolean(tracker?.hasLiveWork()),
    ...(stillPending.length > 0 ? { pendingPermissions: stillPending } : {}),
  });
  // [local] Stage 5: as after any turn's end (see driveTurn).
  tracker?.reannounce();
  return true;
}

/**
 * Releases the session's thread now, or as soon as its turn ends ("session
 * closed": archived or deleted).
 */
function releaseAppServerSession(sessionId: string): void {
  const threadId = sessionThreads.get(sessionId) ?? sessionId;
  sessionThreads.delete(sessionId);
  for (const prompt of promptsWhere((entry) => entry.kind === 'reviewDenial' && (entry.sessionKey === sessionId || entry.threadId === threadId))) {
    prompt.cancel('cancelled');
  }
  const thread = loadedThreads.get(threadId);
  if (!thread) {
    return;
  }
  if (runsByThread.has(threadId)) {
    thread.releaseWhenIdle = true;
    return;
  }
  // [local] Stage 4: a closed session's background terminals are stopped.
  void releaseThread(threadId, { stopWork: true });
}

/** [local] Stage 4: the tracker of the session's thread, while that thread is loaded here. */
function backgroundOfSession(sessionId: string): CodexThreadBackground | undefined {
  const threadId = sessionThreads.get(sessionId) ?? sessionId;
  return loadedThreads.has(threadId) ? backgroundByThread.get(threadId) : undefined;
}

/** [local] Stage 4: every session with background terminals or subagents still running. */
function listAppServerBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
  const entries: Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> = [];
  for (const tracker of backgroundByThread.values()) {
    const sessionId = tracker.sessionKey;
    if (!sessionId || !loadedThreads.has(tracker.threadId)) {
      continue;
    }
    const tasks = tracker.listTasks();
    if (tasks.length > 0) {
      entries.push({ sessionId, tasks });
    }
  }
  return entries;
}

/** [local] Stage 4: stops one background terminal of the session (its task id is Codex's process id). */
async function stopAppServerBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
  const tracker = backgroundOfSession(sessionId);
  if (!tracker || !tracker.terminals.has(taskId) || !connection.isRunning()) {
    return false;
  }
  return tracker.stopTerminal(taskId);
}

/** [local] Stage 4: "Stop all background work": every background terminal of the session. */
async function stopAllAppServerBackgroundWork(sessionId: string): Promise<boolean> {
  const tracker = backgroundOfSession(sessionId);
  if (!tracker || !connection.isRunning()) {
    return false;
  }
  return tracker.stopAllTerminals();
}

/** Stops the child; for server shutdown. */
function shutdownAppServerRuntime(): void {
  for (const prompt of [...pendingPrompts.values()]) {
    prompt.cancel('cancelled', 'none');
  }
  for (const thread of loadedThreads.values()) {
    cancelRelease(thread);
  }
  loadedThreads.clear();
  for (const threadId of [...backgroundByThread.keys()]) {
    dropBackground(threadId);
  }
  connection.stop('CloudCLI is shutting down.');
}

export const codexAppServerRuntime = {
  settings,
  run: runAppServerTurn,
  abort: abortAppServerRun,
  steer: steerAppServerRun,
  releaseSession: releaseAppServerSession,
  shutdown: shutdownAppServerRuntime,
  /** [local] Stage 4: background terminals and subagents. */
  listBackgroundWork: listAppServerBackgroundWork,
  stopBackgroundTask: stopAppServerBackgroundTask,
  stopAllBackgroundWork: stopAllAppServerBackgroundWork,
  /** The chat's answers to approvals, questions and "Allow anyway" (stage 3). */
  permissions: {
    resolve: (requestId: string, decision: ProviderPermissionDecision) => {
      pendingPrompts.get(requestId)?.answer(decision);
    },
    listPending: listPendingPrompts,
  },
  /** Whether the session has a turn running in this runtime. */
  isRunning: (sessionId: string) => activeRuns.has(sessionId),
  /** Thread ids currently loaded (for tests and diagnostics). */
  loadedThreadIds: () => [...loadedThreads.keys()],
  /** Whether the shared child is up (for tests and diagnostics). */
  isAppServerRunning: () => connection.isRunning(),
};
