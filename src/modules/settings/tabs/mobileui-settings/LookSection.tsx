// [local] Settings > MobileUI > Look: the skin (as cards, so a long name never squeezes its
// description on a phone), the current skin's own options, and the agent reply bubble.
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { ASSISTANT_BUBBLE_STYLES, type AssistantBubbleStyle } from '@/shared/assistantBubble';
import { useSkin } from '@/shared/context/SkinContext';
import { SKIN_IDS } from '@/shared/skin';
import { SKIN_OPTIONS } from '@/shared/skinOptions';
import { cn } from '@/shared/utils';
import MobileUiSettingRow, { MOBILEUI_SELECT_CLASS } from '@/modules/settings/tabs/mobileui-settings/MobileUiSettingRow';

const SKIN_FALLBACK: Record<string, { name: string; description: string }> = {
  default: { name: 'Default', description: 'The original CloudCLI look' },
  otsr: { name: 'OTSR', description: 'Lab white, copper, square corners' },
  aztecan: { name: 'Aztecan', description: 'Near-black, cyan, glass' },
};

export default function LookSection() {
  const { t } = useTranslation('mobileui');
  const { skin, setSkin, skinOptions, setSkinOption, assistantBubble, setAssistantBubble } = useSkin();
  const skinOptionDefinitions = SKIN_OPTIONS[skin];

  return (
    <SettingsSection title={t('sections.look', { defaultValue: 'Look' })}>
      <div>
        <div className="mb-2 text-sm font-medium text-foreground">{t('skin.label', { defaultValue: 'Skin' })}</div>
        <p className="mb-3 text-sm text-muted-foreground">
          {t('skin.description', { defaultValue: 'The visual style of the interface; light and dark work with every skin' })}
        </p>
        <div role="radiogroup" aria-label={t('skin.label', { defaultValue: 'Skin' })} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {SKIN_IDS.map((id) => {
            const selected = id === skin;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`mobileui-skin-${id}`}
                onClick={() => setSkin(id)}
                className={cn(
                  'flex min-w-0 touch-manipulation items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-primary bg-primary/5' : 'border-border bg-card/50 hover:bg-accent/40',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {t(`skin.names.${id}`, { defaultValue: SKIN_FALLBACK[id].name })}
                  </span>
                  <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                    {t(`skin.descriptions.${id}`, { defaultValue: SKIN_FALLBACK[id].description })}
                  </span>
                </span>
                <span
                  className={cn(
                    'mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                  aria-hidden="true"
                >
                  {selected && <Check className="h-3 w-3" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {skinOptionDefinitions.length > 0 && (
        <SettingsCard divided>
          {skinOptionDefinitions.map((definition) => {
            const key = `skinOptions.${skin}.${definition.id}`;
            const label = t(`${key}.label`, { defaultValue: definition.id });
            const value = skinOptions[definition.id] ?? definition.default;
            return (
              <MobileUiSettingRow
                key={definition.id}
                kind={definition.kind === 'toggle' ? 'toggle' : 'control'}
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
                    className={MOBILEUI_SELECT_CLASS}
                  >
                    {definition.choices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {t(`${key}.${choice.value}`, { defaultValue: choice.value })}
                      </option>
                    ))}
                  </select>
                )}
              </MobileUiSettingRow>
            );
          })}
        </SettingsCard>
      )}

      <SettingsCard>
        <MobileUiSettingRow
          label={t('assistantBubble.label', { defaultValue: 'Agent reply bubble' })}
          description={t('assistantBubble.description', { defaultValue: 'How the agent’s written replies are framed in the conversation' })}
        >
          <select
            value={assistantBubble}
            onChange={(event) => setAssistantBubble(event.target.value as AssistantBubbleStyle)}
            aria-label={t('assistantBubble.label', { defaultValue: 'Agent reply bubble' })}
            className={MOBILEUI_SELECT_CLASS}
          >
            {ASSISTANT_BUBBLE_STYLES.map((style) => (
              <option key={style} value={style}>{t(`assistantBubble.${style}`, { defaultValue: style })}</option>
            ))}
          </select>
        </MobileUiSettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}
