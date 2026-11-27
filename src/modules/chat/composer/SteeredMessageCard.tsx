import { useTranslation } from 'react-i18next';

import type { PendingSteer } from '@/shared/types';

type SteeredMessageCardProps = {
  steer: PendingSteer;
  /** The provider's display name, e.g. "Claude". */
  providerLabel: string;
  /**
   * [local] Takes the message back while the agent has not read it yet. Absent
   * when nothing can withdraw it; the card then has no button.
   */
  onWithdraw?: (messageId: string) => void;
  /** [local] "Send now" stops the current step and starts a new turn (Codex). */
  sendNowInterruptsTurn?: boolean;
};

/**
 * Rendered by chat's ChatComposer for a message sent into the running turn
 * that the agent has not read yet. There is no edit: the message is already
 * in the agent's input. [local] It can be withdrawn until the agent takes it,
 * which puts it back into the composer. The card goes away when the agent
 * reads it and it appears in the transcript, where it was read.
 */
export default function SteeredMessageCard({ steer, providerLabel, onWithdraw, sendNowInterruptsTurn = false }: SteeredMessageCardProps) {
  const { t } = useTranslation('chat');
  const attachmentCount = steer.uploadedAttachments.length || steer.attachments.length;

  // [local] Pending, in the words of when it will be read; delivery removes the card.
  let status: string;
  if (steer.status === 'sending') {
    status = t('input.steer.sending', { defaultValue: 'Sending…' });
  } else if (steer.status === 'withdrawing') {
    status = t('input.steer.withdrawing', { defaultValue: 'Withdrawing…' });
  } else if (steer.withdrawFailed) {
    status = t('input.steer.withdrawTooLate', { provider: providerLabel, defaultValue: 'Too late to withdraw: {{provider}} is already reading it' });
  } else if (steer.urgent && sendNowInterruptsTurn) {
    status = t('input.steer.willReadNowInterrupts', { provider: providerLabel, defaultValue: '{{provider}} stops the current step and reads it' });
  } else if (steer.urgent) {
    status = t('input.steer.willReadNow', { provider: providerLabel, defaultValue: '{{provider}} reads it right away' });
  } else {
    status = t('input.steer.willRead', { provider: providerLabel, defaultValue: '{{provider}} reads it at its next tool call' });
  }
  const canWithdraw = Boolean(onWithdraw) && steer.status === 'accepted' && !steer.withdrawFailed;
  const withdrawLabel = t('input.steer.withdraw', { defaultValue: 'Withdraw' });

  return (
    <div className="settings-content-enter mx-auto mb-2 chat-content-width rounded-xl rounded-t-none border border-primary/30 bg-primary/[0.06] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/80">
            <span>
              {steer.urgent
                ? t('input.steer.labelNow', { defaultValue: 'Sent now' })
                : t('input.steer.label', { defaultValue: 'Steering' })}
            </span>
            <span className="normal-case text-muted-foreground/70" role="status">
              · {status}
            </span>
          </div>
          <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground/90">
            {steer.content}
          </p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('input.steer.attachments', { count: attachmentCount, defaultValue: '{{count}} files attached' })}
            </p>
          )}
        </div>

        {canWithdraw && (
          // [local] A real button with a finger-sized target, not a hover affordance.
          <button
            type="button"
            onClick={() => onWithdraw?.(steer.messageId)}
            className="-my-1 inline-flex min-h-9 shrink-0 items-center rounded-lg border border-border/60 bg-background/80 px-3 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted active:bg-muted"
            aria-label={withdrawLabel}
          >
            {withdrawLabel}
          </button>
        )}
      </div>
    </div>
  );
}
