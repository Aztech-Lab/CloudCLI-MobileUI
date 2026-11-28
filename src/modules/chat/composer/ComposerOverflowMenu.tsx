// [local] The "more" menu of the phone composer toolbar (Settings > MobileUI > compact composer).
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Clock, EraserIcon, MessageSquareIcon, Mic, MoreHorizontal } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { ComposerMenuItem, ComposerMenuSeparator } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { ScheduleMessageOptions } from '@/modules/chat/composer/ScheduleMessagePopover';
import { COMPACT_COMPOSER_CLASSES } from '@/modules/chat/composer/compactComposerToolbar';

const VIEWPORT_MARGIN = 8;

/**
 * Wraps an action of the composer row that the compact phone toolbar moves
 * into the "more" menu: hidden below `sm`, untouched above. With the compact
 * toolbar off it renders the action as it is.
 */
export function PhoneHiddenAction({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return hidden ? <div className={COMPACT_COMPOSER_CLASSES.phoneHidden}>{children}</div> : <>{children}</>;
}

type ComposerOverflowMenuProps = {
  /** Clears the session's context; absent when the session cannot be cleared. */
  onClearContext?: () => void;
  /** A running turn is still writing to the context. */
  clearContextDisabled: boolean;
  onScheduleMessage: (scheduledFor: Date) => void;
  /** Nothing typed yet, so there is nothing to schedule. */
  scheduleDisabled: boolean;
  onToggleCommandMenu: () => void;
  slashCommandsCount: number;
  /** Starts voice input; absent when voice input is not available. */
  onStartVoice?: () => void;
};

/**
 * Rendered by chat's ChatComposer in the left-hand tools of the footer, on
 * phones only (`sm:hidden`), when the compact composer toolbar is on. Holds
 * the actions that do not fit one row at 360-414px: clear context, schedule,
 * the commands list (typing "/" opens it too) and voice input.
 */
export default function ComposerOverflowMenu({
  onClearContext,
  clearContextDisabled,
  onScheduleMessage,
  scheduleDisabled,
  onToggleCommandMenu,
  slashCommandsCount,
  onStartVoice,
}: ComposerOverflowMenuProps) {
  const { t } = useTranslation('chat');
  const { t: tm } = useTranslation('mobileui');
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'actions' | 'schedule'>('actions');
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);
  const label = tm('composer.moreActions', { defaultValue: 'More actions' });

  // The trigger sits at the left of the composer, so the menu opens from its
  // left edge (the shared surface is anchored to the right, for the controls).
  const [left, setLeft] = useState(VIEWPORT_MARGIN);
  const run = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setLeft(Math.max(VIEWPORT_MARGIN, triggerRef.current?.getBoundingClientRect().left ?? VIEWPORT_MARGIN));
          setView('actions');
          setIsOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={label}
        title={label}
        data-composer-overflow=""
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:hidden',
          isOpen && 'bg-accent text-foreground',
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="fixed z-[100] min-w-52 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          style={{
            left,
            bottom: anchor.bottom,
            maxHeight: anchor.maxHeight,
            maxWidth: Math.max(200, window.innerWidth - left - VIEWPORT_MARGIN),
          }}
        >
          {view === 'schedule' ? (
            <>
              <ComposerMenuItem
                role="menuitem"
                label={tm('composer.back', { defaultValue: 'Back' })}
                icon={<ChevronLeft className="h-4 w-4" />}
                isSelected={false}
                onSelect={() => setView('actions')}
                className="text-muted-foreground"
              />
              <ComposerMenuSeparator />
              <ScheduleMessageOptions onCommit={(scheduledFor) => run(() => onScheduleMessage(scheduledFor))} />
            </>
          ) : (
            <>
              <ComposerMenuItem
                role="menuitem"
                label={t('input.showAllCommands')}
                icon={<MessageSquareIcon className="h-4 w-4" />}
                isSelected={false}
                onSelect={() => run(onToggleCommandMenu)}
                trailing={slashCommandsCount > 0 ? (
                  <span className="text-xs tabular-nums text-muted-foreground">{slashCommandsCount}</span>
                ) : undefined}
              />
              <ComposerMenuItem
                role="menuitem"
                label={t('schedule.trigger')}
                icon={<Clock className="h-4 w-4" />}
                isSelected={false}
                disabled={scheduleDisabled}
                onSelect={() => setView('schedule')}
              />
              {onStartVoice && (
                <ComposerMenuItem
                  role="menuitem"
                  label={t('voice.input')}
                  icon={<Mic className="h-4 w-4" />}
                  isSelected={false}
                  onSelect={() => run(onStartVoice)}
                />
              )}
              {onClearContext && (
                <ComposerMenuItem
                  role="menuitem"
                  label={t('misc.clearContext')}
                  icon={<EraserIcon className="h-4 w-4" />}
                  isSelected={false}
                  disabled={clearContextDisabled}
                  onSelect={() => run(onClearContext)}
                />
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
