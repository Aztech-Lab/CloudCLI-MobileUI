import { useCallback, useSyncExternalStore } from 'react';

import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

/**
 * [local] Phone and navigation preferences of CloudCLI-MobileUI, set in Settings > MobileUI.
 * Stored as the `mobileUi` user preference (one object), so they follow the user across
 * devices like the other settings. The defaults are what the app did before these switches
 * existed, so a user who never opens them sees no change.
 */
export type MobileUiPreferences = {
  /** Swipe left/right in the workspace (phones) to switch tabs or open the menu. */
  swipeNavigation: boolean;
  /** The home screen lists recent conversations and projects instead of the plain intro. */
  homeRecents: boolean;
};

export const MOBILE_UI_DEFAULTS: MobileUiPreferences = {
  swipeNavigation: true,
  homeRecents: true,
};

let cachedRaw: unknown;
let cachedValue: MobileUiPreferences = MOBILE_UI_DEFAULTS;

/** The stored values over the defaults; anything not a boolean falls back to its default. */
export function readMobileUiPreferences(): MobileUiPreferences {
  const raw = readUserPreference<unknown>('mobileUi', null);
  // Same object while the store has not changed, so useSyncExternalStore sees a stable snapshot.
  if (raw === cachedRaw) return cachedValue;
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next = { ...MOBILE_UI_DEFAULTS };
  for (const key of Object.keys(MOBILE_UI_DEFAULTS) as Array<keyof MobileUiPreferences>) {
    if (typeof stored[key] === 'boolean') next[key] = stored[key] as boolean;
  }
  cachedRaw = raw;
  cachedValue = next;
  return next;
}

export function writeMobileUiPreference<K extends keyof MobileUiPreferences>(key: K, value: MobileUiPreferences[K]): void {
  const raw = readUserPreference<unknown>('mobileUi', null);
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  writeUserPreference('mobileUi', { ...stored, [key]: value });
}

/** The current values, re-rendering when they change here or arrive from the server. */
export function useMobileUiPreferences(): MobileUiPreferences {
  return useSyncExternalStore(subscribeToUserPreferences, readMobileUiPreferences, readMobileUiPreferences);
}

/** The current values plus a setter; for Settings > MobileUI. */
export function useMobileUiPreference(): [MobileUiPreferences, <K extends keyof MobileUiPreferences>(key: K, value: MobileUiPreferences[K]) => void] {
  const preferences = useMobileUiPreferences();
  const set = useCallback(<K extends keyof MobileUiPreferences>(key: K, value: MobileUiPreferences[K]) => {
    writeMobileUiPreference(key, value);
  }, []);
  return [preferences, set];
}
