/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ElicitationRequest, ElicitationResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { askClaudeSideQuestion } from '@/modules/providers/list/claude/claude-side-question.provider.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  getReportedClaudeContextWindow,
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import {
  ADOPT_UNAVAILABLE_ERROR_CODE,
  AppError,
  createCompleteMessage,
  createNormalizedMessage,
  errorMessage,
  UUID_PATTERN,
} from '@/shared/utils.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SideQuestionRequest,
  SideQuestionSink,
  SideQuestionOutcome,
} from '@/shared/types.js';

// The notifications module is still JavaScript, and its defaults (`dedupeKey = null`)
// infer as the only accepted types; this states the shape callers really pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;

type ClaudeQuery = ReturnType<NonNullable<ProviderRuntimeContext['createQuery']>>;

/**
 * The run's writer: the WebSocket writer adds a socket swap for reconnects, and
 * [local] the chat gateway's writer can take over the sockets of the writer a
 * held process was streaming to when a new send adopts that process.
 */
type ClaudeRuntimeWriter = ProviderRuntimeWriter & {
  updateWebSocket?(rawWs: unknown): void;
  adoptConnectionsFrom?(previous: unknown): void;
};

type ActiveSession = {
  instance: ClaudeQuery;
  startTime: number;
  status: 'active' | 'aborted';
  writer: ClaudeRuntimeWriter | null;
  releaseInput: (() => void) | null;
  // Set the moment `releaseInput` actually runs (idle ceiling, or the turn
  // ending with no background work left). A native side question writes
  // into that same stdin, and the SDK drops a write after it has been
  // released rather than erroring, so this flag is the only signal
  // `askSideQuestion` has to fall back to the read-only fork instead.
  inputReleased: boolean;
  // Count of `askSideQuestion` native calls currently in flight against
  // this entry's live query. Carried across the mid-run re-registration
  // below (same process, same question), reset only when superseded.
  pendingNativeSideQuestions: number;
  // Set when a release was requested (turn end, idle ceiling) while the
  // count above was still positive, so the last question to settle knows
  // to pick the deferred release back up.
  releaseDeferred: boolean;
  /**
   * Delivers a user message into the running turn (see steerClaudeSDKSession).
   * Resolves false once the turn has ended and the message can no longer join
   * it; the caller then falls back to an ordinary next turn.
   */
  steerInput: SteerInput | null;
  /**
   * [local] Withdraws a steered message the CLI has not read yet
   * (`cancel_async_message`). Resolves true only when the CLI dropped it.
   */
  cancelSteer: CancelSteer | null;
  // [local] Entry points of an adoptable run (a chat turn dispatched through
  // the gateway, `options.adoptable`), carried across the mid-run
  // re-registration like `steerInput`. All null for any other run, which
  // keeps every path below exactly as it was.
  /** Writes a new send into this held process as a turn of its own (see `adoptTurn` in queryClaudeSDK). */
  adoptTurn: AdoptTurn | null;
  /** Stops only the adopted turn, leaving the work that existed at adoption running. */
  interruptTurn: (() => Promise<boolean>) | null;
  /** Whether a Stop now should take `interruptTurn` rather than the full abort. */
  canInterruptTurnOnly: (() => boolean) | null;
  /** Cancels an adoption that is still being set up (nothing pushed yet). */
  cancelAdoption: (() => void) | null;
  /**
   * Withdraws an adopted message that was pushed but not read yet, before a
   * full Stop interrupts the process: cancelled in the CLI's queue when
   * possible, otherwise interrupted the moment it starts.
   */
  cancelPendingAdopted: (() => Promise<void>) | null;
  /** Asks for the release `maybeReleasePromptStream` would do, honouring an adoption in flight. */
  requestRelease: (() => void) | null;
  /**
   * Stops every background task of the process and, when no turn of the
   * user's is running, lets the process go. False when there was nothing to stop.
   */
  stopAllBackground: (() => boolean) | null;
};

/** [local] What a send that adopts a held process hands that process's run. */
type AdoptRequest = {
  command: string;
  images?: unknown;
  files?: unknown;
  /** The id the client asked for; the held run checks it and makes it unique. */
  messageId: string;
  writer: ClaudeRuntimeWriter;
  /** The adopting send's options (model, effort, permission mode, tools). */
  options: AnyRecord;
  /** The provider-native id the adopting send resolved from the session row. */
  providerSessionId: string | null;
  context: ProviderRuntimeContext;
};

/**
 * [local] `adopted: false` means the held run could not take the send (the
 * caller falls back, or refuses with ADOPT_UNAVAILABLE); `done` settles once
 * the adopted turn has been reported complete on the request's writer.
 */
type AdoptOutcome = { adopted: false } | { adopted: true; done: Promise<void> };

type AdoptTurn = (request: AdoptRequest) => Promise<AdoptOutcome>;

/** [local] The hooks an adoptable run registers on its ActiveSession. */
type AdoptionHooks = Pick<ActiveSession, 'adoptTurn' | 'interruptTurn' | 'canInterruptTurnOnly' | 'cancelAdoption' | 'cancelPendingAdopted' | 'requestRelease' | 'stopAllBackground'>;

/**
 * [local] One attempt to adopt a held process. `cancelled` is set by a Stop
 * that lands before anything was pushed; `abandoned` settles at that moment so
 * a control request still in flight is not waited on. `decided` settles once
 * the attempt has pushed its message or given up, which is what a steer sent
 * meanwhile waits for.
 */
type AdoptAttempt = {
  cancelled: boolean;
  pushed: boolean;
  writer: ClaudeRuntimeWriter;
  decided: Promise<void>;
  markDecided: () => void;
  abandoned: Promise<void>;
  abandon: () => void;
};

function createAdoptAttempt(writer: ClaudeRuntimeWriter): AdoptAttempt {
  let markDecided!: () => void;
  let abandon!: () => void;
  const decided = new Promise<void>((resolve) => { markDecided = resolve; });
  const abandoned = new Promise<void>((resolve) => { abandon = resolve; });
  return { cancelled: false, pushed: false, writer, decided, markDecided, abandoned, abandon };
}

/** What a steered message carries: its text, attachments, and the id it is tracked by. */
type SteerRequest = {
  command: string;
  images?: unknown;
  files?: unknown;
  messageId: string;
  /**
   * [local] "Send now": the message is read at once instead of at the next
   * tool-call boundary (see `steerIntoTurn`).
   */
  urgent?: boolean;
};

type SteerInput = (request: SteerRequest) => Promise<boolean>;

/** [local] Withdraws an unread steered message by its id; true when the CLI dropped it. */
type CancelSteer = (messageId: string) => Promise<boolean>;

// [local] Main-thread tools whose running call the CLI can move to the
// background (`backgroundTasks`, Ctrl+B in the terminal): shell commands and
// subagents. `Task` is the older name of `Agent`.
const BACKGROUNDABLE_TOOL_NAMES = new Set(['Bash', 'PowerShell', 'Agent', 'Task']);

type ToolApprovalDecision = AnyRecord | null;

/** A pending approval's resolver, carrying the lookup fields getPendingApprovalsForSession reads. */
type ToolApprovalResolver = ((decision: ToolApprovalDecision) => void) & AnyRecord;

/**
 * A context-window reading. `used` is what the window holds; `total` is its size.
 */
type TokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: { input: number; output: number };
};

const activeSessions = new Map<string, ActiveSession>();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map<string, ToolApprovalResolver>();
// Query instances cancelled via abort-session. The abort handler already sent
// the terminal `complete` (aborted: true) to the client, so the run loop must
// not emit a second one when its generator winds down. [local] Keyed by the
// instance, not the session id: a session-keyed flag outlived the aborted
// process's loop and swallowed the `complete` of the next run on the session.
const abortedInstances = new WeakSet<ClaudeQuery>();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet<ClaudeQuery>();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || 55000;

// How long a held process may stay silent before it is let go. This drives
// two halves of the same behaviour:
//
//  1. ([local] now the hold bound below) Passed to the spawned CLI as
//     CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how long it waits for
//     still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
//
// [local] This short ceiling now applies only while no tracked background task is
// running (a hold for a ScheduleWakeup, a cron, a relay that never came). While one
// is, a long build or test run may say nothing for hours, and the official client
// puts no limit on it; the hold then lasts up to CLOUDCLI_BG_MAX_HOLD_MS instead.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

// [local] Upper bound on how long a held process with background tasks still
// running may go without a single stream message (CLOUDCLI_BG_MAX_HOLD_MS,
// default 12 hours). When it passes, the tasks are stopped and the process is let
// go, so an abandoned session cannot pin a CLI forever. Also what the CLI is told
// to wait for its agents (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS), so the CLI never
// gives up on an agent before we do.
const DEFAULT_BG_MAX_HOLD_MS = 12 * 60 * 60 * 1000;
// setTimeout's largest delay; a larger one fires at once.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * [local] The hold bound for background tasks that are still running, read from
 * CLOUDCLI_BG_MAX_HOLD_MS. Anything that is not a whole number of milliseconds of
 * at least the idle ceiling falls back to the default (a shorter bound would make
 * running work die sooner than idle holds do); the timer's own limit caps it.
 * @param {NodeJS.ProcessEnv} [hostEnv] - Environment to read, `process.env` by default
 * @returns {number} Milliseconds
 */
export function resolveBackgroundMaxHoldMs(hostEnv: NodeJS.ProcessEnv = process.env): number {
  const raw = hostEnv.CLOUDCLI_BG_MAX_HOLD_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < BG_WAIT_CEILING_MS) {
    return DEFAULT_BG_MAX_HOLD_MS;
  }
  return Math.min(parsed, MAX_TIMER_DELAY_MS);
}

// How long a turn that ended with steered messages still unread waits for the
// follow-up turn the CLI runs them in, before giving up and ending the run.
// That turn normally starts within milliseconds of the `result`; this only
// bounds a CLI that dropped them, so the session is not left processing.
const STEER_FOLLOW_UP_GRACE_MS = 30 * 1000;

// [local] How long a message written into a held process (an adopted send) may
// go unread while the process says nothing at all. The CLI normally starts its
// turn within milliseconds; this only bounds a CLI that never does, so the
// adopting run cannot stay "processing" forever. Reset by any stream message.
const ADOPT_PICKUP_WATCHDOG_MS = 60 * 1000;

// [local] Absolute bound on how long an adopted message may stay unread after
// its push, whatever the stream says meanwhile. The silence watchdog above is
// suspended while the CLI runs a turn of its own (a relay with a long silent
// tool call is legitimately quiet); this only catches a wedged CLI.
const ADOPT_PICKUP_BACKSTOP_MS = 10 * 60 * 1000;

// [local] Bound on each control request sent while adopting or stopping a
// held process. The SDK drops a request written after stdin ended and gives
// it no timeout of its own, so an unbounded await could last as long as the
// CLI's wind-down.
const CONTROL_REQUEST_TIMEOUT_MS = 5 * 1000;

// [local] Shown when an adopted message was never read by the CLI.
const ADOPTED_MESSAGE_NOT_PICKED_UP = 'The message was not picked up by the running Claude process. Please send it again.';

// [local] Permission modes from most to least permissive. Switching a held
// process to a stricter mode must succeed, or the adoption is refused: the
// turn would otherwise run with more permission than the user chose. An
// unknown mode ranks as strictest.
const PERMISSION_MODE_STRICTNESS: Record<string, number> = {
  bypassPermissions: 0,
  auto: 1,
  acceptEdits: 2,
  default: 3,
  plan: 4,
};

function isStricterPermissionMode(target: string, current: string): boolean {
  const rank = (mode: string) => PERMISSION_MODE_STRICTNESS[mode] ?? Number.MAX_SAFE_INTEGER;
  return rank(target) > rank(current);
}

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// An MCP server's request for input travels as a permission request under this
// name. It is not a tool the model can call: the name routes the request to the
// client's McpElicitation panel and keys it in the pending-approval list, so a
// page refresh replays it like any other prompt.
const MCP_ELICITATION_TOOL_NAME = 'McpElicitation';

/**
 * Turns the client's answer to an McpElicitation request into the MCP result.
 * The panel accepts with `updatedInput.content` and declines with a denial. No
 * answer at all (an abort, a closed run) is `cancel`, never an invented accept.
 */
function toElicitationResult(decision: ToolApprovalDecision, mode: ElicitationRequest['mode']): ElicitationResult {
  if (!decision || decision.cancelled) {
    return { action: 'cancel' };
  }
  if (!decision.allow) {
    return { action: 'decline' };
  }
  // A URL request is accepted without content: accepting is consent to open
  // the page, and the server learns the outcome from the page itself.
  if (mode === 'url') {
    return { action: 'accept' };
  }
  const content = (decision.updatedInput as AnyRecord | undefined)?.content;
  const fields: Record<string, string | number | boolean | string[]> = {};
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    for (const [key, value] of Object.entries(content as AnyRecord)) {
      // Form fields are flat primitives, or string lists for multi-select.
      const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      const isStringList = Array.isArray(value) && value.every((item) => typeof item === 'string');
      if (isPrimitive || isStringList) {
        fields[key] = value as string | number | boolean | string[];
      }
    }
  }
  return { action: 'accept', content: fields };
}

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(
  model: string,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions: AnyRecord, resolvedEffort: string | undefined) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

