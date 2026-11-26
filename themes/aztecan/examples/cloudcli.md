# Application record: Aztecan on CloudCLI-MobileUI

The first application of the Aztecan package, as the `aztecan` skin of this repository. The
output is `src/skins/aztecan.css`; the mechanism it plugs into is described in
`docs/fork/THEMING.md`, and the OTSR record (`themes/otsr/examples/cloudcli.md`) explains how
the app was made token-ready.

## Shape of the change

Token override only, keyed on `html[data-skin="aztecan"]` with the app's `.dark` class. Three
signature rules, each a skin option (`src/shared/skinOptions.ts`), plus two always-on rules
(shadows, dark letters on pale fills). One addition outside the skin file: `Inter` is added
to the Google Fonts link in `index.html`, beside the app's own Encode Sans and Merriweather.
A browser downloads a face only when a rule uses it, so the default and OTSR skins do not
download Inter.

## Role mapping

Semantic tokens (HSL channels in the CSS; hex here):

| app token | Aztecan role | light (derived) | dark (site) |
|---|---|---|---|
| `--background` | surface.base | `#f5f5f7` | `#030305` (`--bg`) |
| `--card` | surface.raised | `#ffffff` | `#0e0e12` (`--panel` flattened) |
| `--popover` | surface.overlay | `#ffffff` | `#0d0e13` (mobile menu) |
| `--secondary`, `--muted` | surface.sunken | `#ebebef` | `#141417` (white 4.5%) |
| `--accent` | surface.hover | `#e8edf7` (site `--accent`) | `#1b1b1e` (white 8%) |
| `--foreground` | ink.text | `#0b0b0f` | `#f5f5f7` (`--text`) |
| `--muted-foreground` | ink.muted | `#5f5f69` | `#a1a1aa` (`--muted`) |
| `--border` | line.default | `#dcdce2` | `#1f1f22` (`--line` flattened) |
| `--input` | line.bright | `#d1d1d8` | `#3a3a3c` (`--line-bright` flattened) |
| `--primary` / `-foreground` | primary.fill / onFill | `#111114` / `#f5f5f7` | `#e8edf7` / `#050507` (`.primary-action`) |
| `--ring` | signal.cyanText / cyan | `#0a6f9c` | `#76d8ff` (`--cyan`, the site's focus outline) |
| `--destructive` / `-foreground` | status.danger | `#c62828` / white | `#ff8a8a` / `#050507` |
| `--nav-glass-*` | surface.glass | white 72%, blur 24px, saturate 1.4 | `--panel` 72%, same blur (`.topbar`) |
| `--nav-tab-*`, `--nav-input-focus-ring` | cyan at 10 to 25% | | |
| `--app-theme-color-*` | chrome | `#f5f5f7` | `#030305` |
| `--terminal-*` | terminal block | as `theme.json` | as `theme.json` |

Palette families (RGB channels):

| family | became | notes |
|---|---|---|
| `blue-*` | cyan | light: 50 to 300 pale tints, 400 = `#76d8ff`, 500/600/700 = `#0a78a8`/`#0a6f9c`/`#075a80` (text-safe), 800 to 950 deep. Dark: 400 to 600 = `#76d8ff`, 300 and 700 = `#a6e6ff`, 800 to 950 cyan-black for tinted areas |
| `gray-*` | cool zinc | `#a1a1aa` and a darker `#6b6b74` at 400/500 (light); dark moves 500 to `#82828c` and 700 to 950 to the site's surfaces (`#26262b`, `#141418`, `#0b0b0f`, `#030305`) |
| `green-*`, `emerald-*` | mint | light 500 to 700 deep mint (`#0f8256`, `#0d7a4f`, `#0a6340`); dark 400 to 600 `#94f0c3`, 300/700 paler |
| `red-300/400` (dark) | the site's error text | `#ffb4b4`, `#ff8a8a`; red fills under white text stay the host's |
| `purple-`, `violet-300/400` (dark) | violet | `#b9a8ff`, `#d3c8ff`; they are only used as dots and text here |
| radii | 8 / 6 / 12 / 18 / 22px | `--radius`, `--radius-base`, `--radius-xl`, `-2xl`, `-3xl` |
| fonts | Inter stack, the site's mono stack; serif to sans | CJK system faces appended to the sans stack |

## Contrast pass

Ratios computed on the final values (WCAG 2 relative luminance):

| pair | light | dark |
|---|---|---|
| body text on base / on raised | 18.0 / 19.6 | 18.9 / 17.7 |
| muted text on base / raised / sunken / hover | 5.8 / 6.3 / 5.3 / 5.4 | 8.0 / 7.5 / 7.2 / 6.7 |
| primary label on primary | 17.3 | 17.4 |
| `text-blue-600` on base / white | 5.1 / 5.6 | 12.8 (as `#76d8ff`) |
| `text-blue-500` on white / base | 4.9 / 4.5 | 12.8 |
| `text-blue-700` on `bg-blue-50` | 7.1 | |
| `text-blue-300` on `bg-blue-900` | | 11.5 |
| white on `bg-blue-500/600/700` | 4.9 / 5.6 / 7.6 | letters turned `#050507`: 12.6 |
| `text-green-600` on white / base | 5.4 / 4.9 | 15.2 (as `#94f0c3`) |
| white on `bg-green-500/600` | 4.8 / 5.4 | letters turned `#050507`: 15.0 |
| `text-gray-500` on white / gray-50 / gray-100 | 5.3 / 5.0 / 4.7 | 4.8 on gray-800, 5.2 on gray-900 |
| destructive label on destructive | 5.6 | 9.0 |
| `text-red-400` on base | | 9.1 |
| `text-purple-400` on base | | 9.9 |

Two values were moved off the site for AA: the dark `text-gray-500` slot (site `--soft`
`#72727c`, 4.1 to 4.3:1 on the panels) became `#82828c`; and light mode needed its own cyan
and mint text tones, since the site's are pale. `text-gray-400` stays a decoration and
placeholder tone (2.6:1 on white in light mode, the same as the app's default).

## Signature rules

| rule | hook | option |
|---|---|---|
| 80px grid, faded at top and bottom | `.chat-messages-pane` background | grid: off / faint / **normal** (the site's strength) |
| white halo at the top (cyan tint in light), narrower on phones | same | halo |
| glowing status dots, dark only | `.rounded-full.h-2.w-2` etc. with a green or blue fill | halo |
| pill tab tracks | `[role="tablist"].rounded-lg` and its `[role="tab"]` (the PillBar) | pillTabs |
| deep float shadow | `.shadow-lg/-xl/-2xl` | always |
| dark letters on pale cyan and mint, dark | `.bg-blue-*`/`.bg-green-*` with `.text-white` | always |

The fade is painted in `hsl(var(--background))` above the grid rather than masked, because
the pane is the scroll container and a mask would fade the messages too.

## Verification

- Default skin: built CSS with every `[data-skin…]` rule stripped, against a build of `main`
  stripped the same way, through `scripts/check-theme-equivalence.mjs`: `EQUIVALENT`.
- `src/shared/tests/skin.test.tsx`, `skinOptions.test.tsx` and the settings tests green.
- Screenshots of chat, sidebar and Settings › Appearance at 390px and 1440px in both modes,
  on a throwaway server with a copy of the database.

## Not done / left as the host had it

The particle canvas (animated; not worth the battery on a phone), hover lifts on cards (the
skin changes no layout or motion), the site's glass gradient on individual cards, and the
amber/yellow families (the site has no warning colour; the host's stay). Syntax highlighting
and the code editor theme are not themeable yet (`docs/fork/THEMING.md`).
