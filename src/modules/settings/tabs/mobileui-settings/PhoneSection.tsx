// [local] Settings > MobileUI > Phone & navigation: the swipe gesture, the home screen and the composer toolbar.
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useMobileUiPreference } from '@/shared/mobileUiPreferences';
import MobileUiSettingRow from '@/modules/settings/tabs/mobileui-settings/MobileUiSettingRow';

export default function PhoneSection() {
  const { t } = useTranslation('mobileui');
  const [preferences, setPreference] = useMobileUiPreference();
  const swipeLabel = t('phone.swipeNavigation', { defaultValue: 'Swipe between tabs' });
  const recentsLabel = t('phone.homeRecents', { defaultValue: 'Recent conversations on the home screen' });
  const compactComposerLabel = t('phone.compactComposer', { defaultValue: 'Compact composer toolbar on phones' });

  return (
    <SettingsSection title={t('sections.phone', { defaultValue: 'Phone & navigation' })}>
      <SettingsCard divided>
        <MobileUiSettingRow
          kind="toggle"
          label={swipeLabel}
          description={t('phone.swipeNavigationDescription', {
            defaultValue: 'On a phone, swipe left or right to switch workspace tabs; swiping back from the first tab opens the menu.',
          })}
        >
          <SettingsToggle
            checked={preferences.swipeNavigation}
            onChange={(value) => setPreference('swipeNavigation', value)}
            ariaLabel={swipeLabel}
          />
        </MobileUiSettingRow>
        <MobileUiSettingRow
          kind="toggle"
          label={recentsLabel}
          description={t('phone.homeRecentsDescription', {
            defaultValue: 'With no project open, list the latest conversations and their projects. Off: the original “choose a project” screen.',
          })}
        >
          <SettingsToggle
            checked={preferences.homeRecents}
            onChange={(value) => setPreference('homeRecents', value)}
            ariaLabel={recentsLabel}
          />
        </MobileUiSettingRow>
        <MobileUiSettingRow
          kind="toggle"
          label={compactComposerLabel}
          description={t('phone.compactComposerDescription', {
            defaultValue: 'On a phone, keep the buttons under the message box on one row: the commands list, scheduling, voice input and clear context move into a “⋯” menu. Typing / still opens the commands. Off: every button in the row, which can wrap onto two rows.',
          })}
        >
          <SettingsToggle
            checked={preferences.compactComposer}
            onChange={(value) => setPreference('compactComposer', value)}
            ariaLabel={compactComposerLabel}
          />
        </MobileUiSettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}
