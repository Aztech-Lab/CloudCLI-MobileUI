/**
 * [local] Approvals and questions of the Codex app-server runtime (stage 3):
 * how the app-server's server-to-client requests become the chat's permission
 * prompts, how the chat's answers go back, and how an automatic review
 * (`item/autoApprovalReview/*`) is shown and overridden.
 *
 * Pure mapping only; the runtime (`codex-app-server.runtime.ts`) owns the
 * pending prompts, timeouts and the connection. Shapes follow the protocol
 * generated from Codex 0.169 (`v2/CommandExecutionRequestApprovalParams`,
 * `v2/FileChangeRequestApprovalParams`, `v2/PermissionsRequestApprovalParams`,
 * `v2/ToolRequestUserInputParams`, `v2/ItemGuardianApprovalReviewCompletedNotification`).
 */

import type { AnyRecord, ProviderPermissionDecision } from '@/shared/types.js';

/**
 * Tool names the chat's permission panels are registered under. The client
 * registers the same strings (`src/modules/chat/tools/InteractiveRenderers/CodexApprovalPanel.tsx`).
 * A Codex question reuses the AskUserQuestion panel, as OpenCode's does.
 */
export const CODEX_PROMPT_TOOL_NAMES = {
  command: 'CodexCommandApproval',
  fileChange: 'CodexFileChangeApproval',
  permissions: 'CodexPermissionsApproval',
  question: 'AskUserQuestion',
  reviewDenial: 'CodexAutoReviewDenial',
} as const;

/** Transcript row of a finished automatic review. */
export const CODEX_AUTO_REVIEW_TOOL_NAME = 'CodexAutoReview';

/** The server requests a person can answer from the chat. */
export const CODEX_INTERACTIVE_SERVER_REQUESTS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
] as const;

export type CodexInteractiveServerRequest = typeof CODEX_INTERACTIVE_SERVER_REQUESTS[number];

export function isInteractiveCodexServerRequest(method: string): method is CodexInteractiveServerRequest {
  return (CODEX_INTERACTIVE_SERVER_REQUESTS as readonly string[]).includes(method);
}

/** Decisions the chat offers; everything else the protocol has (policy amendments, cancel) is left out. */
export type CodexApprovalChoice = 'accept' | 'acceptForSession' | 'decline';

const DEFAULT_CHOICES: CodexApprovalChoice[] = ['accept', 'acceptForSession', 'decline'];

/**
 * The choices to show for a command approval: the simple ones of
 * `availableDecisions`, in Codex's order, or all three when Codex lists none
 * (older servers). Policy amendments are never offered: they change the
 * user's Codex rules for good, which is more than a tap on a phone should do.
 */
function readChoices(available: unknown): CodexApprovalChoice[] {
  if (!Array.isArray(available)) {
    return DEFAULT_CHOICES;
  }
  const simple = available.filter((decision): decision is CodexApprovalChoice =>
    decision === 'accept' || decision === 'acceptForSession' || decision === 'decline');
  // Declining must always be possible from the chat.
  return simple.includes('decline') ? simple : [...simple, 'decline'];
}

const readString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const readStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];

/** File-system and network access a permissions request (or a command) asks for, flattened for display. */
function describePermissionProfile(profile: unknown): { network: boolean | null; read: string[]; write: string[] } {
  const record = (profile && typeof profile === 'object' ? profile : {}) as AnyRecord;
  const fileSystem = (record.fileSystem && typeof record.fileSystem === 'object' ? record.fileSystem : {}) as AnyRecord;
  const entries: AnyRecord[] = Array.isArray(fileSystem.entries) ? fileSystem.entries : [];
  const entryPaths = (access: string) => entries
    .filter((entry) => entry?.access === access)
    .map((entry) => readString(entry?.path?.path) ?? readString(entry?.path?.pattern) ?? readString(entry?.path?.value?.kind))
    .filter((entry): entry is string => Boolean(entry));
  const network = typeof record.network?.enabled === 'boolean' ? record.network.enabled : null;
  return {
    network,
    read: [...new Set([...readStringList(fileSystem.read), ...entryPaths('read')])],
    write: [...new Set([...readStringList(fileSystem.write), ...entryPaths('write')])],
  };
}

export type CodexPromptDescription = {
  toolName: string;
  input: AnyRecord;
  context: AnyRecord;
};

/**
 * One server request as the chat's permission prompt: the panel to use, what
 * it shows, and the choices it offers. `fileChanges` holds the `fileChange`
 * items of the turn by id: an approval request names only the item, whose
 * paths and diffs Codex reported in `item/started` just before.
 */
