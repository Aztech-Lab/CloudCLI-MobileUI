import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] Skins: visual themes layered on top of the light/dark mode.
 *
 * A skin is a stylesheet that overrides the design tokens (docs/fork/THEMING.md)
 * under `:root[data-skin="<id>"]`. The id is stored as the `skin` user preference,
 * so it follows the user across devices like the theme does, and mirrored in
 * localStorage so index.html can apply it before React mounts (no flash of the
 * default look). The default skin sets no attribute at all, so with it the app is
 * exactly the unthemed stylesheet.
 */

export const SKIN_IDS = ['default', 'otsr', 'aztecan'] as const;

export type SkinId = (typeof SKIN_IDS)[number];

export const DEFAULT_SKIN: SkinId = 'default';

/** The `<html>` attribute the skin stylesheets key on; also read by index.html. */
export const SKIN_ATTRIBUTE = 'data-skin';

/** The localStorage mirror of the preference store, read by index.html before React. */
export const PREFERENCES_MIRROR_STORAGE_KEY = 'user-preferences';

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === 'string' && (SKIN_IDS as readonly string[]).includes(value);
}

/** The stored skin, or the default for an absent or unknown value. */
export function readStoredSkin(): SkinId {
  const stored = readUserPreference<unknown>('skin', DEFAULT_SKIN);
  return isSkinId(stored) ? stored : DEFAULT_SKIN;
}

/**
 * Applies a skin to the document. The default skin removes the attribute rather
 * than setting `data-skin="default"`, so the unthemed stylesheet needs no selector.
 */
export function applySkin(skin: SkinId): void {
  if (typeof document === 'undefined') return;
  if (skin === DEFAULT_SKIN) {
    document.documentElement.removeAttribute(SKIN_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(SKIN_ATTRIBUTE, skin);
  }
}

export function writeSkin(skin: SkinId): void {
  writeUserPreference('skin', skin);
}