/**
 * [local] The same choice as `applyClaudeEffort`, for a live process
 * (`applyFlagSettings`). Both keys are always sent: an `effortLevel` change
 * without an `ultracode` key turns ultracode off, and going back to the
 * model's default needs `effortLevel: null` rather than no key at all.
 */
function toEffortFlagSettings(resolvedEffort: string | undefined): AnyRecord {
  if (resolvedEffort === CLAUDE_ULTRACODE_EFFORT) {
    return { effortLevel: ULTRACODE_SDK_EFFORT, ultracode: true, enableWorkflows: true };
  }
  if (resolvedEffort) {
    return { effortLevel: resolvedEffort, ultracode: false };
  }
  return { effortLevel: null, ultracode: false };
}

/**
 * [local] Sends one control request to a held process and resolves whether it
 * succeeded. `send` returns undefined when the query has no such method, which
 * counts as a failure, as do a rejection, CONTROL_REQUEST_TIMEOUT_MS without an
 * answer, and `abandon` settling first (an adoption cancelled meanwhile).
 */
function sendControlRequest(send: () => Promise<unknown> | undefined, abandon?: Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(succeeded);
    };
    const timer = setTimeout(() => finish(false), CONTROL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    abandon?.then(() => finish(false), () => finish(false));
    try {
      const request = send();
      if (!request) {
        finish(false);
        return;
      }
      request.then(() => finish(true), (error: unknown) => {
        console.warn('[Claude SDK] Control request failed:', errorMessage(error));
        finish(false);
      });
    } catch (error) {
      console.warn('[Claude SDK] Control request failed:', errorMessage(error));
      finish(false);
    }
  });
}

/**
 * [local] Asks the CLI to drop a uuid-stamped message it has queued but not run
 * (`cancel_async_message`). SDK 0.3.311 ships the method without typing it, so
 * it is read through a guard; a missing method, a failure or a timeout all
 * count as "not cancelled".
 */
function cancelQueuedMessage(instance: ClaudeQuery, uuid: string): Promise<boolean> {
  const cancel = (instance as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<unknown> }).cancelAsyncMessage;
  if (typeof cancel !== 'function') {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONTROL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      Promise.resolve(cancel.call(instance, uuid)).then(
        (cancelled) => { clearTimeout(timer); resolve(cancelled === true); },
        () => { clearTimeout(timer); resolve(false); },
      );
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * [local] Asks the CLI to move running foreground tasks (shell commands and
 * subagents) to the background, as Ctrl+B does in the terminal: each blocking
 * tool call returns at once and the turn goes on while the task keeps running.
 * With `toolUseId`, only the task that tool call started. A missing method, a
 * refusal (background tasks disabled), a failure or a timeout all resolve
 * false; so does a `toolUseId` that matched no foreground task.
 */
function requestBackgroundTasks(instance: ClaudeQuery, toolUseId?: string): Promise<boolean> {
  const background = instance.backgroundTasks;
  if (typeof background !== 'function') {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONTROL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const settle = (backgrounded: boolean) => { clearTimeout(timer); resolve(backgrounded); };
    try {
      Promise.resolve(background.call(instance, toolUseId)).then(
        (backgrounded) => settle(backgrounded !== false),
        (error: unknown) => {
          console.warn('[Claude SDK] Moving work to the background failed:', errorMessage(error));
          settle(false);
        },
      );
    } catch (error) {
      console.warn('[Claude SDK] Moving work to the background failed:', errorMessage(error));
      settle(false);
    }
  });
}

/**
 * [local] Updates the running main-thread tool calls from one stream message:
 * an assistant `tool_use` block starts one, a `tool_result` block in a user
 * message ends it, and a turn's `result` ends them all. Subagent messages
 * (`parent_tool_use_id` set) and stdin echoes are not the main thread's calls.
 */
function trackForegroundToolCalls(message: AnyRecord, calls: Map<string, string>): void {
  if (message.type === 'result') {
    calls.clear();
    return;
  }
  if (message.parent_tool_use_id || message.isReplay === true) {
    return;
  }
  const content = (message.message as AnyRecord | undefined)?.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content as AnyRecord[]) {
    if (message.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
      calls.set(block.id, typeof block.name === 'string' ? block.name : '');
    } else if (message.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      calls.delete(block.tool_use_id);
    }
  }
}

/** [local] The uuids an interrupt receipt says will still run, or null for a CLI that sends no receipt. */
function readStillQueued(receipt: unknown): string[] | null {
  const stillQueued = (receipt as AnyRecord | null | undefined)?.still_queued;
  return Array.isArray(stillQueued) ? stillQueued.filter((id): id is string => typeof id === 'string') : null;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

type ToolApprovalWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: (reason: string) => void;
  metadata?: AnyRecord;
};

function waitForToolApproval(requestId: string, options: ToolApprovalWaitOptions = {}): Promise<ToolApprovalDecision> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ToolApprovalDecision>(resolve => {
    let settled = false;

    const finalize = (decision: ToolApprovalDecision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ToolApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId: string, decision: ToolApprovalDecision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string, toolName: string, input: unknown) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof (input as AnyRecord).command === 'string') {
      command = (input as AnyRecord).command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 *
 * @param {NodeJS.ProcessEnv} [hostEnv] - Environment to forward, `process.env` by default
 * @returns {NodeJS.ProcessEnv} Environment for the spawned CLI
 */
export function buildClaudeSdkEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claudecodeui',
    ...hostEnv,
    // [local] The long bound, not the idle ceiling: see resolveBackgroundMaxHoldMs.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(resolveBackgroundMaxHoldMs(hostEnv)),
  };
}

function mapCliOptionsToSDK(options: AnyRecord = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions: AnyRecord = {};

  sdkOptions.env = buildClaudeSdkEnv();

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {Function} steerInput - Pushes a user message into the running turn
 * @param {Object} adoption - [local] The adoption entry points of an adoptable run
 * @param {Function} cancelSteer - [local] Withdraws an unread steered message
 */
function addSession(
  sessionId: string,
  queryInstance: ClaudeQuery,
  writer: ClaudeRuntimeWriter | null = null,
  releaseInput: (() => void) | null = null,
  steerInput: SteerInput | null = null,
  adoption: AdoptionHooks | null = null,
  cancelSteer: CancelSteer | null = null,
) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, which would
  // mark the old run aborted and go through its whole Stop path.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding && existing) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.releaseInput?.();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  }
  const carried = superseding ? null : existing;
  const sessionEntry: ActiveSession = {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Set the moment `releaseInput` actually runs (idle ceiling, or the turn
    // ending with no background work left). A native side question writes
    // into that same stdin, and the SDK drops a write after it has been
    // released rather than erroring, so this flag is the only signal
    // `askSideQuestion` has to fall back to the read-only fork instead.
    inputReleased: false,
    releaseInput: null,
    // Count of `askSideQuestion` native calls currently in flight against
    // this entry's live query. Carried across the mid-run re-registration
    // below (same process, same question), reset only when superseded.
    pendingNativeSideQuestions: carried?.pendingNativeSideQuestions || 0,
    // Set when a release was requested (turn end, idle ceiling) while the
    // count above was still positive, so the last question to settle knows
    // to pick the deferred release back up.
    releaseDeferred: carried?.releaseDeferred || false,
    // Re-registered mid-run once the provider session id lands; keep the
    // steer entry point like the closer below.
    steerInput: steerInput || carried?.steerInput || null,
    // [local] Carried the same way as `steerInput`.
    cancelSteer: cancelSteer || carried?.cancelSteer || null,
    // [local] Carried the same way as `steerInput`.
    adoptTurn: adoption?.adoptTurn ?? carried?.adoptTurn ?? null,
    interruptTurn: adoption?.interruptTurn ?? carried?.interruptTurn ?? null,
    canInterruptTurnOnly: adoption?.canInterruptTurnOnly ?? carried?.canInterruptTurnOnly ?? null,
    cancelAdoption: adoption?.cancelAdoption ?? carried?.cancelAdoption ?? null,
    cancelPendingAdopted: adoption?.cancelPendingAdopted ?? carried?.cancelPendingAdopted ?? null,
    requestRelease: adoption?.requestRelease ?? carried?.requestRelease ?? null,
    stopAllBackground: adoption?.stopAllBackground ?? carried?.stopAllBackground ?? null,
  };
  // Re-registered mid-run once the provider session id lands; keep the closer.
  const effectiveReleaseInput = releaseInput || carried?.releaseInput || null;
  sessionEntry.releaseInput = effectiveReleaseInput
    ? () => {
      sessionEntry.inputReleased = true;
      effectiveReleaseInput();
    }
    : null;
  activeSessions.set(sessionId, sessionEntry);
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Lets go of the process an earlier run left holding a session open, so the
 * next turn can take the session over.
 *
 * Closing stdin is not enough on its own: the CLI's wind-down waits for the
 * background agents the process still has going — for up to the ceiling it
 * was started with ([local] the hold bound, hours) — so an abandoned process with an
 * agent outstanding would run next to the process that replaced it for as
 * long as the agent does, both appending to the same session file. Stop the
 * tasks first, while stdin is still open: the SDK drops control requests
 * written after stdin has ended, which is also why the interrupt a later
 * supersede sends to this process cannot do the job.
 *
 * The stops are not awaited — each request is written to the CLI before this
 * returns, and a reply is only missing when the process has already gone.
 * @param {string} sessionId - Session identifier
 */
function releaseHeldSession(sessionId: string) {
  const held = getSession(sessionId);
  if (!held) {
    return;
  }
  sendTaskStops(held.instance, backgroundWork.outstanding(sessionId));
  held.releaseInput?.();
}

/**
 * Writes a `stop_task` for each task to the process, without waiting for the
 * answers. Shared by releaseHeldSession and ([local]) the Stop paths, which
 * need the same guarantee: the requests are on stdin before anything closes it.
 */
function sendTaskStops(instance: ClaudeQuery | undefined, tasks: BackgroundTaskSummary[]) {
  for (const task of tasks) {
    // A stop that cannot be delivered changes nothing about what happens
    // next: the process is on its way out either way. Guard the synchronous
    // call too, so a failing stop can never skip what follows.
    try {
      Promise.resolve(instance?.stopTask?.(task.taskId)).catch(() => {});
    } catch {
      // Same as a rejected stop.
    }
  }
}

/**
 * [local] A `chat.send` that asked to go into the session's held process
 * (`options.adoptHeld`, set by the client only when its composer shows
 * background work and the send is not an edit). Hands it to the held run's
 * `adoptTurn` and waits for the adopted turn to be reported complete.
 *
 * Resolves true when the send was adopted (or cancelled by a Stop while being
 * set up): the caller is done. Resolves false when there is nothing to adopt,
 * so the caller goes on exactly as before (stop the held work, spawn). Throws
 * an ADOPT_UNAVAILABLE AppError when the held process could not take the send
 * while it still has background work outstanding: the client promised the
 * user that work keeps running, so it is neither stopped nor replaced.
 */
async function adoptHeldSession(
  sessionKey: string,
  command: string,
  options: AnyRecord,
  writer: ClaudeRuntimeWriter,
  context: ProviderRuntimeContext,
  providerSessionId: string | null,
): Promise<boolean> {
  const held = getSession(sessionKey);
  if (!held || held.status !== 'active' || held.inputReleased) {
    return false;
  }
  const requestedId = typeof options.messageId === 'string' ? options.messageId.trim() : '';
  let outcome: AdoptOutcome = { adopted: false };
  // Slash content is not adopted until a probe confirms the CLI echoes it
  // with our uuid: without that echo the adopted turn never starts for us.
  if (held.adoptTurn && !command.trimStart().startsWith('/')) {
    try {
      outcome = await held.adoptTurn({
        command,
        images: options.images,
        files: options.files,
        messageId: requestedId,
        writer,
        options,
        providerSessionId,
        context,
      });
    } catch (error) {
      console.warn(`[Claude SDK] Adopting the held process of session ${sessionKey} failed:`, errorMessage(error));
    }
  }
  if (outcome.adopted) {
    await outcome.done;
    return true;
  }
  const live = getSession(sessionKey);
  if (live && live.status === 'active' && !live.inputReleased && backgroundWork.hasOutstanding(sessionKey)) {
    throw new AppError(
      'The message could not be sent into the running Claude process, and sending it as a new turn would stop its background work.',
      {
        code: ADOPT_UNAVAILABLE_ERROR_CODE,
        statusCode: 409,
        details: { messageId: UUID_PATTERN.test(requestedId) ? requestedId : crypto.randomUUID() },
      },
    );
  }
  return false;
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId: string) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId: string) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage: AnyRecord): AnyRecord {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message: AnyRecord | null | undefined) {
  return Boolean(message?.parentToolUseId) && message?.role === 'user' && message?.kind === 'text';
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The window a budget is measured against: the one the SDK reported for the
 * session's model when known, else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} reportedContextWindow - SDK-reported window
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(reportedContextWindow?: number | null): number {
  if (typeof reportedContextWindow === 'number' && Number.isFinite(reportedContextWindow) && reportedContextWindow > 0) {
    return reportedContextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage: AnyRecord, mainModel: string | null): number | null {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage as Record<string, AnyRecord>).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage: AnyRecord, reportedContextWindow?: number | null): TokenBudget {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage: unknown, reportedContextWindow?: number | null): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  const message = sdkMessage as AnyRecord;
  if (message.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (message.type !== 'assistant') {
    return null;
  }

  const messageUsage = message.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage, reportedContextWindow);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(rawMessage: unknown, reportedContextWindow?: number | null): TokenBudget | null {
  const sdkMessage = rawMessage as AnyRecord | null;
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, reportedContextWindow);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage: AnyRecord | null | undefined) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block: AnyRecord | null) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 * [local] A CLI that emits `system/background_tasks_changed` (the full set of
 * live background tasks after every change, REPLACE semantics) is followed by
 * that level rather than by pairing edges alone, so a missed `task_started` or
 * `task_notification` cannot leave a ghost task (or lose a live one). The edges
 * still supply the launching call and description, and remain the only source
 * for an older CLI that sends no level. The level lists background tasks only:
 * a task the turn is blocking on (foreground) is left to its edges.
 *
 */
