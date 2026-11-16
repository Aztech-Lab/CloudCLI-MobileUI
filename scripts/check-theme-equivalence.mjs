#!/usr/bin/env node
// [local] Proves that tokenising the stylesheet changed nothing visible.
//
// Usage: node scripts/check-theme-equivalence.mjs <before.css> <after.css>
//
// Both files are built CSS (dist/assets/index-*.css). Every custom property that
// <after.css> declares on `:root` but <before.css> does not is treated as a new theme
// token: its declarations are dropped, and every `var(--token)` / `var(--token, x)`
// in the remaining rules is replaced by the token's default. Colours are normalised
// (hex, rgb(), rgba(), space or comma syntax) before comparing. The rule lists must
// then match one to one, in order, inside the same at-rules. Exit code 1 on any
// difference.

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
  for (let parent = node.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    chain.unshift(parent.type === 'atrule' ? `@${parent.name} ${parent.params}` : parent.selector);
  }
  return chain.join(' > ');
}

function entries(root, { dropTokens }) {
  const list = [];
  root.walkDecls((decl) => {
    if (dropTokens && tokens.has(decl.prop) && decl.parent?.selector?.trim() === ':root') return;
    let value = normalise(decl.value);
    // Quotes around a family name are optional ("Encode Sans" == Encode Sans); the
    // minifier drops them in rules but keeps them inside custom property values.
    if (decl.prop === 'font-family') value = value.replace(/["']/g, '');
    list.push(`${context(decl)} { ${decl.prop}: ${value}${decl.important ? ' !important' : ''} }`);
  });
  return list;
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

let quantised = 0;
let differences = 0;
const length = Math.max(beforeEntries.length, afterEntries.length);
for (let index = 0; index < length; index += 1) {
  const left = beforeEntries[index];
  const right = afterEntries[index];
  if (left === right) continue;
  if (left !== undefined && right !== undefined && onlyAlphaQuantised(left, right)) {
    quantised += 1;
    continue;
  }
  differences += 1;
  if (differences <= 20) {
    console.log(`#${index}\n  before: ${left}\n  after:  ${right}`);
  }
}

console.log(`new tokens: ${tokens.size}`);
console.log(`declarations compared: before ${beforeEntries.length}, after ${afterEntries.length}`);
console.log(`alpha only differs by the minifier's 8-bit rounding (< half a step): ${quantised}`);
console.log(differences === 0 ? 'EQUIVALENT: no visible change' : `DIFFERENT: ${differences} declaration(s) differ`);
process.exit(differences === 0 ? 0 : 1);
