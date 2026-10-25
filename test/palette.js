#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// luccet.css's own colours (docs/schema.html#custom-properties): its light and
// dark palettes reach 4.5:1 for every text colour against what it is drawn
// on, code colours too on the code background and 3:1 on a highlighted line,
// a control's border 3:1 against the page; text in a highlight is the text
// colour, so muted text and links on a highlight are the checked fg-on-mark
// pair; and the base answers prefers-contrast and forced-colors. The themes,
// which set the same properties, are checked the same way in
// github.com/Luccet/themes.
//
//   node test/palette.js
'use strict';

const P = require('./lib/palette');

let failed = 0;
const results = [];
function test(name, fn) {
  const problems = [];
  try {
    fn(problems);
  } catch (e) {
    problems.push((e && e.message) || String(e));
  }
  if (problems.length) failed++;
  results.push(problems.length ? `✗ ${name}\n  ${problems.join('\n  ')}` : `✓ ${name}`);
}

// What each colour is drawn on: text pairs need 4.5:1; the rest only need to
// be told apart from the page.
const TEXT = [
  ['fg', 'bg'], ['fg', 'soft'], ['fg', 'mark'],
  ['muted', 'bg'], ['muted', 'soft'],
  ['link', 'bg'], ['link', 'soft'],
  ['error', 'error-bg'], ['error', 'bg'],
  ['warn', 'bg'],
];
const APART = [['line', 'bg', 1.15], ['line-strong', 'bg', 3], ['soft', 'bg', 1.03], ['mark', 'bg', 1.05], ['error-bg', 'bg', 1.05]];
function pairs(name, c, min, p) {
  const missing = P.COLOURS.filter((k) => !/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(c[k] || ''));
  if (missing.length) return p.push(`${name}: no colour for ${missing.join(', ')}`);
  const x = Object.fromEntries(P.COLOURS.map((k) => [k, P.expand(c[k])]));
  const text = [...TEXT.map(([a, b]) => [a, b, min]), ...P.CODE.flatMap((k) => [[`code-${k}`, 'soft', min], [`code-${k}`, 'mark', P.onMark(min)]])];
  for (const [a, b, least] of text) {
    const r = P.contrast(x[a], x[b]);
    if (r < least) p.push(`${name}: --t-${a} on --t-${b} is ${r.toFixed(2)}:1, under ${least}:1`);
  }
  for (const [a, b, least] of APART) {
    const r = P.contrast(x[a], x[b]);
    if (r < least) p.push(`${name}: --t-${a} and --t-${b} are ${r.toFixed(2)}:1 apart, under ${least}:1`);
  }
}

test('the light and dark palettes: every text and code colour reaches its contrast against what it is drawn on (4.5:1; code on a highlighted line 3:1)', (p) => {
  const { light, dark } = P.palettes();
  pairs('luccet.css (light)', light, 4.5, p);
  pairs('luccet.css (dark)', dark, 4.5, p);
});

// Muted text and a link inside a highlight would be new pairs to check
// (muted on mark fails in most dark palettes); luccet.css makes them the
// checked pair instead: text in a mark is the text colour.
test('text in a highlight is --t-fg, and the base answers prefers-contrast and forced-colors', (p) => {
  const css = P.css();
  if (!/\.luccet mark, \.luccet mark a \{[^}]*color: var\(--t-fg\)/.test(css)) p.push('.luccet mark and .luccet mark a do not set color: var(--t-fg)');
  for (const q of ['@media (prefers-contrast: more)', '@media (forced-colors: active)']) if (!css.includes(q)) p.push(`luccet.css has no ${q} block`);
  const forced = P.forcedColors();
  for (const k of ['bg', 'fg', 'muted', 'line', 'line-strong', 'soft', 'link', 'mark']) if (!new RegExp(`--t-${k}: [A-Z][A-Za-z]+;`).test(forced)) p.push(`forced-colors gives --t-${k} no system colour`);
  // --t-size follows the reader's own size: a rem on the root is the browser's default size.
  if (!/--t-size: [\d.]+rem;/.test(css)) p.push('--t-size is not in rem, so a reader’s font-size setting would be ignored');
});

test('print: every colour property has a print value, the light one where print sets none', (p) => {
  const print = P.printPalette();
  const missing = P.COLOURS.filter((k) => !print[k]);
  if (missing.length) p.push(`no print colour for ${missing.join(', ')}`);
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} palette checks pass`);
process.exit(failed ? 1 : 0);
