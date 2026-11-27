// [local] Settings > MobileUI > About this edition: which CloudCLI it is based on, and links.
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SettingsSection from '@/modules/settings/SettingsSection';
import { APP_VERSION, PROJECT_REPO_URL } from '@/shared/constants';

const WHATS_NEW_URL = `${PROJECT_REPO_URL}#whats-new`;

export default function AboutEditionSection() {
  const { t } = useTranslation('mobileui');

  return (
    <SettingsSection title={t('sections.about', { defaultValue: 'About this edition' })}>
      <div className="space-y-2 rounded-xl border border-border bg-card/50 p-4 text-sm">
        <p className="text-muted-foreground">
          {APP_VERSION
            ? t('about.basedOnVersion', {
              version: APP_VERSION,
              defaultValue: 'CloudCLI-MobileUI, based on CloudCLI {{version}}.',
            })
            : t('about.basedOn', { defaultValue: 'CloudCLI-MobileUI, based on CloudCLI.' })}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <a href={PROJECT_REPO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            {t('about.repository', { defaultValue: 'Repository' })}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a href={WHATS_NEW_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            {t('about.whatsNew', { defaultValue: 'What’s new' })}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </SettingsSection>
  );
}
