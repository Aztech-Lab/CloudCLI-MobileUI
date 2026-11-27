// [local] Settings > MobileUI: rows for the server switches. Each row says where the running
// value comes from (default, set here, or locked by the server configuration), and when a
// saved value only applies after a restart, offers that restart.
import { Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { confirmServerAction, type useServerControl } from '@/modules/settings/hooks/useServerControl';
import type { ServerSettingId, ServerSettingView, useServerSettings } from '@/modules/settings/hooks/useServerSettings';
import MobileUiSettingRow, { MobileUiBadge, MOBILEUI_SELECT_CLASS } from '@/modules/settings/tabs/mobileui-settings/MobileUiSettingRow';
import { Button } from '@/shared/ui';

export type ServerSwitchContext = {
  settings: ReturnType<typeof useServerSettings>;
  serverControl: ReturnType<typeof useServerControl>;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 55000 -> "55 s", 3600000 -> "1 h", 90000 -> "1.5 min". */
function formatDuration(ms: number): string {
  const units: Array<[number, string]> = [[DAY, 'd'], [HOUR, 'h'], [MINUTE, 'min'], [SECOND, 's']];
  for (const [size, unit] of units) {
    if (ms >= size) {
      const value = Math.round((ms / size) * 10) / 10;
      return `${value} ${unit}`;
    }
  }
  return `${ms} ms`;
}

/** The value the control shows: what is saved, else what the configuration forces, else the default (''). */
function shownValue(setting: ServerSettingView): string {
  if (setting.source === 'config') return setting.running ?? '';
  return setting.saved ?? '';
}

function SourceBadge({ setting }: { setting: ServerSettingView }) {
  const { t } = useTranslation('mobileui');
  if (setting.source === 'config') {
    return <MobileUiBadge tone="warning">{t('serverSwitches.source.config', { defaultValue: 'Locked by server config' })}</MobileUiBadge>;
  }
  if (setting.saved !== null) {
    return <MobileUiBadge tone="primary">{t('serverSwitches.source.ui', { defaultValue: 'Set here' })}</MobileUiBadge>;
  }
  return <MobileUiBadge>{t('serverSwitches.source.default', { defaultValue: 'Default' })}</MobileUiBadge>;
}

/** What to say under a row: locked, or a saved value waiting for a restart. */
function RowFooter({ setting, context }: { setting: ServerSettingView; context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  const { serverControl } = context;
  const [restartRequested, setRestartRequested] = useState(false);

  if (setting.source === 'config') {
    return (
      <p className="text-xs text-muted-foreground">
        {t('serverSwitches.lockedHint', {
          defaultValue: 'Set in the server configuration ({{key}}), which always wins. Change it in _server/config.json.',
          key: setting.envKey,
        })}
      </p>
    );
  }
  if (!setting.pendingRestart) return null;

  const restartNow = async () => {
    if (!(await confirmServerAction(serverControl, 'restart', t))) return;
    setRestartRequested(true);
    await serverControl.restart(false);
  };
  const busy = serverControl.pendingAction !== null || serverControl.scheduled !== null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="status">
      <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
        {t('serverSwitches.appliesAfterRestart', { defaultValue: 'Saved. Applies after the server restarts.' })}
      </span>
      {serverControl.managed ? (
        <Button size="sm" variant="outline" onClick={() => void restartNow()} disabled={busy}>
          {restartRequested && busy
            ? t('serverSettings.working', { defaultValue: 'Working…' })
            : t('serverSwitches.restartNow', { defaultValue: 'Restart now' })}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t('serverSwitches.restartManually', { defaultValue: 'Restart the server on the computer to use it.' })}
        </span>
      )}
    </div>
  );
}

type ServerSwitchRowProps = {
  id: ServerSettingId;
  context: ServerSwitchContext;
  label: string;
  description: string;
  extraBadge?: ReactNode;
  children: (setting: ServerSettingView, disabled: boolean) => ReactNode;
};

/** One server switch; renders nothing until the server reported the switch. */
export function ServerSwitchRow({ id, context, label, description, extraBadge, children }: ServerSwitchRowProps) {
  const setting = context.settings.get(id);
  if (!setting) return null;
  const disabled = setting.source === 'config' || context.settings.saving !== null;
  return (
    <MobileUiSettingRow
      label={label}
      description={description}
      badges={<>{extraBadge}<SourceBadge setting={setting} /></>}
      footer={<RowFooter setting={setting} context={context} />}
    >
      {children(setting, disabled)}
    </MobileUiSettingRow>
  );
}

type Preset = { value: string; label: string };

/** A select of presets; '' is the built-in default. A value outside the presets is listed as well. */
function PresetSelect({ setting, disabled, presets, ariaLabel, onChange, describe }: {
  setting: ServerSettingView;
  disabled: boolean;
  presets: Preset[];
  ariaLabel: string;
  onChange: (value: string) => void;
  describe: (value: string) => string;
}) {
  const value = shownValue(setting);
  const options = presets.some((preset) => preset.value === value) ? presets : [...presets, { value, label: describe(value) }];
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className={MOBILEUI_SELECT_CLASS}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function CodexRuntimeRow({ context }: { context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  const label = t('serverSwitches.codexRuntime.label', { defaultValue: 'Codex runtime' });
  return (
    <ServerSwitchRow
      id="codexRuntime"
      context={context}
      label={label}
      description={t('serverSwitches.codexRuntime.description', {
        defaultValue: 'How Codex conversations run: one process per message (exec, the default), or a long-lived app server with approvals and background terminals.',
      })}
      extraBadge={<MobileUiBadge tone="warning">{t('serverSwitches.experimental', { defaultValue: 'Experimental' })}</MobileUiBadge>}
    >
      {(setting, disabled) => (
        <PresetSelect
          setting={setting}
          disabled={disabled}
          ariaLabel={label}
          presets={[
            { value: '', label: t('serverSwitches.codexRuntime.exec', { defaultValue: 'exec (default)' }) },
            { value: 'appserver', label: t('serverSwitches.codexRuntime.appserver', { defaultValue: 'appserver (experimental)' }) },
          ]}
          describe={(value) => value}
          onChange={(value) => void context.settings.save('codexRuntime', value || null)}
        />
      )}
    </ServerSwitchRow>
  );
}

function DurationRow({ id, context, label, description, defaultMs, presetsMs }: {
  id: 'toolApprovalTimeoutMs' | 'backgroundMaxHoldMs';
  context: ServerSwitchContext;
  label: string;
  description: string;
  defaultMs: number;
  presetsMs: number[];
}) {
  const { t } = useTranslation('mobileui');
  const presets: Preset[] = [
    { value: '', label: t('serverSwitches.defaultValue', { defaultValue: 'Default ({{value}})', value: formatDuration(defaultMs) }) },
    ...presetsMs.map((ms) => ({ value: String(ms), label: formatDuration(ms) })),
  ];
  return (
    <ServerSwitchRow id={id} context={context} label={label} description={description}>
      {(setting, disabled) => (
        <PresetSelect
          setting={setting}
          disabled={disabled}
          ariaLabel={label}
          presets={presets}
          describe={(value) => (/^\d+$/.test(value) ? formatDuration(Number(value)) : value)}
          onChange={(value) => void context.settings.save(id, value ? Number(value) : null)}
        />
      )}
    </ServerSwitchRow>
  );
}

export function ApprovalTimeoutRow({ context }: { context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  return (
    <DurationRow
      id="toolApprovalTimeoutMs"
      context={context}
      label={t('serverSwitches.approvalTimeout.label', { defaultValue: 'Approval timeout' })}
      description={t('serverSwitches.approvalTimeout.description', {
        defaultValue: 'How long a tool approval waits for your answer before it is declined.',
      })}
      defaultMs={55 * SECOND}
      presetsMs={[5 * MINUTE, HOUR, DAY]}
    />
  );
}

export function BackgroundHoldRow({ context }: { context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  return (
    <DurationRow
      id="backgroundMaxHoldMs"
      context={context}
      label={t('serverSwitches.backgroundHold.label', { defaultValue: 'Background work limit' })}
      description={t('serverSwitches.backgroundHold.description', {
        defaultValue: 'How long a session with background tasks still running may stay silent before those tasks are stopped.',
      })}
      defaultMs={12 * HOUR}
      presetsMs={[HOUR, DAY]}
    />
  );
}

const FILE_TREE_DEFAULT = 10_000;
const FILE_TREE_MIN = 1_000;
const FILE_TREE_MAX = 200_000;

export function FileTreeMaxEntriesRow({ context }: { context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  const label = t('serverSwitches.fileTreeMaxEntries.label', { defaultValue: 'File tree limit' });
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <ServerSwitchRow
      id="fileTreeMaxEntries"
      context={context}
      label={label}
      description={t('serverSwitches.fileTreeMaxEntries.description', {
        defaultValue: 'How many entries the Files tab loads at once in a very large project (default {{value}}). Folders beyond it load when opened.',
        value: FILE_TREE_DEFAULT.toLocaleString(),
      })}
    >
      {(setting, disabled) => {
        const current = shownValue(setting);
        const value = draft ?? current;
        const number = Number(value);
        const valid = value === '' || (/^\d+$/.test(value) && number >= FILE_TREE_MIN && number <= FILE_TREE_MAX);
        const changed = value !== current;
        const save = async () => {
          if (await context.settings.save('fileTreeMaxEntries', value === '' ? null : number)) setDraft(null);
        };
        return (
          <div className="flex w-full min-w-0 items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={FILE_TREE_MIN}
              max={FILE_TREE_MAX}
              step={1000}
              value={value}
              placeholder={String(FILE_TREE_DEFAULT)}
              disabled={disabled}
              aria-label={label}
              aria-invalid={!valid}
              onChange={(event) => setDraft(event.target.value)}
              className="w-full min-w-0 touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-32"
            />
            <Button size="sm" onClick={() => void save()} disabled={disabled || !changed || !valid}>
              {t('serverSwitches.save', { defaultValue: 'Save' })}
            </Button>
          </div>
        );
      }}
    </ServerSwitchRow>
  );
}

export function ExtraReadRootsRow({ context }: { context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  const label = t('serverSwitches.extraReadRoots.label', { defaultValue: 'Extra read-only folders' });
  const [draft, setDraft] = useState('');
  return (
    <ServerSwitchRow
      id="extraReadRoots"
      context={context}
      label={label}
      description={t('serverSwitches.extraReadRoots.description', {
        defaultValue: 'Folders outside the project that the in-chat file viewer may open, read-only. Absolute paths of existing folders, up to 20.',
      })}
    >
      {(setting, disabled) => {
        const value = shownValue(setting);
        const roots = value ? value.split(';').filter(Boolean) : [];
        const saveRoots = (next: string[]) => context.settings.save('extraReadRoots', next.length > 0 ? next : null);
        const add = async () => {
          const entry = draft.trim();
          if (!entry) return;
          const warning = t('serverSwitches.extraReadRoots.confirm', {
            defaultValue: 'Anyone signed in to this server will be able to read every file under\n{{path}}\nfrom the chat. Add it?',
            path: entry,
          });
          if (!window.confirm(warning)) return;
          if (await saveRoots([...roots, entry])) setDraft('');
        };
        return (
          <div className="w-full min-w-0 space-y-2 sm:w-72">
            {roots.length > 0 && (
              <ul className="space-y-1">
                {roots.map((root) => (
                  <li key={root} className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{root}</span>
                    {!disabled && (
                      <button
                        type="button"
                        onClick={() => void saveRoots(roots.filter((entry) => entry !== root))}
                        aria-label={t('serverSwitches.extraReadRoots.remove', { defaultValue: 'Remove {{path}}', path: root })}
                        className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!disabled && (
              <div className="flex min-w-0 items-center gap-2">
                <input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void add();
                  }}
                  placeholder={t('serverSwitches.extraReadRoots.placeholder', { defaultValue: 'Absolute folder path' })}
                  aria-label={t('serverSwitches.extraReadRoots.add', { defaultValue: 'Add folder' })}
                  className="w-full min-w-0 touch-manipulation rounded-lg border border-input bg-card p-2.5 font-mono text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                />
                <Button size="sm" variant="outline" onClick={() => void add()} disabled={!draft.trim() || roots.length >= 20}>
                  <Plus className="h-4 w-4" />
                  <span className="sr-only">{t('serverSwitches.extraReadRoots.add', { defaultValue: 'Add folder' })}</span>
                </Button>
              </div>
            )}
          </div>
        );
      }}
    </ServerSwitchRow>
  );
}
