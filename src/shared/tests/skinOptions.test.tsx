import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SkinProvider, useSkin } from '@/shared/context/SkinContext';
import { SKIN_ATTRIBUTE } from '@/shared/skin';
import {
  applySkinOptions,
  defaultSkinOptions,
  readStoredSkinOptions,
  SKIN_OPTIONS,
  skinOptionAttribute,
  writeSkinOption,
} from '@/shared/skinOptions';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] Per-skin options are declared as data, stored per skin under one
 * preference, validated against the declaration on read, and applied as
 * `data-skin-<id>` attributes that the skin's stylesheet keys on.
 */

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SkinProvider, null, children);

const html = () => document.documentElement;
const clearAttributes = () => {
  html().removeAttribute(SKIN_ATTRIBUTE);
  for (const definitions of Object.values(SKIN_OPTIONS)) {
    for (const definition of definitions) html().removeAttribute(skinOptionAttribute(definition.id));
  }
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  clearAttributes();
});

afterEach(clearAttributes);

describe('skin option declarations', () => {
  it('declares OTSR options and none for the default skin', () => {
    expect(SKIN_OPTIONS.default).toEqual([]);
    expect(SKIN_OPTIONS.otsr.map((option) => option.id)).toEqual(['dotField', 'chamfers', 'monoLabels', 'squareMarks']);
    expect(defaultSkinOptions('otsr')).toEqual({ dotField: 'faint', chamfers: true, monoLabels: true, squareMarks: true });
  });

  it('declares the Aztecan options', () => {
    expect(SKIN_OPTIONS.aztecan.map((option) => option.id)).toEqual(['stars', 'glassContrast', 'grid', 'halo', 'pillTabs']);
    expect(defaultSkinOptions('aztecan')).toEqual({ stars: 'animated', glassContrast: 'standard', grid: 'normal', halo: true, pillTabs: true });
    expect(skinOptionAttribute('pillTabs')).toBe('data-skin-pill-tabs');
    expect(skinOptionAttribute('glassContrast')).toBe('data-skin-glass-contrast');
  });

  it('maps option ids to kebab-case data attributes', () => {
    expect(skinOptionAttribute('dotField')).toBe('data-skin-dot-field');
    expect(skinOptionAttribute('chamfers')).toBe('data-skin-chamfers');
  });
});

describe('stored skin options', () => {
  it('reads defaults when nothing is stored', () => {
    expect(readStoredSkinOptions('otsr')).toEqual(defaultSkinOptions('otsr'));
  });

  it('keeps each skin\'s values apart and ignores undeclared or invalid values', () => {
    writeUserPreference('skinOptions', {
      otsr: { dotField: 'strong', chamfers: false, monoLabels: 'yes', bogus: 1 },
      future: { anything: true },
    });
    expect(readStoredSkinOptions('otsr')).toEqual({ dotField: 'strong', chamfers: false, monoLabels: true, squareMarks: true });
    expect(readStoredSkinOptions('default')).toEqual({});
  });

  it('writes one option without disturbing the others or other skins', () => {
    writeUserPreference('skinOptions', { otsr: { chamfers: false }, future: { anything: true } });
    writeSkinOption('otsr', 'dotField', 'off');
    expect(readUserPreference('skinOptions', null)).toEqual({ otsr: { chamfers: false, dotField: 'off' }, future: { anything: true } });
  });

  it('refuses a value the declaration does not allow', () => {
    writeSkinOption('otsr', 'dotField', 'blinding');
    writeSkinOption('otsr', 'chamfers', 'maybe');
    writeSkinOption('otsr', 'nope', true);
    expect(readUserPreference('skinOptions', 'untouched')).toBe('untouched');
  });
});

describe('applySkinOptions', () => {
  it('sets one attribute per declared option and clears other skins\' attributes', () => {
    applySkinOptions('otsr', { dotField: 'off', chamfers: false, monoLabels: true, squareMarks: true });
    expect(html().getAttribute('data-skin-dot-field')).toBe('off');
    expect(html().getAttribute('data-skin-chamfers')).toBe('false');
    expect(html().getAttribute('data-skin-mono-labels')).toBe('true');

    applySkinOptions('default', {});
    expect(html().hasAttribute('data-skin-dot-field')).toBe(false);
    expect(html().hasAttribute('data-skin-chamfers')).toBe(false);
  });

  it('replaces the option attributes of the previous skin', () => {
    applySkinOptions('otsr', defaultSkinOptions('otsr'));
    applySkinOptions('aztecan', { stars: 'still', glassContrast: 'solid', grid: 'faint', halo: false, pillTabs: true });
    expect(html().getAttribute('data-skin-glass-contrast')).toBe('solid');
    expect(html().getAttribute('data-skin-stars')).toBe('still');
    expect(html().getAttribute('data-skin-grid')).toBe('faint');
    expect(html().getAttribute('data-skin-halo')).toBe('false');
    expect(html().getAttribute('data-skin-pill-tabs')).toBe('true');
    expect(html().hasAttribute('data-skin-dot-field')).toBe(false);
    expect(html().hasAttribute('data-skin-chamfers')).toBe(false);
  });
});

describe('SkinProvider options', () => {
  it('exposes the active skin\'s options and applies a change', () => {
    writeUserPreference('skin', 'otsr');
    const { result } = renderHook(() => useSkin(), { wrapper });
    expect(result.current.skinOptions).toEqual(defaultSkinOptions('otsr'));
    expect(html().getAttribute('data-skin-dot-field')).toBe('faint');

    act(() => result.current.setSkinOption('dotField', 'off'));
    expect(result.current.skinOptions.dotField).toBe('off');
    expect(html().getAttribute('data-skin-dot-field')).toBe('off');
    expect((readUserPreference('skinOptions', {}) as { otsr: { dotField: string } }).otsr.dotField).toBe('off');
  });

  it('switches option sets with the skin and drops the old attributes', () => {
    writeUserPreference('skin', 'otsr');
    writeUserPreference('skinOptions', { otsr: { chamfers: false } });
    const { result } = renderHook(() => useSkin(), { wrapper });
    expect(html().getAttribute('data-skin-chamfers')).toBe('false');

    act(() => result.current.setSkin('default'));
    expect(result.current.skinOptions).toEqual({});
    expect(html().hasAttribute('data-skin-chamfers')).toBe(false);

    act(() => result.current.setSkin('otsr'));
    expect(result.current.skinOptions.chamfers).toBe(false);
    expect(html().getAttribute('data-skin-chamfers')).toBe('false');
  });

  it('follows an option change arriving from the store', () => {
    writeUserPreference('skin', 'otsr');
    const { result } = renderHook(() => useSkin(), { wrapper });
    act(() => writeUserPreference('skinOptions', { otsr: { dotField: 'strong' } }));
    expect(result.current.skinOptions.dotField).toBe('strong');
    expect(html().getAttribute('data-skin-dot-field')).toBe('strong');
  });
});
