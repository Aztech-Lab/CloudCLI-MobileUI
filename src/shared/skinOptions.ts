import type { SkinId } from '@/shared/skin';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] Per-skin options: the dials a skin exposes for its own signature elements
 * (how strong the OTSR dot field is, whether edges are chamfered, …).
 *
 * A skin declares its options here, as data; the Settings tab renders them from the
 * declaration, so a new skin or option needs no UI code. Each option is applied as a
 * `data-skin-<id>="<value>"` attribute on <html>, which the skin's stylesheet reads —
 * the same pattern as `data-skin` itself. Values are stored per skin under the
 * `skinOptions` user preference (`{ otsr: { dotField: 'faint' } }`), so switching
 * skins keeps each one's settings, and index.html applies the mirrored values
 * before React mounts, so there is no flash.
 *
 * Only declared options with a declared value are ever applied or written.
 */

export type SkinOptionChoice = { value: string };

export type SkinOptionDefinition =
  | { id: string; kind: 'toggle'; default: boolean }
  | { id: string; kind: 'select'; default: string; choices: readonly SkinOptionChoice[] };

export type SkinOptionValue = string | boolean;

export type SkinOptionValues = Record<string, SkinOptionValue>;

/** `dotField` -> `data-skin-dot-field`; also hard-coded in index.html's boot script. */
export function skinOptionAttribute(optionId: string): string {
  return `data-skin-${optionId.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

const OTSR_OPTIONS: readonly SkinOptionDefinition[] = [
  { id: 'dotField', kind: 'select', default: 'faint', choices: [{ value: 'off' }, { value: 'faint' }, { value: 'normal' }, { value: 'strong' }] },
  { id: 'chamfers', kind: 'toggle', default: true },
  { id: 'monoLabels', kind: 'toggle', default: true },
  { id: 'squareMarks', kind: 'toggle', default: true },
];

const AZTECAN_OPTIONS: readonly SkinOptionDefinition[] = [
  { id: 'stars', kind: 'select', default: 'animated', choices: [{ value: 'off' }, { value: 'still' }, { value: 'animated' }] },
  { id: 'glassContrast', kind: 'select', default: 'standard', choices: [{ value: 'subtle' }, { value: 'standard' }, { value: 'strong' }, { value: 'solid' }] },
  { id: 'grid', kind: 'select', default: 'normal', choices: [{ value: 'off' }, { value: 'faint' }, { value: 'normal' }] },
  { id: 'halo', kind: 'toggle', default: true },
  { id: 'pillTabs', kind: 'toggle', default: true },
];

/** The options each skin declares. The default skin has none, so its section hides. */
export const SKIN_OPTIONS: Record<SkinId, readonly SkinOptionDefinition[]> = {
  default: [],
  otsr: OTSR_OPTIONS,
  aztecan: AZTECAN_OPTIONS,
};

function isValidValue(definition: SkinOptionDefinition, value: unknown): value is SkinOptionValue {
  if (definition.kind === 'toggle') return typeof value === 'boolean';
  return typeof value === 'string' && definition.choices.some((choice) => choice.value === value);
}

/** Every option of `skin` with its default. */
export function defaultSkinOptions(skin: SkinId): SkinOptionValues {
  return Object.fromEntries(SKIN_OPTIONS[skin].map((definition) => [definition.id, definition.default]));
}

/**
 * The stored values for `skin`, each falling back to its default when absent or
 * not one of the declared values (an older or newer client, a hand-edited store).
 */
export function readStoredSkinOptions(skin: SkinId): SkinOptionValues {
  const all = readUserPreference<unknown>('skinOptions', {});
  const stored = all && typeof all === 'object' && !Array.isArray(all)
    ? (all as Record<string, unknown>)[skin]
    : undefined;
  const values = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};

  const resolved: SkinOptionValues = {};
  for (const definition of SKIN_OPTIONS[skin]) {
    const value = values[definition.id];
    resolved[definition.id] = isValidValue(definition, value) ? value : definition.default;
  }
  return resolved;
}

/** Writes one option of `skin`, leaving the other skins' options untouched. */
export function writeSkinOption(skin: SkinId, optionId: string, value: SkinOptionValue): void {
  const definition = SKIN_OPTIONS[skin].find((candidate) => candidate.id === optionId);
  if (!definition || !isValidValue(definition, value)) return;

  const all = readUserPreference<unknown>('skinOptions', {});
  const previous = all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>) : {};
  const forSkin = previous[skin] && typeof previous[skin] === 'object' ? (previous[skin] as Record<string, unknown>) : {};
  writeUserPreference('skinOptions', { ...previous, [skin]: { ...forSkin, [optionId]: value } });
}

/**
 * Applies the options as attributes. Options of other skins are removed, so a
 * skin switch never leaves a stale attribute behind.
 */
export function applySkinOptions(skin: SkinId, values: SkinOptionValues): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;

  for (const [otherSkin, definitions] of Object.entries(SKIN_OPTIONS)) {
    if (otherSkin === skin) continue;
    for (const definition of definitions) html.removeAttribute(skinOptionAttribute(definition.id));
  }
  for (const definition of SKIN_OPTIONS[skin]) {
    const value = values[definition.id] ?? definition.default;
    html.setAttribute(skinOptionAttribute(definition.id), String(value));
  }
}
