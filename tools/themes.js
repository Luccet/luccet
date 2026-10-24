#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Builds the committed themes/*.css (docs/schema.html#themes): colour themes
// after well-known palettes, as stylesheet add-ons that set luccet.css's colour
// properties. A family with a light and a dark variant gives three files:
// NAME.css follows the reader's system setting, NAME-light.css and
// NAME-dark.css hold one palette for every reader. A family with one variant
// gives NAME.css. Every file prints as luccet.css prints, black on white.
//
// Text colours must reach the family's contrast (4.5:1, WCAG AA; 7:1 for
// high-contrast) against what they are drawn on; code colours too, on the
// code background, and 3:1 on a highlighted line (4.5:1 for high-contrast);
// a control's border (line-strong) 3:1 against the page. Text in a highlight
// is the text colour (luccet.css), so the highlight is checked against fg.
// Each file also answers prefers-contrast: more (muted text in the text
// colour, rules in the strong line) and forced-colors (the system palette).
// A palette colour that falls short is mixed toward black or white until it
// does, and the file's header names it. test/themes.js checks the result.
//
//   node tools/themes.js           write themes/*.css
//   node tools/themes.js --check   exit 1 if themes/ is not the current build (CI)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'themes');

// ---------------------------------------------------------------- colour

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
// `a` taken `t` of the way to `b`, in sRGB.
const mix = (a, b, t) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};
// WCAG 2's relative luminance and contrast ratio.
function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const isLight = (bg) => luminance(bg) > 0.179; // where black text beats white
// HSL, each part 0-1.
function hsl(h) {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue / 6, s, l];
}
function fromHsl([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h * 6) % 6];
  return hex([r, g, b].map((v) => (v + l - c / 2) * 255));
}

// ---------------------------------------------------------------- palettes

