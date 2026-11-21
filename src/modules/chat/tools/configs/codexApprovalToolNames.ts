/**
 * [local] Tool names of the Codex prompts (app-server runtime, stage 3). The
 * server sends the same strings (`codex-app-server.approvals.ts`,
 * CODEX_PROMPT_TOOL_NAMES); a Codex question uses the AskUserQuestion panel.
 */
export const CODEX_APPROVAL_TOOL_NAMES = {
  command: 'CodexCommandApproval',
  fileChange: 'CodexFileChangeApproval',
  permissions: 'CodexPermissionsApproval',
  reviewDenial: 'CodexAutoReviewDenial',
} as const;
