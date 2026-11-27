// [local] One setting row of Settings > MobileUI. Unlike SettingsRow, a select or input
// control does not squeeze the label on a phone: below `sm` the label and description sit
// above a full-width control. Toggles stay on the right, as everywhere else.
import type { ReactNode } from 'react';

import { cn } from '@/shared/utils';

type MobileUiSettingRowProps = {
  label: ReactNode;
  description?: ReactNode;
  /** Small badges after the label (source, "Experimental", ...). */
  badges?: ReactNode;
  /** 'toggle' keeps the control on the right at every width; 'control' stacks it on phones. */
  kind?: 'toggle' | 'control';
  children?: ReactNode;
  /** Extra content under the row (hints, warnings, a "Restart now" line). */
  footer?: ReactNode;
  className?: string;
  disabled?: boolean;
};

export default function MobileUiSettingRow({
  label,
  description,
  badges,
  kind = 'control',
  children,
  footer,
  className,
  disabled,
}: MobileUiSettingRowProps) {
  const text = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
        <span className="min-w-0 break-words">{label}</span>
        {badges}
      </div>
      {description && <div className="mt-0.5 break-words text-sm text-muted-foreground">{description}</div>}
    </div>
  );

  return (
    <div className={cn('px-4 py-4', disabled && 'opacity-50', className)}>
      {kind === 'toggle' ? (
        <div className="flex items-center justify-between gap-4">
          {text}
          <div className="flex-shrink-0">{children}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          {text}
          {children && <div className="w-full min-w-0 sm:w-auto sm:max-w-[60%] sm:flex-shrink-0">{children}</div>}
        </div>
      )}
      {footer && <div className="mt-2 min-w-0 text-sm">{footer}</div>}
    </div>
  );
}

/** Pill badge used next to a row label. */
export function MobileUiBadge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'primary' | 'warning' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        tone === 'muted' && 'border-border bg-muted/50 text-muted-foreground',
        tone === 'primary' && 'border-primary/30 bg-primary/10 text-primary',
        tone === 'warning' && 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      {children}
    </span>
  );
}

/** The select style of the settings dialog, full width on phones. */
export const MOBILEUI_SELECT_CLASS =
  'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-48';
