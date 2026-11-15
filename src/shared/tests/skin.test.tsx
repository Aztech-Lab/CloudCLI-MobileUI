import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SkinProvider, useSkin } from '@/shared/context/SkinContext';
import { applySkin, isSkinId, readStoredSkin, SKIN_ATTRIBUTE, SKIN_IDS } from '@/shared/skin';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] Skins are stored as the `skin` user preference and applied as
 * `data-skin` on <html>. The default skin must leave the document attribute-free,
 * so the unthemed stylesheet needs no selector; unknown values fall back to it.
 */

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SkinProvider, null, children);

const skinAttribute = () => document.documentElement.getAttribute(SKIN_ATTRIBUTE);

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  document.documentElement.removeAttribute(SKIN_ATTRIBUTE);
});

afterEach(() => {
  document.documentElement.removeAttribute(SKIN_ATTRIBUTE);
});

describe('skin ids', () => {
  it('knows the default and the OTSR skin, nothing else', () => {
    expect(SKIN_IDS).toEqual(['default', 'otsr']);
    expect(isSkinId('otsr')).toBe(true);
    expect(isSkinId('neon')).toBe(false);
    expect(isSkinId(null)).toBe(false);
  });

  it('reads the stored skin and falls back to the default for anything unknown', () => {
    expect(readStoredSkin()).toBe('default');
    writeUserPreference('skin', 'otsr');
    expect(readStoredSkin()).toBe('otsr');
    writeUserPreference('skin', 'from-a-newer-client');
    expect(readStoredSkin()).toBe('default');
  });

  it('applies a skin as a document attribute and removes it for the default', () => {
    applySkin('otsr');
    expect(skinAttribute()).toBe('otsr');
    applySkin('default');
    expect(skinAttribute()).toBeNull();
  });
});

describe('SkinProvider', () => {
  it('starts from the stored skin and applies it', () => {
    writeUserPreference('skin', 'otsr');
    const { result } = renderHook(() => useSkin(), { wrapper });
    expect(result.current.skin).toBe('otsr');
    expect(skinAttribute()).toBe('otsr');
  });

  it('stores an explicit choice and applies it', () => {
    const { result } = renderHook(() => useSkin(), { wrapper });
    expect(skinAttribute()).toBeNull();

    act(() => result.current.setSkin('otsr'));
    expect(result.current.skin).toBe('otsr');
    expect(skinAttribute()).toBe('otsr');
    expect(readUserPreference('skin', 'default')).toBe('otsr');

    act(() => result.current.setSkin('default'));
    expect(skinAttribute()).toBeNull();
    expect(readUserPreference('skin', 'x')).toBe('default');
  });

  it('follows a change arriving from the preference store without writing it back', () => {
    const { result } = renderHook(() => useSkin(), { wrapper });
    act(() => writeUserPreference('skin', 'otsr'));
    expect(result.current.skin).toBe('otsr');
    expect(skinAttribute()).toBe('otsr');
  });

  it('mirrors the skin where index.html reads it before React mounts', () => {
    const { result } = renderHook(() => useSkin(), { wrapper });
    act(() => result.current.setSkin('otsr'));
    const mirror = JSON.parse(localStorage.getItem('user-preferences') ?? '{}') as { skin?: string };
    expect(mirror.skin).toBe('otsr');
  });
});