export function describeCodexServerRequest(
  method: CodexInteractiveServerRequest,
  params: AnyRecord,
  fileChanges: Map<string, AnyRecord>,
): CodexPromptDescription {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const network = params.networkApprovalContext && typeof params.networkApprovalContext === 'object'
        ? { host: readString(params.networkApprovalContext.host), protocol: readString(params.networkApprovalContext.protocol) }
        : null;
      return {
        toolName: CODEX_PROMPT_TOOL_NAMES.command,
        input: {
          command: readString(params.command),
          cwd: readString(params.cwd),
          reason: readString(params.reason),
          kind: readString(params.kind) ?? 'command',
          network,
          additionalPermissions: params.additionalPermissions ? describePermissionProfile(params.additionalPermissions) : null,
        },
        context: { provider: 'codex', choices: readChoices(params.availableDecisions) },
      };
    }
    case 'item/fileChange/requestApproval': {
      const item = typeof params.itemId === 'string' ? fileChanges.get(params.itemId) : undefined;
      const changes = (Array.isArray(item?.changes) ? item.changes : []).map((change: AnyRecord) => ({
        path: readString(change?.path) ?? '',
        kind: readString(change?.kind?.type) ?? readString(change?.kind) ?? 'update',
        diff: typeof change?.diff === 'string' ? change.diff : '',
      }));
      return {
        toolName: CODEX_PROMPT_TOOL_NAMES.fileChange,
        input: { reason: readString(params.reason), grantRoot: readString(params.grantRoot), changes },
        context: { provider: 'codex', choices: DEFAULT_CHOICES },
      };
    }
    case 'item/permissions/requestApproval':
      return {
        toolName: CODEX_PROMPT_TOOL_NAMES.permissions,
        input: { reason: readString(params.reason), cwd: readString(params.cwd), ...describePermissionProfile(params.permissions) },
        context: { provider: 'codex', choices: DEFAULT_CHOICES },
      };
    case 'item/tool/requestUserInput': {
      const questions: AnyRecord[] = Array.isArray(params.questions) ? params.questions : [];
      return {
        toolName: CODEX_PROMPT_TOOL_NAMES.question,
        input: {
          questions: questions.map((question) => ({
            question: String(question?.question ?? ''),
            header: readString(question?.header) ?? undefined,
            options: (Array.isArray(question?.options) ? question.options : []).map((option: AnyRecord) => ({
              label: String(option?.label ?? ''),
              description: typeof option?.description === 'string' ? option.description : '',
            })),
            multiSelect: false,
            // Codex offers a typed answer only with `isOther`; a question with
            // no options at all can only be answered by typing.
            ...(question?.isOther === true || !Array.isArray(question?.options) || question.options.length === 0
              ? {}
              : { custom: false }),
          })),
        },
        // One label list per question, and Dismiss instead of Skip (see AskUserQuestionPanel).
        context: { provider: 'codex', answerFormat: 'label-lists' },
      };
    }
    default:
      throw new Error(`Not an interactive Codex request: ${String(method)}`);
  }
}

/** The choice a chat decision picks. "Allow for this session" is sent as `rememberEntry: 'session'`. */
export function readCodexApprovalChoice(decision: ProviderPermissionDecision): CodexApprovalChoice {
  if (!decision.allow) {
    return 'decline';
  }
  return decision.rememberEntry === 'session' ? 'acceptForSession' : 'accept';
}

/** What a declined (or timed-out, or unanswered) request is answered with. */
export function codexDeclineResponse(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'item/permissions/requestApproval':
      // Nothing granted.
      return { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput':
      // No answers: Codex carries on without them.
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: 'No one is available to approve this request.' } } };
    default:
      throw new Error(`CloudCLI does not support "${method}" yet.`);
  }
}

/** Only the parts of a requested permission profile Codex asked for, as a grant. */
function grantRequestedPermissions(requested: unknown): AnyRecord {
  const record = (requested && typeof requested === 'object' ? requested : {}) as AnyRecord;
  const granted: AnyRecord = {};
  if (record.network && typeof record.network === 'object') {
    granted.network = record.network;
  }
  if (record.fileSystem && typeof record.fileSystem === 'object') {
    granted.fileSystem = record.fileSystem;
  }
  return granted;
}

/** Reads the chat's answers to a Codex question: one label list per question, in question order. */
function readQuestionAnswers(updatedInput: unknown, questions: AnyRecord[]): AnyRecord {
  const answers = (updatedInput && typeof updatedInput === 'object' ? (updatedInput as AnyRecord).answers : null);
  const result: AnyRecord = {};
  questions.forEach((question, index) => {
    const id = readString(question?.id);
    if (!id) {
      return;
    }
    const raw = Array.isArray(answers) ? answers[index] : (answers && typeof answers === 'object' ? answers[question.question] : undefined);
    const labels = Array.isArray(raw)
      ? raw.filter((label: unknown): label is string => typeof label === 'string' && label.trim().length > 0)
      : (typeof raw === 'string' && raw.trim() ? [raw] : []);
    result[id] = { answers: labels };
  });
  return result;
}

/** The JSON-RPC result for a server request the chat answered. */
export function codexServerRequestResponse(
  method: CodexInteractiveServerRequest,
  params: AnyRecord,
  decision: ProviderPermissionDecision,
): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: readCodexApprovalChoice(decision) };
    case 'item/permissions/requestApproval': {
      const choice = readCodexApprovalChoice(decision);
      if (choice === 'decline') {
        return codexDeclineResponse(method);
      }
      return {
        permissions: grantRequestedPermissions(params.permissions),
        scope: choice === 'acceptForSession' ? 'session' : 'turn',
      };
    }
    case 'item/tool/requestUserInput':
      return decision.allow
        ? { answers: readQuestionAnswers(decision.updatedInput, Array.isArray(params.questions) ? params.questions : []) }
        : codexDeclineResponse(method);
    default:
      return codexDeclineResponse(method);
  }
}

