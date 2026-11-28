import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import '@/shared/mobileUiI18n'; // [local] the fork's own namespace, registered from main.tsx
import zhCNGit from '@/modules/i18n/locales/zh-CN/git.json';
import zhTWGit from '@/modules/i18n/locales/zh-TW/git.json';

/**
 * Guards the class of bug behind the "Git panel is still English in Chinese"
 * report: `fallbackLng: 'en'` makes a missing key render English silently, so a
 * locale that simply never shipped a namespace looks like a translation-quality
 * problem instead of the missing-file problem it is.
 *
 * The Git namespace is the one these assertions cover because it is the
 * namespace the Chinese locales were missing entirely. Other namespaces still
 * have known gaps in other languages; asserting on them here would fail for
 * reasons unrelated to this file's purpose.
 */

const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'locales',
);

const CHINESE_LOCALES = ['zh-CN', 'zh-TW'] as const;

/** Flattens a bundle into `a.b.c` -> leaf value, the form i18next resolves. */
const flatten = (
  value: unknown,
  prefix = '',
  into = new Map<string, string>(),
): Map<string, string> => {
  if (value === null || typeof value !== 'object') {
    into.set(prefix, String(value));
    return into;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, into);
  }

  return into;
};

/** `{{ name }}` interpolations a translation must keep verbatim. */
const placeholdersOf = (text: string): string[] =>
  (text.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? []).map(token => token.replace(/\s+/g, ''));

/** Rich-text tags a translation must keep balanced and identical in count. */
const refTagsOf = (text: string): number => (text.match(/<\/?ref>/g) ?? []).length;

const zhGitBundles = {
  'zh-CN': zhCNGit,
  'zh-TW': zhTWGit,
} as const;

describe('Chinese locales ship a complete Git namespace', () => {
  // Without this floor every assertion below would pass vacuously if the
  // resource bundles silently stopped importing (an empty bundle has no
  // missing keys and no blank values).
  test('the English git baseline actually loaded', () => {
    expect(flatten(i18n.getResourceBundle('en', 'git')).size).toBeGreaterThan(150);
  });

  test.each(CHINESE_LOCALES)('%s registers the git namespace', locale => {
    expect(i18n.hasResourceBundle(locale, 'git')).toBe(true);
  });

  test.each(CHINESE_LOCALES)('%s translates every English git key', locale => {
    const en = flatten(i18n.getResourceBundle('en', 'git'));
    const localized = flatten(zhGitBundles[locale]);

    const missing = [...en.keys()].filter(key => !localized.has(key));

    expect(missing, `missing ${locale} git keys: ${missing.join(', ')}`).toEqual([]);
  });

  test.each(CHINESE_LOCALES)('%s has no empty git translation', locale => {
    const blank = [...flatten(zhGitBundles[locale])]
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => key);

    expect(blank, `blank ${locale} git keys: ${blank.join(', ')}`).toEqual([]);
  });

  test.each(CHINESE_LOCALES)('%s keeps the git placeholders intact', locale => {
    const en = flatten(i18n.getResourceBundle('en', 'git'));
    const localized = flatten(zhGitBundles[locale]);

    const drifted: string[] = [];

    for (const [key, english] of en) {
      const translation = localized.get(key);

      if (translation === undefined) {
        continue;
      }

      const expected = placeholdersOf(english).sort().join('|');
      const actual = placeholdersOf(translation).sort().join('|');

      if (expected !== actual || refTagsOf(english) !== refTagsOf(translation)) {
        drifted.push(key);
      }
    }

    expect(drifted, `placeholder drift in ${locale}: ${drifted.join(', ')}`).toEqual([]);
  });
});

/**
 * The reported symptom was literal English on screen, so the strongest
 * assertion is the one that asks i18next the same question the Git panel asks.
 * A key can exist and still resolve to English if it lands in the wrong nesting
 * level, which the flatten-based checks above cannot see.
 */
