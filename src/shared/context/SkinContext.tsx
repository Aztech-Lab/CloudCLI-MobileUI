import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { applySkin, readStoredSkin, writeSkin, type SkinId } from '@/shared/skin';
import { subscribeToUserPreferences } from '@/shared/userSettings';

type SkinContextValue = {
  skin: SkinId;
  setSkin: (skin: SkinId) => void;
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
 * [local] Mounted once by App, beside ThemeProvider. Keeps `data-skin` on <html>
 * in step with the stored `skin` preference, which index.html already applied
 * from the localStorage mirror before React mounted, so there is no flash.
 *
 * Mirrors ThemeProvider: the only write is an explicit choice (setSkin); a value
 * arriving from the store (another device, another tab, the hydrate) is applied
 * but never written back.
 */
export const SkinProvider = ({ children }: { children: ReactNode }) => {
  const [skin, setSkinState] = useState<SkinId>(readStoredSkin);

  useEffect(() => subscribeToUserPreferences(() => {
    setSkinState(readStoredSkin());
  }), []);

  useEffect(() => {
    applySkin(skin);
  }, [skin]);

  const setSkin = useCallback((next: SkinId) => {
    writeSkin(next);
    setSkinState(next);
  }, []);

  const value = useMemo<SkinContextValue>(() => ({ skin, setSkin }), [skin, setSkin]);

  return (
    <SkinContext.Provider value={value}>
      {children}
    </SkinContext.Provider>
  );
};
