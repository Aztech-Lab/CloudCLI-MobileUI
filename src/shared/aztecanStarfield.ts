/**
 * [local] The Aztecan skin's starfield (src/skins/aztecan.css, themes/aztecan).
 *
 * aztecan.net draws its stars on a <canvas> every frame. Here they are generated
 * once per page load (and again when the skin or its options change) into a few
 * SVG masks, and only CSS moves them: the drift is a `transform` on one wrapper
 * and each twinkle group is an `opacity` animation, so after this runs there is
 * no script work per frame and no canvas loop. A fresh random seed on every load
 * gives a different sky each time; the generator takes a seeded RNG so it can be
 * tested.
 *
 * Why masks and a handful of elements rather than one element per star: a few
 * hundred stars become six to nine composited layers, each painted once. The
 * star colour comes from CSS (`--aztecan-star-color`) through the mask, so the
 * light/dark switch needs no regeneration.
 */

export type StarTier = 'dust' | 'small' | 'medium' | 'bright';

export type Star = {
  x: number;
  y: number;
  /** Radius of the core, px. */
  r: number;
  /** Core opacity, 0..1. */
  a: number;
  tier: StarTier;
};

export type StarfieldOptions = {
  /** Tile size in px; the layers repeat it, so it should be at least the viewport. */
  width: number;
  height: number;
  /** Mean area per star, px². Lower is denser. */
  areaPerStar: number;
  /** How many independently twinkling groups the brighter stars are split into. */
  twinkleGroups: number;
};

export type TwinkleGroup = {
  stars: Star[];
  /** Animation duration, s. */
  duration: number;
  /** Negative animation delay, s, so the groups start out of phase. */
  delay: number;
};

export type ShootingStar = {
  /** Start position, % of the viewport. */
  x: number;
  y: number;
  /** Direction, degrees (down and to the right or left). */
  angle: number;
  /** Full cycle, s: the streak takes the first ~4% of it, then the sky is still. */
  cycle: number;
  delay: number;
};

export type Starfield = {
  width: number;
  height: number;
  base: Star[];
  groups: TwinkleGroup[];
  shooting: ShootingStar;
};

/** mulberry32: a small, fast, seedable PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: () => number, low: number, high: number) => low + rng() * (high - low);
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/**
 * Tiers, from the site's particles (radius 0.4–2px, white at 0.42 on a canvas at
 * 58%) widened into a sky: most stars are dust, a few are bright with a glow.
 */
const TIERS: { tier: StarTier; share: number; r: [number, number]; a: [number, number] }[] = [
  { tier: 'dust', share: 0.55, r: [0.45, 0.7], a: [0.35, 0.6] },
  { tier: 'small', share: 0.28, r: [0.7, 1], a: [0.55, 0.8] },
  { tier: 'medium', share: 0.12, r: [1, 1.35], a: [0.75, 0.95] },
  { tier: 'bright', share: 0.05, r: [1.3, 1.8], a: [0.95, 1] },
];

function pickTier(rng: () => number) {
  let roll = rng();
  for (const tier of TIERS) {
    if (roll < tier.share) return tier;
    roll -= tier.share;
  }
  return TIERS[0];
}

export function generateStarfield(rng: () => number, options: StarfieldOptions): Starfield {
  const { width, height, areaPerStar } = options;
  const groupCount = Math.max(1, Math.floor(options.twinkleGroups));
  const count = Math.max(1, Math.round((width * height) / areaPerStar));

  const base: Star[] = [];
  const groups: TwinkleGroup[] = Array.from({ length: groupCount }, () => ({
    stars: [],
    // 4.5–11s per cycle: a slow shimmer, far below the 3 Hz flash threshold.
    duration: round(between(rng, 4.5, 11), 1),
    delay: 0,
  }));
  for (const group of groups) group.delay = -round(between(rng, 0, group.duration), 1);

  for (let index = 0; index < count; index += 1) {
    const tier = pickTier(rng);
    const star: Star = {
      x: round(rng() * width, 1),
      y: round(rng() * height, 1),
      r: round(between(rng, tier.r[0], tier.r[1])),
      a: round(between(rng, tier.a[0], tier.a[1])),
      tier: tier.tier,
    };
    // Dust and small stars hold still; a share of the medium ones and every bright
    // star twinkles, each in a randomly chosen group so neighbours fall out of step.
    const twinkles = tier.tier === 'bright' || (tier.tier === 'medium' && rng() < 0.6);
    if (twinkles) {
      groups[Math.floor(rng() * groupCount)].stars.push(star);
    } else {
      base.push(star);
    }
  }

  const shooting: ShootingStar = {
    x: round(between(rng, 5, 70), 1),
    y: round(between(rng, 3, 40), 1),
    angle: round(rng() < 0.5 ? between(rng, 18, 34) : between(rng, 146, 162), 1),
    cycle: round(between(rng, 26, 48), 1),
    delay: round(between(rng, 4, 16), 1),
  };

  return { width, height, base, groups, shooting };
}

