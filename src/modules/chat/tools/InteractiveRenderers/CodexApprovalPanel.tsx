import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlertIcon } from 'lucide-react';

import type { PermissionPanelProps } from '@/shared/types';
import { CODEX_APPROVAL_TOOL_NAMES } from '@/modules/chat/tools/configs/codexApprovalToolNames';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/modules/chat/composer/Confirmation';

type Choice = 'accept' | 'acceptForSession' | 'decline';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];

const readChoices = (context: unknown): Choice[] => {
  const choices = asRecord(context).choices;
  const known = Array.isArray(choices)
    ? choices.filter((choice): choice is Choice => choice === 'accept' || choice === 'acceptForSession' || choice === 'decline')
    : [];
  return known.length > 0 ? known : ['accept', 'acceptForSession', 'decline'];
};

/** Large, full-width buttons on a phone; a row from the small breakpoint up. No hover-only actions. */
const BUTTON_CLASS = 'h-11 w-full px-3 text-sm sm:h-9 sm:w-auto';

const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="mt-1.5 text-xs text-muted-foreground">
    <span className="font-medium text-foreground/80">{label}: </span>
    {children}
  </div>
);

const PathList = ({ paths }: { paths: string[] }) => (
  <span className="inline-flex flex-wrap gap-1 align-middle">
    {paths.map((entry) => (
      <code key={entry} className="break-all rounded bg-muted px-1 py-0.5 text-xs">{entry}</code>
    ))}
  </span>
);

const CodeBlock = ({ children }: { children: string }) => (
  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-2 font-mono text-xs text-foreground">
    {children}
  </pre>
);

/**
 * The chat card for a Codex approval request (command, file change, extra
 * permissions) and for an action Codex's automatic reviewer denied. Answers
 * go back through the same `chat.permission-response` as Claude's:
 * - Allow once → `{ allow: true }` (Codex `accept`, permissions for this turn)
 * - Allow for this session → `{ allow: true, rememberEntry: 'session' }`
 *   (Codex `acceptForSession`, permissions for the session)
 * - Deny → `{ allow: false }` (Codex `decline`)
 * - Allow anyway (denied review) → `{ allow: true }`; Keep denied → `{ allow: false }`
 *
 * Registered by PermissionRequestsBanner under CODEX_APPROVAL_TOOL_NAMES.
 */
