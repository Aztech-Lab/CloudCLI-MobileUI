import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToolCardActions } from '@/modules/chat/context/ToolCardActionsContext';

type MoveToBackgroundButtonProps = {
  /** The tool_use id of the running call. */
  toolId: string;
};

/**
 * [local] "Move to background" under a running foreground shell command or
 * agent call (Ctrl+B in the terminal): the call returns at once, the reply
 * goes on, and the work keeps running as a background task. Rendered by
 * MessageComponent only while the call has no result; it disappears when the
 * result (a "running in the background" note, once moved) arrives. Renders
 * nothing when the turn cannot move work aside.
 */
export function MoveToBackgroundButton({ toolId }: MoveToBackgroundButtonProps) {
  const { t } = useTranslation('chat');
  const { moveToBackground, refusedAt } = useToolCardActions();
  const [requestedAt, setRequestedAt] = useState<number | null>(null);

  if (!moveToBackground) {
    return null;
  }

  const refused = requestedAt !== null && (refusedAt.get(toolId) ?? 0) >= requestedAt;
  const moving = requestedAt !== null && !refused;
  const label = t('tools.moveToBackground.label', { defaultValue: 'Move to background' });

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={moving}
        onClick={() => {
          setRequestedAt(Date.now());
          moveToBackground(toolId);
        }}
        className="inline-flex min-h-9 items-center rounded-lg border border-border/60 bg-background px-3 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted active:bg-muted disabled:opacity-60"
        title={t('tools.moveToBackground.description', { defaultValue: 'Keep it running in the background and let the reply go on' })}
      >
        {moving ? t('tools.moveToBackground.moving', { defaultValue: 'Moving…' }) : label}
      </button>
      {refused && (
        <span className="text-xs text-muted-foreground" role="status">
          {t('tools.moveToBackground.failed', { defaultValue: 'Could not move it to the background' })}
        </span>
      )}
    </div>
  );
}
