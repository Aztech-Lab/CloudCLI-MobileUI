import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { showStarfield, unmountStarfield } from '@/shared/aztecanStarfield';
import { applySkin, readStoredSkin, writeSkin, type SkinId } from '@/shared/skin';
import {
  applySkinOptions,
  readStoredSkinOptions,
  writeSkinOption,
  type SkinOptionValue,
  type SkinOptionValues,
} from '@/shared/skinOptions';
import { subscribeToUserPreferences } from '@/shared/userSettings';

type SkinContextValue = {
  skin: SkinId;
  setSkin: (skin: SkinId) => void;
  /** The active skin's option values, every declared option present. */
  skinOptions: SkinOptionValues;
  setSkinOption: (optionId: string, value: SkinOptionValue) => void;
};

const SkinContext = createContext<SkinContextValue | null>(null);

export const useSkin = () => {
  const context = useContext(SkinContext);
  if (!context) {
    throw new Error('useSkin must be used within a SkinProvider');
  }
  return context;
};

/**
 * [local] Mounted once by App, beside ThemeProvider. Keeps `data-skin` and the
 * skin's `data-skin-*` option attributes on <html> in step with the stored
 * preferences, which index.html already applied from the localStorage mirror
 * before React mounted, so there is no flash.
 *
 * Mirrors ThemeProvider: the only writes are explicit choices (setSkin,
 * setSkinOption); a value arriving from the store (another device, another tab,
 * the hydrate) is applied but never written back.
 */
export const SkinProvider = ({ children }: { children: ReactNode }) => {
  const [skin, setSkinState] = useState<SkinId>(readStoredSkin);
  const [skinOptions, setSkinOptionsState] = useState<SkinOptionValues>(() => readStoredSkinOptions(readStoredSkin()));

  useEffect(() => subscribeToUserPreferences(() => {
    const storedSkin = readStoredSkin();
    setSkinState(storedSkin);
    setSkinOptionsState(readStoredSkinOptions(storedSkin));
  }), []);

  useEffect(() => {
    applySkin(skin);
    applySkinOptions(skin, skinOptions);
  }, [skin, skinOptions]);

  // The Aztecan skin's starfield: generated once per load (a new random sky each
  // time) and again when the skin or the stars option changes. CSS animates it.
  const starsOption = skin === 'aztecan' ? skinOptions.stars : undefined;
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (skin !== 'aztecan' || starsOption === 'off') {
      unmountStarfield(document);
      return undefined;
    }
    showStarfield(document);
    return () => unmountStarfield(document);
  }, [skin, starsOption]);

  const setSkin = useCallback((next: SkinId) => {
    writeSkin(next);
    setSkinState(next);
    setSkinOptionsState(readStoredSkinOptions(next));
  }, []);

  const setSkinOption = useCallback((optionId: string, value: SkinOptionValue) => {
    writeSkinOption(skin, optionId, value);
    setSkinOptionsState(readStoredSkinOptions(skin));
  }, [skin]);

  const value = useMemo<SkinContextValue>(
    () => ({ skin, setSkin, skinOptions, setSkinOption }),
    [skin, setSkin, skinOptions, setSkinOption],
  );

  return (
    <SkinContext.Provider value={value}>
      {children}
    </SkinContext.Provider>
  );
};
