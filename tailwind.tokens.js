// [local] Theme-ready design tokens for Tailwind.
//
// Every palette colour class (`text-gray-500`, `bg-blue-600/10`, `from-emerald-400`,
// `@apply accent-blue-600`, ...), the fixed border radii and the font stacks are routed
// through CSS custom properties whose defaults are Tailwind's own values. With no
// theme applied the generated CSS resolves to exactly what it was before; a theme only
// has to override the variables (see docs/fork/THEMING.md).
//
// The defaults are taken from Tailwind's own palette and default theme, so they cannot
// drift from the colours the classes produced before.

import colors from 'tailwindcss/colors';
import defaultTheme from 'tailwindcss/defaultTheme';
import plugin from 'tailwindcss/plugin';

/** Every colour family of Tailwind's default palette (deprecated aliases excluded). */
export const PALETTE_FAMILIES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];

/** `#3b82f6` / `#fff` -> `59 130 246`, the channel form `rgb(... / <alpha>)` expects. */
export function hexToChannels(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((digit) => digit + digit).join('') : value;
  const number = Number.parseInt(full, 16);
  return `${(number >> 16) & 255} ${(number >> 8) & 255} ${number & 255}`;
}

const paletteColor = (name) => `rgb(var(--palette-${name}) / <alpha-value>)`;

/** `theme.extend.colors`: the palette families plus white and black, read from variables. */
export const paletteColors = {
  white: paletteColor('white'),
  black: paletteColor('black'),
  ...Object.fromEntries(PALETTE_FAMILIES.map((family) => [
    family,
    Object.fromEntries(Object.keys(colors[family]).map((shade) => [shade, paletteColor(`${family}-${shade}`)])),
  ])),
};

/**
 * `theme.extend.ringColor`. Tailwind derives the default ring colour (`ring` without a
 * colour class) by parsing `colors.blue.500`; a variable cannot be parsed, so it would
 * silently fall back to blue-300. The function form keeps blue-500 at the ring opacity.
 */
export const ringColor = {
  DEFAULT: ({ opacityValue }) => `rgb(var(--palette-blue-500) / ${opacityValue ?? 1})`,
};

/** `--palette-*` defaults: Tailwind's colours as RGB channels. */
export const paletteDefaults = {
  '--palette-white': hexToChannels(colors.white),
  '--palette-black': hexToChannels(colors.black),
  ...Object.fromEntries(PALETTE_FAMILIES.flatMap((family) => (
    Object.entries(colors[family]).map(([shade, hex]) => [`--palette-${family}-${shade}`, hexToChannels(hex)])
  ))),
};

// The stacks the app used before (sans and serif were customised; mono is Tailwind's).
const SANS_STACK = ['"Encode Sans"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'];
const SERIF_STACK = ['Merriweather', 'Georgia', 'Cambria', '"Times New Roman"', 'serif'];

/** `theme.extend.fontFamily`, read from variables. */
export const fontFamily = {
  sans: ['var(--font-sans)'],
  serif: ['var(--font-serif)'],
  mono: ['var(--font-mono)'],
};

/** `--font-*` defaults. */
export const fontDefaults = {
  '--font-sans': SANS_STACK.join(', '),
  '--font-serif': SERIF_STACK.join(', '),
  '--font-mono': defaultTheme.fontFamily.mono.join(', '),
};

/**
 * `theme.extend.borderRadius`. `lg`/`md`/`sm` already followed `--radius` (index.css);
 * the fixed sizes now have variables too. `none` and `full` stay literal on purpose:
 * pills, avatars and spinners must stay round under any theme.
 */
export const borderRadius = {
  DEFAULT: 'var(--radius-base)',
  xl: 'var(--radius-xl)',
  '2xl': 'var(--radius-2xl)',
  '3xl': 'var(--radius-3xl)',
  lg: 'var(--radius)',
  md: 'calc(var(--radius) - 2px)',
  sm: 'calc(var(--radius) - 4px)',
};

/** `--radius-*` defaults: Tailwind's own sizes. */
export const radiusDefaults = {
  '--radius-base': defaultTheme.borderRadius.DEFAULT,
  '--radius-xl': defaultTheme.borderRadius.xl,
  '--radius-2xl': defaultTheme.borderRadius['2xl'],
  '--radius-3xl': defaultTheme.borderRadius['3xl'],
};

/** Declares every token default on `:root`, in the base layer. */
export const themeTokensPlugin = plugin(({ addBase }) => {
  addBase({ ':root': { ...paletteDefaults, ...radiusDefaults, ...fontDefaults } });
});
