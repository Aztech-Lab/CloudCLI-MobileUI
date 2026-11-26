import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRng,
  generateStarfield,
  mountStarfield,
  showStarfield,
  starfieldOptionsForViewport,
  starsToSvg,
  STARFIELD_ELEMENT_ID,
  unmountStarfield,
} from '@/shared/aztecanStarfield';
import { SkinProvider, useSkin } from '@/shared/context/SkinContext';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] The Aztecan starfield generator: seeded, so the same seed draws the same
 * sky and different seeds draw different ones; the counts, tiers and twinkle
 * timings stay inside the ranges the skin's contrast and motion budget assume.
 */

const desktop = starfieldOptionsForViewport(1440, 900);
const phone = starfieldOptionsForViewport(390, 844);

const allStars = (field: ReturnType<typeof generateStarfield>) => [
  ...field.base,
  ...field.groups.flatMap((group) => group.stars),
];

afterEach(() => {
  unmountStarfield(document);
  localStorage.clear();
  resetUserPreferences();
  document.documentElement.removeAttribute('data-skin');
});

describe('createRng', () => {
  it('is deterministic for a seed and stays in [0, 1)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const values = Array.from({ length: 200 }, () => a());
    expect(Array.from({ length: 200 }, () => b())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(createRng(43)()).not.toBe(createRng(42)());
  });
});

describe('generateStarfield', () => {
  it('draws the same sky for the same seed and a different one for another seed', () => {
    const first = generateStarfield(createRng(7), desktop);
    expect(generateStarfield(createRng(7), desktop)).toEqual(first);
    const other = generateStarfield(createRng(8), desktop);
    expect(allStars(other).slice(0, 5)).not.toEqual(allStars(first).slice(0, 5));
  });

  it('places the expected number of stars inside the tile', () => {
    const field = generateStarfield(createRng(1), desktop);
    const stars = allStars(field);
    expect(stars).toHaveLength(Math.round((desktop.width * desktop.height) / desktop.areaPerStar));
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(desktop.width);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(desktop.height);
      expect(star.a).toBeGreaterThan(0);
      expect(star.a).toBeLessThanOrEqual(1);
    }
  });

  it('is mostly dust with a few bright stars, and only bright or medium stars twinkle', () => {
    const field = generateStarfield(createRng(2024), desktop);
    const stars = allStars(field);
    const share = (tier: string) => stars.filter((star) => star.tier === tier).length / stars.length;
    expect(share('dust')).toBeGreaterThan(0.45);
    expect(share('bright')).toBeGreaterThan(0.02);
    expect(share('bright')).toBeLessThan(0.09);
    expect(field.base.some((star) => star.tier === 'bright')).toBe(false);
    for (const group of field.groups) {
      expect(group.stars.every((star) => star.tier === 'bright' || star.tier === 'medium')).toBe(true);
    }
  });

  it('gives each twinkle group a slow, out-of-phase cycle (well under 3 Hz)', () => {
    const field = generateStarfield(createRng(99), desktop);
    expect(field.groups).toHaveLength(desktop.twinkleGroups);
    for (const group of field.groups) {
      expect(group.duration).toBeGreaterThanOrEqual(4.5);
      expect(group.duration).toBeLessThanOrEqual(11);
      expect(group.delay).toBeLessThanOrEqual(0);
      expect(-group.delay).toBeLessThanOrEqual(group.duration);
    }
    expect(new Set(field.groups.map((group) => group.duration)).size).toBeGreaterThan(1);
    expect(field.shooting.cycle).toBeGreaterThanOrEqual(26);
  });

  it('is sparser on a phone, with fewer twinkle groups', () => {
    const density = (options: typeof desktop) => 1 / options.areaPerStar;
    expect(density(phone)).toBeLessThan(density(desktop));
    expect(phone.twinkleGroups).toBeLessThan(desktop.twinkleGroups);
  });
});

describe('starsToSvg', () => {
  it('draws one core per star and a glow only for bright stars', () => {
    const svg = starsToSvg(
      [
        { x: 10, y: 10, r: 0.5, a: 0.4, tier: 'dust' },
        { x: 20, y: 30, r: 1.4, a: 1, tier: 'bright' },
      ],
      100,
      80,
    );
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"')).toBe(true);
    expect(svg.match(/fill="#fff"/g)).toHaveLength(2);
    expect(svg.match(/fill="url\(#g\)"/g)).toHaveLength(1);
    expect(starsToSvg([{ x: 1, y: 1, r: 0.5, a: 0.4, tier: 'dust' }], 10, 10)).not.toContain('radialGradient');
  });
});

describe('mounting', () => {
  it('builds one base layer, the twinkle groups and a shooting star, and replaces itself', () => {
    const field = generateStarfield(createRng(5), phone);
    const root = mountStarfield(document, field);
    expect(root.id).toBe(STARFIELD_ELEMENT_ID);
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelectorAll('.aztecan-stars-base')).toHaveLength(1);
    expect(root.querySelectorAll('.aztecan-stars-twinkle').length).toBeLessThanOrEqual(phone.twinkleGroups);
    expect(root.querySelector('.aztecan-shooting-star')).not.toBeNull();
    const twinkle = root.querySelector<HTMLElement>('.aztecan-stars-twinkle');
    expect(twinkle?.style.getPropertyValue('--aztecan-twinkle-duration')).toMatch(/s$/);

    showStarfield(document, 6);
    expect(document.querySelectorAll(`#${STARFIELD_ELEMENT_ID}`)).toHaveLength(1);
    unmountStarfield(document);
    expect(document.getElementById(STARFIELD_ELEMENT_ID)).toBeNull();
  });
});

describe('SkinProvider', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(SkinProvider, null, children);
  const sky = () => document.getElementById(STARFIELD_ELEMENT_ID);

  it('draws a sky only for the Aztecan skin, a new one on each mount, and none when stars are off', () => {
    writeUserPreference('skin', 'aztecan');
    const first = renderHook(() => useSkin(), { wrapper });
    expect(sky()).not.toBeNull();
    const firstMask = sky()?.querySelector<HTMLElement>('.aztecan-stars-base')?.style.getPropertyValue('mask-image');
    first.unmount();
    expect(sky()).toBeNull();

    const { result } = renderHook(() => useSkin(), { wrapper });
    const secondMask = sky()?.querySelector<HTMLElement>('.aztecan-stars-base')?.style.getPropertyValue('mask-image');
    expect(secondMask).not.toBe(firstMask);

    act(() => result.current.setSkinOption('stars', 'off'));
    expect(sky()).toBeNull();
    act(() => result.current.setSkinOption('stars', 'still'));
    expect(sky()).not.toBeNull();
    act(() => result.current.setSkin('default'));
    expect(sky()).toBeNull();
  });
});
