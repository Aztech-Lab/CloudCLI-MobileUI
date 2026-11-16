# OTSR — the look, and why

OTSR is the interface of a GPU image-upscaling tool and of its technical report
([source](https://github.com/Aztech-Lab/OTSR), `src/tokens.css`). It is meant to feel like a
**lab instrument**: quiet, exact, nothing decorative, one warm signal colour on a cool
neutral. If an element does not carry information, it is not drawn.

Read this file first; `theme.json` has the values, `apply.md` the procedure.

## In one paragraph

Lab white (`#ebebe8`, not pure white) or near-black (`#0f1112`, not pure black), warm
grey-green neutrals, and **one** accent: copper. Corners are square; a few important edges
are chamfered (top-right and bottom-left corner cut). Type is the system sans, with small
**monospace, uppercase, letter-spaced** labels for everything that names a control or a
state. Status is shown by a 6px **square**, not a dot. Panels are separated by hairlines,
not shadows. The main stage sits on a faint field of dots. No web fonts, no gradients, no
glows.

## The rules

1. **One accent.** Copper is the only colour that means "look here": active tab, focus
   ring, link underline, the running mark, the cursor. Blue does not exist in this design;
   whatever the host UI uses blue for becomes copper. Green is only for *ok*, red only for
   *danger*; there is no separate warning or info colour (warning is copper, info is muted
   ink).
2. **Copper is a fill tone, not a text tone.** The design paints copper on buttons and
   marks and puts text *on* it: white in light mode, **black in dark mode** (dark copper is
   pale). Copper as *letters* on lab white is only 3:1; white letters on light copper are
   3.6:1; white on dark copper is 2.3:1. OTSR itself accepts the first two (its micro-labels,
   chips and active states are copper letters; its primary button is white on copper) and
   avoids the third by putting **black** on dark copper. Follow the source: keep the real
   copper and, in dark mode, swap the letters to black rather than darkening the fill. The
   text-safe tones (`signal.copperText`, `copperDeep`, `ink.mutedText`) exist for a target
   that must meet WCAG AA; using them costs some of the OTSR character, so say so when you do.
3. **Warm neutrals, never pure.** Every grey has a little green-yellow in it (`#6f726a`,
   `#c7c8c0`). Pure `#000`/`#fff`/`#808080` look wrong next to them. Secondary text uses
   `ink.muted` for short labels and `ink.mutedText` where a paragraph has to be read.
4. **Square.** Radius 0; up to 2px where 0 breaks (focus rings, thumbnails). Circles are
   kept only for things that are circular by nature: avatars, spinners.
5. **Chamfer a few, not all.** The cut corner marks the elements that matter most: the
   primary button, the main input, the user's own turn, the tab strip. On everything it
   becomes wallpaper. Chamfers are `clip-path`s, so never put one on a container whose
   children overflow it (menus, tooltips, scroll areas).
6. **Hairline over shadow.** Elevation is a 1px `line.default` edge. The one shadow in the
   design belongs to the floating stage/dialog. Hover is a copper-soft fill or a copper
   border, never a lift.
7. **Micro-labels.** Anything that names a control, a mode, a key or a state is set in mono,
   10 to 10.5px, uppercase, `0.12em` tracking. Body text stays sans, 13px/1.5. This contrast
   of voices (sans says, mono labels) is most of the character; do not apply mono to body.
8. **Texture, not decoration.** The dot field (22px grid) is the only ornament, and it is
   quiet: at the source strength it reads as graph paper; on a text-heavy screen use the
   *faint* value so it is felt, not seen. Dark mode may add a vignette; light mode does not.
9. **Everything clickable has an edge, a fill on hover, or both.** Buttons are outlined in
   ink (not grey) or filled with `surface.inverse`; the primary one is filled with copper.
   Disabled is 35% opacity, not a different colour.
10. **Motion is stepped and short.** 150ms colour transitions; a running mark *blinks*
    (`steps(2)`), it does not pulse or glow.

## What it is not

- Not a "dark theme with orange": the light mode is the first mode; dark is its inversion
  with copper lightened, not just the surfaces swapped.
- Not brutalist: it is square and plain, but it is tidy. Alignment, consistent 44px control
  heights and hairlines matter more than the chamfers.
- Not retro-terminal: mono is for labels only, and there is no scanline, glow or CRT effect.

## Where the values come from

`theme.json` is the source `tokens.css` of OTSR 0.1.4 with three additions, each marked
with a role note: the text-safe tones (`copperText`, `copperDeep`, `mutedText`, `okFill`),
the faint and strong dot strengths, and the terminal slots. Source values are kept
unchanged; corrections are new roles, so a future OTSR release can be diffed in.
