import assert from 'node:assert/strict';

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import '@/shared/mobileUiI18n';
import QuickSettingsContent from '@/modules/quick-settings-panel/QuickSettingsContent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import type { QuickSettingsPreferences } from '@/shared/types';

// [local] The "auto-expand thinking" row sits under "show thinking" and only
// applies while thinking is shown.

const preferences = (overrides: Partial<QuickSettingsPreferences>): QuickSettingsPreferences => ({
  showRawParameters: false,
  showThinking: true,
  autoExpandThinking: false,
  sendByCtrlEnter: false,
  voiceEnabled: false,
  ...overrides,
});

const autoExpandCheckbox = (container: HTMLElement) => {
  const label = Array.from(container.querySelectorAll('label'))
    .find((element) => /Auto-expand thinking/.test(element.textContent ?? ''));
  assert.ok(label, 'the quick settings panel lists the auto-expand row');
  return label.querySelector('input') as HTMLInputElement;
};

test('quick settings shows the toggle under show thinking and disables it while thinking is hidden', () => {
  const changes: Array<[string, boolean]> = [];
  const onChange = (key: string, value: boolean) => changes.push([key, value]);

  const panel = (overrides: Partial<QuickSettingsPreferences>) => (
    <ThemeProvider>
      <QuickSettingsContent isDarkMode={false} preferences={preferences(overrides)} onPreferenceChange={onChange} />
    </ThemeProvider>
  );

  const { container, rerender } = render(panel({}));
  const checkbox = autoExpandCheckbox(container);
  assert.equal(checkbox.disabled, false);
  fireEvent.click(checkbox);
  assert.deepEqual(changes, [['autoExpandThinking', true]]);

  rerender(panel({ showThinking: false }));
  assert.equal(autoExpandCheckbox(container).disabled, true);
});