describe('the Git panel resolves Chinese text, not the English fallback', () => {
  // Labels taken verbatim from the reported screen: the tab strip, the commit
  // composer, the staged-file list and the status legend.
  const PANEL_KEYS = [
    'tabs.changes',
    'tabs.compare',
    'tabs.history',
    'tabs.branches',
    'tabs.worktrees',
    'composer.commit',
    'composer.placeholder',
    'changes.stageAll',
    'changes.noStagedFiles',
    'legend.title',
  ] as const;

  test.each(CHINESE_LOCALES)('%s renders those labels in Chinese', async locale => {
    const previous = i18n.language;
    await i18n.changeLanguage(locale);

    try {
      const english = i18n.getResourceBundle('en', 'git') as Record<string, unknown>;
      const read = (bundle: Record<string, unknown>, key: string): unknown =>
        key.split('.').reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          bundle,
        );

      const untranslated = PANEL_KEYS.filter(key => {
        const rendered = i18n.t(`git:${key}`);
        // Equal to the English source means the fallback fired.
        if (rendered === read(english, key)) {
          return true;
        }
        // A Chinese locale must actually contain CJK somewhere in the string.
        return !/[\u4e00-\u9fff]/.test(rendered);
      });

      expect(
        untranslated,
        `${locale} still falls back to English for: ${untranslated.join(', ')}`,
      ).toEqual([]);
    } finally {
      await i18n.changeLanguage(previous);
    }
  });
});

describe('locale bundles on disk match what i18n registers', () => {
  // The original bug was two-fold: the JSON file did not exist, and config.ts
  // never imported a git namespace for these locales. Checking the registered
  // namespace set against the directory contents catches the second half, which
  // a file-existence assertion alone would miss.
  test.each(CHINESE_LOCALES)('%s has a bundle for every namespace file', locale => {
    const onDisk = fs
      .readdirSync(path.join(LOCALES_DIR, locale))
      .filter(entry => entry.endsWith('.json'))
      .map(entry => entry.slice(0, -'.json'.length))
      .sort();

    // `options.ns` is typed as `string | readonly string[]` because i18next
    // accepts a single namespace as a bare string too.
    const declaredNs = i18n.options.ns;
    const namespaces = (Array.isArray(declaredNs) ? declaredNs : [declaredNs])
      .filter((namespace): namespace is string => typeof namespace === 'string')
      .filter(namespace => i18n.hasResourceBundle(locale, namespace))
      .sort();

    expect(namespaces).toEqual(onDisk);
  });

  test('the git bundle is committed for both Chinese locales', () => {
    for (const locale of CHINESE_LOCALES) {
      expect(
        fs.existsSync(path.join(LOCALES_DIR, locale, 'git.json')),
        `${locale}/git.json is missing`,
      ).toBe(true);
    }
  });
});

/**
 * [local] The fork's own `mobileui` namespace (Settings > MobileUI, skins, the
 * server section) ships for every locale the app offers, so a non-English user
 * never sees that tab half in English.
 */
describe('every locale ships a complete mobileui namespace', () => {
  const locales = fs
    .readdirSync(LOCALES_DIR)
    .filter(locale => fs.existsSync(path.join(LOCALES_DIR, locale, 'settings.json')))
    .filter(locale => locale !== 'en')
    .sort();

  const readBundle = (locale: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'mobileui.json'), 'utf8'));

  test('the locale list is not empty', () => {
    expect(locales.length).toBeGreaterThan(10);
  });

  test.each(locales)('%s registers the mobileui namespace', locale => {
    expect(fs.existsSync(path.join(LOCALES_DIR, locale, 'mobileui.json'))).toBe(true);
    expect(i18n.hasResourceBundle(locale, 'mobileui')).toBe(true);
  });

  test.each(locales)('%s has every English mobileui key, no extras and no blanks', locale => {
    const en = flatten(readBundle('en'));
    const localized = flatten(readBundle(locale));

    const missing = [...en.keys()].filter(key => !localized.has(key));
    const extra = [...localized.keys()].filter(key => !en.has(key));
    const blank = [...localized].filter(([, text]) => text.trim() === '').map(([key]) => key);

    expect({ missing, extra, blank }).toEqual({ missing: [], extra: [], blank: [] });
  });

  test.each(locales)('%s keeps the mobileui placeholders and line breaks', locale => {
    const en = flatten(readBundle('en'));
    const localized = flatten(readBundle(locale));

    const drifted = [...en].filter(([key, english]) => {
      const translation = localized.get(key);
      if (translation === undefined) return false;
      return (
        placeholdersOf(english).sort().join('|') !== placeholdersOf(translation).sort().join('|') ||
        english.split('\n').length !== translation.split('\n').length
      );
    }).map(([key]) => key);

    expect(drifted, `placeholder drift in ${locale}: ${drifted.join(', ')}`).toEqual([]);
  });
});