export const CodexApprovalPanel: React.FC<PermissionPanelProps> = ({ request, onDecision }) => {
  const { t } = useTranslation('chat');
  const input = asRecord(request.input);
  const isDenial = request.toolName === CODEX_APPROVAL_TOOL_NAMES.reviewDenial;
  const choices = isDenial ? [] : readChoices(request.context);

  const decide = (decision: { allow: boolean; rememberEntry?: string }) => onDecision(request.requestId, decision);

  let title: string;
  let body: React.ReactNode;
  switch (request.toolName) {
    case CODEX_APPROVAL_TOOL_NAMES.command: {
      const network = asRecord(input.network);
      const extra = asRecord(input.additionalPermissions);
      const host = asString(network.host);
      title = host
        ? t('codexApprovals.title.network', { defaultValue: 'Codex wants network access' })
        : input.kind === 'writeStdin'
          ? t('codexApprovals.title.stdin', { defaultValue: 'Codex wants to type into a running command' })
          : t('codexApprovals.title.command', { defaultValue: 'Codex wants to run a command' });
      body = (
        <>
          {asString(input.command) && <CodeBlock>{asString(input.command)}</CodeBlock>}
          {host && <Detail label={t('codexApprovals.label.host', { defaultValue: 'Host' })}><code className="break-all">{host}</code></Detail>}
          {asString(input.cwd) && <Detail label={t('codexApprovals.label.cwd', { defaultValue: 'Folder' })}><PathList paths={[asString(input.cwd)]} /></Detail>}
          {extra.network === true && <Detail label={t('codexApprovals.label.network', { defaultValue: 'Network' })}>{t('codexApprovals.label.networkOn', { defaultValue: 'on' })}</Detail>}
          {asStrings(extra.write).length > 0 && <Detail label={t('codexApprovals.label.write', { defaultValue: 'Write' })}><PathList paths={asStrings(extra.write)} /></Detail>}
          {asStrings(extra.read).length > 0 && <Detail label={t('codexApprovals.label.read', { defaultValue: 'Read' })}><PathList paths={asStrings(extra.read)} /></Detail>}
        </>
      );
      break;
    }
    case CODEX_APPROVAL_TOOL_NAMES.fileChange: {
      const changes = (Array.isArray(input.changes) ? input.changes : []).map(asRecord);
      title = t('codexApprovals.title.fileChange', { defaultValue: 'Codex wants to change files' });
      body = (
        <>
          {changes.length > 0 && (
            <Detail label={t('codexApprovals.label.files', { defaultValue: 'Files' })}>
              <PathList paths={changes.map((change) => asString(change.path)).filter(Boolean)} />
            </Detail>
          )}
          {asString(input.grantRoot) && (
            <Detail label={t('codexApprovals.label.grantRoot', { defaultValue: 'Write access under' })}>
              <PathList paths={[asString(input.grantRoot)]} />
            </Detail>
          )}
          {changes.some((change) => asString(change.diff)) && (
            <details className="mt-2">
              {/* A tap target, not a hover: the summary toggles on touch too. */}
              <summary className="flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground sm:min-h-0">
                {t('codexApprovals.label.showChanges', { defaultValue: 'Show changes' })}
              </summary>
              <CodeBlock>{changes.map((change) => `${asString(change.path)}\n${asString(change.diff)}`).join('\n\n')}</CodeBlock>
            </details>
          )}
        </>
      );
      break;
    }
    case CODEX_APPROVAL_TOOL_NAMES.permissions:
      title = t('codexApprovals.title.permissions', { defaultValue: 'Codex asks for more access' });
      body = (
        <>
          {input.network === true && <Detail label={t('codexApprovals.label.network', { defaultValue: 'Network' })}>{t('codexApprovals.label.networkOn', { defaultValue: 'on' })}</Detail>}
          {asStrings(input.write).length > 0 && <Detail label={t('codexApprovals.label.write', { defaultValue: 'Write' })}><PathList paths={asStrings(input.write)} /></Detail>}
          {asStrings(input.read).length > 0 && <Detail label={t('codexApprovals.label.read', { defaultValue: 'Read' })}><PathList paths={asStrings(input.read)} /></Detail>}
          {asString(input.cwd) && <Detail label={t('codexApprovals.label.cwd', { defaultValue: 'Folder' })}><PathList paths={[asString(input.cwd)]} /></Detail>}
        </>
      );
      break;
    default:
      title = t('codexApprovals.title.reviewDenial', { defaultValue: 'Auto-review blocked an action' });
      body = (
        <>
          {asString(input.action) && <CodeBlock>{asString(input.action)}</CodeBlock>}
          {asString(input.rationale) && (
            <Detail label={t('codexApprovals.label.reviewReason', { defaultValue: 'Reviewer' })}>{asString(input.rationale)}</Detail>
          )}
          {asString(input.riskLevel) && (
            <Detail label={t('codexApprovals.label.risk', { defaultValue: 'Risk' })}>
              {t(`codexApprovals.risk.${asString(input.riskLevel)}`, { defaultValue: asString(input.riskLevel) })}
            </Detail>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t('codexApprovals.reviewDenialHint', {
              defaultValue: 'Allow anyway tells Codex you approve this exact action. It sees that at its next step; if it has already finished, send a message such as "try again". The retry is still reviewed.',
            })}
          </p>
        </>
      );
  }

  return (
    <Confirmation approval="pending" data-testid="codex-approval-panel">
      <ConfirmationTitle className="flex items-start gap-3">
        <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <ConfirmationRequest>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">{title}</div>
            {!isDenial && asString(input.reason) && (
              <Detail label={t('codexApprovals.label.reason', { defaultValue: 'Why' })}>{asString(input.reason)}</Detail>
            )}
            {body}
          </div>
        </ConfirmationRequest>
      </ConfirmationTitle>

      <ConfirmationActions className="w-full flex-col-reverse items-stretch self-stretch sm:w-auto sm:flex-row sm:items-center sm:self-end">
        {isDenial ? (
          <>
            <ConfirmationAction variant="outline" className={BUTTON_CLASS} onClick={() => decide({ allow: false })}>
              {t('codexApprovals.actions.keepDenied', { defaultValue: 'Keep denied' })}
            </ConfirmationAction>
            <ConfirmationAction variant="default" className={BUTTON_CLASS} onClick={() => decide({ allow: true })}>
              {t('codexApprovals.actions.allowAnyway', { defaultValue: 'Allow anyway' })}
            </ConfirmationAction>
          </>
        ) : (
          <>
            {choices.includes('decline') && (
              <ConfirmationAction variant="outline" className={BUTTON_CLASS} onClick={() => decide({ allow: false })}>
                {t('codexApprovals.actions.deny', { defaultValue: 'Deny' })}
              </ConfirmationAction>
            )}
            {choices.includes('acceptForSession') && (
              <ConfirmationAction variant="outline" className={BUTTON_CLASS} onClick={() => decide({ allow: true, rememberEntry: 'session' })}>
                {t('codexApprovals.actions.allowSession', { defaultValue: 'Allow for this session' })}
              </ConfirmationAction>
            )}
            {choices.includes('accept') && (
              <ConfirmationAction variant="default" className={BUTTON_CLASS} onClick={() => decide({ allow: true })}>
                {t('codexApprovals.actions.allowOnce', { defaultValue: 'Allow once' })}
              </ConfirmationAction>
            )}
          </>
        )}
      </ConfirmationActions>
    </Confirmation>
  );
};
