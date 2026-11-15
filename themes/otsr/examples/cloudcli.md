# Application record: OTSR on CloudCLI-MobileUI

The first application of the OTSR package, as the `otsr` skin of this repository. The
output is `src/skins/otsr.css` (about 200 lines); the mechanism it plugs into is described
in `docs/fork/THEMING.md`. This file records the decisions so the next target can copy
the reasoning, not just the CSS.

## Shape of the change (apply.md step 0)

Option 2 then 1. The app hard-coded Tailwind palette classes in ~2,500 places, so the
palette, radii and fonts were first routed through CSS variables whose defaults equal
Tailwind's (`tailwind.tokens.js`), with a build-output checker proving zero visual change
(`scripts/check-theme-equivalence.mjs`). The skin is then one stylesheet keyed on
`html[data-skin="otsr"]`, with the app's own `.dark` class for dark mode. Signature rules
are gated by per-skin options (`data-skin-<option>` attributes) so each can be turned off.

## Role mapping (step 1–2)

Semantic tokens (HSL channels, as the app expects):

| app token | OTSR role | light | dark |
|---|---|---|---|
| `--background` | surface.base | `#ebebe8` | `#0f1112` |
| `--card`, `--popover` | surface.raised | `#f4f4f1` | `#161919` |
| `--secondary`, `--muted` | surface.sunken | `#e3e3de` | `#212726` |
| `--foreground` | ink.text | `#24261f` | `#e2e3dc` |
| `--muted-foreground` | ink.mutedText | `#62635a` (pulled, see below) | `#9ba09a` |
| `--border`, `--input` | line.default | `#c7c8c0` | `#2b302f` (inputs `#343d3b`) |
| `--primary`, `--ring` | signal.copperText (light) / signal.copper (dark) | `#945e2b` | `#d9a25f` |
| `--primary-foreground` | signal.onCopper | white | `#111312` |
| `--accent` | signal.copperSoft, flattened | `#e2d9ca` | `#372f25` |
| `--destructive` | status.danger | `#b4452f` | `#e8745a` |
| `--nav-*` (glass, glow, rings) | raised surface at 86%, copper at 12–25% | | |
| `--app-theme-color-*` | chrome | `#ebebe8` | `#0f1112` |
| `--terminal-*` | terminal block | as in `theme.json` | |

Palette families (RGB channels), the lever for the hard-coded classes:

| family | became | notes |
|---|---|---|
| `blue-*` | copper scale | light: 500 = copperText, 600/700 darker, 50–400 tints; dark: 300/400 = copperBright/copper (text and strokes), **500/600 = copperDeep** (white-text fills) |
| `gray-*` | warm neutrals | 50 raised … 950 near-black; dark mode only remaps 700–950 (surfaces) |
| `green-*`, `emerald-*` | status.ok | 500/600 = **okFill** in both modes (components put white text on them) |
| `red-*` | status.danger | 500/600 |
| radii | 0.125rem | every token except `rounded-full` |
| fonts | sans, mono stacks; serif → sans | |

## Contrast adjustments (step 3)

Found by a script that resolved the mapped tokens and computed WCAG ratios for the real
text/background class pairs in the components (light and dark separately):

| pair | with source value | fix | result |
|---|---|---|---|
| copper as text on base, light (`text-blue-500`, `text-primary`) | 3.0:1 | `--primary`, `blue-500` → copperText `#945e2b` | 4.5:1 |
| white on primary button, light | 3.6:1 | same | 5.4:1 |
| secondary text on raised, light (`text-muted-foreground`) | 3.6–4.4:1 | `--muted-foreground` → `#62635a` | 5.5:1 |
| white on `bg-blue-500/600`, dark | 2.3:1 | `blue-500/600` → copperDeep `#8a5a2b` (500), darker (600) | 5:1 |
| white on `bg-green-500`, dark | 2.1:1 | `green/emerald-500` → okFill `#4f7a4a` | 5:1 |

The source design never has these problems because it puts black on dark copper and does
not use copper as letters; a Tailwind app does both through `text-blue-*` / `bg-blue-*`.

## Signature rules (step 4)

All on stable hooks, all options in Settings › Appearance › Skin:

| rule | hook | option |
|---|---|---|
| mono micro-labels | `[role="tablist"] [role="tab"]` | monoLabels |
| chamfers | tab strip, `form[data-slot="prompt-input"]`, the user bubble | chamfers |
| square marks | `.rounded-full.h-2.w-2` and the 1.5/2.5 sizes | squareMarks |
| dot field | `.chat-messages-pane`, 22px grid | dotField: off / **faint** / normal / strong |
| hairline over shadow | `.shadow-sm … .shadow-xl` → none | always |

Chamfers were kept off containers that own portals or scroll areas: an early attempt on the
whole composer clipped its attachment menu.

The dot field defaults to *faint* (a wider, softer radial at lower alpha) rather than the
source strength: behind a transcript the source value read as a grid and competed with
the text. The source strength is the *normal* option.

## Verification (step 5)

- Default skin: declaration-level diff of built CSS with the skin rules stripped vs. a build
  of `main` → `EQUIVALENT` (one tolerated 8-bit alpha rounding).
- Contrast script re-run on final values → all pairs ≥ 4.5:1 (text) / 3:1 (UI).
- Front-end tests green; `src/shared/tests/skin.test.tsx`, `skinOptions.test.tsx`.
- Checked in both modes on desktop and iPhone PWA: no residual blue (meta theme-colour,
  terminal ANSI blue and cursor covered by tokens), menus open cleanly next to chamfers.

## Not done / left as the host had it

Syntax highlighting (Prism), the CodeMirror editor theme, the mobile terminal selection
handle, git-graph lane colours, brand logos, box-shadow and tap-highlight colours. Listed
under "Not themeable yet" in `docs/fork/THEMING.md`.
