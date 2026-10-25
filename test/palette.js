#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// luccet.css's colours (docs/schema.html#custom-properties). The functional
// layer draws a note in the system's colours, light or dark (color-scheme),
// and sets colours of its own only where the system has none: errors and
// warnings, code for the code add-on, a highlighted line. Those reach 4.5:1
// against the canvas browsers draw (white; #121212 in Chromium's dark scheme,
// #1c1b22 in Firefox's), errors on their own background too, and code 3:1 on
// a highlighted line. Every colour property has a default; print and forced
// colours set every one of them !important, so no theme has to. The themes,
// which set the same properties, are checked in github.com/Luccet/themes.
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

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const SYSTEM = /^(Canvas|CanvasText|LinkText|GrayText|ButtonFace|Highlight|HighlightText|Mark|MarkText)$/;
const CANVAS = { light: ['#ffffff'], dark: ['#121212', '#1c1b22'] };

test('every colour property has a default: a system colour, or a hex colour where the system has none', (p) => {
  const { light, dark } = P.palettes();
  for (const [scheme, c] of Object.entries({ light, dark })) {
    for (const k of P.COLOURS) if (!(HEX.test(c[k] || '') || SYSTEM.test(c[k] || ''))) p.push(`${scheme}: --t-${k} is ${JSON.stringify(c[k])}`);
  }
  if (light['color-scheme'] !== 'light dark') p.push(`color-scheme is ${light['color-scheme']}, not "light dark"`);
  for (const k of ['sans', 'mono']) if (!light[k]) p.push(`no --t-${k}`);
});

test('the colours it sets itself reach their contrast on the canvas browsers draw (4.5:1; errors on their background too; code 3:1 on a highlighted line)', (p) => {
  const { light, dark } = P.palettes();
  for (const [scheme, c] of Object.entries({ light, dark })) {
    const own = P.COLOURS.filter((k) => HEX.test(c[k] || ''));
    for (const bg of CANVAS[scheme]) {
      for (const k of own.filter((k) => !['mark', 'error-bg'].includes(k))) {
        const r = P.contrast(c[k], bg);
        if (r < 4.5) p.push(`${scheme}: --t-${k} on the canvas ${bg} is ${r.toFixed(2)}:1`);
      }
    }
    const pairs = [['error', 'error-bg', 4.5], ...P.CODE.map((k) => [`code-${k}`, 'mark', 3])];
    for (const [a, b, least] of pairs) {
      const r = P.contrast(c[a], c[b]);
      if (r < least) p.push(`${scheme}: --t-${a} on --t-${b} is ${r.toFixed(2)}:1, under ${least}:1`);
    }
  }
});

test('print and forced colours set every page colour !important, so a theme need not repeat them', (p) => {
  const css = P.css();
  const block = (at) => {
    const from = css.indexOf(':root {', css.indexOf(at));
    return css.slice(from, css.indexOf('}', from));
  };
  const print = block('@media print');
  for (const k of P.COLOURS) if (!new RegExp(`--t-${k}: [^;]+ !important;`).test(print)) p.push(`print: --t-${k} is not set !important`);
  if (!/color-scheme: light !important;/.test(print)) p.push('print: color-scheme is not light !important');
  const forced = block('@media (forced-colors: active)');
  for (const k of P.PAGE) if (!new RegExp(`--t-${k}: [A-Z][A-Za-z]+ !important;`).test(forced)) p.push(`forced colours: --t-${k} is not a system colour !important`);
  if (!/\.luccet mark, \.luccet \.t-hl \{ color: HighlightText; forced-color-adjust: none; \}/.test(css)) p.push('forced colours: a highlight does not keep its pair');
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} palette checks pass`);
process.exit(failed ? 1 : 0);
