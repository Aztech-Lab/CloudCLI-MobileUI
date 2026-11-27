// [local] Settings > MobileUI > Server: status, autostart, restart and stop of a server started
// by scripts/server/. The MobileUI tab shows this section only when the server reports it is
// script-managed. Strings live in the `mobileui` namespace (serverSettings.*).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { confirmServerAction, describeActiveWork, hasWork, type useServerControl } from '@/modules/settings/hooks/useServerControl';
import { Button } from '@/shared/ui';
import type { ServerActiveWork, ServerBuildInfo } from '@/shared/types';

type ServerSettingsTabProps = {
  serverControl: ReturnType<typeof useServerControl>;
};

/** Rendered by Settings > MobileUI as its Server section. */
export default function ServerSettingsTab({ serverControl }: ServerSettingsTabProps) {
  const { t } = useTranslation('mobileui');
  const { overview, error, pendingAction, scheduled, setAutostart, restart, stop } = serverControl;
  // Whether a restart also activates the prepared build; on by default whenever one exists.
  const [activateBuild, setActivateBuild] = useState(true);

  const describeBuild = (build: ServerBuildInfo | null) => (
    build
      ? `${t('serverSettings.buildValue', { branch: build.branch, commit: build.commit, builtAt: build.builtAt.replace('T', ' ') })}`
        + (build.dirty ? ` (${t('serverSettings.buildDirty')})` : '')
      : t('serverSettings.noBuildInfo')
  );
  const describeWork = (work: ServerActiveWork) => describeActiveWork(t, work);

  if (!overview) {
    return (
      <SettingsSection title={t('serverSettings.title')} description={t('serverSettings.description')}>
        <p className="text-sm text-muted-foreground">{error ?? t('serverSettings.loading')}</p>
      </SettingsSection>
    );
  }
  if (!overview.managed) {
    return (
      <SettingsSection title={t('serverSettings.title')}>
        <p className="text-sm text-muted-foreground">{t('serverSettings.unavailable')}</p>
      </SettingsSection>
    );
  }

  const { status } = overview;
  const isLive = overview.instance === 'live';
  const busy = pendingAction !== null || scheduled !== null;

  const confirmAction = (action: 'restart' | 'stop') => confirmServerAction(serverControl, action, t);

  const handleRestart = async () => {
    if (await confirmAction('restart')) await restart(Boolean(status.pendingBuild) && activateBuild);
  };
  const handleStop = async () => {
    if (await confirmAction('stop')) await stop();
  };

  const autostartOn = status.autostart === 'on';
  const autostartDescription = !isLive
    ? t('serverSettings.autostartLiveOnly')
    : status.autostart === 'disabled'
      ? t('serverSettings.autostartDisabled')
      : status.autostart === 'unsupported'
        ? t('serverSettings.autostartUnsupported')
        : t('serverSettings.autostartDescription');

  return (
    <div className="space-y-8">
      <SettingsSection title={t('serverSettings.title')} description={t('serverSettings.description')}>
        {!isLive && (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t('serverSettings.testPortal', { port: status.port })}
          </p>
        )}
        <SettingsCard divided>
          <SettingsRow
            label={t('serverSettings.status')}
            description={status.version ? t('serverSettings.version', { version: status.version }) : undefined}
          >
            <span className="text-sm text-foreground">
              {status.running
                ? (status.pid
                  ? t('serverSettings.runningPid', { port: status.port, pid: status.pid })
                  : t('serverSettings.running', { port: status.port }))
                : t('serverSettings.stopped')}
            </span>
          </SettingsRow>
          <div className="px-4 py-4">
            <div className="text-sm font-medium text-foreground">{t('serverSettings.build')}</div>
            <div className="mt-0.5 break-words text-sm text-muted-foreground">{describeBuild(status.build)}</div>
            {status.pendingBuild && (
              <div className="mt-2 text-sm">
                <span className="font-medium text-foreground">{t('serverSettings.pendingBuild')}: </span>
                <span className="break-words text-muted-foreground">{describeBuild(status.pendingBuild)}</span>
                <div className="text-xs text-muted-foreground">{t('serverSettings.pendingBuildHint')}</div>
              </div>
            )}
          </div>
          <div className="px-4 py-4">
            <div className="text-sm font-medium text-foreground">{t('serverSettings.activeWork')}</div>
            <div className="mt-0.5 text-sm text-muted-foreground">
              {hasWork(status.activeWork) ? describeWork(status.activeWork) : t('serverSettings.activeWorkNone')}
            </div>
          </div>
          <SettingsRow label={t('serverSettings.autostart')} description={autostartDescription}>
            <SettingsToggle
              checked={autostartOn}
              onChange={(value) => void setAutostart(value)}
              ariaLabel={t('serverSettings.autostart')}
              disabled={!isLive || busy || status.autostart === 'unsupported' || status.autostart === 'unknown'}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('serverSettings.actionsTitle')} description={t('serverSettings.actionsDescription')}>
        {status.pendingBuild && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={activateBuild}
              onChange={(event) => setActivateBuild(event.target.checked)}
              disabled={busy}
            />
            {t('serverSettings.activateBuild')}
          </label>
        )}
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void handleRestart()} disabled={busy || !status.running}>
            {pendingAction === 'restart' ? t('serverSettings.working') : t('serverSettings.restart')}
          </Button>
          <Button variant="destructive" onClick={() => void handleStop()} disabled={busy || !status.running}>
            {pendingAction === 'stop' ? t('serverSettings.working') : t('serverSettings.stop')}
          </Button>
        </div>
        {scheduled && (
          <p role="status" className="text-sm text-foreground">
            {t(scheduled.action === 'restart' ? 'serverSettings.restartScheduled' : 'serverSettings.stopScheduled')}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </SettingsSection>
    </div>
  );
}
