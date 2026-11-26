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

1. **Grid and halo** behind the main content area: two 1px linear gradients at 80px, with a
   fade to the page colour above them (top 0 to 18%, bottom 68 to 100%) instead of a mask,
   because a mask would fade the content too. On a phone, shrink the halo from 27rem to about
   16rem, or it covers the whole screen.
2. **Pill tab tracks**: a segmented tab strip drawn as a rounded track becomes a 999px pill,
   as the site's navigation. Underline-style tabs stay.
3. **Glowing status dots** in dark mode only.
4. **Deep shadow** on floating layers.
5. **Glass bars**: wherever the host already has a translucent bar, give it the site's blur
   and saturation (24px, 140%); do not add glass to panels that are opaque in the host.

Leave out the particle canvas: it is animated, costs battery on phones and competes with text.
