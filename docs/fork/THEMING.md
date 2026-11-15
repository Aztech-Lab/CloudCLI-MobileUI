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

## Writing a theme (sketch)

A theme is a stylesheet that overrides tokens under a selector of its own, with a dark variant where needed:

```css
:root[data-theme-skin="example"] {
  --primary: 31 51% 48%;
  --palette-blue-500: 184 121 60;      /* blue accents become copper */
  --radius: 0.125rem;
  --radius-xl: 0.125rem;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
:root.dark[data-theme-skin="example"] {
  --background: 200 9% 7%;
  --terminal-dark-background: #0f1112;
  --app-theme-color-dark: #0f1112;
}
```

How a theme is selected (setting, attribute, boot script) is not part of the token layer; it belongs to the change
that adds the first theme.

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
