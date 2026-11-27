import { useTranslation } from 'react-i18next';

import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useSkin } from '@/shared/context/SkinContext';
import { useTheme } from '@/shared/context/ThemeContext';
import { ASSISTANT_BUBBLE_STYLES, type AssistantBubbleStyle } from '@/shared/assistantBubble';
import { SKIN_IDS, type SkinId } from '@/shared/skin';
import { SKIN_OPTIONS } from '@/shared/skinOptions';
import type { CodeEditorSettingsState, ProjectSortOrder, ThemeMode } from '@/shared/types';
import { LanguageSelector } from '@/modules/i18n';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

/** Rendered by Settings for the "appearance" tab, covering theme, project sorting and code editor preferences. */
export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { themeMode, setThemeMode, assistantBubble, setAssistantBubble } = useTheme();
  const { skin, setSkin, skinOptions, setSkinOption } = useSkin();
  // [local] The active skin's own dials, rendered from its declaration (skinOptions.ts).
  const skinOptionDefinitions = SKIN_OPTIONS[skin];
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.theme.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.theme.label')}
            description={t('appearanceSettings.theme.description')}
          >
            <select
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
              aria-label={t('appearanceSettings.theme.label')}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="light">{t('appearanceSettings.theme.light')}</option>
              <option value="dark">{t('appearanceSettings.theme.dark')}</option>
              <option value="system">{t('appearanceSettings.theme.system')}</option>
            </select>
          </SettingsRow>
          {/* [local] How the agent's spoken replies are framed (src/shared/assistantBubble.ts). */}
          <SettingsRow
            label={t('appearanceSettings.assistantBubble.label', { defaultValue: 'Agent reply bubble' })}
            description={t('appearanceSettings.assistantBubble.description', { defaultValue: 'How the agent’s written replies are framed in the conversation' })}
          >
            <select
              value={assistantBubble}
              onChange={(event) => setAssistantBubble(event.target.value as AssistantBubbleStyle)}
              aria-label={t('appearanceSettings.assistantBubble.label', { defaultValue: 'Agent reply bubble' })}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              {ASSISTANT_BUBBLE_STYLES.map((style) => (
                <option key={style} value={style}>{t(`appearanceSettings.assistantBubble.${style}`, { defaultValue: style })}</option>
              ))}
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {/* [local] Skins: token overrides layered on the light/dark mode (docs/fork/THEMING.md). */}
      <SettingsSection title={t('appearanceSettings.skin.label', { defaultValue: 'Skin' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.skin.label', { defaultValue: 'Skin' })}
            description={t('appearanceSettings.skin.description', { defaultValue: 'The visual style of the interface; light and dark work with every skin' })}
          >
            <select
              value={skin}
              onChange={(event) => setSkin(event.target.value as SkinId)}
              aria-label={t('appearanceSettings.skin.label', { defaultValue: 'Skin' })}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-48"
            >
              {SKIN_IDS.map((id) => (
                <option key={id} value={id}>{t(`appearanceSettings.skin.${id}`, { defaultValue: id })}</option>
              ))}
            </select>
          </SettingsRow>
        </SettingsCard>

        {skinOptionDefinitions.length > 0 && (
          <SettingsCard divided>
            {skinOptionDefinitions.map((definition) => {
              const key = `appearanceSettings.skinOptions.${skin}.${definition.id}`;
              const label = t(`${key}.label`, { defaultValue: definition.id });
              const value = skinOptions[definition.id] ?? definition.default;
              return (
                <SettingsRow
                  key={definition.id}
                  label={label}
                  description={t(`${key}.description`, { defaultValue: '' }) || undefined}
                >
                  {definition.kind === 'toggle' ? (
                    <SettingsToggle
                      checked={value === true}
                      onChange={(next) => setSkinOption(definition.id, next)}
                      ariaLabel={label}
                    />
                  ) : (
                    <select
                      value={String(value)}
                      onChange={(event) => setSkinOption(definition.id, event.target.value)}
                      aria-label={label}
                      className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
                    >
                      {definition.choices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {t(`${key}.${choice.value}`, { defaultValue: choice.value })}
                        </option>
                      ))}
                    </select>
                  )}
                </SettingsRow>
              );
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.keepProjectsExpanded.section', { defaultValue: 'Sidebar' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            description={t('appearanceSettings.keepProjectsExpanded.description', { defaultValue: 'Open several projects together and remember them after reloading.' })}
          >
            <SettingsToggle
              checked={preferences.keepProjectsExpanded}
              onChange={(value) => setPreference('keepProjectsExpanded', value)}
              ariaLabel={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {/* [local] Thinking display, mirrored from Quick Settings so it is reachable here too. */}
      <SettingsSection title={t('quickSettings.sections.toolDisplay')}>
        <SettingsCard divided>
          <SettingsRow label={t('quickSettings.showThinking')}>
            <SettingsToggle
              checked={preferences.showThinking}
              onChange={(value) => setPreference('showThinking', value)}
              ariaLabel={t('quickSettings.showThinking')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('quickSettings.autoExpandThinking')}
            description={t('quickSettings.autoExpandThinkingDescription')}
            className={preferences.showThinking ? undefined : 'opacity-50'}
          >
            <SettingsToggle
              checked={preferences.autoExpandThinking}
              onChange={(value) => setPreference('autoExpandThinking', value)}
              ariaLabel={t('quickSettings.autoExpandThinking')}
              disabled={!preferences.showThinking}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