export function createBackgroundWorkTracker() {
  const sessions = new Map<string, Map<string, BackgroundTaskSummary>>();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   */
  const ownToolUseIds = new Map<string, Set<string>>();
  /**
   * [local] Tool-use ids of calls made to block on their work (a foreground
   * Agent or Bash), for CLIs whose `task_started` does not say
   * `is_backgrounded` yet.
   */
  const foregroundLaunches = new Map<string, Set<string>>();
  /**
   * [local] Tasks the turn that started them is blocking on. A Stop of that
   * turn stops these; every other task keeps running, as Esc leaves it in
   * the official client. A task moved to the background leaves the set.
   */
  const foregroundTasks = new Map<string, Set<string>>();
  /**
   * [local] The run id each tracked task was last seen running under. A
   * subagent resumed with SendMessage keeps its task id and gets a new run
   * id, and the SDK promises run ids of one task sort in the order the runs
   * opened: an end reported for an earlier run (a late frame, or the orphan
   * report of a previous process) must not drop the run that is live now.
   */
  const runIds = new Map<string, Map<string, string>>();

  const noteRun = (sessionKey: string, taskId: string, runId: unknown) => {
    if (typeof runId !== 'string' || !runId) {
      return;
    }
    let runs = runIds.get(sessionKey);
    if (!runs) {
      runs = new Map<string, string>();
      runIds.set(sessionKey, runs);
    }
    const known = runs.get(taskId);
    if (!known || runId > known) {
      runs.set(taskId, runId);
    }
  };

  /** [local] Whether a frame names a run older than the one tracked (see `runIds`). */
  const isLate = (sessionKey: string, taskId: string, runId: unknown) => {
    const known = runIds.get(sessionKey)?.get(taskId);
    return typeof runId === 'string' && runId !== '' && known !== undefined && runId < known;
  };

  const addTo = (map: Map<string, Set<string>>, sessionKey: string, id: string) => {
    let ids = map.get(sessionKey);
    if (!ids) {
      ids = new Set<string>();
      map.set(sessionKey, ids);
    }
    ids.add(id);
  };

  const remove = (sessionKey: string, taskId: string) => {
    foregroundTasks.get(sessionKey)?.delete(taskId);
    runIds.get(sessionKey)?.delete(taskId);
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  /**
   * [local] Folds one `background_tasks_changed` level into the session's set:
   * a background task missing from it has ended, and a task in it that no edge
   * announced is running. `ambient` tasks (watchers, housekeeping) are not
   * activity, so they are never added from the level; one the session itself
   * started (a Monitor) stays tracked while the level lists it.
   */
  const applyLevel = (sessionKey: string, level: unknown[]) => {
    const live = new Map<string, AnyRecord>();
    for (const entry of level) {
      const task = entry as AnyRecord | null;
      if (task && typeof task.task_id === 'string') {
        live.set(task.task_id, task);
        noteRun(sessionKey, task.task_id, task.run_id);
      }
    }
    for (const taskId of Array.from(sessions.get(sessionKey)?.keys() ?? [])) {
      if (live.has(taskId)) {
        // Listed, so it runs in the background now.
        foregroundTasks.get(sessionKey)?.delete(taskId);
      } else if (!foregroundTasks.get(sessionKey)?.has(taskId)) {
        remove(sessionKey, taskId);
      }
    }
    for (const [taskId, entry] of live) {
      if (entry.ambient === true || sessions.get(sessionKey)?.has(taskId)) {
        continue;
      }
      // No edge named its launching call (yet: a background task joins the
      // level before its `task_started`, which then fills this in). Nothing
      // in the parent transcript can show it, so it is kept as nested.
      const task: BackgroundTaskSummary = {
        taskId,
        toolUseId: '',
        taskType: typeof entry.task_type === 'string' ? entry.task_type : 'unknown',
        description: typeof entry.description === 'string' ? entry.description : '',
        startedAt: Date.now(),
        nested: true,
      };
      let tasks = sessions.get(sessionKey);
      if (!tasks) {
        tasks = new Map<string, BackgroundTaskSummary>();
        sessions.set(sessionKey, tasks);
      }
      tasks.set(taskId, task);
    }
  };

  return {
    apply(sessionKey: string, message: AnyRecord | null | undefined) {
      if (message?.type === 'system' && message.subtype === 'background_tasks_changed') {
        if (Array.isArray(message.tasks)) {
          applyLevel(sessionKey, message.tasks);
        }
        return;
      }
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              addTo(ownToolUseIds, sessionKey, block.id);
              // [local] Same reading of the input as `startsBackgroundWork`.
              if (
                (block.name === 'Agent' && block.input?.run_in_background === false)
                || (block.name === 'Bash' && block.input?.run_in_background !== true)
              ) {
                addTo(foregroundLaunches, sessionKey, block.id);
              }
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          // [local] Housekeeping tasks have no launching call and stay
          // untracked. A subagent task without one is a subagent resumed with
          // SendMessage (the SDK registers it in the background) unless the
          // CLI marks it as housekeeping: work the process is kept for.
          const resumedAgent = typeof message.tool_use_id !== 'string'
            && message.task_type === 'local_agent'
            && message.ambient !== true
            && message.skip_transcript !== true;
          if (typeof message.tool_use_id !== 'string' && !resumedAgent) {
            return;
          }
          noteRun(sessionKey, message.task_id, message.run_id);
          const toolUseId: string = typeof message.tool_use_id === 'string' ? message.tool_use_id : '';
          const task: BackgroundTaskSummary = {
            taskId: message.task_id,
            toolUseId,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(toolUseId)) {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map<string, BackgroundTaskSummary>();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          // [local] The CLI says where the task runs; an older one only
          // through the launching call's input.
          const foreground = message.is_backgrounded === false
            || (message.is_backgrounded === undefined && Boolean(foregroundLaunches.get(sessionKey)?.has(toolUseId)));
          if (foreground) {
            addTo(foregroundTasks, sessionKey, task.taskId);
          } else {
            foregroundTasks.get(sessionKey)?.delete(task.taskId);
          }
          return;
        }
        case 'task_notification':
          // [local] An end reported for an earlier run of a resumed task.
          if (isLate(sessionKey, message.task_id, message.run_id)) {
            return;
          }
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (isLate(sessionKey, message.task_id, message.run_id)) {
            return;
          }
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          } else if (message.patch?.is_backgrounded === true) {
            // [local] Moved to the background: no longer the turn's to stop.
            foregroundTasks.get(sessionKey)?.delete(message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey: string) {
      return sessions.has(sessionKey);
    },

    has(sessionKey: string, taskId: string) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    /** [local] Whether the turn that started this outstanding task is blocking on it. */
    isForeground(sessionKey: string, taskId: string) {
      return Boolean(sessions.get(sessionKey)?.has(taskId) && foregroundTasks.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey: string): BackgroundTaskSummary[] {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey: string) {
      sessions.delete(sessionKey);
      runIds.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
      foregroundLaunches.delete(sessionKey);
      foregroundTasks.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command: string, images: unknown, files: unknown, cwd: string) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * While it is parked, `push` writes one more message to the same stdin. That is
 * how a message sent during a turn reaches the running CLI (steering) instead of
 * waiting for the run to end. A push after `release` is refused, because the
 * CLI is already on its way out and would never read it.
 *
 * [local] `onTaken` is called once the SDK has taken the pushed message and
 * asked for the next one (it writes each message to stdin before asking), or
 * when the stream is released first. A control request that must reach the
 * CLI after the message waits for it.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void, push: (message: unknown, onTaken?: () => void) => boolean }}
 */
function createHeldPromptStream(messages: unknown[]) {
  // Messages pushed while parked, waiting for the CLI to read them.
  const pending: Array<{ message: unknown; onTaken?: () => void }> = [];
  let released = false;
  // Wakes the parked generator for a push or the release.
  let wake: (() => void) | null = null;

  const release = () => {
    released = true;
    // [local] Nothing parked will be taken now.
    for (const entry of pending) {
      entry.onTaken?.();
    }
    wake?.();
  };

  const push = (message: unknown, onTaken?: () => void) => {
    if (released) {
      return false;
    }
    pending.push({ message, onTaken });
    wake?.();
    return true;
  };

  const stream = (async function* () {
    // The turn's own prompt always goes out, as it did before steering existed.
    for (const message of messages) {
      yield message;
    }
    for (;;) {
      while (pending.length > 0 && !released) {
        const entry = pending.shift()!;
        yield entry.message;
        entry.onTaken?.();
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      if (released) {
        return;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  return { stream, release, push };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd: string | undefined): Promise<AnyRecord | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', (error as Error).message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers: AnyRecord = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', (error as Error).message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} initialWriter - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(
  command: string,
  options: AnyRecord = {},
  initialWriter: ClaudeRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  // [local] Every client-facing write of this run goes through this binding,
  // never the parameter: a later send that adopts this run's held process
  // hands the stream to its own writer (see `adoptTurn`), and every closure
  // below must follow.
  let ws: ClaudeRuntimeWriter = initialWriter;
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event: unknown) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream: () => void = () => {};
  // Writes one more message to the held stdin stream (steering). Replaced
  // once the stream exists; refuses until then and after the release.
  let pushPromptMessage: (message: unknown, onTaken?: () => void) => boolean = () => false;
  // Every message steered into this run, by the uuid it was sent with. The CLI
  // echoes a message written to its stdin when it reads it, and only these
  // echoes are shown — the turn's own prompt is already on screen.
  const steeredMessageIds = new Set<string>();
  // The steered messages the CLI has not read yet. While any remain, the
  // turn's `result` does not end the run: the CLI reads them in a follow-up
  // turn of its own.
  const pendingSteerIds = new Set<string>();
  let steerFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The window the SDK reported for this session's model (a resumed session
  // starts from the one its last run reported), the model the main thread's
  // assistant rows name, and the budget last published — re-sent with the
  // right total when the turn's `result` is the first to state the window.
  let reportedContextWindow: number | null = getReportedClaudeContextWindow(providerSessionId) ?? null;
  let mainThreadModel: string | null = null;
  let lastSentTokenBudget: TokenBudget | null = null;

  // [local] Adoption state: a later send can be written into this run's held
  // process (`adoptTurn` below) instead of replacing it. Only a run the chat
  // gateway dispatched (`adoptable`) with a person watching registers the
  // entry points; for every other run all of this stays at its initial value
  // and every path below behaves exactly as it did before.
  const adoptable = options.adoptable === true && !options.unattended;
  // True from the moment an adoption attempt starts until its turn is
  // reported complete (or the attempt gives up). Holds back every release.
  let adoptInFlight = false;
  let currentAttempt: AdoptAttempt | null = null;
  // The uuid of the adopted message until the CLI echoes it (reads it).
  let adoptedPendingId: string | null = null;
  let adoptWatchdog: ReturnType<typeof setTimeout> | null = null;
  // The absolute pickup bound (ADOPT_PICKUP_BACKSTOP_MS), armed at the push.
  let adoptBackstop: ReturnType<typeof setTimeout> | null = null;
  // Whether the pickup watchdog is watching (an adopted message is unread).
  // Its silence timer only runs while the CLI is idle between turns.
  let adoptWatchdogActive = false;
  // Whether the CLI is inside a turn of its own: set by `init`, cleared by
  // `result`. A turn may go silent for minutes on one tool call.
  let cliTurnActive = false;
  // Set once the run loop has ended: nothing may arm a timer after that.
  let loopEnded = false;
  // Resolves the adopting run's promise once its turn is reported complete.
  let resolveAdoptDone: (() => void) | null = null;
  // A release asked for while an adoption was in flight, picked up after it.
  let releaseRequestedWhileAdopting = false;
  // Every uuid this run has written an adopted message under.
  const adoptedMessageIds = new Set<string>();
  let everAdopted = false;
  // After the first adoption: task reports whose relay turn has not run yet.
  // Closing stdin while one is owed would cut that relay short.
  let relaysOwed = 0;
  let relayGraceTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the last hold rested on the launch rule alone (a ScheduleWakeup,
  // CronCreate, ... with no task events), and whether the adopted turn has to
  // keep that hold: the tracker knows nothing of such work.
  let lastHoldWasStatic = false;
  let carriedStaticHold = false;
  // Messages a Stop could not cancel. If the CLI starts one anyway, it is
  // interrupted at once and nothing it says reaches the client.
  const doomedIds = new Set<string>();
  let suppressForwarding = false;
  let doomedTurnActive = false;
  // The next `result` ends a turn a Stop interrupted, not a relay.
  let interruptedResultPending = false;
  // [local] True from the `init` of a turn the CLI started on its own after
  // the last turn was reported complete (a relay: background work reporting
  // in) until that turn's `result`. Such a turn is reported like any other
  // (`turn_started`, then its own `complete`), so it can be stopped and
  // steered. Only for an adoptable run; always false for any other.
  let relayTurnActive = false;
  // Tools a person allowed with "remember": kept when an adoption swaps in
  // the adopting send's tool settings.
  const rememberedEntries = new Set<string>();

  // [local] A send marked `adoptHeld` goes into the session's held process
  // when it can (see adoptHeldSession). An edit never does: it must resume the
  // conversation partway, which only a new process can.
  if (options.adoptHeld === true && !options.resumeAnchorId && !options.resumeFromScratch && sessionKey()) {
    if (await adoptHeldSession(sessionKey()!, command, options, ws, context, providerSessionId)) {
      return;
    }
  }

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    releaseHeldSession(sessionKey()!);
  }

  // Closes the held stdin, going through the activeSessions entry so
  // `inputReleased` is set accurately for `askSideQuestion`'s own check —
  // unless a native side question (`askSideQuestion` below) is still
  // waiting on this same query. The SDK drops a write made after release
  // instead of erroring, so releasing under a pending question would have
  // the CLI cancel it ("Side question cancelled") instead of answering it.
  // `askSideQuestion`'s `finally` calls this again once the count drops back
  // to zero, picking the deferred release back up.
  //
  // The map entry under this session's key may belong to a newer run that
  // superseded this one (a turn started while this one was still held) — in
  // that case `addSession` already released this run's stdin directly via
  // its own closure when it superseded it, and the entry's pending count and
  // `releaseInput` belong to the new run, not this one. Only read or write
  // the entry when it is still this run's own (`entry.instance ===
  // queryInstance`); otherwise fall back to this run's own closer so a late
  // call here cannot touch the run that replaced it.
  //
  // `isIdleCeiling` is true only when this call is the idle timer itself
  // firing. A normal call (turn end, background work settling) still defers
  // under a pending native side question and arms the ceiling as a backstop;
  // the ceiling's own call must not defer again on top of itself — a side
  // question the CLI never answers would otherwise hold the process (and its
  // MCP servers) forever, so the ceiling forces the release through instead.
  const maybeReleasePromptStream = (isIdleCeiling = false) => {
    // [local] While an adoption is in flight nothing closes stdin, the idle
    // ceiling included: the adopted turn's own settle (or the attempt giving
    // up) decides again, and picks this request back up.
    if (adoptInFlight) {
      releaseRequestedWhileAdopting = true;
      return;
    }
    const found = sessionKey() ? getSession(sessionKey()!) : undefined;
    const entry = found && found.instance === queryInstance ? found : null;
    if (entry && entry.pendingNativeSideQuestions > 0 && !isIdleCeiling) {
      entry.releaseDeferred = true;
      // Re-arm (rather than drop) the same idle ceiling that governs every
      // other hold, so an unanswered question is rechecked instead of being
      // left to wait on `askSideQuestion`'s own resolution alone.
      scheduleRelease();
      return;
    }
    if (entry) {
      entry.releaseDeferred = false;
      if (entry.releaseInput) {
        entry.releaseInput();
      } else {
        releasePromptStream();
      }
    } else {
      releasePromptStream();
    }
  };

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  // [local] Short (BG_WAIT_CEILING_MS) while no tracked task is running, long
  // (CLOUDCLI_BG_MAX_HOLD_MS) while one is. Every stream message re-arms it, so a task
  // ending switches back to the short one.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    const holdKey = sessionKey();
    const tasksRunning = Boolean(holdKey) && backgroundWork.hasOutstanding(holdKey!);
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      // [local] Tasks still running at the long bound are stopped first, while
      // stdin is open, as releaseHeldSession does: the CLI would otherwise wait
      // for its agents as long again after the release.
      const key = sessionKey();
      const entry = key ? getSession(key) : undefined;
      if (key && entry && entry.instance === queryInstance && backgroundWork.hasOutstanding(key)) {
        console.warn(`[Claude SDK] Background work of session ${key} said nothing for the hold bound; stopping it.`);
        sendTaskStops(queryInstance ?? undefined, backgroundWork.outstanding(key));
      }
      maybeReleasePromptStream(true);
    }, tasksRunning ? resolveBackgroundMaxHoldMs() : BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer?.unref?.();
  };

  // [local] Adoption bookkeeping that the catch and finally below need too.
  const clearAdoptWatchdog = () => {
    adoptWatchdogActive = false;
    if (adoptWatchdog) {
      clearTimeout(adoptWatchdog);
      adoptWatchdog = null;
    }
    if (adoptBackstop) {
      clearTimeout(adoptBackstop);
      adoptBackstop = null;
    }
  };
  const clearRelayGrace = () => {
    if (relayGraceTimer) {
      clearTimeout(relayGraceTimer);
      relayGraceTimer = null;
    }
  };
  // Ends the adoption in flight, if any, and lets the adopting run return.
  // Idempotent. Callers send the turn's `complete` first.
  const finishAdoptedTurn = () => {
    adoptInFlight = false;
    adoptedPendingId = null;
    clearAdoptWatchdog();
    currentAttempt = null;
    const resolveDone = resolveAdoptDone;
    resolveAdoptDone = null;
    resolveDone?.();
  };
  // An adoption whose turn never ran puts the process back in the hold it was
  // in: a release asked for meanwhile happens now, otherwise the idle ceiling
  // the adoption suspended is armed again.
  const restoreHold = () => {
    // A run whose loop has ended holds nothing (its finally cleared the timers).
    if (loopEnded) {
      return;
    }
    if (releaseRequestedWhileAdopting) {
      releaseRequestedWhileAdopting = false;
      maybeReleasePromptStream();
    } else if (!idleReleaseTimer) {
      scheduleRelease();
    }
  };
  // Held only for a relay the CLI owes: if no relay turn starts within the
  // grace, stop waiting for it.
  const armRelayGrace = () => {
    clearRelayGrace();
    relayGraceTimer = setTimeout(() => {
      relayGraceTimer = null;
      console.warn(`[Claude SDK] A background task's relay turn never started for session ${sessionKey()}; letting the process go.`);
      relaysOwed = 0;
      maybeReleasePromptStream();
    }, STEER_FOLLOW_UP_GRACE_MS);
    relayGraceTimer.unref?.();
  };
  // A Stop that lands while an adoption is still being set up: nothing is
  // pushed, and the attempt stops waiting on its control requests.
  const cancelAdoption = () => {
    const attempt = currentAttempt;
    if (attempt && !attempt.pushed && !attempt.cancelled) {
      attempt.cancelled = true;
      attempt.abandon();
    }
  };
  // [local] A Stop ends only the turn the user is waiting on (this run's own
  // turn, or one adopted into its process) whenever background work would
  // outlive it, as Esc does in the official client. Every other Stop takes
  // the full abort, exactly as before. A task the turn is blocking on (a
  // foreground agent or command of the main thread) is part of the turn.
  const isTurnTask = (key: string, task: BackgroundTaskSummary) => !task.nested && backgroundWork.isForeground(key, task.taskId);
  const canInterruptTurnOnly = () => {
    const key = sessionKey();
    // [local] A relay turn is stopped on its own, whatever else runs: it is
    // the CLI's turn, and the process it runs in is the session's.
    if (key && relayTurnActive && !turnCompleteSent && !adoptInFlight) {
      return true;
    }
    if (!key || (!adoptInFlight && turnCompleteSent)) {
      return false;
    }
    return backgroundWork.outstanding(key).some((task) => !isTurnTask(key, task));
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance: ClaudeQuery | null = null;

  // Delivers a message into this run while its turn is going. Priority `next`
  // makes the CLI read it at the next tool-call boundary, without stopping the
  // turn; a turn that ends before one runs it as a follow-up turn instead.
  // Refused once the turn has been reported complete: the client then sends
  // it as an ordinary new turn.
  //
  // [local] An `urgent` message ("Send now") is read at once. While a shell
  // command or subagent of the main thread is running, it is pushed as `next`
  // and that work is moved to the background (Ctrl+B), so the call returns
  // and Claude reads the message in the same turn, as Ctrl+Enter does in the
  // official client. If nothing could be moved, or nothing such is running,
  // it goes as `now`, which makes the CLI cut the current step short and read
  // it straight away; work already in the background keeps running.
  const steerIntoTurn: SteerInput = async ({ command: steerCommand, images, files, messageId, urgent = false }) => {
    // [local] A steer that arrives while an adoption is being set up (the
    // client already shows the adopted turn as running) waits for its push
    // rather than being refused against the previous turn's state.
    const settingUp = currentAttempt;
    if (turnCompleteSent && adoptInFlight && settingUp && !settingUp.pushed) {
      await settingUp.decided;
    }
    if (turnCompleteSent) {
      return false;
    }
    const [steerMessage] = await buildPromptMessages(steerCommand, images, files, options.cwd);
    // Reading attachments takes a moment; the turn may have ended meanwhile.
    if (turnCompleteSent || !steerMessage) {
      return false;
    }
    pendingSteerIds.add(messageId);
    steeredMessageIds.add(messageId);
    // [local] See above: `next` unless an urgent message has no work to move aside.
    const movable = urgent && [...foregroundToolCalls.values()].some((name) => BACKGROUNDABLE_TOOL_NAMES.has(name));
    let markTaken!: () => void;
    const taken = new Promise<void>((resolve) => { markTaken = resolve; });
    const pushed = pushPromptMessage({ ...steerMessage, priority: urgent && !movable ? 'now' : 'next', uuid: messageId }, markTaken);
    if (!pushed) {
      pendingSteerIds.delete(messageId);
      steeredMessageIds.delete(messageId);
      return false;
    }
    const instance = queryInstance;
    // [local] The message must be in the CLI's queue before the moved call
    // returns, or the turn would go on past the boundary that reads it.
    // Bounded, so a stalled stream cannot hold the sender's answer forever.
    if (movable) {
      await Promise.race([taken, new Promise<void>((resolve) => {
        setTimeout(resolve, CONTROL_REQUEST_TIMEOUT_MS).unref?.();
      })]);
    }
    if (movable && instance && !(await requestBackgroundTasks(instance))) {
      // [local] Nothing moved (background tasks disabled, or an older CLI), so
      // the message would wait for the running call. Take it back and send it
      // again as `now`; if the CLI has already taken it, it is being read.
      if (pendingSteerIds.has(messageId) && await cancelQueuedMessage(instance, messageId)) {
        if (!pushPromptMessage({ ...steerMessage, priority: 'now', uuid: messageId })) {
          forgetSteer(messageId);
        }
      }
    }
    return true;
  };

  // [local] Main-thread tool calls that have started and not returned yet, by
  // tool_use id, with the tool's name. Read by an urgent steer to tell whether
  // there is running work to move to the background.
  const foregroundToolCalls = new Map<string, string>();
  // [local] Set once the turn loop below can settle a turn: a turn that ended
  // waiting only for a message that was then withdrawn is over.
  let settleAfterWithdrawnSteer: (() => void) | null = null;
  // [local] Drops a steered message that will never be read.
  const forgetSteer = (messageId: string) => {
    pendingSteerIds.delete(messageId);
    steeredMessageIds.delete(messageId);
    if (steerFollowUpTimer && pendingSteerIds.size === 0) {
      clearTimeout(steerFollowUpTimer);
      steerFollowUpTimer = null;
      settleAfterWithdrawnSteer?.();
    }
  };
  // [local] Withdraws a steered message the CLI has not read yet (the official
  // client's Up arrow on a queued message). Only the CLI can say whether it was
  // still queued: false means it was read, or is being read, and its echo
  // follows as usual.
  const cancelSteer: CancelSteer = async (messageId) => {
    const instance = queryInstance;
    if (!instance || !pendingSteerIds.has(messageId)) {
      return false;
    }
    if (!(await cancelQueuedMessage(instance, messageId))) {
      return false;
    }
    forgetSteer(messageId);
    return true;
  };

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    // [local] Tells the CLI this consumer stops background tasks one by one
    // (`stopTask`), so an interrupt ends only the current turn and spares
    // them. That is what lets a Stop of the turn (`interruptTurn`) leave the
    // background work running. A full Stop (nothing would outlive the turn,
    // or a run that is not adoptable) stops the tracked tasks itself before
    // it interrupts (abortClaudeSDKSession), which keeps its old outcome.
    sdkOptions.perTaskStopAffordance = true;
    // [local] What the process runs with, for the live changes an adoption makes.
    let appliedModel: unknown = sdkOptions.model;
    let appliedEffort = resolveClaudeEffort(sdkOptions.model, options.effort, effortModels);

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Makes the CLI echo each message it reads from stdin, at the moment it
    // reads it. For a steered message that echo is the only word on when — and
    // whether — Claude actually took it in; the run loop below drops every
    // other echo, so nothing else changes on screen.
    sdkOptions.extraArgs = { ...(sdkOptions.extraArgs || {}), 'replay-user-messages': null };

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input: AnyRecord) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(notificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // An MCP server asking the person for input mid-call ("elicitation"). The
    // CLI declares form and URL elicitation support to every server, and without
    // this callback the SDK answers each request with `decline` itself — the
    // server is told a person refused when nobody was shown anything. The
    // request takes the permission round trip so it reaches every attached tab,
    // survives a refresh and raises a notification. There is no timeout here:
    // the server keeps its own, and an abort arrives through the signal.
    // An unattended run (commit-message generation, and an agent-API run unless
    // its caller passed `unattended: false`) has nobody to show the form to, so
    // it leaves the callback unset: the SDK then declines at once, rather than
    // the run waiting on an answer that cannot come.
    if (!options.unattended) {
      sdkOptions.onElicitation = async (request: ElicitationRequest, elicitationOptions: { signal: AbortSignal }) => {
        const requestId = createRequestId();
        const input = {
          serverName: request.serverName,
          message: request.message,
          mode: request.mode ?? 'form',
          requestedSchema: request.requestedSchema,
          url: request.url,
          elicitationId: request.elicitationId,
          title: request.title,
          displayName: request.displayName,
          description: request.description,
        };
        const serverLabel = request.displayName || request.serverName;
        ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName: MCP_ELICITATION_TOOL_NAME, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        emitNotification(notificationEvent({
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          kind: 'action_required',
          code: 'agent.notification',
          meta: { message: `${serverLabel} asks: ${request.message}`, sessionName: sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `claude:elicitation:${sessionId || capturedSessionId || 'none'}:${requestId}`
        }));

        const decision = await waitForToolApproval(requestId, {
          timeoutMs: 0,
          signal: elicitationOptions?.signal,
          metadata: {
            _sessionId: sessionId || capturedSessionId || null,
            _toolName: MCP_ELICITATION_TOOL_NAME,
            _input: input,
            _receivedAt: new Date(),
          },
          onCancel: (reason: string) => {
            ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
        });
        if (decision && !decision.cancelled) {
          // Same as canUseTool: retract the answered prompt on every attached tab.
          ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
        return toElicitationResult(decision, request.mode);
      };
    }

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName: string, input: unknown, context?: { signal?: AbortSignal }) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(notificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason: string) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          // [local] Kept across an adoption's swap of the tool settings.
          rememberedEntries.add(decision.rememberEntry);
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter((entry: string) => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;
    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    pushPromptMessage = heldPrompt.push;
    try {
      queryInstance = createQuery({
        prompt: heldPrompt.stream as AsyncIterable<SDKUserMessage>,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', (hookError as Error)?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      pushPromptMessage = heldPrompt.push;
      queryInstance = createQuery({
        prompt: heldPrompt.stream as AsyncIterable<SDKUserMessage>,
        options: sdkOptions
      });
    }

    // [local] This run's own query, for the closures below (the hoisted
    // `queryInstance` is not narrowed inside them).
    const liveQuery: ClaudeQuery = queryInstance;

    // [local] This run's activeSessions entry, while it is live with stdin open.
    const ownLiveEntry = () => {
      const found = sessionKey() ? getSession(sessionKey()!) : undefined;
      return found && found.instance === liveQuery && found.status === 'active' && !found.inputReleased ? found : null;
    };

    // [local] (Re)arms the adopted message's pickup watchdog. Its silence
    // timer is suspended while the CLI runs a turn of its own (a relay with
    // a long silent tool call is not a CLI that ignores the message); it
    // counts only while the CLI sits idle between turns.
    const armAdoptWatchdog = () => {
      if (adoptWatchdog) {
        clearTimeout(adoptWatchdog);
        adoptWatchdog = null;
      }
      adoptWatchdogActive = true;
      if (cliTurnActive || loopEnded) {
        return;
      }
      adoptWatchdog = setTimeout(expireAdoptWatchdog, ADOPT_PICKUP_WATCHDOG_MS);
      adoptWatchdog.unref?.();
    };
    // [local] Starts watching a freshly pushed adopted message: the silence
    // watchdog above, plus an absolute backstop for a wedged CLI.
    const startAdoptWatchdog = () => {
      clearAdoptWatchdog();
      armAdoptWatchdog();
      adoptBackstop = setTimeout(expireAdoptWatchdog, ADOPT_PICKUP_BACKSTOP_MS);
      adoptBackstop.unref?.();
    };

    // [local] The process went silent for ADOPT_PICKUP_WATCHDOG_MS with the
    // adopted message still unread: tell the user it was not picked up and
    // end the adopting run, rather than leave it "processing" forever. Should
    // the CLI run it after all, it is stopped the moment it starts.
    const expireAdoptWatchdog = () => {
      clearAdoptWatchdog();
      const unreadId = adoptedPendingId;
      if (!unreadId) {
        return;
      }
      console.warn(`[Claude SDK] Adopted message ${unreadId} was never read by the held process of session ${sessionKey()}.`);
      doomedIds.add(unreadId);
      void cancelQueuedMessage(liveQuery, unreadId);
      adoptedPendingId = null;
      ws.send(createNormalizedMessage({ kind: 'error', content: ADOPTED_MESSAGE_NOT_PICKED_UP, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      settleTurnResult(ADOPTED_MESSAGE_NOT_PICKED_UP);
    };

    // [local] Brings the held process in line with what an adopting send
    // asks for: permission mode (and the tool lists canUseTool reads), model
    // and effort, each through a live control request. Only a stricter
    // permission mode that cannot be applied makes the adoption fail (false):
    // the turn would otherwise run with more permission than chosen. A model
    // or effort change that fails is logged and the turn runs anyway; nothing
    // here ever stops background work.
    //
    // Every change made (the tool-check mirror, and each control request
    // sent, whatever it answered) leaves an entry in `undo`, which the caller
    // runs should the attempt end without a push. Those entries put the
    // previous values back on a best-effort basis and never throw.
    const applyLiveOptions = async (request: AdoptRequest, attempt: AdoptAttempt, undo: Array<() => void>): Promise<boolean> => {
      const control = (send: () => Promise<unknown> | undefined) =>
        sendControlRequest(() => (ownLiveEntry() ? send() : undefined), attempt.abandoned);
      // Not tied to the attempt (it has been abandoned by then), and fire and
      // forget: a revert that fails only leaves what the failed adoption set.
      const revert = (send: () => Promise<unknown> | undefined) => {
        void sendControlRequest(() => (ownLiveEntry() ? send() : undefined));
      };
      const requestedModel = request.options.model;
      const resolvedModel = await request.context.resolveResumeModel(sessionId, requestedModel);
      if (attempt.cancelled) {
        return false;
      }
      let models = effortModels;
      try {
        models = await request.context.getProviderModels();
      } catch (error) {
        console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
      }
      if (attempt.cancelled) {
        return false;
      }
      const next = mapCliOptionsToSDK({
        ...request.options,
        providerSessionId: request.providerSessionId,
        model: resolvedModel || requestedModel,
        effortModels: models,
      });

      const currentMode = typeof sdkOptions.permissionMode === 'string' ? sdkOptions.permissionMode : 'default';
      const nextMode = typeof next.permissionMode === 'string' ? next.permissionMode : 'default';
      const hadPermissionMode = Object.prototype.hasOwnProperty.call(sdkOptions, 'permissionMode');
      const previousPermissionMode = sdkOptions.permissionMode;
      const previousAllowed = Array.isArray(sdkOptions.allowedTools) ? [...sdkOptions.allowedTools] : sdkOptions.allowedTools;
      const previousDisallowed = Array.isArray(sdkOptions.disallowedTools) ? [...sdkOptions.disallowedTools] : sdkOptions.disallowedTools;
      undo.push(() => {
        if (hadPermissionMode) {
          sdkOptions.permissionMode = previousPermissionMode;
        } else {
          delete sdkOptions.permissionMode;
        }
        // Tools a person allowed with "remember" meanwhile stay allowed.
        sdkOptions.allowedTools = Array.isArray(previousAllowed)
          ? Array.from(new Set([...previousAllowed, ...rememberedEntries]))
          : previousAllowed;
        sdkOptions.disallowedTools = Array.isArray(previousDisallowed)
          ? previousDisallowed.filter((entry: string) => !rememberedEntries.has(entry))
          : previousDisallowed;
      });
      let modeApplied = currentMode === nextMode;
      if (!modeApplied) {
        undo.push(() => revert(() => liveQuery.setPermissionMode?.(currentMode)));
        modeApplied = await control(() => liveQuery.setPermissionMode?.(nextMode));
        if (attempt.cancelled) {
          return false;
        }
        if (!modeApplied && isStricterPermissionMode(nextMode, currentMode)) {
          console.warn(`[Claude SDK] Could not switch the held process of session ${sessionKey()} from ${currentMode} to ${nextMode}; not adopting it.`);
          return false;
        }
      }
      if (modeApplied) {
        // canUseTool reads these: once the process runs in the new mode, so do
        // the tool checks (a bypass process adopted in default mode must ask
        // again). Tools a person allowed with "remember" stay allowed.
        if (next.permissionMode) {
          sdkOptions.permissionMode = next.permissionMode;
        } else {
          delete sdkOptions.permissionMode;
        }
        sdkOptions.allowedTools = Array.from(new Set([...(next.allowedTools || []), ...rememberedEntries]));
        sdkOptions.disallowedTools = (next.disallowedTools || []).filter((entry: string) => !rememberedEntries.has(entry));
      }

      if (next.model !== appliedModel) {
        const previousModel = appliedModel;
        undo.push(() => {
          appliedModel = previousModel;
          revert(() => liveQuery.setModel?.(previousModel as string | undefined));
        });
        if (await control(() => liveQuery.setModel?.(next.model))) {
          appliedModel = next.model;
        }
        if (attempt.cancelled) {
          return false;
        }
      }

      const nextEffort = resolveClaudeEffort(next.model, request.options.effort, models);
      if (nextEffort !== appliedEffort) {
        const previousEffort = appliedEffort;
        undo.push(() => {
          appliedEffort = previousEffort;
          revert(() => liveQuery.applyFlagSettings?.(toEffortFlagSettings(previousEffort)));
        });
        if (await control(() => liveQuery.applyFlagSettings?.(toEffortFlagSettings(nextEffort)))) {
          appliedEffort = nextEffort;
        }
        if (attempt.cancelled) {
          return false;
        }
      }
      return true;
    };

    // [local] Writes a new send into this held process as a turn of its own,
    // while the background work it holds keeps running: the official CLI's
    // behaviour, where the main thread stays free to chat. Steps: guard,
    // apply the send's options live, hand the stream over to the adopting
    // run's writer, reset the per-turn state, push the message with its uuid
    // (no priority: the CLI starts a turn for it at once when idle). The
    // CLI's echo of that uuid marks the turn as ours; its `result` ends it.
    // Refuses (`adopted: false`, nothing changed) whenever any guard fails;
    // a Stop during setup resolves `adopted: true` with nothing pushed.
    const adoptTurn: AdoptTurn = async (request) => {
      // [local] A relay turn that started after the gateway let this send
      // through is no reason to refuse it: the CLI runs the message after
      // the relay, as it always has (see settleRelayBeforeAdoptedEcho).
      const mayAdopt = () => (turnCompleteSent || relayTurnActive) && pendingSteerIds.size === 0 && ownLiveEntry() !== null;
      if (adoptInFlight || !mayAdopt()) {
        return { adopted: false };
      }
      // A cleared context points the session row at a new provider id (or
      // none). Answering from this process would bring the old context back,
      // and handing the stream over would map the old id onto the session.
      if (!request.providerSessionId || request.providerSessionId !== capturedSessionId) {
        return { adopted: false };
      }
      const requestedId = request.messageId;
      const messageId = UUID_PATTERN.test(requestedId) && !steeredMessageIds.has(requestedId) && !adoptedMessageIds.has(requestedId)
        ? requestedId
        : crypto.randomUUID();
      const cancelledOutcome: AdoptOutcome = { adopted: true, done: Promise.resolve() };
      const attempt = createAdoptAttempt(request.writer);
      currentAttempt = attempt;
      adoptInFlight = true;
      releaseRequestedWhileAdopting = false;
      // Undoes the live option changes should the attempt end without a push.
      const undoLiveOptions: Array<() => void> = [];
      try {
        const [message] = await buildPromptMessages(request.command, request.images, request.files, options.cwd);
        if (attempt.cancelled) {
          return cancelledOutcome;
        }
        if (!message || !mayAdopt()) {
          return { adopted: false };
        }
        const applied = await applyLiveOptions(request, attempt, undoLiveOptions);
        if (attempt.cancelled) {
          return cancelledOutcome;
        }
        const entry = ownLiveEntry();
        if (!applied || !entry || !mayAdopt()) {
          return { adopted: false };
        }

        // From here to the push nothing awaits, so a Stop sees either the
        // attempt still being set up or the message pushed.
        const previousWriter = ws;
        const saved = {
          turnCompleteSent,
          relayTurnActive,
          assistantBudgetSent,
          releaseDeferred: entry.releaseDeferred,
          sawTaskEventThisTurn,
          backgroundWorkPending,
          idleArmed: idleReleaseTimer !== null,
        };
        request.writer.adoptConnectionsFrom?.(previousWriter);
        ws = request.writer;
        entry.writer = ws;
        if (capturedSessionId) {
          ws.setSessionId?.(capturedSessionId);
        }
        turnCompleteSent = false;
        // [local] A relay under way is now the relay before the adopted echo.
        relayTurnActive = false;
        assistantBudgetSent = false;
        // The adopted turn is not idle time: its own settle re-arms the ceiling.
        if (idleReleaseTimer) {
          clearTimeout(idleReleaseTimer);
          idleReleaseTimer = null;
        }
        // A side question's deferred release must not close stdin mid-turn.
        entry.releaseDeferred = false;
        carriedStaticHold = heldForBackgroundWork && lastHoldWasStatic;
        sawTaskEventThisTurn = false;
        backgroundWorkPending = false;
        adoptedPendingId = messageId;
        const done = new Promise<void>((resolve) => { resolveAdoptDone = resolve; });

        if (!pushPromptMessage({ ...message, uuid: messageId })) {
          ws = previousWriter;
          entry.writer = previousWriter;
          // [local] Back to what it was: done, or a relay under way.
          turnCompleteSent = saved.turnCompleteSent;
          relayTurnActive = saved.relayTurnActive;
          assistantBudgetSent = saved.assistantBudgetSent;
          entry.releaseDeferred = saved.releaseDeferred;
          sawTaskEventThisTurn = saved.sawTaskEventThisTurn;
          backgroundWorkPending = saved.backgroundWorkPending;
          carriedStaticHold = false;
          adoptedPendingId = null;
          resolveAdoptDone = null;
          if (saved.idleArmed) {
            scheduleRelease();
          }
          return { adopted: false };
        }
        attempt.pushed = true;
        everAdopted = true;
        adoptedMessageIds.add(messageId);
        startAdoptWatchdog();
        return { adopted: true, done };
      } finally {
        attempt.markDecided();
        if (!attempt.pushed) {
          // Cancelled or refused: put the process back the way it was.
          for (const undo of undoLiveOptions) {
            try {
              undo();
            } catch (error) {
              console.warn(`[Claude SDK] Reverting a live option of session ${sessionKey()} failed:`, errorMessage(error));
            }
          }
        }
        if (!attempt.pushed && currentAttempt === attempt) {
          currentAttempt = null;
          adoptInFlight = false;
          if (releaseRequestedWhileAdopting) {
            releaseRequestedWhileAdopting = false;
            maybeReleasePromptStream();
          }
        }
      }
    };

    // [local] Stops only the running turn — this run's own, or one adopted
    // into its process — while background work keeps running. The Stop is
    // reported at once on the turn's writer, marked `backgroundContinues` so
    // the client stays in the background state. Tasks the turn is blocking on
    // (foreground) are stopped; the adopted message and unread steers are
    // cancelled in the CLI's queue when possible, and the turn itself is
    // interrupted only once it is ours to stop. Whatever could not be
    // cancelled is interrupted the moment it starts.
    const interruptTurn = async (): Promise<boolean> => {
      const attempt = currentAttempt;
      // [local] No adoption in flight: the Stop is of this run's own turn.
      const ownTurn = !adoptInFlight;
      const pushed = ownTurn || Boolean(attempt?.pushed);
      const target = !ownTurn && attempt && !attempt.pushed ? attempt.writer : ws;
      // [local] A relay turn may report the last task: then nothing runs on
      // once it is stopped, and the client goes idle rather than background.
      const stoppingRelay = ownTurn && relayTurnActive;
      const relayKey = sessionKey();
      const workContinues = !stoppingRelay || Boolean(relayKey && backgroundWork.outstanding(relayKey).some((task) => !isTurnTask(relayKey, task)));
      turnCompleteSent = true;
      target.send({
        ...createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0, aborted: true }),
        backgroundContinues: workContinues,
        pendingPermissions: getPendingApprovalsForSession(sessionId || capturedSessionId || ''),
      });
      notifyRunStopped({
        userId: target?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: 'aborted'
      });
      const unreadAdoptedId = !ownTurn && pushed ? adoptedPendingId : null;
      const ours = [...(unreadAdoptedId ? [unreadAdoptedId] : []), ...pendingSteerIds];
      pendingSteerIds.clear();
      if (steerFollowUpTimer) {
        clearTimeout(steerFollowUpTimer);
        steerFollowUpTimer = null;
      }
      cancelAdoption();
      finishAdoptedTurn();
      if (!pushed) {
        // Nothing of the user's reached the CLI, which may be running a relay
        // turn that is not the user's to stop.
        restoreHold();
        return true;
      }
      // The adopted turn is running: its own `result`, which may land while
      // the awaits below are still out, ends the interrupted turn and pays no
      // relay. Set before the first await so it cannot be miscounted.
      if (!unreadAdoptedId) {
        interruptedResultPending = true;
      }
      // Only what the turn is blocking on. Background tasks, and tasks
      // launched inside them (flagged nested), keep running.
      const turnKey = sessionKey()!;
      sendTaskStops(liveQuery, backgroundWork.outstanding(turnKey).filter((task) => isTurnTask(turnKey, task)));
      const cancelled = new Set<string>();
      for (const id of ours) {
        if (await cancelQueuedMessage(liveQuery, id)) {
          cancelled.add(id);
        }
      }
      if (unreadAdoptedId && ours.every((id) => cancelled.has(id))) {
        // The adopted turn never started and nothing of ours is left queued.
        restoreHold();
        return true;
      }
      if (unreadAdoptedId) {
        interruptedResultPending = true;
      }
      // The interrupted turn's own result decides the hold again.
      releaseRequestedWhileAdopting = false;
      let receipt: unknown;
      try {
        receipt = await liveQuery.interrupt();
      } catch (error) {
        console.warn(`[Claude SDK] Interrupting the turn of session ${sessionKey()} failed:`, errorMessage(error));
      }
      const stillQueued = readStillQueued(receipt);
      for (const id of ours) {
        if (cancelled.has(id)) {
          continue;
        }
        // A CLI without a receipt gives no word on what survived the interrupt.
        if (stillQueued === null) {
          doomedIds.add(id);
        } else if (stillQueued.includes(id) && !(await cancelQueuedMessage(liveQuery, id))) {
          doomedIds.add(id);
        }
      }
      // Backstop in case the interrupted turn's result never comes — unless
      // the process exited meanwhile and its finally cleared every timer.
      if (!idleReleaseTimer && !loopEnded) {
        scheduleRelease();
      }
      return true;
    };

    // [local] A full Stop (abortClaudeSDKSession) of a run whose adopted
    // message was pushed but not read yet: the interrupt alone would leave
    // that message queued in the CLI, which would then run it after the Stop.
    // Cancel it in the queue when possible; whatever the CLI does not cancel
    // is interrupted the moment it starts and shows nothing. The adopting run
    // still returns when the process exits, as on any full Stop.
    const cancelPendingAdopted = async (): Promise<void> => {
      const unreadId = currentAttempt?.pushed ? adoptedPendingId : null;
      if (!unreadId) {
        return;
      }
      doomedIds.add(unreadId);
      adoptedPendingId = null;
      clearAdoptWatchdog();
      if (await cancelQueuedMessage(liveQuery, unreadId)) {
        doomedIds.delete(unreadId);
      }
    };

    // [local] "Stop all background work": every task is stopped. With no turn
    // of the user's running, the process is let go as well, which also ends
    // work the tracker cannot see (a ScheduleWakeup, a cron); a running turn
    // carries on and its own end decides the hold again.
    const stopAllBackground = (): boolean => {
      const key = sessionKey();
      if (!key) {
        return false;
      }
      const tasks = backgroundWork.outstanding(key);
      const idle = turnCompleteSent && !adoptInFlight;
      if (tasks.length === 0 && !(idle && heldForBackgroundWork)) {
        return false;
      }
      sendTaskStops(liveQuery, tasks);
      if (idle) {
        heldForBackgroundWork = false;
        relaysOwed = 0;
        clearRelayGrace();
        maybeReleasePromptStream();
      }
      return true;
    };

    // [local] Registered only for an adoptable run; see `adoptable`.
    const adoptionHooks: AdoptionHooks | null = adoptable
      ? { adoptTurn, interruptTurn, canInterruptTurnOnly, cancelAdoption, cancelPendingAdopted, requestRelease: () => maybeReleasePromptStream(), stopAllBackground }
      : null;

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey()!, queryInstance, ws, releasePromptStream, steerIntoTurn, adoptionHooks, cancelSteer);
    }

    // Settles a turn whose `result` has arrived: tells the client the turn is
    // over, then holds the process for background work or lets it go.
    // [local] `failure` ends an adopted turn whose message was never read.
    const settleTurnResult = (failure: string | null = null) => {
      // [local] The adopted turn's own end: reported on the adopting run's
      // writer, and only then is that run let go (finishAdoptedTurn below).
      const settlingAdopted = adoptInFlight && Boolean(currentAttempt?.pushed) && !adoptedPendingId;
      if (settlingAdopted) {
        adoptInFlight = false;
        releaseRequestedWhileAdopting = false;
      }
      // The turn is done as far as the client is concerned.
      const abortPending = abortedInstances.has(liveQuery);
      const stillOutstanding = backgroundWork.hasOutstanding(sessionKey()!);
      // [local] A relay turn ends here, reported now or (stopped) already.
      const settlingRelay = relayTurnActive;
      relayTurnActive = false;
      if (!turnCompleteSent && !abortPending) {
        turnCompleteSent = true;
        const complete = createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: failure ? 1 : 0 });
        // [local] A background agent's approval may still be pending; the
        // client drops every prompt on `complete` unless it is listed here.
        ws.send(settlingAdopted || settlingRelay
          ? { ...complete, pendingPermissions: getPendingApprovalsForSession(sessionId || capturedSessionId || '') }
          : complete);
        if (settlingRelay && !failure) {
          // [local] Not a run of the user's that stopped: the background
          // work reported in, and when it was the last of it, that is the
          // notice the user gets, as before relay turns were reported.
          if (heldForBackgroundWork && !stillOutstanding) {
            notifyBackgroundWorkCompleted({
              userId: ws?.userId || null,
              provider: 'claude',
              sessionId: sessionId || capturedSessionId || null,
              sessionName: sessionSummary
            });
          }
        } else if (failure) {
          notifyRunFailed({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            error: new Error(failure)
          });
        } else {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
        }
      } else if (heldForBackgroundWork && !abortPending && !stillOutstanding) {
        // A result after the turn already reported complete means the work we
        // held the process open for has finished and pushed a follow-up turn
        // — the last of it, when nothing else is still running.
        notifyBackgroundWorkCompleted({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary
        });
      }
      // Work started during this turn, or work from an earlier turn that
      // has not settled yet (a follow-up turn reports one task in while
      // another is still going), is still running. Hold the process open
      // so it can finish and report back in a follow-up turn; the ceiling
      // is only a backstop for work that never reports.
      //
      // The release when the last task settles is this same branch on the
      // follow-up turn the CLI pushes for it, not the settling event
      // itself: closing stdin at that moment would cut the turn that
      // relays the task's result.
      //
      // When the turn reported its tasks, the tracker is the whole truth: an
      // Agent call without `run_in_background` is scored as background by
      // `startsBackgroundWork`, but the CLI runs it in the foreground and
      // it has settled before this `result` — holding for it kept a process
      // alive for the full ceiling with nothing outstanding.
      const holdForWork = sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding;
      // [local] After an adoption two more reasons hold the process: a task
      // that reported in still owes the relay turn the CLI queues for it,
      // and work held by the launch rule before the adoption (which the
      // tracker cannot see) is still running. Both are always false for a
      // run that was never adopted.
      const holdForRelay = everAdopted && relaysOwed > 0;
      const holdForTurn = holdForWork || carriedStaticHold || holdForRelay;
      lastHoldWasStatic = (holdForWork && !stillOutstanding) || carriedStaticHold;
      carriedStaticHold = false;
      backgroundWorkPending = false;
      sawTaskEventThisTurn = false;
      if (holdForTurn) {
        heldForBackgroundWork = true;
        scheduleRelease();
        if (!holdForWork && !lastHoldWasStatic) {
          armRelayGrace();
        }
      } else {
        // Either nothing was backgrounded, or the background work just
        // reported in — let the CLI exit now, as it always has (unless a
        // native side question is still in flight; see
        // `maybeReleasePromptStream`).
        heldForBackgroundWork = false;
        maybeReleasePromptStream();
      }
      // [local] The complete went out above; only now may the adopting run
      // return (an aborted one returns when the process exits, as before).
      if (settlingAdopted && !abortPending) {
        finishAdoptedTurn();
      }
    };

    // [local] A `result` that arrived before the CLI read the adopted message
    // ends a relay turn the CLI ran first. It is not the adopted turn, so no
    // complete and no release; the per-turn flags and the background
    // completion notice are settled as for any relay.
    const settleRelayBeforeAdoptedEcho = () => {
      if (everAdopted) {
        relaysOwed = Math.max(0, relaysOwed - 1);
      }
      if (heldForBackgroundWork && !abortedInstances.has(liveQuery) && !backgroundWork.hasOutstanding(sessionKey()!)) {
        heldForBackgroundWork = false;
        notifyBackgroundWorkCompleted({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary
        });
      }
      backgroundWorkPending = false;
      sawTaskEventThisTurn = false;
    };

    // A turn that ended with steered messages still unread waits for the
    // follow-up turn the CLI starts for them. It starts at once (its `init`
    // arrives within milliseconds); the grace timer only covers a CLI that
    // drops them instead, so the run cannot sit "processing" until the idle
    // ceiling with nothing coming.
    settleAfterWithdrawnSteer = () => settleTurnResult();
    const awaitSteerFollowUp = () => {
      if (steerFollowUpTimer) {
        clearTimeout(steerFollowUpTimer);
      }
      steerFollowUpTimer = setTimeout(() => {
        steerFollowUpTimer = null;
        console.warn(`[Claude SDK] Steered message(s) never started a follow-up turn for session ${sessionKey()}; ending the run.`);
        pendingSteerIds.clear();
        settleTurnResult();
      }, STEER_FOLLOW_UP_GRACE_MS);
      steerFollowUpTimer.unref?.();
    };

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const rawMessage of queryInstance) {
      const message = rawMessage as AnyRecord;
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey()!, queryInstance, ws, releasePromptStream, steerIntoTurn, adoptionHooks, cancelSteer);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId!);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // [local] A turn the CLI starts on its own once the last one was
      // reported complete (background work reporting in) is announced as a
      // turn: the gateway runs the session's run again until its `complete`,
      // so a Stop, a steer, the indicator and the queue treat it like any
      // reply. Not an adopted message's turn (adoptInFlight), and nothing on
      // a process that is being aborted. While a message a Stop could not
      // cancel may still start (doomedIds), a turn could be that message's,
      // which is stopped the moment it is read and must show nothing: such a
      // turn is left unannounced, as every relay turn was before.
      if (
        adoptable
        && message.type === 'system'
        && message.subtype === 'init'
        && turnCompleteSent
        && !adoptInFlight
        && !relayTurnActive
        && !interruptedResultPending
        && doomedIds.size === 0
        && !abortedInstances.has(liveQuery)
      ) {
        relayTurnActive = true;
        turnCompleteSent = false;
        assistantBudgetSent = false;
        ws.send(createNormalizedMessage({ kind: 'turn_started', origin: 'background', sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      // The follow-up turn for unread steered messages has started; its own
      // `result` ends the run.
      if (steerFollowUpTimer && message.type === 'system' && message.subtype === 'init') {
        clearTimeout(steerFollowUpTimer);
        steerFollowUpTimer = null;
      }
      // [local] A relay turn the hold was waiting for has started.
      if (relayGraceTimer && message.type === 'system' && message.subtype === 'init') {
        clearRelayGrace();
      }
      // [local] Whether the CLI is inside a turn of its own. The adopted
      // message's pickup watchdog is suspended while it is, and otherwise
      // measures silence, so any message pushes it back.
      if (message.type === 'system' && message.subtype === 'init') {
        cliTurnActive = true;
      } else if (message.type === 'result') {
        cliTurnActive = false;
      }
      if (adoptedPendingId && adoptWatchdogActive) {
        armAdoptWatchdog();
      }
      // [local] Keeps `foregroundToolCalls` current: a main-thread tool_use
      // starts a call, its tool_result (not an echo of stdin) ends it.
      trackForegroundToolCalls(message, foregroundToolCalls);

      // The CLI's echo of a message it read from stdin (see `extraArgs`).
      if (message.type === 'user' && message.isReplay === true) {
        const echoedId = typeof message.uuid === 'string' ? message.uuid : '';
        // [local] A message a Stop could not cancel has started after all:
        // stop it at once, and show nothing of its turn.
        if (doomedIds.delete(echoedId)) {
          pendingSteerIds.delete(echoedId);
          suppressForwarding = true;
          doomedTurnActive = true;

          Promise.resolve()
            .then(() => liveQuery.interrupt())
            .catch((error) => {
              console.error(`Error interrupting a stopped message for session ${sessionKey()}:`, errorMessage(error));
            });
          continue;
        }
        // [local] The CLI has read the adopted message: its turn is under way.
        // Not shown, because the client already shows the row it sent.
        if (adoptedPendingId && echoedId === adoptedPendingId) {
          adoptedPendingId = null;
          clearAdoptWatchdog();
          continue;
        }
        pendingSteerIds.delete(echoedId);
        if (steeredMessageIds.has(echoedId)) {
          if (steerFollowUpTimer && pendingSteerIds.size === 0) {
            clearTimeout(steerFollowUpTimer);
            steerFollowUpTimer = null;
          }
          // Shown now, where Claude read it, on every tab watching the run.
          for (const steered of context.normalizeMessage(transformMessage(message), capturedSessionId || sessionId || null)) {
            // A message read mid-turn is stored as an attachment of the turn,
            // not a user row of its own, so it is no anchor for editing.
            delete steered.transcriptAnchorId;
            // [local] Nothing of a stopped message's turn is shown.
            if (!suppressForwarding) {
              ws.send(steered);
            }
          }
        }
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        // [local] Nothing of a stopped message's turn is shown.
        if (suppressForwarding) {
          continue;
        }
        ws.send(msg);
      }

      if (
        message.type === 'assistant'
        && !message.parent_tool_use_id
        && typeof message.message?.model === 'string'
        && message.message.model !== '<synthetic>'
      ) {
        mainThreadModel = message.message.model;
      }

      // Only a turn's `result` states the window of the model that served it.
      const turnContextWindow = readReportedContextWindow(message, mainThreadModel);
      const contextWindowChanged = Boolean(turnContextWindow) && turnContextWindow !== reportedContextWindow;
      if (turnContextWindow) {
        reportedContextWindow = turnContextWindow;
        rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow);
        if (contextWindowChanged && sessionKey()) {
          // A history page cached before this turn ended carries the old total.
          sessionHistoryCache.invalidate(sessionKey());
        }
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      let tokenBudgetData = extractTokenBudget(message, reportedContextWindow)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message, reportedContextWindow));
      if (
        !tokenBudgetData
        && turnContextWindow
        && lastSentTokenBudget
        && lastSentTokenBudget.total !== turnContextWindow
      ) {
        // The reading stands; only the window it is measured against was wrong.
        tokenBudgetData = { ...(lastSentTokenBudget as TokenBudget), total: turnContextWindow };
      }
      // [local] ...and none of its budget readings.
      if (tokenBudgetData && !suppressForwarding) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        lastSentTokenBudget = tokenBudgetData;
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      if (message.type === 'system' && message.subtype === 'task_started') {
        sawTaskEventThisTurn = true;
      }
      // [local] After an adoption, a task of the session's own that reports
      // in (anything but a stop) owes the relay turn the CLI queues for it.
      if (
        everAdopted
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status !== 'stopped'
        && backgroundWork.outstanding(sessionKey()!).some((task) => task.taskId === message.task_id && !task.nested)
      ) {
        relaysOwed += 1;
      }
      // [local] An aborted process's late task events would bring back tasks
      // the abort already dropped with its session entry.
      if (!abortedInstances.has(liveQuery)) {
        backgroundWork.apply(sessionKey()!, message);
      }

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      if (
        heldForBackgroundWork
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey()!)
      ) {
        heldForBackgroundWork = false;
        maybeReleasePromptStream();
      }

      if (message.type === 'result') {
        const abortPending = abortedInstances.has(liveQuery);
        if (doomedTurnActive) {
          // [local] The end of a stopped message's turn: it owes no complete
          // (the Stop reported one) and no relay.
          doomedTurnActive = false;
          suppressForwarding = false;
          settleTurnResult();
        } else if (adoptedPendingId) {
          // [local] A relay turn the CLI ran before reading the adopted
          // message; the adopted turn is still to come.
          settleRelayBeforeAdoptedEcho();
        } else if (pendingSteerIds.size > 0 && !abortPending) {
          // The turn ended before Claude reached a tool-call boundary, so the
          // steered messages it never read are still queued in the CLI, which
          // runs them as a follow-up turn on this same process. The run is not
          // over for the client yet, and stdin must stay open for that turn.
          awaitSteerFollowUp();
        } else {
          // [local] A turn ending after the last one was reported complete
          // (other than one a Stop interrupted) is a relay paying its debt,
          // and so is a relay turn that was announced, stopped or not.
          if (everAdopted && (relayTurnActive || (turnCompleteSent && !interruptedResultPending))) {
            relaysOwed = Math.max(0, relaysOwed - 1);
          }
          interruptedResultPending = false;
          settleTurnResult();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // [local] See `loopEnded`.
    loopEnded = true;

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey()!)?.instance === queryInstance) {
      removeSession(sessionKey()!);
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded ? abortedInstances.delete(queryInstance) : false;
    // [local] The process ended with an adopted message it never read: that
    // message was not answered, so its run ends as failed, not completed.
    const unreadAdoptedId = adoptedPendingId;
    clearAdoptWatchdog();
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted && unreadAdoptedId) {
        ws.send(createNormalizedMessage({ kind: 'error', content: ADOPTED_MESSAGE_NOT_PICKED_UP, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: new Error(ADOPTED_MESSAGE_NOT_PICKED_UP)
        });
      } else {
        if (!wasAborted) {
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
        }
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: wasAborted ? 'aborted' : 'completed'
        });
      }
    }
    // [local] The adopting run, if any, returns now that its end is reported.
    finishAdoptedTurn();
    // Complete

  } catch (error) {
    // [local] See `loopEnded`.
    loopEnded = true;
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey()!)?.instance === queryInstance) {
      removeSession(sessionKey()!);
    }

    if (queryInstance && supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    // [local] Instance-keyed, like everywhere else.
    clearAdoptWatchdog();
    const wasAborted = queryInstance ? abortedInstances.delete(queryInstance) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error. It
      // is still a cancelled run, reported the same way as when the stream
      // ends after the interrupt.
      if (!turnCompleteSent) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'aborted'
        });
      }
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : (error as Error).message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    if (steerFollowUpTimer) {
      clearTimeout(steerFollowUpTimer);
      steerFollowUpTimer = null;
    }
    // [local] No timer of a finished run may fire later (nor be armed again
    // by a Stop still awaiting a control request), and an adopting run still
    // waiting returns (after whatever the catch above reported).
    loopEnded = true;
    clearAdoptWatchdog();
    clearRelayGrace();
    finishAdoptedTurn();
    releasePromptStream();
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId: string) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  // [local] An adoption still being set up pushes nothing after a Stop.
  session.cancelAdoption?.();

  // [local] A Stop while background work would outlive the turn stops only
  // the turn: the process stays held and the work keeps running ("Stop all
  // background work" is a separate action). The turn's runtime reports the
  // Stop itself.
  if (session.interruptTurn && session.canInterruptTurnOnly?.()) {
    console.log(`Stopping the current turn of SDK session ${sessionId}; its background work keeps running`);
    try {
      return await session.interruptTurn();
    } catch (error) {
      console.error(`Error stopping the current turn of session ${sessionId}:`, error);
      return false;
    }
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedInstances.add(session.instance);

    // [local] An adopted message pushed but not read yet would otherwise run
    // after the interrupt below. Withdrawn first, while stdin is open.
    if (session.cancelPendingAdopted) {
      await session.cancelPendingAdopted();
    }

    // [local] Every query declares the per-task stop affordance, under which
    // an interrupt spares background tasks. A full Stop still ends them, as
    // it did before: stop each tracked task first, while stdin is open.
    sendTaskStops(session.instance, backgroundWork.outstanding(sessionId));

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedInstances.delete(session.instance);
    return false;
  }
}

