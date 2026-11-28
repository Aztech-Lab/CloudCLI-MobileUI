#!/usr/bin/env node
// [local] Proves that tokenising the stylesheet changed nothing visible.
//
// Usage: node scripts/check-theme-equivalence.mjs <before.css> <after.css>
//
// Both files are built CSS (dist/assets/index-*.css). Every custom property that
// <after.css> declares on `:root` but <before.css> does not is treated as a new theme
// token: its declarations are dropped, and every `var(--token)` / `var(--token, x)`
// in the remaining rules is replaced by the token's default. Colours are normalised
// (hex, rgb(), rgba(), space or comma syntax) before comparing.
//
// The comparison is per selector, not per position: each declaration is filed under
// its at-rule chain and each single selector of its rule (`a,b{...}` counts for `a`
// and for `b`), and the declaration lists of a selector present in both files must
// match. Rule order, and how the minifier groups selectors, therefore do not matter,
// so utility classes added or dropped elsewhere in the build do not show up as
// differences. Selectors that exist in only one of the two files are listed for
// information (they come from markup changes, not from tokens) and do not fail the
// check. Exit code 1 on any difference.
import fs from 'node:fs';

import postcss from 'postcss';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: check-theme-equivalence.mjs <before.css> <after.css>');
  process.exit(2);
}

const parse = (path) => postcss.parse(fs.readFileSync(path, 'utf8'));

function rootDeclarations(root) {
  const declarations = new Map();
  root.walkRules((rule) => {
    if (rule.selector.trim() !== ':root') return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) declarations.set(decl.prop, decl.value.trim());
    });
  });
  return declarations;
}

const before = parse(beforePath);
const after = parse(afterPath);
const beforeRoot = rootDeclarations(before);
const tokens = new Map([...rootDeclarations(after)].filter(([name]) => !beforeRoot.has(name)));

const varPattern = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;

function substitute(value) {
  let previous;
  let current = value;
  for (let pass = 0; pass < 10 && previous !== current; pass += 1) {
    previous = current;
    current = current.replace(varPattern, (match, name, fallback) => {
      if (tokens.has(name)) return tokens.get(name);
      return fallback !== undefined && !tokens.has(name) ? match : match;
    });
  }
  return current;
}