// A variant names the palette's own colours for each role:
//   bg, fg     the page and its text
//   muted      quotes, captions, equation and line numbers
//   soft       code and table-header backgrounds
//   line       rules and borders
//   lineStrong a control's border (a kbd, the panel, a search box), 3:1
//              against the page; derived from line when absent
//   link       links
//   red        errors; their background is red mixed into bg, unless errorBg
//   warn       warnings in the diagnostics panel
//   yellow     highlights, in its hue (resolve), unless mark gives one
//   code       the code colours (CODE), for addons/code.js: the theme's own
//              syntax colours
const FAMILIES = [
  {
    name: 'solarized',
    title: 'Solarized',
    after: "Ethan Schoonover's Solarized",
    url: 'https://ethanschoonover.com/solarized/',
    light: {
      bg: '#fdf6e3', fg: '#586e75', muted: '#657b83', soft: '#eee8d5', line: mix('#93a1a1', '#eee8d5', 0.45), link: '#268bd2', red: '#dc322f', warn: '#cb4b16', yellow: '#b58900',
      code: { comment: '#93a1a1', keyword: '#859900', string: '#2aa198', number: '#d33682', function: '#268bd2', type: '#b58900', variable: '#6c71c4', meta: '#cb4b16', inserted: '#859900', deleted: '#dc322f' },
    },
    dark: {
      bg: '#002b36', fg: '#839496', muted: '#586e75', soft: '#073642', line: mix('#586e75', '#073642', 0.5), link: '#268bd2', red: '#dc322f', warn: '#cb4b16', yellow: '#b58900',
      code: { comment: '#586e75', keyword: '#859900', string: '#2aa198', number: '#d33682', function: '#268bd2', type: '#b58900', variable: '#6c71c4', meta: '#cb4b16', inserted: '#859900', deleted: '#dc322f' },
    },
  },
  {
    name: 'gruvbox',
    title: 'Gruvbox',
    after: "Pavel Pertsev's gruvbox",
    url: 'https://github.com/morhetz/gruvbox',
    light: {
      bg: '#fbf1c7', fg: '#3c3836', muted: '#7c6f64', soft: '#ebdbb2', line: '#d5c4a1', link: '#076678', red: '#9d0006', warn: '#af3a03', yellow: '#d79921',
      code: { comment: '#928374', keyword: '#9d0006', string: '#79740e', number: '#8f3f71', function: '#427b58', type: '#b57614', variable: '#076678', meta: '#af3a03', inserted: '#79740e', deleted: '#9d0006' },
    },
    dark: {
      bg: '#282828', fg: '#ebdbb2', muted: '#a89984', soft: '#3c3836', line: '#504945', link: '#83a598', red: '#fb4934', warn: '#fe8019', yellow: '#d79921',
      code: { comment: '#928374', keyword: '#fb4934', string: '#b8bb26', number: '#d3869b', function: '#8ec07c', type: '#fabd2f', variable: '#83a598', meta: '#fe8019', inserted: '#b8bb26', deleted: '#fb4934' },
    },
  },
  {
    name: 'nord',
    title: 'Nord',
    after: "Arctic Ice Studio's Nord",
    url: 'https://www.nordtheme.com',
    dark: {
      bg: '#2e3440', fg: '#d8dee9', muted: '#616e88', soft: '#3b4252', line: '#434c5e', link: '#88c0d0', red: '#bf616a', warn: '#d08770', yellow: '#ebcb8b',
      code: { comment: '#616e88', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', function: '#88c0d0', type: '#8fbcbb', variable: '#d8dee9', meta: '#5e81ac', inserted: '#a3be8c', deleted: '#bf616a' },
    },
  },
  {
    name: 'dracula',
    title: 'Dracula',
    after: 'Dracula',
    url: 'https://draculatheme.com',
    dark: {
      bg: '#282a36', fg: '#f8f8f2', muted: '#6272a4', soft: '#343746', line: '#44475a', link: '#8be9fd', red: '#ff5555', warn: '#ffb86c', yellow: '#f1fa8c',
      code: { comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', function: '#50fa7b', type: '#8be9fd', variable: '#ffb86c', meta: '#ff79c6', inserted: '#50fa7b', deleted: '#ff5555' },
    },
  },
  {
    name: 'one',
    title: 'One',
    after: "Atom's One Light and One Dark",
    url: 'https://github.com/atom/atom/tree/master/packages/one-dark-syntax',
    light: {
      bg: '#fafafa', fg: '#383a42', muted: '#a0a1a7', soft: '#f0f0f1', line: '#e5e5e6', link: '#4078f2', red: '#e45649', warn: '#c18401', yellow: '#e5c07b',
      code: { comment: '#a0a1a7', keyword: '#a626a4', string: '#50a14f', number: '#986801', function: '#4078f2', type: '#c18401', variable: '#e45649', meta: '#0184bc', inserted: '#50a14f', deleted: '#e45649' },
    },
    dark: {
      bg: '#282c34', fg: '#abb2bf', muted: '#5c6370', soft: '#21252b', line: '#3e4451', link: '#61afef', red: '#e06c75', warn: '#d19a66', yellow: '#e5c07b',
      code: { comment: '#5c6370', keyword: '#c678dd', string: '#98c379', number: '#d19a66', function: '#61afef', type: '#e5c07b', variable: '#e06c75', meta: '#56b6c2', inserted: '#98c379', deleted: '#e06c75' },
    },
  },
  {
    name: 'github',
    title: 'GitHub',
    after: "GitHub's Primer colours",
    url: 'https://primer.style/foundations/color',
    light: {
      bg: '#ffffff', fg: '#1f2328', muted: '#59636e', soft: '#f6f8fa', line: '#d1d9e0', link: '#0969da', red: '#d1242f', errorBg: '#ffebe9', warn: '#9a6700', mark: '#fff8c5',
      code: { comment: '#59636e', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', function: '#6639ba', type: '#953800', variable: '#0550ae', meta: '#116329', inserted: '#116329', deleted: '#82071e' },
    },
    dark: {
      bg: '#0d1117', fg: '#f0f6fc', muted: '#9198a1', soft: '#151b23', line: '#3d444d', link: '#4493f8', red: '#f85149', warn: '#d29922', yellow: '#bb8009',
      code: { comment: '#9198a1', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', function: '#d2a8ff', type: '#ffa657', variable: '#79c0ff', meta: '#7ee787', inserted: '#7ee787', deleted: '#ffa198' },
    },
  },
  {
    name: 'catppuccin',
    title: 'Catppuccin',
    after: 'Catppuccin Latte (light) and Mocha (dark)',
    url: 'https://catppuccin.com/palette',
    light: {
      bg: '#eff1f5', fg: '#4c4f69', muted: '#6c6f85', soft: '#e6e9ef', line: '#ccd0da', link: '#1e66f5', red: '#d20f39', warn: '#fe640b', yellow: '#df8e1d',
      code: { comment: '#7c7f93', keyword: '#8839ef', string: '#40a02b', number: '#fe640b', function: '#1e66f5', type: '#df8e1d', variable: '#e64553', meta: '#179299', inserted: '#40a02b', deleted: '#d20f39' },
    },
    dark: {
      bg: '#1e1e2e', fg: '#cdd6f4', muted: '#a6adc8', soft: '#181825', line: '#313244', link: '#89b4fa', red: '#f38ba8', warn: '#fab387', yellow: '#f9e2af',
      code: { comment: '#9399b2', keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', function: '#89b4fa', type: '#f9e2af', variable: '#eba0ac', meta: '#94e2d5', inserted: '#a6e3a1', deleted: '#f38ba8' },
    },
  },
  {
    name: 'tokyo-night',
    title: 'Tokyo Night',
    after: 'Tokyo Night Day (light) and Night (dark)',
    url: 'https://github.com/folke/tokyonight.nvim',
    light: {
      bg: '#e1e2e7', fg: '#3760bf', muted: '#848cb5', soft: '#d0d5e3', line: '#c4c8da', link: '#2e7de9', red: '#f52a65', warn: '#b15c00', yellow: '#8c6c3e',
      code: { comment: '#848cb5', keyword: '#9854f1', string: '#587539', number: '#b15c00', function: '#2e7de9', type: '#188092', variable: '#387068', meta: '#007197', inserted: '#587539', deleted: '#f52a65' },
    },
    dark: {
      bg: '#1a1b26', fg: '#c0caf5', muted: '#737aa2', soft: '#16161e', line: '#292e42', link: '#7aa2f7', red: '#f7768e', warn: '#ff9e64', yellow: '#e0af68',
      code: { comment: '#565f89', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', function: '#7aa2f7', type: '#2ac3de', variable: '#73daca', meta: '#7dcfff', inserted: '#9ece6a', deleted: '#f7768e' },
    },
  },
  {
    name: 'rose-pine',
    title: 'Rosé Pine',
    after: 'Rosé Pine Dawn (light) and Rosé Pine (dark)',
    url: 'https://rosepinetheme.com/palette/',
    light: {
      bg: '#faf4ed', fg: '#575279', muted: '#797593', soft: '#f2e9e1', line: '#dfdad9', link: '#286983', red: '#b4637a', warn: '#ea9d34', yellow: '#ea9d34',
      code: { comment: '#9893a5', keyword: '#286983', string: '#ea9d34', number: '#ea9d34', function: '#d7827e', type: '#56949f', variable: '#907aa9', meta: '#907aa9', inserted: '#56949f', deleted: '#b4637a' },
    },
    dark: {
      bg: '#191724', fg: '#e0def4', muted: '#908caa', soft: '#26233a', line: '#403d52', link: '#9ccfd8', red: '#eb6f92', warn: '#f6c177', yellow: '#f6c177',
      code: { comment: '#6e6a86', keyword: '#31748f', string: '#f6c177', number: '#f6c177', function: '#ebbcba', type: '#9ccfd8', variable: '#c4a7e7', meta: '#c4a7e7', inserted: '#9ccfd8', deleted: '#eb6f92' },
    },
  },
  {
    name: 'monokai',
    title: 'Monokai',
    after: "Wimer Hazenberg's Monokai",
    url: 'https://monokai.nl',
    dark: {
      bg: '#272822', fg: '#f8f8f2', muted: '#75715e', soft: '#3e3d32', line: '#49483e', link: '#66d9ef', red: '#f92672', warn: '#fd971f', yellow: '#e6db74',
      code: { comment: '#75715e', keyword: '#f92672', string: '#e6db74', number: '#ae81ff', function: '#a6e22e', type: '#66d9ef', variable: '#fd971f', meta: '#f92672', inserted: '#a6e22e', deleted: '#f92672' },
    },
  },
  {
    name: 'everforest',
    title: 'Everforest',
    after: "sainnhe's Everforest (medium)",
    url: 'https://github.com/sainnhe/everforest',
    light: {
      bg: '#fdf6e3', fg: '#5c6a72', muted: '#829181', soft: '#f4f0d9', line: '#e0dcc7', link: '#3a94c5', red: '#f85552', warn: '#f57d26', yellow: '#dfa000',
      code: { comment: '#939f91', keyword: '#f85552', string: '#8da101', number: '#df69ba', function: '#35a77c', type: '#dfa000', variable: '#3a94c5', meta: '#f57d26', inserted: '#8da101', deleted: '#f85552' },
    },
    dark: {
      bg: '#2d353b', fg: '#d3c6aa', muted: '#9da9a0', soft: '#343f44', line: '#475258', link: '#7fbbb3', red: '#e67e80', warn: '#e69875', yellow: '#dbbc7f',
      code: { comment: '#859289', keyword: '#e67e80', string: '#a7c080', number: '#d699b6', function: '#83c092', type: '#dbbc7f', variable: '#7fbbb3', meta: '#e69875', inserted: '#a7c080', deleted: '#e67e80' },
    },
  },
  {
    name: 'kanagawa',
    title: 'Kanagawa',
    after: "rebelot's Kanagawa (wave)",
    url: 'https://github.com/rebelot/kanagawa.nvim',
    dark: {
      bg: '#1f1f28', fg: '#dcd7ba', muted: '#727169', soft: '#2a2a37', line: '#363646', link: '#7e9cd8', red: '#e82424', warn: '#ff9e3b', yellow: '#e6c384',
      code: { comment: '#727169', keyword: '#957fb8', string: '#98bb6c', number: '#d27e99', function: '#7e9cd8', type: '#7aa89f', variable: '#e6c384', meta: '#e46876', inserted: '#76946a', deleted: '#c34043' },
    },
  },
  {
    name: 'sepia',
    title: 'Sepia',
    after: 'the warm paper of e-readers',
    light: {
      bg: '#f5ecd8', fg: '#3b3024', muted: '#6e5d48', soft: '#ece0c5', line: '#d9c9a7', link: '#2d5a87', red: '#a1301c', warn: '#8a5300', yellow: '#e9c46a',
      code: { comment: '#8a7a63', keyword: '#8b2252', string: '#4d7a2b', number: '#a0522d', function: '#2d5a87', type: '#7a5c00', variable: '#5a4a7a', meta: '#8a5300', inserted: '#4d7a2b', deleted: '#a1301c' },
    },
  },
  {
    name: 'high-contrast',
    title: 'High contrast',
    after: 'black and white, for low vision',
    min: 7,
    light: {
      bg: '#ffffff', fg: '#000000', muted: '#3b3b3b', soft: '#f0f0f0', line: '#767676', link: '#0033b3', red: '#a00000', errorBg: '#ffe8e8', warn: '#6b4400', mark: '#ffff00',
      code: { comment: '#3b3b3b', keyword: '#0000a0', string: '#005a00', number: '#7a2e00', function: '#5a00a0', type: '#00546b', variable: '#4a3000', meta: '#6b4400', inserted: '#005a00', deleted: '#a00000' },
    },
    dark: {
      bg: '#000000', fg: '#ffffff', muted: '#d0d0d0', soft: '#1a1a1a', line: '#8a8a8a', link: '#a8ccff', red: '#ff8f8f', errorBg: '#3a0000', warn: '#ffd24d', mark: '#5c5000',
      code: { comment: '#d0d0d0', keyword: '#9ecbff', string: '#9dff9d', number: '#ffc380', function: '#e0b0ff', type: '#80ffff', variable: '#ffe08a', meta: '#ffd24d', inserted: '#9dff9d', deleted: '#ff8f8f' },
    },
  },
];

// ---------------------------------------------------------------- resolving

// The most a derived highlight may stand out from bg, as a contrast ratio.
const MARK = { light: 1.3, dark: 2.2 };

const PAGE = ['bg', 'fg', 'muted', 'line', 'line-strong', 'soft', 'link', 'mark', 'error', 'error-bg', 'warn'];
const CODE = ['comment', 'keyword', 'string', 'number', 'function', 'type', 'variable', 'meta', 'inserted', 'deleted'];
// Every colour property, without its --t-: the page's, then code-*.
const COLOURS = [...PAGE, ...CODE.map((k) => `code-${k}`)];

// The contrast a code colour needs on a highlighted line, for a family's `min`.
const onMark = (min) => (min >= 7 ? 4.5 : 3);

// A variant's colours, each text colour raised to what it needs against what
// it is drawn on, and the roles that needed it.
function resolve(v, min) {
  const { bg, soft, line } = v;
  const light = isLight(bg);
  const raised = [];
  // `backs`: [[background, ratio]].
  const fit = (role, c, backs) => {
    let out = c;
    const short = (x) => backs.some(([b, r]) => contrast(x, b) < r);
    for (let i = 1; i <= 50 && short(out); i++) out = mix(c, light ? '#000000' : '#ffffff', i / 50);
    if (out !== c) raised.push(role);
    return out;
  };
  const fg = fit('fg', v.fg, [[bg, min], [soft, min]]);
  // The highlight: the palette's yellow, its hue and saturation kept, at the
  // lightness that sets it furthest from bg while the text on it keeps
  // `min`, and no further from bg than MARK.
  let mark = v.mark;
  if (!mark) {
    const [h, sat] = hsl(v.yellow);
    for (let i = 0; i <= 200; i++) {
      const c = fromHsl([h, sat, light ? 1 - i / 200 : i / 200]);
      if (contrast(fg, c) < min || contrast(c, bg) > MARK[light ? 'light' : 'dark']) break;
      mark = c;
    }
  }
  if (!mark || contrast(fg, mark) < min) throw new Error(`no highlight in ${v.yellow || v.mark} keeps ${min}:1 for ${fg}`);
  const errorBg = v.errorBg || mix(bg, v.red, light ? 0.1 : 0.18);
  const out = {
    bg,
    fg,
    muted: fit('muted', v.muted, [[bg, min], [soft, min]]),
    line,
    'line-strong': fit('line-strong', v.lineStrong || line, [[bg, 3]]),
    soft,
    link: fit('link', v.link, [[bg, min], [soft, min]]),
    mark,
    error: fit('error', v.red, [[errorBg, min], [bg, min]]),
    'error-bg': errorBg,
    warn: fit('warn', v.warn, [[bg, min]]),
  };
  for (const k of CODE) out[`code-${k}`] = fit(`code ${k}`, v.code[k], [[soft, min], [mark, onMark(min)]]);
  return { colours: out, raised, light };
}

// luccet.css's print palette: its light colours under its print overrides, so
// that a theme prints as the base does.
function printPalette() {
  const file = path.join(ROOT, 'src', 'css.js');
  delete require.cache[require.resolve(file)];
  const { css } = require(file);
  const props = (block) => Object.fromEntries([...block.matchAll(/--t-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const block = (from) => css.slice(from, css.indexOf('}', from));
  const light = props(block(css.indexOf(':root {')));
  const print = props(block(css.indexOf(':root {', css.indexOf('@media print'))));
  return Object.fromEntries(COLOURS.map((k) => [k, print[k] || light[k]]));
}

// luccet.css's forced-colors block, as it is: a theme under forced colours is
// the system's palette, like the base.
function forcedColors() {
  const file = path.join(ROOT, 'src', 'css.js');
  delete require.cache[require.resolve(file)];
  const { css } = require(file);
  const from = css.indexOf('@media (forced-colors: active) {');
  if (from < 0) throw new Error('src/css.js has no forced-colors block');
  let depth = 0;
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(from, i + 1);
  }
  throw new Error('src/css.js: the forced-colors block is not closed');
}

// ---------------------------------------------------------------- writing

// Five to a line, the page's colours then the code's.
const declarations = (c, indent) =>
  COLOURS.map((_, i) => i)
    .filter((i) => i % 5 === 0)
    .map((i) => indent + COLOURS.slice(i, i + 5).map((k) => `--t-${k}: ${c[k]};`).join(' '))
    .join('\n');
const rootBlock = (scheme, c, indent = '') => `${indent}:root {\n${indent}  color-scheme: ${scheme};\n${declarations(c, `${indent}  `)}\n${indent}}`;
const declarationsOnly = (c) => `  :root {\n${declarations(c, '    ')}\n  }`;

const MODE = {
  auto: "Light or dark, by the reader's system setting.",
  light: 'Light for every reader.',
  dark: 'Dark for every reader.',
};

// One file: `variants` holds the resolved light and/or dark palette.
function sheet(family, file, mode, variants) {
  const min = family.min || 4.5;
  const raised = Object.entries(variants)
    .filter(([, r]) => r.raised.length)
    .map(([which, r]) => r.raised.join(', ') + (mode === 'auto' ? ` (${which})` : ''));
  const head = [
    '/* SPDX-License-Identifier: MIT */',
    `/* ${family.title} for Luccet, after ${family.after}${family.url ? ` (${family.url})` : ''}.`,
    `   ${MODE[mode]} Use: <script src="luccet.js" data-use="themes/${file}"></script>`,
  ];
  if (raised.length) head.push(`   Raised to ${min}:1 contrast: ${raised.join('; ')}.`);
  head.push('   Built by tools/themes.js; edit that, not this file. */');
  const body = [];
  if (mode === 'auto') {
    body.push(rootBlock('light dark', variants.light.colours));
    body.push(`@media (prefers-color-scheme: dark) {\n${declarationsOnly(variants.dark.colours)}\n}`);
  } else body.push(rootBlock(mode, variants[mode].colours));
  body.push(`@media print {\n${rootBlock('light', printPalette(), '  ')}\n}`);
  // More contrast: muted text in the text colour, rules in the strong line;
  // the dark variant's under its own query. Forced colours: luccet.css's block.
  const more = (c) => `:root { --t-muted: ${c.fg}; --t-line: ${c['line-strong']}; }`;
  if (mode === 'auto') body.push(`@media (prefers-contrast: more) {\n  ${more(variants.light.colours)}\n  @media (prefers-color-scheme: dark) { ${more(variants.dark.colours)} }\n}`);
  else body.push(`@media (prefers-contrast: more) {\n  ${more(variants[mode].colours)}\n}`);
  body.push(forcedColors());
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

// Every file of the build: {name: css}.
function build() {
  const files = {};
  for (const f of FAMILIES) {
    const min = f.min || 4.5;
    const v = {};
    if (f.light) v.light = resolve(f.light, min);
    if (f.dark) v.dark = resolve(f.dark, min);
    if (v.light && v.dark) {
      files[`${f.name}.css`] = sheet(f, `${f.name}.css`, 'auto', v);
      files[`${f.name}-light.css`] = sheet(f, `${f.name}-light.css`, 'light', { light: v.light });
      files[`${f.name}-dark.css`] = sheet(f, `${f.name}-dark.css`, 'dark', { dark: v.dark });
    } else {
      const which = v.light ? 'light' : 'dark';
      files[`${f.name}.css`] = sheet(f, `${f.name}.css`, which, { [which]: v[which] });
    }
  }
  return files;
}

function main() {
  const files = build();
  const names = Object.keys(files);
  const existing = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n.endsWith('.css')) : [];
  if (process.argv.includes('--check')) {
    const stale = names.filter((n) => !existing.includes(n) || fs.readFileSync(path.join(DIR, n), 'utf8') !== files[n]);
    const extra = existing.filter((n) => !names.includes(n));
    if (stale.length || extra.length) {
      if (stale.length) console.log(`✗ not the current build of tools/themes.js: ${stale.join(', ')}`);
      if (extra.length) console.log(`✗ in themes/ but not built by tools/themes.js: ${extra.join(', ')}`);
      console.log('  run node tools/themes.js');
      process.exit(1);
    }
    console.log(`✓ themes/ is current: ${names.length} files`);
    process.exit(0);
  }
  fs.mkdirSync(DIR, { recursive: true });
  for (const n of existing) if (!names.includes(n)) fs.unlinkSync(path.join(DIR, n));
  for (const n of names) fs.writeFileSync(path.join(DIR, n), files[n]);
  console.log(`wrote ${names.length} themes to themes/`);
}

module.exports = { FAMILIES, PAGE, CODE, COLOURS, build, resolve, printPalette, forcedColors, onMark, contrast, luminance, isLight };

if (require.main === module) main();
