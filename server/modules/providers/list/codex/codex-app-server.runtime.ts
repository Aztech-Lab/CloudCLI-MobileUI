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
 * Threads are released after a short idle period (`thread/unsubscribe`) so the
 * Codex desktop app can take them over; when no thread is left the child
 * itself is stopped, which frees the writer lock at once (measured against
 * Codex 0.169: after `thread/unsubscribe` the app-server keeps a thread loaded
 * and locked for about 60 seconds before `thread/closed`).
 */

import type { ModelReasoningEffort } from '@openai/codex-sdk';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  createCompleteMessage,
  createNormalizedMessage,
  normalizeImageDescriptors,
} from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

import { codexAppServer } from './codex-app-server.client.js';
import {
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
  requests: ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'thread/unsubscribe'],
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
  ],
  /** Server → client requests this runtime answers (all declined for now). */
  serverRequests: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
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

/** Which runtime `CLOUDCLI_CODEX_RUNTIME` selects. Anything but `appserver` is exec. */
export function resolveCodexRuntimeMode(value = process.env.CLOUDCLI_CODEX_RUNTIME): 'appserver' | 'exec' {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'appserver' || normalized === 'app-server' ? 'appserver' : 'exec';
}

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
};

/**
 * Exec has no channel to a person, so an approval request there can only be
 * refused. Stage 1 keeps exactly that: every request is declined (approvals
 * reach the user in a later stage). "Approve for me" is unaffected, since its
 * reviews run inside Codex and never reach the client.
 */
async function declineServerRequest(method: string): Promise<unknown> {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: 'No one is available to approve this request.' } } };
    default:
      throw new Error(`CloudCLI does not support "${method}" yet.`);
  }
}

const connection = new CodexAppServerConnection({
  // Through the exported client object so tests swap in a fake app-server
  // script the same way they do for forks and side questions.
  resolveLauncher: () => codexAppServer.resolveLauncher(),
  handleServerRequest: declineServerRequest,
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

type ActiveRun = {
  sessionKey: string;
  threadId: string;
  turnId: string | null;
  aborted: boolean;
  settle: (outcome: TurnOutcome) => void;
  /** Resolves once the run has fully ended (listeners removed). */
  finished: Promise<void>;
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

connection.onExit(() => {
  // Every loaded thread went with the child; the next message resumes it.
  for (const thread of loadedThreads.values()) {
    if (thread.releaseTimer) {
      clearTimeout(thread.releaseTimer);
    }
  }
  loadedThreads.clear();
});

connection.onNotification((method, params) => {
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
  }
});

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
      // What exec prints as a generic `collab_tool_call` row; subagent cards
      // come in a later stage.
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
    void releaseThread(threadId);
    return;
  }
  thread.releaseTimer = setTimeout(() => {
    thread.releaseTimer = null;
    void releaseThread(threadId);
  }, settings.idleReleaseMs);
  thread.releaseTimer.unref?.();
}

