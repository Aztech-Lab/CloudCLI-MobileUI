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
| `--secondary`, `--muted` | surface.sunken | `#e2e2de` | `#151819` |
| `--foreground` | ink.text | `#24261f` | `#e2e3dc` |
| `--muted-foreground` | ink.muted | `#6f726a` | `#9ba09a` |
| `--border`, `--input` | line.default | `#c7c8c0` | `#2b302f` |
| `--primary`, `--ring` | signal.copper | `#b8793c` | `#d9a25f` |
| `--primary-foreground` | signal.onCopper | white | `#111312` |
| `--accent` | signal.copperSoft, flattened | `#e4dbd0` | `#2f281e` |
| `--destructive` | status.danger | `#b4452f` | `#e8745a` |
| `--nav-*` (glass, glow, rings) | raised surface at 86%, copper at 12–25% | | |
| `--app-theme-color-*` | chrome | `#ebebe8` | `#0f1112` |
| `--terminal-*` | terminal block | as in `theme.json` | |

Palette families (RGB channels), the lever for the hard-coded classes:

| family | became | notes |
|---|---|---|
| `blue-*` | copper scale | light: 400 = copperBright, 500/600 = copper, 700 one step darker, 50–300 tints; dark: 400–600 = copper, 300/700 = copperBright (a hover brightens, as the source) |
| `gray-*` | warm neutrals | 50 raised … 950 near-black; dark mode only remaps 700–950 (surfaces) |
| `green-*`, `emerald-*` | status.ok | light `#4f7a4a`, dark `#8fbf7a` at 400–600 |
| `red-*` | status.danger | 500/600 |
| radii | 0.125rem | every token except `rounded-full` |
| fonts | sans, mono stacks; serif → sans | |

## Contrast pass (step 3): fidelity over AA

A script resolved the mapped tokens and computed WCAG ratios for the real text/background
class pairs in the components. Findings, and what was done:

| pair | ratio | decision |
|---|---|---|
| copper as text on base, light (`text-blue-500/600`, `text-primary`) | 3.0:1 | kept: OTSR sets its labels, chips and active states in copper at exactly this ratio |
| white on copper button, light | 3.6:1 | kept: OTSR's own `.btn.copper` |
| secondary text on raised, light (`text-muted-foreground`) | 4.4:1 | kept at the source `--muted` |
| white on `bg-blue-500/600`, dark | 2.3:1 | **letters turned black** (`#111312`, OTSR's `--on-copper`) by one rule on `.bg-blue-*.text-white`; the copper stays `#d9a25f` |
| white on `bg-green-500`, dark | 2.1:1 | same rule; green stays `#8fbf7a` |

A first version darkened the copper and the muted text to reach 4.5:1 everywhere
(`#945e2b`, `#62635a`, `#8a5a2b` under white). It passed the numbers and lost the look: the
copper read as brown. The text-safe tones remain in `theme.json` for a target that needs AA.

## Signature rules (step 4)

All on stable hooks, all options in Settings › Appearance › Skin:

| rule | hook | option |
|---|---|---|
| mono micro-labels | `[role="tablist"] [role="tab"]` | monoLabels |
| chamfers | tab strip, `form[data-slot="prompt-input"]`, the user bubble | chamfers |
| square marks | `.rounded-full.h-2.w-2` and the 1.5/2.5 sizes | squareMarks |
| dot field | `.chat-messages-pane`, 22px grid | dotField: off / **faint** / normal / strong |
| elevation | `.shadow-sm/-md` → none; `.shadow-lg/-xl` → OTSR's one soft shadow | always |
| black on copper, dark | `.bg-blue-*`/`.bg-green-*` with `.text-white` → `#111312` | always |

Chamfers were kept off containers that own portals or scroll areas: an early attempt on the
whole composer clipped its attachment menu.

The dot field defaults to *faint* (a wider, softer radial at lower alpha) rather than the
source strength: behind a transcript the source value read as a grid and competed with
the text. The source strength is the *normal* option.

## Verification (step 5)

- Default skin: declaration-level diff of built CSS with the skin rules stripped vs. a build
  of `main` → `EQUIVALENT` (one tolerated 8-bit alpha rounding).
- Contrast script re-run on final values → every pair at or above the ratio OTSR itself uses; no white on pale copper or green.
- Front-end tests green; `src/shared/tests/skin.test.tsx`, `skinOptions.test.tsx`.
- Checked in both modes on desktop and iPhone PWA: no residual blue (meta theme-colour,
  terminal ANSI blue and cursor covered by tokens), menus open cleanly next to chamfers.

## Not done / left as the host had it

Syntax highlighting (Prism), the CodeMirror editor theme, the mobile terminal selection
handle, git-graph lane colours, brand logos, box-shadow and tap-highlight colours. Listed
under "Not themeable yet" in `docs/fork/THEMING.md`.
