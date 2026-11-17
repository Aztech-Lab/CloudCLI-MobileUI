/**
 * [local] Pieces shared by the two Codex runtimes: the `codex exec` one
 * (`codex-runtime.provider.ts`, through the SDK) and the app-server one
 * (`codex-app-server.runtime.ts`). Moved here unchanged from
 * codex-runtime.provider.ts, which re-exports what it exported before.
 */

import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';

import { createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/index.js';

// Codex CLI requires non-whitespace stdin even when --image arguments are
// present, so attachment-only turns need a small text instruction.
export const CODEX_IMAGE_ONLY_PROMPT = 'Please analyze the attached image(s).';

function readUsageNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function extractCodexTokenBudget(event: AnyRecord) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

type CodexPermissionOptions = Pick<ThreadOptions, 'sandboxMode' | 'approvalPolicy'> & {
  /**
   * Extra `--config` overrides for the Codex CLI, passed through
   * `CodexOptions.config`. Absent for every mode that needs none, so those
   * keep spawning the CLI exactly as before.
   */
  config?: CodexOptions['config'];
};

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'approveForMe', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy, config? }
 */
export function mapPermissionModeToCodexOptions(permissionMode: string): CodexPermissionOptions {
  switch (permissionMode) {
    // [local] Codex's "Approve for me": what `codex exec --approve-for-me`
    // sets. Same sandbox and policy as the default mode, but approval
    // requests go to Codex's automatic reviewer instead of the user. The
    // reviewer is spelled out per run so a user-level `approvals_reviewer`
    // in config.toml cannot change what this mode means.
    case 'approveForMe':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        config: { approvals_reviewer: 'auto_review' },
      };
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        // Current Codex CLI versions reject the retired `untrusted` policy.
        // Keep sandboxing enabled; exec cannot grant interactive approval requests.
        approvalPolicy: 'on-request'
      };
  }
}

/**
 * [local] Stable code on the error row sent when Codex refuses to resume a
 * thread because another process (typically the Codex desktop app's
 * app-server) already holds it open for writing. The client translates it.
 */
export const CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE = 'codex_thread_active_writer';

/** English fallback for the error row above, shown when no translation applies. */
export const CODEX_THREAD_ACTIVE_WRITER_MESSAGE =
  'This conversation is open in the Codex app, which allows only one writer at a time. '
  + 'Close it there (or continue there), then send again.';

/**
 * Codex allows one writer per thread. A second resume fails with
 * `thread/resume failed: thread <id> already has an active writer (code -32600)`
 * or, from the thread store, `thread-store conflict: thread <id> already has
 * an active writer`; the SDK wraps either in "Codex Exec exited with code 1".
 */
export function isCodexThreadActiveWriterError(message: unknown): boolean {
  return typeof message === 'string' && /already has an active writer/i.test(message);
}

/** The error row for a thread another process holds open; see CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE. */
export function createCodexActiveWriterErrorMessage(sessionId: string | null) {
  return createNormalizedMessage({
    kind: 'error',
    content: CODEX_THREAD_ACTIVE_WRITER_MESSAGE,
    errorCode: CODEX_THREAD_ACTIVE_WRITER_ERROR_CODE,
    sessionId,
    provider: 'codex',
  });
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
export function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isWebSocketWriter) {
      // The gateway writer handles stringification
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}
