// [local] Settings > MobileUI > Agents & background: server switches for how agents run.
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import {
  ApprovalTimeoutRow,
  BackgroundHoldRow,
  CodexRuntimeRow,
  type ServerSwitchContext,
} from '@/modules/settings/tabs/mobileui-settings/ServerSwitches';

export default function AgentsSection({ context }: { context: ServerSwitchContext }) {
  const { t } = useTranslation('mobileui');
  const { overview, error } = context.settings;
  if (!overview) return null;

  return (
    <SettingsSection
      title={t('sections.agents', { defaultValue: 'Agents & background' })}
      description={t('serverSwitches.intro', {
        defaultValue: 'Server switches: saved on the server and used from its next restart. A value set in the server configuration always wins.',
      })}
    >
      {overview.instance === 'staging' && (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t('serverSwitches.stagingNote', {
            defaultValue: 'This is the test portal: these switches affect only the test portal (it has its own database).',
          })}
        </p>
      )}
      <SettingsCard divided>
        <CodexRuntimeRow context={context} />
        <ApprovalTimeoutRow context={context} />
        <BackgroundHoldRow context={context} />
      </SettingsCard>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </SettingsSection>
  );
}