/** An SVG of the stars as white shapes, for use as a CSS mask (alpha carries the brightness). */
export function starsToSvg(stars: Star[], width: number, height: number): string {
  const glow = stars.some((star) => star.tier === 'bright');
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  if (glow) {
    parts.push('<defs><radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".35" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>');
  }
  for (const star of stars) {
    if (star.tier === 'bright') {
      parts.push(`<circle cx="${star.x}" cy="${star.y}" r="${round(star.r * 5)}" fill="url(#g)"/>`);
    }
    parts.push(`<circle cx="${star.x}" cy="${star.y}" r="${star.r}" fill="#fff" fill-opacity="${star.a}"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

export function svgToCssUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export const STARFIELD_ELEMENT_ID = 'aztecan-starfield';

/** Phones get a sparser sky and fewer twinkle groups (fewer layers to composite). */
export function starfieldOptionsForViewport(viewportWidth: number, viewportHeight: number): StarfieldOptions {
  const narrow = viewportWidth <= 640;
  return {
    // The layers are inset by 64px on every side so the drift never shows an edge.
    width: Math.max(480, Math.ceil(viewportWidth + 128)),
    height: Math.max(480, Math.ceil(viewportHeight + 128)),
    areaPerStar: narrow ? 4200 : 3400,
    twinkleGroups: narrow ? 3 : 6,
  };
}

function layer(doc: Document, className: string, stars: Star[], field: Starfield): HTMLDivElement {
  const element = doc.createElement('div');
  element.className = className;
  const url = svgToCssUrl(starsToSvg(stars, field.width, field.height));
  element.style.setProperty('-webkit-mask-image', url);
  element.style.setProperty('mask-image', url);
  element.style.setProperty('-webkit-mask-size', `${field.width}px ${field.height}px`);
  element.style.setProperty('mask-size', `${field.width}px ${field.height}px`);
  return element;
}

/**
 * Builds (or rebuilds) the starfield behind the app. All the motion is in
 * aztecan.css; this only writes the elements and their custom properties.
 */
export function mountStarfield(doc: Document, field: Starfield): HTMLElement {
  unmountStarfield(doc);
  const root = doc.createElement('div');
  root.id = STARFIELD_ELEMENT_ID;
  root.setAttribute('aria-hidden', 'true');

  const drift = doc.createElement('div');
  drift.className = 'aztecan-stars-drift';
  drift.appendChild(layer(doc, 'aztecan-stars-layer aztecan-stars-base', field.base, field));
  for (const group of field.groups) {
    if (group.stars.length === 0) continue;
    const element = layer(doc, 'aztecan-stars-layer aztecan-stars-twinkle', group.stars, field);
    element.style.setProperty('--aztecan-twinkle-duration', `${group.duration}s`);
    element.style.setProperty('--aztecan-twinkle-delay', `${group.delay}s`);
    drift.appendChild(element);
  }
  root.appendChild(drift);

  const shooting = doc.createElement('div');
  shooting.className = 'aztecan-shooting-star';
  shooting.style.setProperty('--aztecan-shoot-x', `${field.shooting.x}%`);
  shooting.style.setProperty('--aztecan-shoot-y', `${field.shooting.y}%`);
  shooting.style.setProperty('--aztecan-shoot-angle', `${field.shooting.angle}deg`);
  shooting.style.setProperty('--aztecan-shoot-cycle', `${field.shooting.cycle}s`);
  shooting.style.setProperty('--aztecan-shoot-delay', `${field.shooting.delay}s`);
  root.appendChild(shooting);

  doc.body.insertBefore(root, doc.body.firstChild);
  return root;
}

export function unmountStarfield(doc: Document): void {
  doc.getElementById(STARFIELD_ELEMENT_ID)?.remove();
}

/** A seed for this page load: different on every refresh. */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 4294967296);
}

/** Mounts a new random sky sized for the current viewport. */
export function showStarfield(doc: Document = document, seed: number = randomSeed()): HTMLElement {
  const view = doc.defaultView;
  const options = starfieldOptionsForViewport(view?.innerWidth ?? 1280, view?.innerHeight ?? 800);
  return mountStarfield(doc, generateStarfield(createRng(seed), options));
}
