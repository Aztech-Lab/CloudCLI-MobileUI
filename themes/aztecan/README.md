# Aztecan: the look, and why

Aztecan is the look of the Aztech Labs website, [aztecan.net](https://aztecan.net/)
(`styles.bundle.css`, which bundles the shared `design.css` with the site's own `styles.css`).
It is meant to feel like a **night-time product page for a research lab**: deep near-black,
light coming from above, content on glass, one cool signal colour. It is polished rather than
plain; where OTSR removes everything, Aztecan keeps a little atmosphere.

Read this file first; `theme.json` has the values, `apply.md` the procedure.

## In one paragraph

Near-black (`#030305`, a hair of blue in it) with a soft **white halo** at the top of the
page and a **fine 80px grid** that fades out towards the top and the bottom. Text is
`#f5f5f7`, secondary text zinc `#a1a1aa`. Panels are **glass**: a translucent dark fill
(`rgba(18,18,22,.72)`) behind a 1px white-at-11% hairline, with backdrop blur. The primary
action is a **white pill** with near-black letters; everything else that points somewhere is
**cyan** `#76d8ff` (focus rings, links, meta labels), with **mint** `#94f0c3` for "ok" and
**violet** `#b9a8ff` as a rare third accent. Type is **Inter**, heavy for headings (740 to
760) and quiet for everything else. Containers have 8px corners, controls are pills.

## The rules

1. **Light comes from above.** One radial white halo at the top of the stage, and deep
   shadows under floating things. No light from the sides, no coloured gradients over content.
2. **Glass over hairline.** A panel is a translucent fill plus a 1px light edge; it is never
   a solid grey block with a dark border. Elevation is blur and a deep, soft shadow.
3. **Cyan points, white acts.** The primary action is white (dark mode) or near-black (light
   mode), not cyan. Cyan marks what is focused, linked, selected or live. Mint is only for
   *ok/running*; violet only for a third category. Red exists only as error text and fills.
4. **Neutrals are cool zinc.** `#a1a1aa`, `#72727c`, `#f5f5f7`: no warm greys.
5. **Soft containers, pill controls.** 8px panels, 10 to 12px cards, 18 to 22px floating
   cards and dialogs. Buttons, navigation tracks and their items, chips: fully rounded.
   Icon badges sit in a ringed circle.
6. **The grid is felt, not seen.** 1px lines at 2.5 to 3.5% white, 80px apart, masked off at
   the edges. Never a dense grid, never behind body text at full strength.
7. **Glow belongs to the dark.** Status dots and the primary pill glow in their own colour in
   dark mode. In light mode a glow is a smudge, so it is dropped.
8. **Motion eases out.** 160ms for colour; 520ms `cubic-bezier(0.22, 1, 0.36, 1)` for rises
   and lifts; hover lifts cards by 2 to 8px.

## What it is not

- Not "dark mode with blue": cyan is a signal, not a surface. Large cyan fills are wrong.
- Not neon or cyberpunk: the glows are wide and faint (12 to 16% white), the accents pastel.
- Not flat: removing the halo, the glass and the deep shadow loses most of the character.

## Where the values come from

`theme.json` lists each value with the selector or variable it was read from, from the site's
CSS as served on 2026-11-25. The site is **dark only**. Its shared design system says the sister
team portal is white and reuses these values for its dark mode, but that portal is not
public, so the **light mode is derived** here: the dark mode's ink becomes the light base, the
site's silver `--accent` (`#e8edf7`) becomes the hover tint, the primary pill is inverted to
near-black, and cyan and mint are pulled down to text-safe depths. Each derived value says so
in its role note.

Fonts: the site names Inter first but does not load it (no `@font-face`), so the face a visitor
sees is usually their system UI font. Inter is under the SIL Open Font License and is on Google
Fonts. No logo, image or particle animation is part of this package.
