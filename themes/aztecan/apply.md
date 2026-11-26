# Applying Aztecan to a UI you have not seen before

The general procedure is the one in [`../otsr/apply.md`](../otsr/apply.md): decide the shape
of the change (token override first), inventory the target's roles, map the values, run a
contrast pass, add a few signature rules on stable hooks, verify. This file lists only what is
different for Aztecan. The worked example is [`examples/cloudcli.md`](examples/cloudcli.md).

## Role mapping

| the app has | it means | Aztecan role |
|---|---|---|
| page background | surface | `surface.base` |
| card / panel | raised surface | `surface.raised` (the glass fill, flattened) |
| popover / menu | overlay | `surface.overlay` |
| input / secondary / muted background | sunken surface | `surface.sunken` |
| hover / accent background | hover | `surface.hover` |
| foreground | body ink | `ink.text` |
| muted text | secondary ink | `ink.muted`; `ink.softText` for small meta text |
| border / divider | hairline | `line.default`; inputs take `line.bright` |
| primary button | the action | `primary.fill` / `primary.onFill` (white pill in dark, not cyan) |
| brand / link / focus / selected (usually blue) | the signal | `signal.cyan`, `signal.cyanText` where it carries text |
| success / green | ok | `status.ok` |
| destructive | danger | `status.danger` |
| a third category colour (purple) | | `signal.violet` in dark |
| warning / amber | (not in the design) | leave the host's |
| shadows on floating layers | elevation | `shadow.float` |
| radius tokens | shape | 8px panels, 12px cards, 18 to 22px floating, pills for tab tracks |
| font families | type | `type.sans` (load Inter if the target loads web fonts), `type.mono`; serif to sans |

## Contrast notes

- **Dark cyan and mint are pale.** White letters on `#76d8ff` are 1.6:1. Keep the fill and
  put `signal.onCyan` (`#050507`) on it, which is what the site does with its own light pill.
- **Light mode cyan is a different tone.** `#76d8ff` on white is 1.7:1; anything that carries
  or sits under text uses `signal.cyanText` (`#0a6f9c`, 5.6:1). Keep `#76d8ff` for marks only.
- **`ink.soft` is for labels.** `#72727c` is 4.3:1 on the base; where the host uses it for
  sentences on raised panels, use `ink.softText`.

## Signature rules

1. **The scene behind everything**: the gradient, halo, glows and the 80px grid (with a fade
   to the page colour above it instead of a mask, because a mask would fade the content
   too) on the page itself, and the starfield on fixed layers behind the app. Then make the
   app's root container transparent. On a phone, shrink the halo from 27rem to about 16rem.
2. **Starfield in CSS**: tiled `radial-gradient` dots in two or three layers with different
   tile sizes, moved only by `transform` and `opacity` animations; stop the drift on phones
   and under `prefers-reduced-motion`. Do not port the canvas.
3. **Glass on the large containers** (side panel, top bar, composer, dialogs, menus): a
   translucent fill, `backdrop-filter`, a top sheen and a lit edge. Cards and messages inside
   get translucency without blur; make them opaque enough that muted text passes over a
   star's core.
4. **Pill tab tracks**: a segmented tab strip drawn as a rounded track becomes a 999px pill,
   as the site's navigation. Underline-style tabs stay.
5. **Glowing status dots** in dark mode only.
6. **Deep shadow** on floating layers.
Blur is expensive on phones when the field behind it moves: keep it to a handful of large
containers, never on every row or message.
