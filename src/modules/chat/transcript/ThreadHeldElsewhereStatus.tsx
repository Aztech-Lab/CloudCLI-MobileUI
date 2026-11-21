import { useTranslation } from 'react-i18next';

import { isThreadHeldElsewhere } from '@/modules/chat/utils/threadHeldElsewhere';
import type { ChatMessage } from '@/shared/types';

type ThreadHeldElsewhereStatusProps = {
  /** The provider can say this at all (Codex on the app-server runtime). */
  enabled: boolean;
  isProcessing: boolean;
  messages: ChatMessage[];
};

/**
 * [local] A one-line status at the top of the conversation while its thread
 * is open in the Codex app, so a phone user sees why nothing runs before
 * scrolling to the refused send. Gone as soon as a send goes through.
 */
export default function ThreadHeldElsewhereStatus({ enabled, isProcessing, messages }: ThreadHeldElsewhereStatusProps) {
  const { t } = useTranslation('chat');
  if (!enabled || isProcessing || !isThreadHeldElsewhere(messages)) {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="thread-held-elsewhere"
      className="flex flex-shrink-0 items-start gap-2 border-b border-amber-300/60 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200 sm:px-4"
    >
      <span className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium">{t('threadHeldElsewhere.label', { defaultValue: 'Open in the Codex app' })}</span>
        <span className="text-amber-800/80 dark:text-amber-200/70">
          {' · '}
          {t('threadHeldElsewhere.hint', {
            defaultValue: 'The last send was refused because this conversation is open in the Codex app. Close it there, then send again.',
          })}
        </span>
      </span>
    </div>
  );
}
