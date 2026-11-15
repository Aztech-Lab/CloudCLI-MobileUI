import colors from 'tailwindcss/colors';
import defaultTheme from 'tailwindcss/defaultTheme';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readThemeToken, toTokenName } from '@/shared/utils';

// oxlint-disable-next-line no-restricted-imports -- the token module sits at the repo root beside tailwind.config.js, outside the @/ (src) alias
import * as tokens from '../../../tailwind.tokens.js';

const {
  borderRadius,
  fontDefaults,
  fontFamily,
  hexToChannels,
  PALETTE_FAMILIES,
  radiusDefaults,
  ringColor,
} = tokens;
// Inferred from a plain JS module: widen the generated maps to what they hold.
const paletteDefaults = tokens.paletteDefaults as Record<string, string>;
const paletteColors = tokens.paletteColors as unknown as Record<string, string | Record<string, string>>;

/**
 * [local] The theme-ready refactor routes Tailwind's palette, radii and fonts through
 * CSS variables. Its promise is that the defaults are the previous values, so the app
 * looks exactly as before until a theme overrides them. These tests pin that promise.
 */

describe('tailwind theme tokens', () => {
  it('covers every colour family of the default palette, plus white and black', () => {
    const families = Object.keys(colors).filter((name) => (
      // Deprecated aliases are getters that warn; the listed families are the real ones.
      !['lightBlue', 'warmGray', 'trueGray', 'coolGray', 'blueGray'].includes(name)
      && typeof Object.getOwnPropertyDescriptor(colors, name)?.value === 'object'
    ));
    expect([...PALETTE_FAMILIES].sort()).toEqual(families.sort());
    expect(paletteColors.white).toBe('rgb(var(--palette-white) / <alpha-value>)');
    expect(paletteColors.black).toBe('rgb(var(--palette-black) / <alpha-value>)');
  });

  it('defaults every palette variable to the exact Tailwind colour', () => {
    expect(paletteDefaults['--palette-white']).toBe('255 255 255');
    expect(paletteDefaults['--palette-black']).toBe('0 0 0');
    let checked = 0;
    for (const family of PALETTE_FAMILIES) {
      const shades = colors[family as keyof typeof colors] as Record<string, string>;
      for (const [shade, hex] of Object.entries(shades)) {
        expect(paletteDefaults[`--palette-${family}-${shade}`]).toBe(hexToChannels(hex));
        expect((paletteColors[family] as Record<string, string>)[shade])
          .toBe(`rgb(var(--palette-${family}-${shade}) / <alpha-value>)`);
        checked += 1;
      }
    }
    expect(checked).toBe(PALETTE_FAMILIES.length * 11);
  });

  it('converts hex to RGB channels', () => {
    expect(hexToChannels('#3b82f6')).toBe('59 130 246');
    expect(hexToChannels('#fff')).toBe('255 255 255');
  });

  it('keeps the default focus-ring colour at blue-500, as Tailwind derived it before', () => {
    expect(ringColor.DEFAULT({ opacityValue: '0.5' })).toBe('rgb(var(--palette-blue-500) / 0.5)');
    expect(paletteDefaults['--palette-blue-500']).toBe(hexToChannels(colors.blue[500]));
  });

  it('defaults the radii to Tailwind sizes and keeps lg/md/sm on --radius', () => {
    expect(radiusDefaults).toEqual({
      '--radius-base': defaultTheme.borderRadius.DEFAULT,
      '--radius-xl': defaultTheme.borderRadius.xl,
      '--radius-2xl': defaultTheme.borderRadius['2xl'],
      '--radius-3xl': defaultTheme.borderRadius['3xl'],
    });
    expect(borderRadius.lg).toBe('var(--radius)');
    expect(borderRadius.md).toBe('calc(var(--radius) - 2px)');
    expect(borderRadius.sm).toBe('calc(var(--radius) - 4px)');
    expect(borderRadius).not.toHaveProperty('full');
    expect(borderRadius).not.toHaveProperty('none');
  });

  it('defaults the fonts to the previous stacks', () => {
    expect(fontFamily).toEqual({ sans: ['var(--font-sans)'], serif: ['var(--font-serif)'], mono: ['var(--font-mono)'] });
    expect(fontDefaults['--font-sans']).toBe('"Encode Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif');
    expect(fontDefaults['--font-serif']).toBe('Merriweather, Georgia, Cambria, "Times New Roman", serif');
    expect(fontDefaults['--font-mono']).toBe(defaultTheme.fontFamily.mono.join(', '));
  });
});

describe('readThemeToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty string when the token is not set', () => {
    expect(readThemeToken('--not-a-token')).toBe('');
  });

  it('returns the trimmed value a theme set', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--app-theme-color-dark' ? '  #0f1112 ' : ''),
    } as unknown as CSSStyleDeclaration);
    expect(readThemeToken('--app-theme-color-dark')).toBe('#0f1112');
  });

  it('never throws', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('no layout');
    });
    expect(readThemeToken('--anything')).toBe('');
  });

  it('derives token names from camelCase keys', () => {
    expect(toTokenName('selectionBackground')).toBe('selection-background');
    expect(toTokenName('brightRed')).toBe('bright-red');
    expect(toTokenName('background')).toBe('background');
  });
});