function hexToRgba(hex) {
  let digits = hex.slice(1);
  if (digits.length === 3 || digits.length === 4) digits = digits.split('').map((d) => d + d).join('');
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  const a = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${+a.toFixed(6)})`;
}

const number = String.raw`-?\d*\.?\d+%?`;
const rgbPattern = new RegExp(String.raw`rgba?\(\s*(${number})[\s,]+(${number})[\s,]+(${number})\s*(?:[,/]\s*(${number}))?\s*\)`, 'gi');

function alphaValue(raw) {
  if (raw === undefined) return 1;
  return raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
}

function normalise(value) {
  return substitute(value)
    .replace(/#[0-9a-f]{3,8}\b/gi, (hex) => hexToRgba(hex.toLowerCase()))
    .replace(rgbPattern, (match, r, g, b, a) => `rgba(${+r},${+g},${+b},${+alphaValue(a).toFixed(6)})`)
    .replace(/\s*([,/()])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s*!important/, ' !important')
    .trim()
    .toLowerCase();
}

function context(node) {
  const chain = [];
  for (let parent = node.parent?.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    chain.unshift(parent.type === 'atrule' ? `@${parent.name} ${parent.params}` : parent.selector);
  }
  return chain.join(' > ');
}

const singleSelectors = (rule) => rule.selectors.map((selector) => selector.replace(/\s+/g, ' ').trim());

/** Maps `[<at-rule chain> | ]<selector>` to its declarations (`prop: value`), in source order. */
function entries(root, { dropTokens }) {
  const bySelector = new Map();
  root.walkDecls((decl) => {
    const rule = decl.parent;
    if (!rule || rule.type !== 'rule') return;
    if (dropTokens && tokens.has(decl.prop) && rule.selector.trim() === ':root') return;
    let value = normalise(decl.value);
    // Quotes around a family name are optional ("Encode Sans" == Encode Sans); the
    // minifier drops them in rules but keeps them inside custom property values.
    if (decl.prop === 'font-family') value = value.replace(/["']/g, '');
    const text = `${decl.prop}: ${value}${decl.important ? ' !important' : ''}`;
    const scope = context(decl);
    for (const selector of singleSelectors(rule)) {
      const key = scope ? `${scope} | ${selector}` : selector;
      if (!bySelector.has(key)) bySelector.set(key, []);
      bySelector.get(key).push(text);
    }
  });
  return bySelector;
}

const beforeEntries = entries(before, { dropTokens: false });
const afterEntries = entries(after, { dropTokens: true });

// The minifier writes `rgb(r g b / .3)` as 8-digit hex when it can, which rounds the
// alpha to n/255 (0.3 -> 0.302). Through a variable it cannot, so the alpha stays exact.
// Browsers composite with 8-bit alpha, so a gap below half a step (0.5/255) is not a
// visible change; anything else is.
const ALPHA_QUANTISATION = 0.5 / 255 + 1e-6;
const rgbaToken = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/g;

function onlyAlphaQuantised(left, right) {
  const leftColours = [...left.matchAll(rgbaToken)];
  const rightColours = [...right.matchAll(rgbaToken)];
  if (leftColours.length === 0 || leftColours.length !== rightColours.length) return false;
  if (left.replace(rgbaToken, 'C') !== right.replace(rgbaToken, 'C')) return false;
  return leftColours.every((colour, index) => {
    const other = rightColours[index];
    return colour[1] === other[1] && colour[2] === other[2] && colour[3] === other[3]
      && Math.abs(Number(colour[4]) - Number(other[4])) <= ALPHA_QUANTISATION;
  });
}

/**
 * Pairs the declarations of one selector by property (in source order per property,
 * which keeps fallbacks such as two `background` lines apart) and returns the pairs
 * that differ by more than the alpha rounding, plus how many only differ by it.
 */
function compareDeclarations(left, right) {
  const group = (list) => {
    const byProp = new Map();
    for (const text of list) {
      const prop = text.slice(0, text.indexOf(':'));
      if (!byProp.has(prop)) byProp.set(prop, []);
      byProp.get(prop).push(text);
    }
    return byProp;
  };
  const leftByProp = group(left);
  const rightByProp = group(right);
  const differing = [];
  let quantisedHere = 0;
  for (const prop of new Set([...leftByProp.keys(), ...rightByProp.keys()])) {
    const leftValues = leftByProp.get(prop) ?? [];
    const rightValues = rightByProp.get(prop) ?? [];
    for (let index = 0; index < Math.max(leftValues.length, rightValues.length); index += 1) {
      const before = leftValues[index];
      const after = rightValues[index];
      if (before === after) continue;
      if (before !== undefined && after !== undefined && onlyAlphaQuantised(before, after)) {
        quantisedHere += 1;
        continue;
      }
      differing.push({ before, after });
    }
  }
  return { differing, quantised: quantisedHere };
}

let quantised = 0;
let differences = 0;
let compared = 0;
for (const [key, left] of beforeEntries) {
  const right = afterEntries.get(key);
  if (right === undefined) continue;
  compared += 1;
  const result = compareDeclarations(left, right);
  quantised += result.quantised;
  for (const { before: leftText, after: rightText } of result.differing) {
    differences += 1;
    if (differences <= 20) {
      console.log(`${key}
  before: ${leftText ?? '(none)'}
  after:  ${rightText ?? '(none)'}`);
    }
  }
}

const onlyBefore = [...beforeEntries.keys()].filter((key) => !afterEntries.has(key));
const onlyAfter = [...afterEntries.keys()].filter((key) => !beforeEntries.has(key));
const listed = (keys) => (keys.length === 0 ? '0' : `${keys.length} (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''})`);

console.log(`new tokens: ${tokens.size}`);
console.log(`selectors compared: ${compared} (before ${beforeEntries.size}, after ${afterEntries.size})`);
console.log(`selectors only in before, not compared: ${listed(onlyBefore)}`);
console.log(`selectors only in after, not compared: ${listed(onlyAfter)}`);
console.log(`alpha only differs by the minifier's 8-bit rounding (< half a step): ${quantised}`);
console.log(differences === 0 ? 'EQUIVALENT: no visible change' : `DIFFERENT: ${differences} declaration(s) differ`);
process.exit(differences === 0 ? 0 : 1);
