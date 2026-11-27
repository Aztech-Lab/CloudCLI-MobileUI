// [local] Settings > MobileUI > Conversation: how thinking blocks are shown.
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import MobileUiSettingRow from '@/modules/settings/tabs/mobileui-settings/MobileUiSettingRow';

export default function ConversationSection() {
  const { t } = useTranslation('mobileui');
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const showThinkingLabel = t('showThinking.label', { defaultValue: 'Show thinking' });
  const autoExpandLabel = t('autoExpandThinking', { defaultValue: 'Auto-expand thinking' });

  return (
    <SettingsSection title={t('sections.conversation', { defaultValue: 'Conversation' })}>
      <SettingsCard divided>
        <MobileUiSettingRow
          kind="toggle"
          label={showThinkingLabel}
          description={t('showThinking.description', { defaultValue: 'The same switch as in quick settings.' })}
        >
          <SettingsToggle
            checked={preferences.showThinking}
            onChange={(value) => setPreference('showThinking', value)}
            ariaLabel={showThinkingLabel}
          />
        </MobileUiSettingRow>
        <MobileUiSettingRow
          kind="toggle"
          label={autoExpandLabel}
          description={t('autoExpandThinkingDescription', {
            defaultValue: 'Open thinking blocks by default, also while they stream. You can still collapse a block yourself.',
          })}
          disabled={!preferences.showThinking}
        >
          <SettingsToggle
            checked={preferences.autoExpandThinking}
            onChange={(value) => setPreference('autoExpandThinking', value)}
            ariaLabel={autoExpandLabel}
            disabled={!preferences.showThinking}
          />
        </MobileUiSettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}
