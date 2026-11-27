// [local] Settings > MobileUI > Phone & navigation: the swipe gesture and the home screen.
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
      </SettingsCard>
    </SettingsSection>
  );
}
