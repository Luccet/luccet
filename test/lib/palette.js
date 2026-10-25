// SPDX-License-Identifier: MIT
// luccet.css's colours, read from src/css.js, and WCAG 2's contrast: for
// test/palette.js (the colours the functional layer sets itself are readable
// on the browser's own canvas) and test/addons.js (an add-on that prints as
// the base prints). A value is a hex colour or one of the system's (Canvas,
// CanvasText …), which the browser resolves. The themes, which set the same
// properties, are built and checked in github.com/Luccet/themes.
'use strict';

const PAGE = ['bg', 'fg', 'muted', 'line', 'line-strong', 'soft', 'link', 'mark', 'error', 'error-bg', 'warn'];
const CODE = ['comment', 'keyword', 'string', 'number', 'function', 'type', 'variable', 'meta', 'inserted', 'deleted'];
const COLOURS = [...PAGE, ...CODE.map((k) => `code-${k}`)];
// The contrast a code colour needs on a highlighted line, for a family's own.
const onMark = (min) => (min >= 7 ? 4.5 : 3);

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const expand = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h);
function luminance(h) {
  const [r, g, b] = rgb(expand(h)).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const css = () => require('../../src/css').css;
// The --t-* properties and color-scheme a block sets, without the --t-.
const props = (block) => Object.fromEntries([...block.matchAll(/(?<![\w-])(--t-[a-z-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1].replace(/^--t-/, ''), m[2].replace(/\s*!important\s*$/, '').trim()]));
const blockAt = (s, from) => props(s.slice(from, s.indexOf('}', from)));

// The light and dark defaults, as luccet.css sets them (dark: what its dark
// block changes, over the light).
function palettes() {
  const s = css();
  const light = blockAt(s, s.indexOf(':root {'));
  return { light, dark: { ...light, ...blockAt(s, s.indexOf(':root {', s.indexOf('@media (prefers-color-scheme: dark)'))) } };
}

// What luccet.css prints: its light colours under its print block.
function printPalette() {
  const s = css();
  const light = blockAt(s, s.indexOf(':root {'));
  const print = blockAt(s, s.indexOf(':root {', s.indexOf('@media print')));
  return Object.fromEntries(COLOURS.map((k) => [k, print[k] || light[k]]));
}

// luccet.css's forced-colors block, as it is.
function forcedColors() {
  const s = css();
  const from = s.indexOf('@media (forced-colors: active) {');
  if (from < 0) throw new Error('src/css.js has no forced-colors block');
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(from, i + 1);
  }
  throw new Error('src/css.js: the forced-colors block is not closed');
}

module.exports = { PAGE, CODE, COLOURS, onMark, contrast, luminance, expand, props, css, palettes, printPalette, forcedColors };
