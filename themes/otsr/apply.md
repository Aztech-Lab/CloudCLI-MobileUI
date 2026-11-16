# Applying OTSR to a UI you have not seen before

A procedure for an agent (or a person) handed a codebase and the instruction "make it look
like OTSR". It assumes you have read `README.md`. Budget: a few hours for a medium app, most
of it in steps 2 and 5. The worked example is `examples/cloudcli.md`.

## 0. Decide the shape of the change

Prefer, in this order:

1. **Token override.** The app already reads its colours, radii and fonts from variables
   (CSS custom properties, a Tailwind config, a theme object). Then the theme is one file
   that sets those variables, keyed on a selector or a flag, and no component changes.
2. **Introduce the variables, then override.** The app hard-codes values. First route them
   through variables whose defaults are the current values (verify zero visual change), then
   do 1. This is more work once and makes every later theme cheap.
3. **Edit components.** Only for the handful of *signature* rules that are not values:
   chamfers, square marks, mono labels, the dot field. Attach them to stable hooks (roles,
   data attributes, existing semantic class names), not to utility classes that will churn.

Never fork the component tree into "OTSR versions". The theme must survive the app's next
release.

## 1. Inventory the target's roles

List what the app's existing variables or classes *mean*, not what they are called. For each,
note the mode (light/dark) and whether it carries text. Typical findings:

| the app has | it means | OTSR role |
|---|---|---|
| page background | surface | `surface.base` |
| card / panel / popover background | raised surface | `surface.raised` |
| input / secondary / muted background | sunken surface | `surface.sunken` |
| foreground / text | body ink | `ink.text` |
| muted / secondary text | secondary ink | `ink.mutedText` (if paragraphs) or `ink.muted` (labels) |
| border / divider / input border | hairline | `line.default` |
| primary / brand / accent (usually blue) | the signal | `signal.copper` (fill) or `signal.copperText` (see step 3) |
| primary-foreground | text on the signal | `signal.onCopper` |
| success / green | ok | `status.ok` or `status.okFill` |
| destructive / error / red | danger | `status.danger` |
| warning / amber, info / sky | (do not exist) | copper, muted ink |
| ring / focus | focus | `signal.copper` |
| shadows | elevation | none, plus `line.default` edge; keep one for modals |
| radius tokens | shape | `0`–`2px` |
| font families | type | `type.sans`, `type.mono`; serif → sans |

Also inventory the **palette-class leak**: utility classes like `text-blue-600` or
`bg-gray-800` used directly in components. Count them per family. Those families must be
remapped at the palette level (step 2), because you will not edit hundreds of components.

## 2. Map the values

Write the mapping as a table in your `examples/<target>.md` *before* writing CSS. Then:

- **Surfaces and ink** map one to one from `color.surface` / `color.ink` / `color.line`.
- **The accent family** (whatever blue the app uses) becomes a copper scale. Build it from
  `signal.copper` at the "500" slot, `copperBright` above it, `copperText`/`copperDeep`
  below it, and tints of copper-soft at the pale end. Which slot gets the fill tone and
  which the text tone depends on step 3.
- **The grey family** becomes OTSR's warm neutrals: `ink.strong/text/muted/faint`,
  `line.default`, `surface.sunken/raised/base`, in order of darkness; interpolate the rest.
- **Green/emerald → `status.ok`, red/rose → `status.danger`.** Leave other families alone
  unless the app uses them as accents.
- **Alpha.** Where the app composes colours with opacity (`bg-x/10`), keep its channels
  format; where it cannot, flatten `copperSoft` over the base surface and ship the solid.
- **Shape**: every radius token to `0.125rem` or `0`; leave `rounded-full` alone.
- **Type**: sans and mono stacks verbatim; serif to the sans stack; no web font loading.

## 3. The contrast pass (do not skip)

Designs are drawn in fill tones; UIs put text on them. For each colour slot you remapped,
find how components use it: as text, as a fill under white text, as a fill under dark text,
as a border. Then check the real pairs against the surfaces they sit on, light and dark,
at WCAG thresholds (4.5:1 text, 3:1 large text and UI edges). The quickest way is a script
that resolves the mapped variables and computes the ratio for the pairs you found in the
inventory; one run per mode.

Expect these, every time:

- The slot used as *text* in light mode needs `copperText`, not `copper`.
- A slot that components put *white text* on in dark mode needs `copperDeep`; the pale
  dark copper must go to the slots used as text or as accent strokes.
- Secondary text in light mode needs `mutedText`.
- Dark-mode `status.ok` under white text needs `okFill`.

Record each adjustment and its ratio in the example file.

## 4. Signature rules (the few component edits)

Add, in this order of value, each on a stable hook and each independently switchable:

1. **Mono micro-labels** on tabs, section heads, status words (`type.micro`).
2. **Chamfers** on the primary button, the main input, the user's own message, the tab
   strip. `clip-path` from `shape.chamfer`; small (8px) on short elements, large (14px) on
   tall ones. Not on anything that owns a portal, popover or scroll area.
3. **Square status marks**: 6px squares where the app uses small dots.
4. **Dot field** behind the main content area, at the *faint* strength by default.
5. **Hairline instead of shadow** on panels; keep the modal's shadow.

If the host has a settings surface, expose 2–4 as options (strength / on-off); people differ
on texture more than on colour.

## 5. Verify

- **Unthemed look unchanged**: build with and without the theme selected and compare the
  default output (declaration-level diff of the built CSS, or screenshots). Zero diff.
- **Contrast**: re-run the step-3 script on the final values; all listed pairs pass.
- **Both modes**: light and dark, every main screen. Look for pure white or pure black
  that slipped through (inputs, scrollbars, selection), rounded corners that survived,
  blue that survived (icons, links, focus rings, the browser theme-colour, the terminal's
  ANSI blue).
- **Overflow**: open every menu and tooltip near a chamfered element.
- **Record** the mapping, the adjustments and the checks in `examples/<target>.md`.

## What not to do

- Do not restyle components one by one to "look more OTSR". If the tokens and the five
  signature rules do not get you there, the host is not token-ready; fix that first.
- Do not add colours. If something needs a hue the theme lacks (warning, info, a second
  brand), it becomes copper or muted ink.
- Do not add fonts, gradients, glows, lifts or animations. Restraint is the theme.
