# Aztecan: the look, and why

Aztecan is the look of the Aztech Labs website, [aztecan.net](https://aztecan.net/)
(`styles.bundle.css`, which bundles the shared `design.css` with the site's own `styles.css`).
It is meant to feel like a **night-time product page for a research lab**: deep near-black,
light coming from above, content on glass, one cool signal colour. It is polished rather than
plain; where OTSR removes everything, Aztecan keeps a little atmosphere.

Read this file first; `theme.json` has the values, `apply.md` the procedure.

## In one paragraph

Near-black (`#030305`, a hair of blue in it) with a soft **white halo** at the top of the
page, a **field of slowly drifting white particles** like stars, and a **fine 80px grid**
that fades out towards the top and the bottom. Everything else **floats** over that scene. Text is
`#f5f5f7`, secondary text zinc `#a1a1aa`. Panels are **glass**: a translucent dark fill
(`rgba(18,18,22,.72)`) behind a 1px white-at-11% hairline, with backdrop blur. The primary
action is a **white pill** with near-black letters; everything else that points somewhere is
**cyan** `#76d8ff` (focus rings, links, meta labels), with **mint** `#94f0c3` for "ok" and
**violet** `#b9a8ff` as a rare third accent. Type is **Inter**, heavy for headings (740 to
760) and quiet for everything else. Containers have 8px corners, controls are pills.

## The rules

1. **Light comes from above.** One radial white halo at the top of the stage, and deep
   shadows under floating things. No light from the sides, no coloured gradients over content.
2. **Glass over the scene, without edges.** A panel is frosted glass like the header's
   view switcher: a translucent neutral fill over a hard blur (32px) with saturation, and a
   soft drop shadow so it floats. No border, no rim, no inner highlight: depth comes from
   blur, fill and shadow only. It is never a
   solid block: the stars and glows must be felt through it. Light mode is the same idea in
   white glass (Apple-style), not flat white.
3. **The stars are part of the page.** Take away the particle field and the design collapses
   into "a dark theme". A dense, slow sky (a star every 60px or so, a few bright ones with a
   glow, each twinkling on its own) and soft nebula clouds, which are also what make the
   glass read as glass: frosting needs something behind it to frost.
4. **Cyan points, white acts.** The primary action is white (dark mode) or near-black (light
   mode), not cyan. Cyan marks what is focused, linked, selected or live. Mint is only for
   *ok/running*; violet only for a third category. Red exists only as error text and fills.
5. **Neutrals are cool zinc.** `#a1a1aa`, `#72727c`, `#f5f5f7`: no warm greys.
6. **Soft containers, pill controls.** 8px panels, 10 to 12px cards, 18 to 22px floating
   cards and dialogs. Buttons, navigation tracks and their items, chips: fully rounded.
   Icon badges sit in a ringed circle.
7. **The grid is felt, not seen.** 1px lines at 2.5 to 3.5% white, 80px apart, masked off at
   the edges. Never a dense grid, never behind body text at full strength.
8. **Glow belongs to the dark.** Status dots and the primary pill glow in their own colour in
   dark mode. In light mode a glow is a smudge, so it is dropped.
9. **Motion eases out.** 160ms for colour; 520ms `cubic-bezier(0.22, 1, 0.36, 1)` for rises
   and lifts; hover lifts cards by 2 to 8px.

## What it is not

- Not "dark mode with blue": cyan is a signal, not a surface. Large cyan fills are wrong.
- Not neon or cyberpunk: the glows are wide and faint (12 to 16% white), the accents pastel.
- Not flat: removing the stars, the halo, the glass and the deep shadow loses most of the
  character. (The first application here did exactly that and was rejected as "flat black".)

## Evaluation scorecard

Targets: body text WCAG 2 ≥ 7:1 (AAA) and APCA |Lc| ≥ 75; secondary text ≥ 4.5:1 and
|Lc| ≥ 60; placeholders and fine print ≥ 4.5:1 and |Lc| ≥ 45; control edges (inputs,
toggles, the composer, the focus ring) ≥ 3:1. Each row is the **worst case** over the
surfaces that text actually sits on, measured over the starfield and the glass, not over a
flat background. *Before* is the second version of the skin (stars and glass, first
contrast pass); *after* is this one.

How it was measured:

- **Glass and tiles**: the composite of the backdrop at its brightest point under a panel
  (the top halo, or the centre of a nebula blob), the blur (which spreads a star over a
  32px disc, so it adds about 2%), the `brightness()` dim, the white tint and the sheen
  at the panel's top edge.
- **Text on the sky** (timestamps, tool rows): real pixels. A test line is rendered over a
  carpet of the brightest star tier (a core every 5px), the letters are masked, and the
  background is read in the ring 1 CSS px around every glyph. *Before*: the star core
  itself.
- **APCA**: APCA-W3 0.0.98G.

| role | mode | before: colour, worst ratio, worst Lc | after: colour, worst ratio, worst Lc |
|---|---|---|---|
| body | dark | `#f5f5f7` 1.31:1, Lc 17 (on a star) | `#ebebef` **13.6:1, Lc 93** (glass); on the sky 16.8:1, Lc 95 |
| body | light | `#0b0b0f` 8.53:1, Lc 58 (on a star) | `#0b0b0f` **16.9:1, Lc 96**; on the sky 18.1:1, Lc 100 |
| secondary | dark | `#a1a1aa` 1.80:1, Lc 27 | `#c6c6ce` **9.49:1, Lc 70** (glass); on the sky 11.8:1, Lc 72 |
| secondary | light | `#5f5f69` 2.74:1, Lc 34 | `#4f4f58` **6.97:1, Lc 78**; on the sky 7.3:1, Lc 82 |
| fine print (gray-500) | dark | `#82828c` 2.67:1, Lc 29 | `#b4b4be` **7.83:1, Lc 60** (glass); on the sky 9.7:1, Lc 62 |
| fine print (gray-500) | light | `#6b6b74` 2.29:1, Lc 29 | `#5c5c66` **5.68:1, Lc 73**; on the sky 6.1:1, Lc 77 |
| placeholder | dark | `#a1a1aa` 5.51:1, Lc 48 | `#b4b4be` **7.83:1, Lc 60** |
| placeholder (gray-400) | light | `#a1a1aa` 2.41:1, Lc 46 | `#6a6a74` **4.62:1, Lc 67** |
| focus ring (2px, on focus) | dark / light | 11.1:1 / 5.24:1 | **10.0:1 / 4.85:1** |

The glass rows are for the borderless glass (Update 3: the header pill bar's fill, #131316 at 50% in dark and #f6f6f9 at 60% in light, over `blur(32px) saturate(180%)`, dimmed to `brightness(.8)` in dark), at the centre of the brightest nebula blob.

### Controls without borders (WCAG 1.4.11)

The glass has no edges, and neither do the controls on it. Each control is identified by something other than a border line, and focus always shows a 2px ring in `--ring`:

| control | identified by | contrast, dark / light | verdict |
|---|---|---|---|
| toggle, off | its thumb against its track (the track is a filled pill, white 20% / ink 16%) | thumb vs track **5.2:1 / 4.4:1**; track vs glass 1.9:1 / 1.4:1 | passes on the thumb, which carries the state |
| toggle, on | thumb position, and the track filled with the primary colour | track vs glass **13:1 / 17:1** | passes |
| text fields (`border-input`) | a light fill (white 10% / ink 6%), the placeholder and the label | fill vs glass 1.35:1 / 1.13:1; placeholder **7.8:1 / 4.6:1** | **relies on fill and text**: the field's own edge is below 3:1 |
| composer | its glass panel, the placeholder, the send and attach buttons | panel vs the sky around it 1.2–1.4:1 / 1.07:1; placeholder as above | **relies on fill and text**, like the fields |
| focus (fields, composer, toggles) | a 2px ring in `--ring` | **10.0:1 / 4.85:1** | passes |

Honest summary: the text fields and the composer no longer have a 3:1 boundary at rest.
They are found by their fill, their placeholder and their label, which is what the
borderless look asks for. Toggles and the focus state pass 3:1.

What changed to get there:

- **Text on the sky gets a 2px outline in the page colour**, painted under the letters
  (`-webkit-text-stroke` with `paint-order: stroke fill`), so no star or nebula can sit
  right against a glyph. A `text-shadow` halo was tried first; the pixel test showed it
  barely changed anything.
- **Glass dims what it blurs**: `brightness(.55)` in the backdrop filter, then the white
  tint on top, so the bright nebula behind a panel cannot wash out its muted text.
- **Secondary and fine-print greys raised.** Control edges were raised to 3:1 in the
  third version and removed again in the fourth (borderless glass); see the controls table.

### Visual comfort

- **Halation**: no pure white text in dark mode. Body is `#ebebef`; `text-white`,
  `gray-50` and `gray-100` are capped at `#f0f0f3`/`#ebebef`; stars are blue-white
  `#dfe6f2`, not `#fff`.
- **No pure black or white fields**: the dark base is `#08080b` (was `#030305`) under a
  gradient, nebula and stars. Light-mode panels are 60–72% white glass over a tinted
  gradient, never an opaque white sheet.
- **Background busyness**: the standard deviation of relative luminance behind text, with
  the letters hidden, at 1440px. The glass keeps it at or below 0.65%.

  | region | dark: mean / sd | light: mean / sd |
  |---|---|---|
  | open sky, for reference | 1.07% / 0.68 (star peaks 44%) | 84.2% / 3.29 |
  | sidebar glass | 1.11% / 0.28 | 94.4% / 0.46 |
  | sidebar project tile | 4.09% / 0.15 | 98.7% / 0.37 |
  | header glass (includes the tab pills) | 1.43% / 0.55 | 92.4% / 2.54 |
  | composer text area | 1.57% / 0.64 | 93.4% / 10.2 (its own edge and caret row) |
  | agent bubble (glass tile) | 1.40% / 0.44 | 94.9% / 1.07 |
  | meta row on the sky (with the outline) | 0.52% / 0.65 | 87.4% / 3.05 |

### Motion comfort

- **Twinkle**: each group cycles in 4.5–11s, about 0.1–0.2 Hz, with different speeds and
  phases. On phones it moves in `steps(6)`, about one change a second per group. Nothing
  approaches the 3 Hz flash threshold.
- **Drift**: 44 × 30px over 160s (desktop only).
- **Shooting star**: one streak, about a second long, once every 26–48s. It moves rather
  than flashes. Desktop only.
- **`prefers-reduced-motion`**: everything is static. The *Still* option does the same for
  anyone who picks it.

### Mobile performance

Chrome, emulated 390 × 844 at 3x, CPU throttled 4x, dark mode. Measured with DevTools
Protocol tracing; the frame-time numbers come from the desktop GPU, which the CPU throttle
does not slow down.

| | default skin | Aztecan |
|---|---|---|
| composited layers (LayerTree) | 16 | 29 |
| visible elements with `backdrop-filter` | 3 | 7 (header, composer, two bubbles, a card, the sidebar when open, the drawer scrim) |
| main-thread frames ≥ 33ms in 5s of scrolling | 0 | 0 (rAF p95 6.2ms) |
| compositor draw cost while scrolling, p50 / p95 | 0.26 / 0.38 ms | 0.63 / 0.87 ms |
| compositor redraws while idle (5s) | 4 | about 80 (stepped twinkle only) |

- Turning the blur off on the bubbles saves about 0.08ms per frame, so the bubbles keep it.
- On phones the drift and the shooting star are off. A running animation, even an
  invisible one, keeps the compositor redrawing, and every redraw re-blurs the glass.
- Not measured: a real phone's GPU, where blur costs more. Check it on a device before
  relying on these numbers.

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
Fonts. No logo or image is part of this package; the particle field is described by its
parameters and redrawn, not copied.