/**
 * [local] Stops every background task of a session's live process ("Stop all
 * background work"), and lets the process go when no turn is running. A
 * Stop of the turn spares background work, so this is how a person ends it
 * all in one go. Resolves false when the session has nothing to stop.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True once the stops are on their way
 */
async function stopAllClaudeSDKBackgroundWork(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') {
    return false;
  }
  if (session.stopAllBackground) {
    return session.stopAllBackground();
  }
  const tasks = backgroundWork.outstanding(sessionId);
  if (tasks.length === 0) {
    return false;
  }
  sendTaskStops(session.instance, tasks);
  return true;
}

/**
 * Delivers a user message into a session's running turn ("steering"): Claude
 * reads it at its next tool-call boundary and carries on with it in mind, with
 * nothing stopped. A turn that ends before another tool call reads it in a
 * follow-up turn on the same process, and the run is not reported complete
 * until it has.
 *
 * Resolves false when the session has no live run or its turn has already been
 * reported complete — the message could only start a new turn then, which is
 * the caller's to send.
 * @param {string} sessionId - App session identifier
 * @param {string} command - The message text
 * @param {Object} options - `images`, `files` (verified descriptors) and `messageId`
 * @returns {Promise<boolean>} True once the message is on its way to the CLI
 */
async function steerClaudeSDKSession(sessionId: string, command: string, options: AnyRecord = {}) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.steerInput) {
    return false;
  }
  const messageId = typeof options.messageId === 'string' && options.messageId
    ? options.messageId
    : crypto.randomUUID();
  return session.steerInput({
    command,
    images: options.images,
    files: options.files,
    messageId,
    // [local] "Send now".
    urgent: options.urgent === true,
  });
}