/** Unsubscribes an idle thread; stops the child once nothing is left on it. */
async function releaseThread(threadId: string): Promise<void> {
  const thread = loadedThreads.get(threadId);
  if (!thread || runsByThread.has(threadId)) {
    return;
  }
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

  const promptWithFiles = appendFilesInputTag(command, files);
  const promptForTurn = !promptWithFiles.trim() && normalizeImageDescriptors(images).length > 0
    ? CODEX_IMAGE_ONLY_PROMPT
    : promptWithFiles;
  const input = toUserInput(promptForTurn, images, workingDirectory);

  // Until the first message reaches the client, any app-server failure that
  // means "unusable" hands the message to exec instead.
  let wroteToClient = false;
  const send = (message: unknown) => {
    wroteToClient = true;
    sendMessage(ws, message);
  };

  const failRun = (sessionForRow: string | null, error: unknown) => {
    const runError = error instanceof Error ? error : new Error(String(error));
    console.error('[Codex] app-server error:', runError.message);
    if (isCodexThreadActiveWriterError(runError.message)) {
      send(createCodexActiveWriterErrorMessage(sessionForRow));
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
      failRun(threadId || sessionId || null, error);
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
  }
  cancelRelease(thread);
  thread.releaseWhenIdle = false;
  const loadedThreadId: string = thread.threadId;
  const rowSessionId = loadedThreadId || sessionId || null;
  const sessionKey: string = sessionId || loadedThreadId;
  if (sessionId) {
    sessionThreads.set(sessionId, loadedThreadId);
  }

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
  const turnDone = new Promise<TurnOutcome>((resolve) => {
    let settled = false;
    settleTurn = (outcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
  });

  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const run: ActiveRun = { sessionKey, threadId: loadedThreadId, turnId: null, aborted: false, settle: settleTurn, finished };

  const forward = (event: AnyRecord) => {
    for (const message of context.normalizeMessage(event, rowSessionId)) {
      send(message);
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
        const phase = method === 'item/started' ? 'started' : 'completed';
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
          send(createCodexActiveWriterErrorMessage(rowSessionId));
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
    removeNotificationListener();
    removeExitListener();
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
  try {
    const result = await connection.request('turn/start', turnParams) as AnyRecord | undefined;
    if (!run.turnId && typeof result?.turn?.id === 'string') {
      run.turnId = result.turn.id;
    }
    thread.sandboxMode = sandboxMode;
  } catch (error) {
    cleanup();
    if (shouldFallBack(error) && !wroteToClient) {
      if (isNewThread) {
        // Nothing ran on it; let it go rather than leave it loaded.
        void releaseThread(loadedThreadId);
      } else {
        scheduleRelease(loadedThreadId);
      }
      throw new CodexAppServerFallbackError(error instanceof Error ? error.message : String(error));
    }
    failRun(rowSessionId, error);
    scheduleRelease(loadedThreadId);
    return;
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
  if (run.aborted && run.turnId) {
    // Stop was pressed while turn/start was in flight.
    requestInterrupt(run);
  }

  const outcome = await turnDone;
  cleanup();

  // 5. Finish the way the exec path finishes.
  switch (outcome.kind) {
    case 'completed': {
      const tokenBudget = tokenBudgetFrom(latestTokenUsage);
      if (tokenBudget) {
        send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: rowSessionId, provider: 'codex' }));
      }
      send(createCompleteMessage({ provider: 'codex', sessionId: rowSessionId, actualSessionId: loadedThreadId, exitCode: 0 }));
      notifyRunStopped({ userId: ws?.userId || null, provider: 'codex', sessionId: sessionId || loadedThreadId, sessionName: sessionSummary, stopReason: 'completed' });
      break;
    }
    case 'failed': {
      const message = outcome.message || 'Turn failed';
      if (isCodexThreadActiveWriterError(message)) {
        if (!writerConflictShown) {
          send(createCodexActiveWriterErrorMessage(rowSessionId));
        }
      } else {
        forward({ type: 'turn_failed', error: { message } });
      }
      send(createCompleteMessage({ provider: 'codex', sessionId: rowSessionId, actualSessionId: loadedThreadId, exitCode: 1 }));
      notifyRunFailed({ userId: ws?.userId || null, provider: 'codex', sessionId: sessionId || loadedThreadId, sessionName: sessionSummary, error: new Error(message) });
      break;
    }
    case 'interrupted': {
      if (!run.aborted) {
        // Interrupted by someone else (another client of this thread); end
        // the run here, since no Stop path will.
        send(createCompleteMessage({ provider: 'codex', sessionId: rowSessionId, actualSessionId: loadedThreadId, exitCode: 0, aborted: true }));
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

  scheduleRelease(loadedThreadId);
}

function requestInterrupt(run: ActiveRun) {
  if (!run.turnId) {
    return;
  }
  connection.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch((error) => {
    console.warn(`[Codex] turn/interrupt failed for thread ${run.threadId}:`, error instanceof Error ? error.message : error);
  });
  // A turn that ignores the interrupt is given up on: the run ends here, and
  // when no other conversation uses the child it is stopped, which ends the
  // turn for certain. Another conversation's turn is never taken down.
  const timer = setTimeout(() => {
    if (runsByThread.get(run.threadId) !== run) {
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
  requestInterrupt(run);
  return true;
}

/**
 * Releases the session's thread now, or as soon as its turn ends ("session
 * closed": archived or deleted).
 */
function releaseAppServerSession(sessionId: string): void {
  const threadId = sessionThreads.get(sessionId) ?? sessionId;
  sessionThreads.delete(sessionId);
  const thread = loadedThreads.get(threadId);
  if (!thread) {
    return;
  }
  if (runsByThread.has(threadId)) {
    thread.releaseWhenIdle = true;
    return;
  }
  void releaseThread(threadId);
}

/** Stops the child; for server shutdown. */
function shutdownAppServerRuntime(): void {
  for (const thread of loadedThreads.values()) {
    cancelRelease(thread);
  }
  loadedThreads.clear();
  connection.stop('CloudCLI is shutting down.');
}

export const codexAppServerRuntime = {
  settings,
  run: runAppServerTurn,
  abort: abortAppServerRun,
  releaseSession: releaseAppServerSession,
  shutdown: shutdownAppServerRuntime,
  /** Whether the session has a turn running in this runtime. */
  isRunning: (sessionId: string) => activeRuns.has(sessionId),
  /** Thread ids currently loaded (for tests and diagnostics). */
  loadedThreadIds: () => [...loadedThreads.keys()],
  /** Whether the shared child is up (for tests and diagnostics). */
  isAppServerRunning: () => connection.isRunning(),
};
