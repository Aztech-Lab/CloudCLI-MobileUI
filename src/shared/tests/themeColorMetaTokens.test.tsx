import { renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/shared/context/ThemeContext';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] The browser's theme-color follows the app theme. Its colours are
 * theme-ready: a theme may override them with --app-theme-color-{dark|light};
 * without one they are the previous constants.
 */

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(ThemeProvider, null, children);

function themeColor() {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
}

describe('theme-color meta tokens', () => {
  beforeEach(() => {
    localStorage.clear();
    resetUserPreferences();
    document.documentElement.classList.remove('dark');
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#ffffff';
    document.head.appendChild(meta);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  });

  it('uses the built-in colours when no theme overrides them', () => {
    writeUserPreference('theme', 'dark');
    const { unmount } = renderHook(() => null, { wrapper });
    expect(themeColor()).toBe('#141414');
    unmount();

    writeUserPreference('theme', 'light');
    renderHook(() => null, { wrapper });
    expect(themeColor()).toBe('#f6f4ef');
  });

  it('uses the theme override for the active mode', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => ({
        '--app-theme-color-dark': '#0f1112',
        '--app-theme-color-light': '#ebebe8',
      } as Record<string, string>)[name] ?? '',
    } as unknown as CSSStyleDeclaration);

    writeUserPreference('theme', 'dark');
    const { unmount } = renderHook(() => null, { wrapper });
    expect(themeColor()).toBe('#0f1112');
    unmount();

    writeUserPreference('theme', 'light');
    renderHook(() => null, { wrapper });
    expect(themeColor()).toBe('#ebebe8');
  });
});