/**
 * [local] Withdraws a message steered into a session's running turn that
 * Claude has not read yet. Resolves true only when the CLI dropped it from its
 * queue; false when there is no such message or it has already been read.
 * @param {string} sessionId - App session identifier
 * @param {string} messageId - The id the message was steered with
 * @returns {Promise<boolean>} True once the message is withdrawn
 */
async function cancelSteerClaudeSDKSession(sessionId: string, messageId: string): Promise<boolean> {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.cancelSteer) {
    return false;
  }
  return session.cancelSteer(messageId);
}

/**
 * [local] Moves a running foreground tool call (a shell command or subagent)
 * of a session's turn to the background, as Ctrl+B does in the terminal: the
 * call returns at once, the turn goes on, and the task keeps running and is
 * tracked like any background task. Without `toolUseId`, all such calls.
 * @param {string} sessionId - App session identifier
 * @param {string} [toolUseId] - The tool_use id of the call to move
 * @returns {Promise<boolean>} False when nothing was moved
 */
async function backgroundClaudeSDKTask(sessionId: string, toolUseId?: string): Promise<boolean> {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || session.inputReleased) {
    return false;
  }
  return requestBackgroundTasks(session.instance, toolUseId);
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open for the work — which is exactly the window in which nothing
 * else (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 */
function listClaudeSDKBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
  return backgroundWork.list();
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 *
 * The CLI acknowledges `stop_task` even when it stops nothing (seen with a
 * Monitor task, CLI 2.1.318), so the stop only counts once the task has left
 * the tracker; otherwise this throws and the user hears the stop failed.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @param {number} confirmMs - How long to wait for the task to settle
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
// A repeated ✕ joins the stop under way instead of sending stop_task again.
const pendingTaskStops = new Map<string, Promise<boolean>>();

function stopClaudeSDKTask(sessionId: string, taskId: string, confirmMs = 5000): Promise<boolean> {
  const key = `${sessionId}\u0000${taskId}`;
  const pending = pendingTaskStops.get(key);
  if (pending) return pending;
  const stop = runClaudeSDKTaskStop(sessionId, taskId, confirmMs)
    .finally(() => pendingTaskStops.delete(key));
  pendingTaskStops.set(key, stop);
  return stop;
}

async function runClaudeSDKTaskStop(sessionId: string, taskId: string, confirmMs: number): Promise<boolean> {
  const session = getSession(sessionId);
  const stopTask = session?.instance?.stopTask;
  if (!session || !stopTask || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  // Not awaited: the CLI may answer late or never, and the task leaving the
  // tracker is what counts, so one deadline covers both waits.
  let answered = false;
  let failed = false;
  let failure: unknown;
  stopTask.call(session.instance, taskId).then(
    () => { answered = true; },
    (error: unknown) => { answered = true; failed = true; failure = error; },
  );
  const deadline = Date.now() + confirmMs;
  while (backgroundWork.has(sessionId, taskId)) {
    if (failed) {
      throw failure;
    }
    if (Date.now() >= deadline) {
      throw new Error(answered
        ? `Claude Code acknowledged the stop, but background task "${taskId}" is still running.`
        : `Claude Code did not answer the stop of background task "${taskId}".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId: string) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId: string) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId: string) {
  const pending: AnyRecord[] = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId: string, newRawWs: unknown) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * SDK 0.3.311 ships `Query.prototype.askSideQuestion` without it in the SDK's
 * own typings (checked in node_modules/@anthropic-ai/claude-agent-sdk) — hence
 * the local types below rather than an imported one.
 */
type NativeSideQuestionResult = {
  response: string;
  synthetic: boolean;
  refusalFallback?: AnyRecord;
};

type NativeSideQuestionCapableInstance = {
  askSideQuestion: (
    question: string,
    options?: { signal?: AbortSignal },
  ) => Promise<NativeSideQuestionResult | null>;
};

/**
 * Asks a side question on the live query of `request.appSessionId`, when one
 * is up and ships the method, or on a read-only fork otherwise.
 *
 * Measured 2026-10-27 (`claude-measurement`, SDK 0.3.311, five calls each,
 * alternating): median response time, native vs the fork —
 *   mid-turn (process mid-generation):        native 1504 ms, fork 7476 ms
 *   background (held only for background work): native 2141 ms, fork 5016 ms
 * Native wins in both busy states, so the path taken here does not depend on
 * which one the process is in: any live query with the method answers
 * natively. Caveat: the CLI refused a foreground `sleep 240` during
 * measurement, so most "mid-turn" calls likely ran after the turn ended too
 * — the gap there may be narrower than measured, not wider.
 *
 * `liveTasks` for the fork path comes from this runtime's own background
 * work tracker, keyed by the app session id, so the fork's prompt can say
 * which of the session's own tasks are still running.
 */
async function askSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
  context: ProviderRuntimeContext,
): Promise<SideQuestionOutcome> {
  const session = getSession(request.appSessionId);
  // The SDK does not type this method (see above), so the instance is read
  // through the local type rather than `ClaudeQuery`. Kept alongside the
  // original (`session.instance`, typed `ClaudeQuery`) so the `finally`
  // below can compare identity without comparing through this cast — the
  // cast's structural type and `ClaudeQuery` share no members TS can see,
  // so a `===` between two values of those two types reads as a mistake.
  const instance = session?.instance as NativeSideQuestionCapableInstance | undefined;

  // A session whose stdin was already released (turn ended with no
  // background work, or the idle ceiling) still has `instance` around, but
  // a write into its input stream is silently dropped rather than answered.
  // The fork path below spawns its own process instead, so it is the only
  // one that can still reach this session's transcript.
  // `session &&` (not just `instance &&`) narrows `session` itself for the
  // rest of this block, since `instance` was read off it through a cast TS
  // cannot trace back.
  if (session && instance && typeof instance.askSideQuestion === 'function' && !session.inputReleased) {
    // Counted on the session entry so `queryClaudeSDK`'s
    // `maybeReleasePromptStream` defers a release requested while this is
    // still above zero, instead of closing stdin under the question.
    session.pendingNativeSideQuestions = (session.pendingNativeSideQuestions || 0) + 1;
    try {
      const result = await instance.askSideQuestion(request.question, { signal: request.signal });
      const response = result?.response;
      if (typeof response === 'string' && response.length > 0) {
        sink.delta(response);
        return { status: 'done', answer: response };
      }
      return { status: 'error', error: 'Claude returned no answer.', answer: '' };
    } catch (error) {
      // `request.signal` is what `dismiss` aborts to end this ask at once —
      // a deliberate drop, never retried. A session whose stdin was
      // released while this ask was still outstanding (a new turn
      // superseding this one via `releaseHeldSession`, which lets the old
      // process go directly and does not consult the pending count above)
      // is the CLI cancelling the question for a reason that was not that
      // signal — most of all "Side question cancelled" — so it gets one
      // more try on the read-only fork instead of surfacing the CLI's own
      // error. A plain failure with the session still live is not retried.
      // `session` (not a fresh lookup) so a map entry replaced meanwhile by
      // a new turn's own registration does not hide this very query's
      // release, which `releaseHeldSession` sets on this same object.
      // Cast through `unknown`: the `if` above narrowed `session.inputReleased`
      // to the literal `false`, but that narrowing does not survive the
      // `await` above in reality — `releaseHeldSession` can flip it from
      // other code while this call is in flight — so TS's belief that this
      // comparison can never be true is the stale part, not the check.
      if (!request.signal?.aborted && (session.inputReleased as unknown) === true) {
        return askClaudeSideQuestion(request, sink, {
          createQuery: context.createQuery,
          liveTasks: backgroundWork.outstanding(request.appSessionId),
        });
      }
      return { status: 'error', error: errorMessage(error), answer: '' };
    } finally {
      // Re-fetched: a mid-run re-registration (`addSession`, once the
      // provider session id lands) carries this count onto a new entry
      // object for the same instance, so the one to decrement is whichever
      // is current now — but only when it is still the entry for the
      // instance this question was asked on. A turn that superseded this
      // run while the question was in flight replaced the map entry with
      // the new run's own (a different `instance`, a `pendingNativeSideQuestions`
      // count that was never incremented for this question), and must not
      // be decremented or released on this question's account.
      const entry = getSession(request.appSessionId);
      // Compared through `unknown`, not through the `NativeSideQuestionCapableInstance`
      // cast above: `entry.instance` is `ClaudeQuery` and `instance` is that
      // cast's type, and the two share no member TS can see, so a direct
      // `===` between them reads as unintentional even though both sides
      // are (or were) the very same object.
      if (entry && (entry.instance as unknown) === (instance as unknown)) {
        entry.pendingNativeSideQuestions = Math.max(0, (entry.pendingNativeSideQuestions || 0) - 1);
        if (entry.pendingNativeSideQuestions === 0 && entry.releaseDeferred) {
          entry.releaseDeferred = false;
          // [local] An adoptable run releases through its own check, which
          // holds back while an adopted turn is running; any other run
          // releases directly, as before.
          if (entry.requestRelease) {
            entry.requestRelease();
          } else {
            entry.releaseInput?.();
          }
        }
      }
    }
  }

  return askClaudeSideQuestion(request, sink, {
    createQuery: context.createQuery,
    liveTasks: backgroundWork.outstanding(request.appSessionId),
  });
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
  stopAllBackgroundWork: stopAllClaudeSDKBackgroundWork,
  askSideQuestion,
  steer: steerClaudeSDKSession,
  cancelSteer: cancelSteerClaudeSDKSession,
  backgroundTask: backgroundClaudeSDKTask,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  steerClaudeSDKSession,
  cancelSteerClaudeSDKSession,
  backgroundClaudeSDKTask,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  stopAllClaudeSDKBackgroundWork,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
