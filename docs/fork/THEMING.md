# Theming: design tokens

CloudCLI-MobileUI is *theme-ready*: everything that decides how the UI looks reads a CSS custom property whose
default is the original value. With no theme applied the app is unchanged (this is checked, see
[Verifying "no visible change"](#verifying-no-visible-change)). A theme is therefore just a set of variable
overrides — no component has to change.

## Token layers

| Layer | Variables | Defined in | Used by |
|---|---|---|---|
| Semantic colours | `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring` (+ `-foreground` pairs), `--nav-*` | `src/index.css` (`:root` and `.dark`) | `bg-background`, `text-primary`, … (HSL channels: `0 0% 8%`) |
| Palette | `--palette-<family>-<shade>` for all 22 Tailwind families × 11 shades, plus `--palette-white`, `--palette-black` | generated from Tailwind's palette by `tailwind.tokens.js` (`:root`) | every palette class: `text-gray-500`, `bg-blue-600/10`, `from-emerald-400`, `ring-red-500`, `@apply accent-blue-600`, … (RGB channels: `59 130 246`) |
| Radius | `--radius` (lg/md/sm), `--radius-base` (`rounded`), `--radius-xl`, `--radius-2xl`, `--radius-3xl` | `src/index.css`, `tailwind.tokens.js` | `rounded`, `rounded-lg`, `rounded-xl`, … (`rounded-none` and `rounded-full` stay literal on purpose) |
| Fonts | `--font-sans`, `--font-serif`, `--font-mono` | `tailwind.tokens.js` | `font-sans` (the page default), `font-serif`, `font-mono`, `code`/`pre` |
| Dark-mode literals | `--dark-surface`, `--dark-option-bg`, `--dark-option-fg` (RGB channels) | `src/index.css` | dark focus surfaces / ring offsets, dark `<select>` options |
| Terminal | `--terminal-{dark\|light}-<key>` for `background`, `foreground`, `cursor`, `cursor-accent`, `selection-background`, `selection-foreground`, the 16 ANSI colours (`black` … `bright-white`), and `--terminal-{dark\|light}-minimum-contrast-ratio` | optional, no defaults in CSS | xterm, through `resolveTerminalColors` (`src/modules/shell/hooks/useShellTerminal.ts`) |
| Browser chrome | `--app-theme-color-dark`, `--app-theme-color-light` | optional, no defaults in CSS | `<meta name="theme-color">` (`src/shared/context/ThemeContext.tsx`) |

Notes:

- Palette and dark-mode tokens are **RGB channels** (`59 130 246`) so Tailwind's opacity modifiers keep working
  (`bg-blue-500/10` → `rgb(var(--palette-blue-500) / 0.1)`). Semantic tokens are **HSL channels**, as before.
- Terminal and browser-chrome tokens hold **complete colours** (`#0f1112`), because xterm and the meta tag need a
  concrete value. They are read from JavaScript with `readThemeToken` (`src/shared/themeTokens.ts`); when a token is
  unset the built-in default is used. They are read when the terminal opens and when light/dark is toggled.
- The palette is the lever for the ~2,500 hard-coded Tailwind colour classes in the components: remapping
  `--palette-blue-*` recolours every blue accent, `--palette-gray-*` every grey surface and text, and so on.

## Skins

A **skin** is a stylesheet that overrides the tokens above. It is layered on the light/dark mode: light and dark
both keep working under every skin, and a skin provides values for each.

### How a skin is selected

- The chosen skin is the `skin` user preference (`src/shared/userSettings.ts`), stored like `theme`, so it follows
  the user across devices. Valid ids are the `SKIN_IDS` registry in `src/shared/skin.ts`; anything else resolves to
  `default`.
- `SkinProvider` (`src/shared/context/SkinContext.tsx`, mounted beside `ThemeProvider`) applies it as
  **`data-skin="<id>"` on `<html>`**. The default skin *removes* the attribute, so the unthemed stylesheet needs no
  selector and is exactly the default look.
- `index.html` has a boot script that applies the mirrored `skin` (and its options, below) from localStorage before
  React mounts, so the page never flashes the default look.
- The skin stylesheets live in `src/skins/<id>.css` and are imported in `src/main.tsx` **after** `index.css`, so
  their overrides win.

The stylesheet keys on the attribute, with the app's normal `.dark` class for dark mode:

```css
:root[data-skin="example"] {
  --primary: 30 55% 39%;
  --palette-blue-500: 154 95 44;       /* blue accents become copper */
  --radius: 0.125rem;
  --radius-xl: 0.125rem;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
:root[data-skin="example"].dark {
  --background: 200 9% 6%;
  --terminal-dark-background: #0f1112;
  --app-theme-color-dark: #0f1112;
}
```

`src/skins/otsr.css` is the complete worked example.

### Skin options

A skin can expose dials for its own signature elements (how strong a background texture is, whether edges are
chamfered, …). Options are **declared as data**, in `SKIN_OPTIONS` in `src/shared/skinOptions.ts`:

```ts
{ id: 'dotField', kind: 'select', default: 'faint', choices: [{ value: 'off' }, { value: 'faint' }, { value: 'normal' }, { value: 'strong' }] },
{ id: 'chamfers', kind: 'toggle', default: true },
```

- The Settings › Appearance › Skin card renders the controls **from the declaration** (a toggle per `toggle`, a
  `<select>` per `select`); no UI code per option. A skin with no options shows no card.
- Each option is applied as **`data-skin-<kebab-id>="<value>"` on `<html>`** (`dotField` → `data-skin-dot-field`),
  by `SkinProvider` and by the `index.html` boot script. The stylesheet keys on it:

  ```css
  [data-skin="otsr"][data-skin-dot-field="off"] .chat-messages-pane { background-image: none; }
  [data-skin="otsr"]:not([data-skin-chamfers="false"]) [role="tablist"] { clip-path: var(--otsr-chamfer-sm); }
  ```

  Write selectors so that a **missing attribute means the default** (`:not([…="false"])`, or a rule for both the
  absent attribute and the default value). That is what keeps the default skin's built CSS a zero-diff against
  the unthemed stylesheet.
- Values are stored per skin under the `skinOptions` preference (`{ otsr: { dotField: 'faint' } }`), so switching
  skins keeps each one's settings. Only declared options with declared values are read, written or applied; anything
  else falls back to the option's default.

### i18n

Labels live in `src/modules/i18n/locales/<locale>/settings.json` under `appearanceSettings`:

- `skin.<id>` — the skin's name in the Skin select (`skin.label` / `skin.description` are the select's own).
- `skinOptions.<skin>.<option>.label`, `.description`, and one key per select choice value
  (`skinOptions.otsr.dotField.faint`).

Every string is read with a `defaultValue`, so a locale that lacks a key falls back to English rather than showing
the key. Translate at least `en`, `zh-CN` and `zh-TW`.

### Adding a skin — checklist

1. `src/shared/skin.ts`: add the id to `SKIN_IDS`.
2. `src/skins/<id>.css`: the token overrides, `:root[data-skin="<id>"]` plus a `.dark` variant. Start from
   `src/skins/otsr.css`. Prefer overriding tokens over adding selectors on components; keep any signature rules on
   stable hooks (`role="tablist"`, `.chat-composer-shell`, `.chat-messages-pane`, …).
3. `src/main.tsx`: `import '@/skins/<id>.css'` after `index.css`.
4. `src/shared/skinOptions.ts`: add `SKIN_OPTIONS.<id>` (an empty array if the skin has no options).
5. `src/modules/i18n/locales/*/settings.json`: `appearanceSettings.skin.<id>` and, if there are options,
   `appearanceSettings.skinOptions.<id>.*`.
6. Check contrast: run the components' real text/background pairs through the skin's resolved tokens (the OTSR
   skin did this; copper as text and white-on-copper both needed darker shades than the source design uses).
7. Verify the default skin is untouched: build, strip the `[data-skin…]` rules from the output, and set-diff the
   declarations against a build of `main` (see below). Expect zero added and zero removed.
8. `npx vitest run` stays green; `src/shared/tests/skin.test.tsx` and `skinOptions.test.tsx` cover the registry,
   the store and the attributes.

## The theme library

The design a skin implements lives in [`themes/`](../../themes/README.md) as a **theme package**: the values by
semantic role (`theme.json`), the aesthetic rules (`README.md`) and a procedure for applying the design to any UI
(`apply.md`), with `examples/cloudcli.md` recording how this app applied it. A skin here is one target of a package;
when you change a skin's values, change the package first and record why.

## Not themeable yet

- Syntax highlighting (Prism styles in chat code blocks) and the CodeMirror editor theme (`@codemirror/theme-one-dark`
  and `src/modules/code-editor/utils/editorStyles.ts`): third-party theme objects.
- The mobile terminal selection handle and menu (`src/modules/shell/utils/mobileTerminalSelection.ts`, inline styles).
- Categorical colours that are data, not theme: git graph lanes (`src/modules/git-panel/utils/commitGraph.ts`),
  provider/brand logos.
- Box shadows and tap-highlight colours (neutral black at low opacity).

## Verifying "no visible change"

Any change to the token layer must keep the default theme identical. Build before and after, then compare:

```bash
npm run build:client && cp dist/assets/index-*.css /tmp/before.css   # on the base commit
# ... apply the change ...
npm run build:client && node scripts/check-theme-equivalence.mjs /tmp/before.css dist/assets/index-*.css
```

The script substitutes every new `:root` token with its default, normalises colour syntax, and compares the two
stylesheets declaration by declaration, in order. It reports `EQUIVALENT` or lists the differing declarations. The
only tolerated difference is the minifier's 8-bit alpha rounding (`#xxxxxx4d` = 0.302 before, exact 0.3 through a
variable), which is below half a display step.
