/**
 * [local] Registers the `mobileui` translation namespace: every string that belongs to
 * what CloudCLI-MobileUI adds (Settings > MobileUI, skins, the server section, ...).
 *
 * Kept out of the original namespaces and out of config.ts, so upstream translation files
 * stay as they are. Each locale folder (src/modules/i18n/locales/<lang>/) may hold a `mobileui.json`; a missing key falls back
 * to English like every other namespace. Imported once from src/main.tsx (and from tests
 * that render these strings); registering again is harmless.
 */
import { i18n } from '@/modules/i18n';

export const MOBILEUI_NAMESPACE = 'mobileui';

const bundles = import.meta.glob<{ default: Record<string, unknown> }>('/src/modules/i18n/locales/*/mobileui.json', { eager: true });

// Declared like the built-in namespaces, so code that walks `options.ns` sees it too.
const declared = i18n.options.ns;
const declaredList = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : [];
if (!declaredList.includes(MOBILEUI_NAMESPACE)) {
  i18n.options.ns = [...declaredList, MOBILEUI_NAMESPACE];
}

for (const [path, module] of Object.entries(bundles)) {
  const language = /\/locales\/([^/]+)\/mobileui\.json$/.exec(path)?.[1];
  if (!language) continue;
  // deep + overwrite: a re-import (hot reload, tests) replaces the bundle instead of failing.
  i18n.addResourceBundle(language, MOBILEUI_NAMESPACE, module.default, true, true);
}
