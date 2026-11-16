import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  applyAssistantBubble,
  readStoredAssistantBubble,
  writeAssistantBubble,
  type AssistantBubbleStyle,
} from '@/shared/assistantBubble';
import { readThemeToken } from '@/shared/utils';
import type { ThemeMode } from '@/shared/types';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /** [local] How the agent's spoken replies are framed: off, translucent or solid. */
  assistantBubble: AssistantBubbleStyle;
  setAssistantBubble: (style: AssistantBubbleStyle) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Reads the stored preference as a theme mode.
 *
 * Only `'dark'` and `'light'` were ever written before the system option
 * existed, so anything else — `'system'`, an absent value, or a value a newer
 * client wrote — means "follow the OS", which is also the default.
 */
const readStoredThemeMode = (): ThemeMode => {
  const savedTheme = readUserPreference<string | null>('theme', null);
  return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'system';
};

/** Whether the OS currently asks for a dark appearance; false when unknown. */
const prefersDarkAppearance = (): boolean =>
  Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);

/** The colour a mode resolves to right now. */
const resolveIsDarkMode = (mode: ThemeMode): boolean =>
  mode === 'system' ? prefersDarkAppearance() : mode === 'dark';

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/** Mounted once by App so every module can read and switch the colour theme through useTheme. */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  // The mode the user chose, not the colour it currently resolves to: only the
  // mode is persisted, and `system` has to keep tracking the OS afterwards.
  // Read synchronously from the preference mirror so the very first paint is
  // already the right colour.
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredThemeMode);
  // The resolved colour. It is not derivable from `themeMode` alone, because
  // under `system` it changes when the OS does, with no state change here.
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDarkMode(readStoredThemeMode()));
  // [local] The agent-bubble style rides along with the theme: same store, same
  // mirror, same rule that only an explicit choice is written.
  const [assistantBubble, setAssistantBubbleState] = useState<AssistantBubbleStyle>(readStoredAssistantBubble);

  // The theme now lives in auth.db, so a change made on another device (or in
  // another tab) arrives through the preference store rather than a re-render.
  useEffect(() => subscribeToUserPreferences(() => {
    const storedMode = readStoredThemeMode();
    setThemeModeState(storedMode);
    setIsDarkMode(resolveIsDarkMode(storedMode));
    setAssistantBubbleState(readStoredAssistantBubble());
  }), []);

  useEffect(() => {
    applyAssistantBubble(assistantBubble);
  }, [assistantBubble]);

  // Applying the theme to the document and persisting it are deliberately
  // separate. Persisting from here would also fire on mount — before the stored
  // theme had been fetched — writing this device's system default over the
  // theme the user actually chose on another one.
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');

      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        // Dark background color (hsl(0 0% 8%)). [local] A theme may override it.
        themeColorMeta.setAttribute('content', readThemeToken('--app-theme-color-dark') || '#141414');
      }
    } else {
      document.documentElement.classList.remove('dark');

      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        // Light background color (warm cream). [local] A theme may override it.
        themeColorMeta.setAttribute('content', readThemeToken('--app-theme-color-light') || '#f6f4ef');
      }
    }
  }, [isDarkMode]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Re-read rather than close over `themeMode`: a change that arrived from
      // another device lands in the store first, and only `system` follows the OS.
      if (readStoredThemeMode() === 'system') {
        setIsDarkMode(e.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // The only writer: a theme is stored because the user picked it, never
  // because this device happened to start on one.
  const setThemeMode = useCallback((mode: ThemeMode) => {
    writeUserPreference('theme', mode);
    setThemeModeState(mode);
    setIsDarkMode(resolveIsDarkMode(mode));
  }, []);

  const setAssistantBubble = useCallback((style: AssistantBubbleStyle) => {
    writeAssistantBubble(style);
    setAssistantBubbleState(style);
  }, []);

  // Kept for the callers that only offer a light/dark switch: choosing either
  // one is an explicit choice, so it leaves `system` behind exactly as before.
  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((previous) => {
      const next = !previous;
      writeUserPreference('theme', next ? 'dark' : 'light');
      setThemeModeState(next ? 'dark' : 'light');
      return next;
    });
  }, []);

  // A fresh object here would re-render every consumer in the app on any
  // render of this provider, theme change or not.
  const value = useMemo<ThemeContextValue>(
    () => ({ isDarkMode, toggleDarkMode, themeMode, setThemeMode, assistantBubble, setAssistantBubble }),
    [isDarkMode, toggleDarkMode, themeMode, setThemeMode, assistantBubble, setAssistantBubble],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
