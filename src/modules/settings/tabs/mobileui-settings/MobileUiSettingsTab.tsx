// [local] Settings > MobileUI: every setting and feature this edition adds to CloudCLI, kept
// apart from the original settings tabs so those stay as upstream ships them.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useServerControl } from '@/modules/settings/hooks/useServerControl';
import ServerSettingsTab from '@/modules/settings/tabs/ServerSettingsTab';
import '@/shared/mobileUiI18n';
import AboutEditionSection from '@/modules/settings/tabs/mobileui-settings/AboutEditionSection';
import ConversationSection from '@/modules/settings/tabs/mobileui-settings/ConversationSection';
import FilesSection from '@/modules/settings/tabs/mobileui-settings/FilesSection';
import LookSection from '@/modules/settings/tabs/mobileui-settings/LookSection';
import PhoneSection from '@/modules/settings/tabs/mobileui-settings/PhoneSection';

/** DOM id of the Server section; Settings opened with the old 'server' tab scrolls to it. */
export const MOBILEUI_SERVER_SECTION_ID = 'mobileui-section-server';

type MobileUiSettingsTabProps = {
  /** The tab Settings was opened with; 'server' (the former Server tab) scrolls to that section. */
  initialTab?: string;
};

export default function MobileUiSettingsTab({ initialTab }: MobileUiSettingsTabProps) {
  const { t } = useTranslation('mobileui');
  // The Server section is shown only for a server started by scripts/server/. For any other
  // server the status endpoint answers { managed: false } at once, without running a script.
  const serverControl = useServerControl({ isOpen: true, isActive: true });
  const scrolledRef = useRef(false);

  useEffect(() => {
    if (initialTab !== 'server' || !serverControl.managed || scrolledRef.current) return;
    scrolledRef.current = true;
    document.getElementById(MOBILEUI_SERVER_SECTION_ID)?.scrollIntoView?.({ block: 'start' });
  }, [initialTab, serverControl.managed]);

  return (
    <div className="min-w-0 space-y-8" data-testid="mobileui-settings">
      <p className="text-sm text-muted-foreground">
        {t('tab.description', { defaultValue: 'Everything this edition adds to CloudCLI, in one place.' })}
      </p>
      <LookSection />
      <ConversationSection />
      <PhoneSection />
      <FilesSection />
      {serverControl.managed && (
        <div id={MOBILEUI_SERVER_SECTION_ID} className="scroll-mt-4">
          <ServerSettingsTab serverControl={serverControl} />
        </div>
      )}
      <AboutEditionSection />
    </div>
  );
}