// ---------------------------------------------------------------------------
// Automatic review ("Approve for me")

/** A reviewed action as one short line plus the details the review row shows. */
export function summarizeReviewedAction(action: unknown): { kind: string; summary: string; cwd: string | null } {
  const record = (action && typeof action === 'object' ? action : {}) as AnyRecord;
  const kind = readString(record.type) ?? 'action';
  switch (kind) {
    case 'command':
      return { kind, summary: readString(record.command) ?? '', cwd: readString(record.cwd) };
    case 'execve':
      return { kind, summary: readStringList(record.argv).join(' ') || (readString(record.program) ?? ''), cwd: readString(record.cwd) };
    case 'writeStdin':
      return { kind, summary: readString(record.stdin) ?? '', cwd: readString(record.cwd) };
    case 'applyPatch':
      return { kind, summary: readStringList(record.files).join(', '), cwd: readString(record.cwd) };
    case 'networkAccess':
      return { kind, summary: readString(record.target) ?? readString(record.host) ?? '', cwd: null };
    case 'mcpToolCall':
      return { kind, summary: `${readString(record.server) ?? 'mcp'} / ${readString(record.toolTitle) ?? readString(record.toolName) ?? 'tool'}`, cwd: null };
    case 'requestPermissions': {
      const profile = describePermissionProfile(record.permissions);
      const parts = [
        ...(profile.network ? ['network'] : []),
        ...profile.write.map((entry) => `write ${entry}`),
        ...profile.read.map((entry) => `read ${entry}`),
      ];
      return { kind, summary: readString(record.reason) ?? parts.join(', '), cwd: null };
    }
    default:
      return { kind, summary: '', cwd: null };
  }
}

/** The input of the transcript row (and of the denial prompt) for a finished review. */
export function describeAutoReview(params: AnyRecord): AnyRecord {
  const review = (params.review && typeof params.review === 'object' ? params.review : {}) as AnyRecord;
  const action = summarizeReviewedAction(params.action);
  return {
    reviewId: readString(params.reviewId),
    status: readString(review.status) ?? 'inProgress',
    riskLevel: readString(review.riskLevel),
    userAuthorization: readString(review.userAuthorization),
    rationale: readString(review.rationale),
    actionKind: action.kind,
    action: action.summary,
    cwd: action.cwd,
  };
}

const snakeCase = (value: string) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Keys whose string values are enum variants, which Codex's core protocol spells in snake case. */
const ENUM_VALUE_KEYS = new Set(['type', 'source', 'protocol', 'status', 'access', 'kind']);

/** Camel-cased v2 keys (and enum values) as the core protocol's snake case, recursively. Paths are left alone. */
function toCoreProtocol(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => toCoreProtocol(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as AnyRecord).map(([childKey, child]) => {
      const coreKey = snakeCase(childKey);
      return [coreKey, toCoreProtocol(child, coreKey)];
    }));
  }
  return typeof value === 'string' && ENUM_VALUE_KEYS.has(key) ? snakeCase(value) : value;
}

/**
 * The `event` of `thread/approveGuardianDeniedAction`: a serialized core
 * `GuardianAssessmentEvent`, rebuilt from the v2 review notification.
 *
 * The v2 schema only types it as JSON. Checked against Codex 0.169 with a
 * throwaway CODEX_HOME: `id`, `status` and `action` are required; every field
 * and enum value is snake case (`apply_patch`, `unified_exec`, `file_system`);
 * the call records a developer message in the thread's history ("The user has
 * manually approved a specific action that was previously `Rejected`…"), so
 * the model sees it at its next step, and a retry still goes through review.
 */
export function toGuardianAssessmentEvent(params: AnyRecord): AnyRecord {
  const review = (params.review && typeof params.review === 'object' ? params.review : {}) as AnyRecord;
  return {
    id: params.reviewId,
    ...(typeof params.turnId === 'string' ? { turn_id: params.turnId } : {}),
    target_item_id: typeof params.targetItemId === 'string' ? params.targetItemId : null,
    status: snakeCase(String(review.status ?? 'denied')),
    risk_level: typeof review.riskLevel === 'string' ? review.riskLevel : null,
    user_authorization: typeof review.userAuthorization === 'string' ? review.userAuthorization : null,
    rationale: typeof review.rationale === 'string' ? review.rationale : null,
    ...(typeof params.decisionSource === 'string' ? { decision_source: params.decisionSource } : {}),
    ...(typeof params.startedAtMs === 'number' ? { started_at_ms: params.startedAtMs } : {}),
    ...(typeof params.completedAtMs === 'number' ? { completed_at_ms: params.completedAtMs } : {}),
    action: toCoreProtocol(params.action),
  };
}
