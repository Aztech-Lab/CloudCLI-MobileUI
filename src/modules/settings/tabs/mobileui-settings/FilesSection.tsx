// [local] Settings > MobileUI > Files: the file tree's "show gitignored files" (the same
// device-only switch as the eye button in the Files tab header), plus server switches.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useShowIgnoredFiles } from '@/shared/showIgnoredFiles';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import MobileUiSettingRow from '@/modules/settings/tabs/mobileui-settings/MobileUiSettingRow';

export default function FilesSection({ serverSwitches }: { serverSwitches?: ReactNode }) {
  const { t } = useTranslation('mobileui');
  const { showIgnored, setShowIgnored } = useShowIgnoredFiles();
  const label = t('files.showIgnored', { defaultValue: 'Show gitignored files' });

  return (
    <SettingsSection title={t('sections.files', { defaultValue: 'Files' })}>
      <SettingsCard divided>
        <MobileUiSettingRow
          kind="toggle"
          label={label}
          description={t('files.showIgnoredDescription', {
            defaultValue: 'List gitignored files and folders in the Files tab, dimmed. Same as the eye button there; remembered on this device only.',
          })}
        >
          <SettingsToggle checked={showIgnored} onChange={setShowIgnored} ariaLabel={label} />
        </MobileUiSettingRow>
        {serverSwitches}
      </SettingsCard>
    </SettingsSection>
  );
}
