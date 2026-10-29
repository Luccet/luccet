// SPDX-License-Identifier: MIT
// TeX math to MathML (docs/math.html): the engine's own math. A formula is
// tokenized, its macros expanded, parsed into MathML elements and written as
// a string; the browser lays the MathML out, in the reader's math font. The
// same code runs under node, so luccet build, luccet check and the page agree.
//
//   render(tex, {display, macros}) -> {mathml, defined} | {error}
//     macros: a table from table(); a \gdef in the formula writes into it, for
//     the formulas after (defined: true then), and its macros draw on the
//     table's reserve. Without one, the formula has a table of its own, with
//     no reserve. error: {code, at, end, message, hint}, at and end being
//     offsets into tex.
//   table(defs) -> a macro table; defs: {'\\RR': '\\mathbb{R}', …}, the page's
//     own macros (table.problems lists the ones that do not parse)
//   define(table, tex) -> error | null   a :::macros body: every definition global
//   copy(table) -> table                  a copy, for a safe root
//
// Spacing follows TeX's classes (ord, op, bin, rel, open, close, punct,
// inner). A relation's, a binary operator's and punctuation's spaces come
// from the browser's operator dictionary, which holds TeX's; what the
// dictionary cannot know is written out: a binary operator that TeX reads as
// ordinary (`-x`, `(-1)`), two relations in a row (`:=`), the thin space
// around a function name (`\sin x`) and around fractions and \left…\right.
// A formula that does not parse is an error, and the caller shows its TeX.
'use strict';

const { symbols, classes, text: TEXT_SYMBOLS } = require('./tex-symbols');

const MAX_EXPANSIONS = 10000; // macro expansions in one formula
// Tokens macro expansion may produce, so that the work and the MathML stay
// in proportion to what was written: a formula's own ten for each character
// of its TeX; past those, it draws on its page's reserve, which all the
// page's formulas share. (A macro that used itself, with a long body, grew a
// six-character formula to 200,000 tokens in 126 ms, and a page of such
// formulas took seconds.)
const TOKENS_PER_CHAR = 10;
const PAGE_TOKENS = 5000;
const MAX_DEPTH = 100; // groups nested in one formula

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- errors

function fail(code, tok, message, hint) {
  const at = tok ? tok.at : 0;
  const end = tok ? tok.end : 0;
  throw { tex: true, code, at, end, message, hint };
}

// ---------------------------------------------------------------- tokens

// A token: {t: 'cs' (a command, v its name), 'ch' (a character), 'sp' (spaces)
// or 'arg' (#n in a macro body), v, at, end}. Spaces after a command word
// are skipped, as TeX does; % starts a comment to the end of the line.
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;

function lex(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      let j = i + 1;
      if (j >= n) fail('tex.misplaced', { at: i, end: n }, 'a `\\` ends the formula', 'write `\\backslash` for a backslash');
      if (isLetter(src.charCodeAt(j))) {
        while (j < n && isLetter(src.charCodeAt(j))) j++;
        out.push({ t: 'cs', v: src.slice(i + 1, j), at: i, end: j });
        while (j < n && isSpace(src.charCodeAt(j))) j++;
      } else {
        const cp = src.codePointAt(j);
        const w = cp > 0xffff ? 2 : 1;
        out.push({ t: 'cs', v: isSpace(cp) ? ' ' : src.slice(j, j + w), at: i, end: j + w });
        j += w;
      }
      i = j;
    } else if (c === 37) {
      while (i < n && src.charCodeAt(i) !== 10) i++;
    } else if (isSpace(c)) {
      const at = i;
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      out.push({ t: 'sp', v: ' ', at, end: i });
    } else {
      const cp = src.codePointAt(i);
      let w = cp > 0xffff ? 2 : 1;
      while (i + w < n && src.charCodeAt(i + w) >= 0xfe00 && src.charCodeAt(i + w) <= 0xfe0f) w++; // a variation selector belongs to its character
      out.push({ t: 'ch', v: src.slice(i, i + w), at: i, end: i + w });
      i += w;
    }
  }
  return out;
}

const EOF = { t: 'eof', v: '', at: 0, end: 0 };
const isCh = (t, v) => t.t === 'ch' && t.v === v;
const isCs = (t, v) => t.t === 'cs' && t.v === v;

// ---------------------------------------------------------------- macros

// A macro: {n: its parameters, opt: the optional first argument's default
// (tokens) or null, body: tokens, #k as {t: 'arg', v: k}}. Built in ones are
// written in TeX and lexed on first use.
const BUILTIN = {
  iff: '\\;\\Longleftrightarrow\\;',
  implies: '\\;\\Longrightarrow\\;',
  impliedby: '\\;\\Longleftarrow\\;',
  le: '\\leq',
  ge: '\\geq',
  ne: '\\neq',
  lt: '<',
  gt: '>',
  bmod: '\\mathbin{\\operatorname{mod}}',
  pmod: { n: 1, body: '\\quad(\\operatorname{mod}\\,\\,#1)' },
  mod: { n: 1, body: '\\quad\\operatorname{mod}\\,\\,#1' },
  pod: { n: 1, body: '\\quad(#1)' },
  mathstrut: '\\vphantom{(}',
  dotsb: '\\cdots',
  dotsm: '\\cdots',
  dotsi: '\\!\\cdots',
  dotsc: '\\ldots',
  dotso: '\\ldots',
  thinspace: '\\,',
  medspace: '\\:',
  thickspace: '\\;',
  negthinspace: '\\!',
  enspace: '\\kern.5em',
  space: '\\ ',
  nobreakspace: '~',
  argmin: '\\operatorname*{arg\\,min}',
  argmax: '\\operatorname*{arg\\,max}',
  liminf: '\\operatorname*{lim\\,inf}',
  limsup: '\\operatorname*{lim\\,sup}',
  injlim: '\\operatorname*{inj\\,lim}',
  projlim: '\\operatorname*{proj\\,lim}',
  varliminf: '\\underline{\\operatorname*{lim}}',
  varlimsup: '\\overline{\\operatorname*{lim}}',
  varinjlim: '\\underrightarrow{\\operatorname*{lim}}',
  varprojlim: '\\underleftarrow{\\operatorname*{lim}}',
  plim: '\\operatorname*{plim}',
  newline: '\\\\',
  cr: '\\\\',
  bm: '\\boldsymbol',
  pmb: '\\boldsymbol',
  bold: '\\mathbf',
  Bbb: '\\mathbb',
  mathbfit: '\\boldsymbol',
  underbar: { n: 1, body: '\\underline{#1}' },
  centerdot: '\\cdot',
  emph: '\\textit',
  textnormal: '\\textrm',
  textup: '\\textrm',
  textmd: '\\textrm',
  hbox: '\\text',
  mbox: '\\text',
  ratio: ':',
  coloneq: '\\mathrel{:\\mathrel{-}}',
  vcentcolon: '\\mathrel{:}',
  ordinarycolon: ':',
  notni: '\\not\\ni',
  relax: '',
  nobreak: '',
  allowbreak: '',
  displaylimits: '',
};

function macroOf(def) {
  if (typeof def === 'string') return { n: 0, opt: null, body: params(lex(def)) };
  return { n: def.n, opt: null, body: params(lex(def.body)) };
}
const builtins = new Map();
function builtin(name) {
  if (!has(BUILTIN, name)) return null;
  let m = builtins.get(name);
  if (!m) builtins.set(name, (m = macroOf(BUILTIN[name])));
  return m;
}

// #k in a body becomes {t: 'arg', v: k}; ## is a #.
function params(toks, n = 9, at) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!isCh(t, '#')) {
      out.push(t);
      continue;
    }
    const d = toks[i + 1];
    if (d && isCh(d, '#')) {
      out.push(d), i++;
    } else if (d && d.t === 'ch' && d.v >= '1' && d.v <= '9') {
      const k = +d.v;
      if (k > n) fail('tex.macro', at || t, `#${k} is not a parameter of this macro, which has ${n}`, `use #1 to #${n}, or give the macro more parameters`);
      out.push({ t: 'arg', v: k, at: t.at, end: d.end }), i++;
    } else fail('tex.macro', t, 'a `#` in a macro body is not followed by a parameter number', 'write `#1` for the first argument, or `\\#` for the character');
  }
  return out;
}

// A macro table: {defs: Map(name -> macro), version, reserve}. version counts
// the global definitions, for the caller's caches; reserve, the tokens its
// formulas' macros may still produce past their own (PAGE_TOKENS).
function table(defs, reserve = PAGE_TOKENS) {
  const t = { defs: new Map(), version: 0, problems: [], reserve };
  if (defs && typeof defs === 'object') {
    for (const key of Object.keys(defs)) {
      const name = key.replace(/^\\/, '');
      const body = defs[key];
      if (!/^(?:[A-Za-z]+|[^A-Za-z])$/.test(name) || typeof body !== 'string') {
        t.problems.push(key);
        continue;
      }
      try {
        const toks = lex(body);
        let n = 0;
        for (let i = 0; i + 1 < toks.length; i++) if (isCh(toks[i], '#') && toks[i + 1].t === 'ch' && /[1-9]/.test(toks[i + 1].v)) n = Math.max(n, +toks[i + 1].v);
        t.defs.set(name, { n, opt: null, body: params(toks, n), user: true });
      } catch (e) {
        if (!e || !e.tex) throw e;
        t.problems.push(key);
      }
    }
  }
  return t;
}

const copy = (t) => ({ defs: new Map(t.defs), version: t.version, problems: [], reserve: t.reserve });

// ---------------------------------------------------------------- characters

// Unicode's mathematical alphanumerics: [capital A, small a, digit 0, capital
// Alpha] for each font, and the letters Unicode keeps elsewhere.
const FONTS = {
  bf: [0x1d400, 0x1d41a, 0x1d7ce, 0x1d6a8],
  it: [0x1d434, 0x1d44e, 0, 0x1d6e2],
  bfit: [0x1d468, 0x1d482, 0x1d7ce, 0x1d71c],
  cal: [0x1d49c, 0x1d4b6, 0, 0],
  frak: [0x1d504, 0x1d51e, 0, 0],
  bb: [0x1d538, 0x1d552, 0x1d7d8, 0],
  sf: [0x1d5a0, 0x1d5ba, 0x1d7e2, 0],
  tt: [0x1d670, 0x1d68a, 0x1d7f6, 0],
};
const HOLES = {
  it: { h: 'ℎ' },
  cal: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' },
  frak: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  bb: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
};
// The Greek letters' order in Unicode's mathematical Greek: Α–Ρ, ϴ, Σ–Ω, ∇,
// α–ω, ∂, ϵ, ϑ, ϰ, ϕ, ϱ, ϖ.
const GREEK = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ';

// A character in a font: [char, upright] (upright: mathvariant="normal").
function inFont(ch, font) {
  if (!font || font === 'normal') return [ch, false];
  if (font === 'rm') return [ch, true];
  const f = FONTS[font];
  if (!f) return [ch, false];
  const hole = HOLES[font] && HOLES[font][ch];
  if (hole) return [hole, false];
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90) return [String.fromCodePoint(f[0] + c - 65), false];
  if (c >= 97 && c <= 122) return [String.fromCodePoint(f[1] + c - 97), false];
  if (c >= 48 && c <= 57 && f[2]) return [String.fromCodePoint(f[2] + c - 48), false];
  const g = GREEK.indexOf(ch);
  if (g >= 0 && f[3]) return [String.fromCodePoint(f[3] + g), false];
  return [ch, false];
}

const isUpperGreek = (ch) => ch >= 'Α' && ch <= 'Ω';
const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{Nd}/u;

// ---------------------------------------------------------------- nodes

// A MathML element: {t: tag, a: attributes or null, c: children or a text,
// k: TeX class, fn: a function name (its spacing is written out), m: a
// letter that merges with its neighbours (under \mathrm and the like)}.
const el = (t, c, a, k) => ({ t, c, a: a || null, k: k || 'ord' });
const row = (kids) => (kids.length === 1 ? kids[0] : el('mrow', kids));
// A space of w (em). A negative one is a negative margin, the one way both
// Chromium and Firefox take it, in steps of TeX's mu (1/18 em): luccet.css
// has the classes t-n1 … t-n18.
function space(w) {
  if (!w.startsWith('-')) return el('mspace', [], { width: w });
  let mu = Math.round(-parseFloat(w) * 18);
  const out = [];
  for (const step of [18, 9, 5, 4, 3, 1]) for (; mu >= step; mu -= step) out.push(el('mspace', [], { class: `t-n${step}` }));
  return out.length === 1 ? out[0] : el('mrow', out);
}
const mtext = (s, cls) => el('mtext', s, cls ? { class: cls } : null);

function mo(ch, k, extra) {
  const a = extra ? Object.assign({}, extra) : {};
  if (k === 'open' || k === 'close' || k === 'ord') a.stretchy = 'false';
  if (k === 'ord' || k === 'inner') (a.lspace = '0em'), (a.rspace = '0em');
  return el('mo', ch, Object.keys(a).length ? a : null, k);
}

// The <mo> an element is an embellished form of, if any.
function core(n) {
  for (let x = n; x; ) {
    if (x.t === 'mo') return x;
    if (/^(?:msub|msup|msubsup|munder|mover|munderover|mfrac)$/.test(x.t) || ((x.t === 'mrow' || x.t === 'mstyle' || x.t === 'mpadded' || x.t === 'mphantom') && x.c.length === 1)) x = x.c[0];
    else return null;
  }
  return null;
}
const setSpace = (n, l, r) => {
  const m = core(n);
  if (!m) return;
  m.a = m.a || {};
  if (l != null) m.a.lspace = l;
  if (r != null) m.a.rspace = r;
};

// ---------------------------------------------------------------- the parser

const STYLE_ATTRS = [
  { displaystyle: 'true', scriptlevel: '0' },
  { displaystyle: 'false', scriptlevel: '0' },
  { displaystyle: 'false', scriptlevel: '1' },
  { displaystyle: 'false', scriptlevel: '2' },
];
const scriptStyle = (s) => (s < 2 ? 2 : 3);
const fracStyle = (s) => Math.min(s + 1, 3);

// Space commands, in em.
const SPACES = { ',': '0.1667em', ':': '0.2222em', '>': '0.2222em', ';': '0.2778em', '!': '-0.1667em', quad: '1em', qquad: '2em', enskip: '0.5em', negmedspace: '-0.2222em', negthickspace: '-0.2778em' };
// TeX's units in em, a 10 pt em (as KaTeX).
const UNITS = { em: 1, ex: 0.431, pt: 0.1, mm: 0.2845, cm: 2.845, in: 7.227, bp: 0.10037, pc: 1.2, dd: 0.107, cc: 1.284, mu: 1 / 18, px: 0.075 };

const DELIMS = new Map(
  Object.entries({ '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '/': '/', '<': '⟨', '>': '⟩', '.': '' }),
);
const BIG = { big: '1.2em', Big: '1.8em', bigg: '2.4em', Bigg: '3em' };

// Accents: [char, stretchy, under].
const ACCENTS = {
  hat: ['\u0302', false],
  check: ['ˇ', false],
  tilde: ['~', false],
  acute: ['´', false],
  grave: ['`', false],
  dot: ['˙', false],
  ddot: ['¨', false],
  dddot: ['\u20db', false],
  ddddot: ['\u20dc', false],
  breve: ['˘', false],
  bar: ['¯', false],
  vec: ['\u20d7', false],
  mathring: ['˚', false],
  widehat: ['\u0302', true],
  widetilde: ['˜', true],
  widecheck: ['\u030c', true],
  overrightarrow: ['→', true],
  overleftarrow: ['←', true],
  overleftrightarrow: ['↔', true],
  underrightarrow: ['→', true, true],
  underleftarrow: ['←', true, true],
  underleftrightarrow: ['↔', true, true],
  overbrace: ['⏞', true],
  underbrace: ['⏟', true, true],
  overbracket: ['⎴', true],
  underbracket: ['⎵', true, true],
  overparen: ['⏜', true],
  underparen: ['⏝', true, true],
};
// Text accents, as combining characters.
const TEXT_ACCENTS = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', r: '\u030a', k: '\u0328' };

// Extensible arrows: their char.
const XARROWS = { xrightarrow: '→', xleftarrow: '←', xRightarrow: '⇒', xLeftarrow: '⇐', xleftrightarrow: '↔', xLeftrightarrow: '⇔', xmapsto: '↦', xhookrightarrow: '↪', xhookleftarrow: '↩', xlongequal: '=', xtwoheadrightarrow: '↠', xtwoheadleftarrow: '↞' };

const FONT_CMDS = { mathrm: 'rm', mathit: 'it', mathbf: 'bf', mathsf: 'sf', mathtt: 'tt', mathbb: 'bb', mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak', mathnormal: 'normal', boldsymbol: 'bfit' };
const FONT_SWITCHES = { rm: 'rm', it: 'it', bf: 'bf', sf: 'sf', tt: 'tt', cal: 'cal', frak: 'frak' };
const TEXT_CMDS = { text: '', textrm: '', textbf: 't-bold', textit: 't-italic', textsl: 't-italic', texttt: 't-mono', textsf: 't-sans' };
const STYLES = { displaystyle: 0, textstyle: 1, scriptstyle: 2, scriptscriptstyle: 3 };
const CLASS_CMDS = { mathord: 'ord', mathop: 'op', mathbin: 'bin', mathrel: 'rel', mathopen: 'open', mathclose: 'close', mathpunct: 'punct', mathinner: 'inner' };
const PAD = { bin: '0.2222em', rel: '0.2778em', punct: null };

// Function names: [text, takes limits].
const FUNCS = {};
for (const n of 'arccos arcsin arctan arctg arcctg arg ch cos cosec cosh cot cotg coth csc ctg cth deg dim exp hom ker lg ln log sec sh sin sinh tan tanh tg th'.split(' ')) FUNCS[n] = [n, false];
for (const n of 'det gcd inf lim max min Pr sup'.split(' ')) FUNCS[n] = [n, true];

// Environments: {cols: alignment of every column or a repeating pair,
// fence: [open, close], display: cells in display style, cls: the table's
// class, gap}.
const ENVS = {
  matrix: {},
  pmatrix: { fence: ['(', ')'] },
  bmatrix: { fence: ['[', ']'] },
  Bmatrix: { fence: ['{', '}'] },
  vmatrix: { fence: ['|', '|'] },
  Vmatrix: { fence: ['‖', '‖'] },
  smallmatrix: { small: true },
  cases: { fence: ['{', ''], cls: 't-cases' },
  dcases: { fence: ['{', ''], cls: 't-cases', display: true },
  rcases: { fence: ['', '}'], cls: 't-cases' },
  aligned: { cls: 't-align', display: true, align: true },
  split: { cls: 't-align', display: true, align: true },
  alignedat: { cls: 't-align', display: true, align: true, arg: true },
  gathered: { cls: 't-gather', display: true },
  array: { spec: true },
  'align*': { cls: 't-align', display: true, align: true, block: true },
  'alignat*': { cls: 't-align', display: true, align: true, arg: true, block: true },
  'gather*': { cls: 't-gather', display: true, block: true },
  'equation*': { group: true, block: true },
};

// Commands Luccet knows of and does not do: the hint for each.
const UNSUPPORTED = {};
for (const n of ['label', 'ref', 'eqref', 'tag', 'notag', 'nonumber']) UNSUPPORTED[n] = 'number and refer to equations the Luccet way: an id after the closing `$$`, as `$$ {#eq-name}`, and `@eq-name` in the text';
for (const n of ['href', 'url', 'includegraphics', 'htmlClass', 'htmlId', 'htmlStyle', 'htmlData', 'class', 'id', 'style', 'data']) UNSUPPORTED[n] = 'a formula does not write links, images or HTML attributes: put the link or the image beside the formula';
for (const n of ['ce', 'pu']) UNSUPPORTED[n] = 'chemistry (mhchem) is not part of Luccet\'s math';
for (const n of ['verb', 'char', 'edef', 'xdef', 'newenvironment', 'renewenvironment', 'genfrac', 'above', 'atop', 'brace', 'brack', 'mathchoice', 'sideset', 'prescript', 'raisebox', 'raise', 'lower', 'rule', 'vcenter', 'hdashline', 'cline', 'multicolumn', 'cancelto', 'sout', 'textcircled', 'fcolorbox', 'definecolor', 'expandafter', 'noexpand', 'mathllap', 'mathrlap', 'mathclap', 'llap', 'rlap', 'clap', 'sfrac', 'reflectbox', 'TextOrMath', 'bordermatrix', 'begingroup', 'endgroup', 'bgroup', 'egroup']) UNSUPPORTED[n] = 'Luccet\'s math does not support it in this version';

const NUMBERED_ENVS = { align: 'align*', gather: 'gather*', equation: 'equation*', alignat: 'alignat*', multline: 'gather*', 'multline*': 'gather*', CD: '' };

// CSS colour names, for \color.
const COLOURS = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
);

class Parser {
  constructor(src, macros, display, global) {
    this.toks = lex(src);
    this.i = 0;
    this.q = []; // tokens pushed back or produced by expansion, last first
    this.table = macros;
    this.scopes = [new Map()];
    this.global = global; // a :::macros body: every definition global
    this.globalNext = false; // \global before a \def
    this.display = display;
    this.style = display ? 0 : 1;
    this.font = null;
    this.depth = 0;
    this.expansions = 0;
    this.produced = 0; // tokens its macros produced
    this.own = TOKENS_PER_CHAR * src.length; // the part of them that is the formula's own
    this.drawn = 0; // and the part drawn on the table's reserve
    this.defined = false;
  }

  // ---------------------------------------------------------------- tokens

  raw() {
    if (this.q.length) return this.q.pop();
    return this.i < this.toks.length ? this.toks[this.i++] : EOF;
  }
  unget(t) {
    if (t !== EOF) this.q.push(t);
  }
  peekRaw() {
    if (this.q.length) return this.q[this.q.length - 1];
    return this.i < this.toks.length ? this.toks[this.i] : EOF;
  }
  rawNoSpace() {
    let t;
    do t = this.raw();
    while (t.t === 'sp');
    return t;
  }

  lookup(name, prim) {
    if (!prim) {
      for (let s = this.scopes.length - 1; s >= 0; s--) {
        const m = this.scopes[s].get(name);
        if (m) return m;
      }
      const m = this.table.defs.get(name);
      if (m) return m;
    }
    return builtin(name);
  }

  // The next token with macros expanded, spaces kept.
  next() {
    for (;;) {
      const t = this.raw();
      if (t.t !== 'cs') return t;
      const m = this.lookup(t.v, t.prim);
      if (!m) return t;
      if (m.alias) return { t: 'cs', v: m.alias, at: t.at, end: t.end, prim: true };
      this.expand(m, t);
    }
  }
  nextNoSpace() {
    let t;
    do t = this.next();
    while (t.t === 'sp');
    return t;
  }

  expand(m, call) {
    if (++this.expansions > MAX_EXPANSIONS) fail('tex.limit', call, `macros were expanded more than ${MAX_EXPANSIONS} times in this formula`, 'a macro that uses itself never ends: check its definition');
    const args = [];
    let k = 0;
    if (m.opt) {
      let t = this.raw();
      while (t.t === 'sp') t = this.raw();
      if (isCh(t, '[')) args.push(this.bracketed(t));
      else this.unget(t), args.push(m.opt);
      k = 1;
    }
    for (; k < m.n; k++) args.push(this.argTokens(call, `\\${call.v} takes ${m.n} argument${m.n === 1 ? '' : 's'}`));
    // Counted before it is built: a body the budget refuses costs nothing.
    let size = 0;
    for (const b of m.body) size += b.t === 'arg' ? args[b.v - 1].length : 1;
    this.produced += size;
    const over = Math.min(size, this.produced - this.own);
    if (over > 0) {
      if (over > this.table.reserve) fail('tex.limit', call, `the macros in this formula grow it past ${(this.own + this.drawn + this.table.reserve).toLocaleString('en')} tokens, all the page has left for it`, 'a macro that uses itself grows without end: check its definition');
      this.table.reserve -= over;
      this.drawn += over;
    }
    const out = [];
    for (const b of m.body) {
      if (b.t === 'arg') for (const a of args[b.v - 1]) out.push(a);
      else out.push({ t: b.t, v: b.v, at: call.at, end: call.end, prim: b.prim });
    }
    for (let i = out.length - 1; i >= 0; i--) this.q.push(out[i]);
  }

  // An undelimited argument, unexpanded: a {group} without its braces, or one token.
  argTokens(call, what) {
    let t = this.raw();
    while (t.t === 'sp') t = this.raw();
    if (t === EOF || isCh(t, '}')) fail('tex.argument', call, `${what}, and the formula ends before it`, 'give it in braces, as `{…}`');
    if (!isCh(t, '{')) return [t];
    return this.balanced(t);
  }
  // The tokens up to the } matching the { already read.
  balanced(open) {
    const out = [];
    let depth = 1;
    for (;;) {
      const t = this.raw();
      if (t === EOF) fail('tex.unbalanced', open, 'this `{` is never closed', 'add the `}` that closes it');
      if (isCh(t, '{')) depth++;
      else if (isCh(t, '}') && --depth === 0) return out;
      out.push(t);
    }
  }
  // The tokens up to the ] matching the [ already read, at brace depth 0.
  bracketed(open) {
    const out = [];
    let depth = 0;
    for (;;) {
      const t = this.raw();
      if (t === EOF) fail('tex.unbalanced', open, 'this `[` is never closed', 'add the `]` that closes it');
      if (isCh(t, '{')) depth++;
      else if (isCh(t, '}')) depth--;
      else if (isCh(t, ']') && depth === 0) return out;
      out.push(t);
    }
  }

  // Parses tokens as their own sub-formula, in the current state.
  sub(toks, fn) {
    const saved = [this.toks, this.i, this.q];
    this.toks = toks;
    this.i = 0;
    this.q = [];
    try {
      const r = fn();
      const t = this.nextNoSpace();
      if (t !== EOF) fail(isCh(t, '}') ? 'tex.unbalanced' : 'tex.misplaced', t, isCh(t, '}') ? 'this `}` closes nothing' : `\`${shown(t)}\` cannot stand here`, isCh(t, '}') ? 'remove it, or add the `{` it closes' : 'check the brackets around it');
      return r;
    } finally {
      [this.toks, this.i, this.q] = saved;
    }
  }

  // ---------------------------------------------------------------- rows

  // Atoms up to a stop token (left for the caller); returns their elements.
  // stop(t) says whether t ends the row.
  row(stop) {
    const kids = [];
    for (;;) {
      const t = this.next();
      if (t.t === 'sp') continue;
      if (t === EOF || stop(t)) {
        this.unget(t);
        break;
      }
      // Commands that act on the rest of the row.
      if (t.t === 'cs') {
        if (has(STYLES, t.v)) {
          const s = this.style;
          this.style = STYLES[t.v];
          const rest = finish(this.row(stop), this.style);
          this.style = s;
          kids.push(el('mstyle', rest, STYLE_ATTRS[STYLES[t.v]]));
          break;
        }
        if (has(FONT_SWITCHES, t.v)) {
          const f = this.font;
          this.font = FONT_SWITCHES[t.v];
          for (const k of this.row(stop)) kids.push(k);
          this.font = f;
          break;
        }
        if (t.v === 'color') {
          const c = this.colour(t);
          const rest = finish(this.row(stop), this.style);
          kids.push(el('mrow', rest, { mathcolor: c }));
          break;
        }
        if (t.v === 'over' || t.v === 'choose') {
          const s = this.style;
          this.style = fracStyle(s);
          const num = finish(kids.splice(0), s); // taken out of the row, which then holds the fraction
          const den = this.row(stop);
          this.style = s;
          const frac = el('mfrac', [row(num), row(finish(den, fracStyle(s)))], t.v === 'choose' ? { linethickness: '0' } : null, 'inner');
          kids.push(t.v === 'choose' ? fenced('(', ')', [frac]) : frac);
          continue;
        }
      }
      if (isCh(t, '^') || isCh(t, '_') || isCh(t, "'")) {
        this.unget(t);
        kids.push(this.scripts(el('mrow', [])));
        continue;
      }
      const base = this.atom(t);
      if (base) kids.push(this.scripts(base));
    }
    return kids;
  }

  // The scripts after a base: ^, _, primes, \limits and \nolimits.
  scripts(base) {
    let sup = null;
    let sub = null;
    let limits = null;
    let primes = null;
    for (;;) {
      const t = this.nextNoSpace();
      if (t.t === 'cs' && (t.v === 'limits' || t.v === 'nolimits')) {
        if (base.k !== 'op') fail('tex.misplaced', t, `\\${t.v} follows something that is not an operator`, 'it goes right after an operator such as `\\sum` or `\\int`');
        limits = t.v === 'limits';
        continue;
      }
      if (isCh(t, "'")) {
        let n = 1;
        for (let p = this.peekRaw(); isCh(p, "'"); p = this.peekRaw()) this.raw(), n++;
        if (sup) fail('tex.script', t, 'a prime after a superscript', 'put the prime first: `f\'^2`');
        primes = mo(n === 1 ? '′' : n === 2 ? '″' : n === 3 ? '‴' : '′'.repeat(n), 'ord');
        delete primes.a.stretchy;
        continue;
      }
      if (isCh(t, '^') || isCh(t, '_')) {
        const up = t.v === '^';
        if (up ? sup : sub) fail('tex.script', t, `a second ${up ? 'superscript' : 'subscript'}`, up ? 'write `x^{ab}` for one superscript, or `{x^a}^b` for a superscript on a superscript' : 'write `x_{ab}` for one subscript, or `{x_a}_b`');
        const s = this.style;
        this.style = scriptStyle(s);
        const arg = this.arg(t, up ? 'a superscript' : 'a subscript');
        this.style = s;
        if (up) sup = arg;
        else sub = arg;
        continue;
      }
      this.unget(t);
      break;
    }
    // A prime follows its base at full size: the font's prime is already
    // raised, and as a superscript Chromium shrinks and raises it again.
    if (primes) base = el('mrow', [base, primes], null, base.k);
    if (!sup && !sub) return base;
    const k = base.k;
    // Above and below, or beside: a large operator with limits, a function
    // name that takes them (\lim), a brace (\underbrace), \limits.
    const over = limits === true || (limits === null && base.limits);
    if (over) {
      let b = base;
      if (base.fn && base.t === 'mi') b = el('mo', base.c, { movablelimits: 'true', lspace: '0em', rspace: '0em' }, 'op');
      else if (base.t === 'mo' && limits === true) b.a = Object.assign({}, b.a, { movablelimits: 'false' });
      const n = sub && sup ? el('munderover', [b, sub, sup]) : sub ? el('munder', [b, sub]) : el('mover', [b, sup]);
      n.k = k;
      n.fn = base.fn;
      return n;
    }
    const n = sub && sup ? el('msubsup', [base, sub, sup]) : sub ? el('msub', [base, sub]) : el('msup', [base, sup]);
    n.k = k;
    n.fn = base.fn;
    return n;
  }

  // A mandatory argument parsed as math: a {group} or one atom.
  arg(at, what) {
    const t = this.nextNoSpace();
    if (t === EOF || isCh(t, '}') || isCh(t, '&') || isCs(t, '\\') || isCs(t, 'end') || isCs(t, 'right')) fail('tex.argument', at, `${what} is missing`, 'give it in braces, as `{…}`');
    if (isCh(t, '{')) return this.group(t);
    if (isCh(t, '^') || isCh(t, '_')) fail('tex.script', t, `${what} cannot start with \`${t.v}\``, 'put it in braces');
    if (t.t === 'ch' && t.v >= '0' && t.v <= '9') return el('mn', this.font && this.font !== 'normal' && this.font !== 'rm' ? inFont(t.v, this.font)[0] : t.v);
    // An argument without braces nests as a group does (\sqrt\sqrt x), and a
    // macro that is its own argument (\def\R{\mathbb\R}) would nest forever.
    if (++this.depth > MAX_DEPTH) fail('tex.limit', t, `arguments nest more than ${MAX_DEPTH} deep in this formula`, 'a macro that uses itself never ends: check its definition');
    const a = this.atom(t);
    this.depth--;
    return a || el('mrow', []);
  }
  // A {group} as a row, its { already read: TeX's ordinary atom.
  group(open) {
    if (++this.depth > MAX_DEPTH) fail('tex.limit', open, `groups nest more than ${MAX_DEPTH} deep in this formula`, 'simplify the formula');
    this.scopes.push(new Map());
    const f = this.font;
    const s = this.style;
    const kids = this.row((t) => isCh(t, '}'));
    const end = this.next();
    this.font = f;
    this.style = s;
    this.scopes.pop();
    this.depth--;
    if (!isCh(end, '}')) fail('tex.unbalanced', open, 'this `{` is never closed', 'add the `}` that closes it');
    const out = finish(kids, this.style);
    if (out.length === 1 && (out[0].t === 'mi' || out[0].t === 'mn' || out[0].t === 'mtext')) {
      out[0].m = null; // \mathrm{a}\mathrm{b}: two names, not one
      return out[0];
    }
    return el('mrow', out);
  }
  // An argument read as raw text (a name, a colour, a length).
  textArg(at, what) {
    const toks = this.argTokens(at, what);
    let s = '';
    for (const t of toks) s += t.t === 'cs' ? `\\${t.v}` : t.v;
    return s.trim();
  }
  optText() {
    const t = this.peekNoSpaceRaw();
    if (!isCh(t, '[')) return null;
    this.rawNoSpace();
    return this.bracketed(t).map((x) => (x.t === 'cs' ? `\\${x.v}` : x.v)).join('').trim();
  }
  peekNoSpaceRaw() {
    let t = this.raw();
    while (t.t === 'sp') t = this.raw();
    this.unget(t);
    return t;
  }
  star() {
    const t = this.peekRaw();
    if (isCh(t, '*')) return this.raw(), true;
    return false;
  }

  // ---------------------------------------------------------------- atoms

  // One atom from token t: an element, or null for a command that writes
  // nothing (a definition).
  atom(t) {
    if (t.t === 'ch') return this.char(t);
    if (t.t !== 'cs') fail('tex.misplaced', t, `\`${shown(t)}\` cannot stand here`, '');
    const name = t.v;
    const sym = symbols.get(name);
    if (sym && !has(COMMANDS, name)) return this.symbol(sym[0], sym[1], t);
    if (has(COMMANDS, name)) return COMMANDS[name].call(this, t);
    if (has(FUNCS, name)) return this.fname(FUNCS[name][0], FUNCS[name][1]);
    if (has(ACCENTS, name)) return this.accent(t, ACCENTS[name]);
    if (has(XARROWS, name)) return this.xarrow(t, XARROWS[name]);
    if (has(FONT_CMDS, name)) return this.inFont(t, FONT_CMDS[name]);
    if (has(TEXT_CMDS, name)) return this.text(t, TEXT_CMDS[name]);
    if (has(SPACES, name)) return space(SPACES[name]);
    if (has(CLASS_CMDS, name)) return this.classed(t, CLASS_CMDS[name]);
    if (has(BIG, name.replace(/[lrm]$/, '')) && /^[bB]ig/.test(name)) return this.big(t);
    if (has(UNSUPPORTED, name)) fail('tex.unsupported', t, `\\${name} is not supported`, UNSUPPORTED[name]);
    if (TEXT_SYMBOLS.has(name)) fail('tex.misplaced', t, `\\${name} is for text`, `write it inside \\text{…}`);
    const near = nearest(name, this);
    fail('tex.unknown', t, `\\${name} is not a command Luccet knows`, near ? `did you mean \`\\${near}\`? Or define it in a :::macros block` : 'define it in a :::macros block, or check its spelling');
  }

  char(t) {
    const c = t.v;
    if (isLetter(c.charCodeAt(0)) && c.length === 1) return this.letter(c);
    if (c >= '0' && c <= '9') return this.number(c);
    switch (c) {
      case '{':
        return this.group(t);
      case '}':
        fail('tex.unbalanced', t, 'this `}` closes nothing', 'remove it, or add the `{` it closes');
        break;
      case '&':
        fail('tex.misplaced', t, '`&` outside an environment', this.display ? 'to align lines, put them in `\\begin{aligned}` … `\\end{aligned}`; for an ampersand write `\\&`' : 'for an ampersand write `\\&`');
        break;
      case '#':
        fail('tex.misplaced', t, '`#` outside a macro definition', 'for the character write `\\#`');
        break;
      case '$':
        fail('tex.misplaced', t, '`$` inside a formula', 'for a dollar sign write `\\$`');
        break;
      case '~':
        return mtext('\u00a0');
      case '-':
        return mo('−', 'bin');
      case '*':
        return mo('∗', 'bin');
      case '+':
        return mo('+', 'bin');
      case '=':
      case '<':
      case '>':
        return mo(c, 'rel');
      case ',':
      case ';':
        return mo(c, 'punct');
      case '(':
      case '[':
        return mo(c, 'open');
      case ')':
      case ']':
        return mo(c, 'close');
      case '!':
      case '?':
        return mo(c, 'close', { lspace: '0em', rspace: '0em' });
      case ':':
        return mo(':', 'rel', { lspace: '0.2778em', rspace: '0.2778em' });
      case '|':
      case '/':
      case '.':
        return mo(c, 'ord');
      case '@':
      case '"':
        return el('mi', c);
      case '`':
        return el('mi', '‘');
      default: {
        const k = classes.get(c);
        if (k) return this.symbol(k, c, t);
        if (LETTER_RE.test(c)) return this.letter(c);
        if (DIGIT_RE.test(c)) return el('mn', c);
        return mo(c, 'ord');
      }
    }
    return null;
  }

  letter(c) {
    const [ch, upright] = inFont(c, this.font);
    const n = el('mi', ch, upright ? { mathvariant: 'normal' } : null);
    if (this.font && this.font !== 'normal') n.m = this.font;
    return n;
  }

  // Digits, with a . between digits: one <mn>.
  number(c) {
    let s = c;
    for (;;) {
      const p = this.peekRaw();
      if (p.t === 'ch' && p.v >= '0' && p.v <= '9') s += this.raw().v;
      else if (isCh(p, '.') && this.i < this.toks.length && !this.q.length && this.toks[this.i + 1] && this.toks[this.i + 1].t === 'ch' && /[0-9]/.test(this.toks[this.i + 1].v)) s += this.raw().v;
      else break;
    }
    if (this.font && this.font !== 'normal' && this.font !== 'rm') s = [...s].map((d) => inFont(d, this.font)[0]).join('');
    return el('mn', s);
  }

  symbol(k, ch, t) {
    if (k === 'mi') {
      if (this.font && this.font !== 'normal' && this.font !== 'rm') {
        const [c] = inFont(ch, this.font);
        if (c !== ch) return el('mi', c);
      }
      // MathML italicises a single letter, Greek and ∇ included; TeX sets
      // capital Greek and \nabla upright.
      if (this.font === 'rm' || isUpperGreek(ch) || ch === '∇') return el('mi', ch, { mathvariant: 'normal' });
      return el('mi', ch);
    }
    if (k === 'op' || k === 'opn') {
      const n = mo(ch, 'op');
      n.limits = k === 'op';
      return n;
    }
    return mo(ch, k);
  }

  // \sin, \lim, \operatorname: an upright name whose spacing is written out.
  fname(name, limits) {
    const n = el('mi', name, null, 'op');
    n.fn = true;
    n.limits = limits;
    return n;
  }

  accent(t, [ch, stretchy, under]) {
    const base = this.arg(t, `\\${t.v}'s argument`);
    const m = el('mo', ch, { stretchy: stretchy ? 'true' : 'false' });
    const n = under ? el('munder', [base, m], { accentunder: 'true' }) : el('mover', [base, m], { accent: 'true' });
    if (t.v === 'overbrace' || t.v === 'underbrace' || t.v === 'overbracket' || t.v === 'underbracket' || t.v === 'overparen' || t.v === 'underparen') {
      n.k = 'op';
      n.limits = true;
    }
    return n;
  }

  xarrow(t, ch) {
    const below = this.optArg();
    const above = this.arg(t, `\\${t.v}'s label`);
    const m = el('mo', ch, { stretchy: 'true', minsize: '1.8em', lspace: '0.2778em', rspace: '0.2778em' }, 'rel');
    const pad = (x) => el('mrow', [space('0.3em'), x, space('0.3em')]);
    const n = below ? el('munderover', [m, pad(below), pad(above)]) : el('mover', [m, pad(above)]);
    n.k = 'rel';
    return n;
  }

  optArg() {
    const t = this.peekNoSpaceRaw();
    if (!isCh(t, '[')) return null;
    this.rawNoSpace();
    const toks = this.bracketed(t);
    return row(finish(this.sub(toks, () => this.row(() => false)), this.style));
  }

  inFont(t, font) {
    const f = this.font;
    this.font = font;
    const a = this.arg(t, `\\${t.v}'s argument`);
    this.font = f;
    return a;
  }

  classed(t, k) {
    const a = this.arg(t, `\\${t.v}'s argument`);
    const one = a.t === 'mo' || a.t === 'mi' || a.t === 'mn' ? a : null;
    if (k === 'op') {
      const n = one && one.t !== 'mn' ? el(one.t === 'mo' ? 'mo' : 'mi', one.c, one.t === 'mo' ? { lspace: '0em', rspace: '0em' } : one.a, 'op') : el('mrow', [a], null, 'op');
      n.fn = true;
      n.limits = n.t === 'mo';
      return n;
    }
    if (k === 'ord' || k === 'inner') {
      const n = one && one.t !== 'mo' ? one : el('mrow', [a]);
      n.k = k;
      return n;
    }
    if (one) {
      const pad = PAD[k] || '0em';
      return el('mo', one.c, { lspace: k === 'punct' || k === 'open' ? '0em' : k === 'close' ? '0em' : pad, rspace: k === 'punct' ? '0.1667em' : k === 'open' || k === 'close' ? '0em' : pad, stretchy: 'false' }, k);
    }
    const n = el('mrow', [a], null, k);
    n.pad = PAD[k] || null;
    return n;
  }

  big(t) {
    const size = BIG[t.v.replace(/[lrm]$/, '')];
    const side = /[lrm]$/.test(t.v) && t.v !== 'big' && t.v !== 'Big' ? t.v.slice(-1) : '';
    const d = this.delim(t);
    const k = side === 'l' ? 'open' : side === 'r' ? 'close' : side === 'm' ? 'rel' : 'ord';
    if (!d) return space('0em');
    const a = { minsize: size, maxsize: size, stretchy: 'true', symmetric: 'true' };
    if (k === 'ord') (a.lspace = '0em'), (a.rspace = '0em');
    if (k === 'open' || k === 'close') a.fence = 'true';
    return el('mo', d, a, k);
  }

  // A delimiter after \left, \right, \middle or \big: its char ('' for .).
  delim(at) {
    const t = this.nextNoSpace();
    if (t.t === 'ch' && DELIMS.has(t.v)) return DELIMS.get(t.v);
    if (t.t === 'cs') {
      if (t.v === '{' || t.v === 'lbrace') return '{';
      if (t.v === '}' || t.v === 'rbrace') return '}';
      const s = symbols.get(t.v);
      if (s && (s[0] === 'open' || s[0] === 'close' || s[0] === 'ord' || (s[0] === 'rel' && /[↑↓↕⇑⇓⇕]/.test(s[1])) || t.v === 'backslash')) return s[1];
    }
    fail('tex.argument', t === EOF ? at : t, `\\${at.v} needs a delimiter${t === EOF ? '' : `, and \`${shown(t)}\` is not one`}`, 'a delimiter is a bracket, a bar or `.` for none: `(`, `[`, `\\{`, `|`, `\\langle` …');
  }

  colour(at) {
    let model = this.optText();
    let c = this.textArg(at, `\\${at.v} needs a colour`);
    if (model) {
      if (model !== 'HTML' || !/^[0-9a-fA-F]{6}$/.test(c)) fail('tex.argument', at, `the colour [${model}]{${c}} is not one Luccet reads`, 'give a CSS colour name or a hex colour: `red`, `#c0392b`, `[HTML]{C0392B}`');
      c = `#${c}`;
    }
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) || COLOURS.has(c.toLowerCase())) return c.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
    fail('tex.argument', at, `\`${c}\` is not a colour Luccet reads`, 'give a CSS colour name or a hex colour: `red`, `#c0392b`, `[HTML]{C0392B}`');
  }

  length(at) {
    const s = this.textArg(at, `\\${at.v} needs a length`);
    const m = /^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]{2})$/.exec(s);
    if (!m || !UNITS[m[2]]) fail('tex.argument', at, `\`${s}\` is not a length`, 'write a number and a unit: `1em`, `3pt`, `2mu`');
    return `${+(+m[1] * UNITS[m[2]]).toFixed(4)}em`;
  }

  // ---------------------------------------------------------------- text

  // \text{…}: text, with $…$ inside as math; cls is the text's class.
  text(at, cls) {
    let t = this.nextNoSpace();
    if (t === EOF || isCh(t, '}')) fail('tex.argument', at, `\\${at.v}'s text is missing`, 'give it in braces, as `\\text{…}`');
    const parts = [];
    let s = '';
    const flush = () => {
      if (s) parts.push(mtext(edge(s), cls || null)), (s = '');
    };
    const one = !isCh(t, '{');
    if (!one) t = this.next();
    let depth = 0;
    for (;;) {
      if (t === EOF) fail('tex.unbalanced', at, `\\${at.v}'s text is never closed`, 'add the `}` that closes it');
      if (!one && isCh(t, '}')) {
        if (depth === 0) break;
        depth--;
      } else if (!one && isCh(t, '{')) depth++;
      else if (t.t === 'sp') s += ' ';
      else if (isCh(t, '$')) {
        flush();
        const f = this.font;
        this.font = null;
        const kids = this.row((x) => isCh(x, '$'));
        this.font = f;
        const end = this.next();
        if (!isCh(end, '$')) fail('tex.unbalanced', t, 'this `$` in the text is never closed', 'add the `$` that ends the formula');
        parts.push(row(finish(kids, this.style)));
      } else if (t.t === 'ch') {
        if (t.v === '~') s += '\u00a0';
        else if (t.v === '-' && isCh(this.peekRaw(), '-')) {
          this.raw();
          if (isCh(this.peekRaw(), '-')) this.raw(), (s += '—');
          else s += '–';
        } else if (t.v === '`') s += isCh(this.peekRaw(), '`') ? (this.raw(), '“') : '‘';
        else if (t.v === "'") s += isCh(this.peekRaw(), "'") ? (this.raw(), '”') : '’';
        else if (t.v === '^' || t.v === '_' || t.v === '&' || t.v === '#') fail('tex.misplaced', t, `\`${t.v}\` in text`, `for the character write \`\\${t.v}\``);
        else s += t.v;
      } else if (t.t === 'cs') {
        const v = t.v;
        if (has(TEXT_ACCENTS, v)) {
          const a = this.textArg(t, `\\${v} needs a letter`);
          s += (a.replace(/^\\([ij])$/, (_, x) => (x === 'i' ? 'ı' : 'ȷ')) + TEXT_ACCENTS[v]).normalize('NFC');
        } else if (TEXT_SYMBOLS.has(v)) s += TEXT_SYMBOLS.get(v);
        else if (v === ' ' || v === 'space') s += ' ';
        else if (v === ',' || v === 'thinspace') s += '\u2009';
        else if (v === 'quad') s += '\u2003';
        else if (v === 'qquad') s += '\u2003\u2003';
        else if (v === 'enspace') s += '\u2002';
        else if (has(TEXT_CMDS, v)) {
          flush();
          parts.push(this.text(t, TEXT_CMDS[v] || cls));
        } else if (v === 'relax' || v === 'nobreak' || v === 'allowbreak') {
          // nothing
        } else if (v === '\\') fail('tex.misplaced', t, '`\\\\` in text', 'a formula\'s text is one line');
        else fail('tex.unknown', t, `\\${v} is not a text command Luccet knows`, 'outside \\text{…} it may be a math command; in text, write the character itself');
      }
      if (one) break;
      t = this.next();
    }
    flush();
    if (!parts.length) return mtext('');
    return parts.length === 1 ? parts[0] : el('mrow', parts);
  }

  // ---------------------------------------------------------------- definitions

  defineMacro(name, m, global, tok) {
    m.user = true;
    if (global || this.global) {
      this.table.defs.set(name, m);
      this.table.version++;
      this.defined = true;
    } else this.scopes[this.scopes.length - 1].set(name, m);
    return null;
  }

  isDefined(name) {
    return !!this.lookup(name) || symbols.has(name) || [COMMANDS, FUNCS, ACCENTS, XARROWS, FONT_CMDS, FONT_SWITCHES, TEXT_CMDS, SPACES, STYLES, CLASS_CMDS].some((o) => has(o, name));
  }

  // The command a definition names: \foo or {\foo}.
  defName(at) {
    let t = this.rawNoSpace();
    if (isCh(t, '{')) {
      const inner = this.balanced(t).filter((x) => x.t !== 'sp');
      if (inner.length !== 1 || inner[0].t !== 'cs') fail('tex.macro', t, `\\${at.v} names its macro as \`\\name\``, `write \`\\${at.v}{\\name}{…}\``);
      t = inner[0];
    }
    if (t.t !== 'cs') fail('tex.macro', t === EOF ? at : t, `\\${at.v} needs the name of the macro to define`, `write \`\\${at.v}{\\name}{…}\``);
    return t;
  }
}

// The commands with their own parsing.
const COMMANDS = {
  dfrac(t) {
    return styled(0, COMMANDS.frac.call(this, t, 1));
  },
  tfrac(t) {
    return styled(1, COMMANDS.frac.call(this, t, 2));
  },
  dbinom(t) {
    return styled(0, COMMANDS.binom.call(this, t, 1));
  },
  tbinom(t) {
    return styled(1, COMMANDS.binom.call(this, t, 2));
  },
  colon() {
    return el('mo', ':', { lspace: '0em', rspace: '0.1667em' }, 'punct');
  },
  frac(t, inner) {
    const s = this.style;
    this.style = inner || fracStyle(s);
    const num = this.arg(t, 'the numerator of \\frac');
    const den = this.arg(t, 'the denominator of \\frac');
    this.style = s;
    return el('mfrac', [num, den], null, 'inner');
  },
  cfrac(t) {
    const num = this.arg(t, 'the numerator of \\cfrac');
    const den = this.arg(t, 'the denominator of \\cfrac');
    return el('mstyle', [el('mfrac', [el('mstyle', [num], STYLE_ATTRS[0]), el('mstyle', [den], STYLE_ATTRS[0])])], STYLE_ATTRS[0], 'inner');
  },
  binom(t, inner) {
    const s = this.style;
    this.style = inner || fracStyle(s);
    const top = this.arg(t, 'the top of \\binom');
    const bottom = this.arg(t, 'the bottom of \\binom');
    this.style = s;
    return fenced('(', ')', [el('mfrac', [top, bottom], { linethickness: '0' })]);
  },
  sqrt(t) {
    const index = this.optArg();
    const body = this.arg(t, 'the argument of \\sqrt');
    return index ? el('mroot', [body, index]) : el('msqrt', body.t === 'mrow' ? body.c : [body]);
  },
  left(t) {
    const open = this.delim(t);
    if (++this.depth > MAX_DEPTH) fail('tex.limit', t, `groups nest more than ${MAX_DEPTH} deep in this formula`, 'simplify the formula');
    this.scopes.push(new Map());
    const kids = [];
    if (open) kids.push(el('mo', open, { fence: 'true', form: 'prefix', stretchy: 'true', symmetric: 'true' }, 'open'));
    for (;;) {
      const part = finish(this.row((x) => isCs(x, 'right') || isCs(x, 'middle')), this.style);
      for (const p of part) kids.push(p);
      const end = this.next();
      if (end === EOF) fail('tex.unbalanced', t, '`\\left` without its `\\right`', 'close it with `\\right)`, or `\\right.` for no delimiter');
      const d = this.delim(end);
      if (end.v === 'middle') {
        kids.push(el('mo', d, { fence: 'true', form: 'infix', stretchy: 'true', symmetric: 'true', lspace: '0.05em', rspace: '0.05em' }, 'rel'));
        continue;
      }
      if (d) kids.push(el('mo', d, { fence: 'true', form: 'postfix', stretchy: 'true', symmetric: 'true' }, 'close'));
      break;
    }
    this.scopes.pop();
    this.depth--;
    return el('mrow', kids, null, 'inner');
  },
  right(t) {
    fail('tex.unbalanced', t, '`\\right` without a `\\left`', 'open it with `\\left(`, or `\\left.` for no delimiter');
  },
  middle(t) {
    fail('tex.misplaced', t, '`\\middle` outside `\\left` … `\\right`', 'put it between a `\\left` and its `\\right`');
  },
  not(t) {
    const n = this.nextNoSpace();
    let ch = null;
    let k = 'rel';
    if (n.t === 'ch' && /^[=<>]$/.test(n.v)) ch = n.v;
    else if (n.t === 'cs' && symbols.has(n.v)) [k, ch] = symbols.get(n.v);
    else if (n.t === 'ch' && classes.has(n.v)) (ch = n.v), (k = classes.get(n.v));
    if (!ch) {
      this.unget(n);
      return el('mpadded', [mo('⧸', 'ord')], { width: '0em' });
    }
    const c = (ch + '\u0338').normalize('NFC');
    return k === 'mi' ? el('mi', c) : mo(c, k);
  },
  operatorname(t) {
    const limits = this.star();
    const f = this.font;
    this.font = 'rm';
    const a = this.arg(t, '\\operatorname\'s name');
    this.font = f;
    const n = a.t === 'mi' ? el('mi', a.c, a.c.length > 1 ? null : { mathvariant: 'normal' }, 'op') : el('mrow', a.t === 'mrow' ? a.c : [a], null, 'op');
    n.fn = true;
    n.limits = limits;
    return n;
  },
  operatornamewithlimits(t) {
    this.unget({ t: 'ch', v: '*', at: t.at, end: t.end });
    return COMMANDS.operatorname.call(this, t);
  },
  overset(t) {
    const top = this.arg(t, 'the top of \\overset');
    const base = this.arg(t, 'the base of \\overset');
    const n = el('mover', [base, top]);
    n.k = base.k;
    return n;
  },
  underset(t) {
    const bottom = this.arg(t, 'the bottom of \\underset');
    const base = this.arg(t, 'the base of \\underset');
    const n = el('munder', [base, bottom]);
    n.k = base.k;
    return n;
  },
  stackrel(t) {
    const top = this.arg(t, 'the top of \\stackrel');
    const base = this.arg(t, 'the base of \\stackrel');
    return el('mover', [base, top], null, 'rel');
  },
  overline(t) {
    return el('mrow', [this.arg(t, 'the argument of \\overline')], { class: 't-overline' });
  },
  underline(t) {
    return el('mrow', [this.arg(t, 'the argument of \\underline')], { class: 't-underline' });
  },
  boxed(t) {
    const a = this.arg(t, 'the argument of \\boxed');
    return el('mrow', [a], { class: 't-boxed' });
  },
  fbox(t) {
    const a = this.text(t, '');
    return el('mrow', [a], { class: 't-boxed' });
  },
  cancel(t) {
    return el('mrow', [this.arg(t, 'the argument of \\cancel')], { class: 't-cancel' });
  },
  bcancel(t) {
    return el('mrow', [this.arg(t, 'the argument of \\bcancel')], { class: 't-bcancel' });
  },
  xcancel(t) {
    return el('mrow', [this.arg(t, 'the argument of \\xcancel')], { class: 't-xcancel' });
  },
  phantom(t) {
    return el('mphantom', [this.arg(t, 'the argument of \\phantom')]);
  },
  hphantom(t) {
    return el('mpadded', [el('mphantom', [this.arg(t, 'the argument of \\hphantom')])], { height: '0', depth: '0' });
  },
  vphantom(t) {
    return el('mpadded', [el('mphantom', [this.arg(t, 'the argument of \\vphantom')])], { width: '0' });
  },
  smash(t) {
    this.optText();
    return el('mpadded', [this.arg(t, 'the argument of \\smash')], { height: '0', depth: '0' });
  },
  textcolor(t) {
    const c = this.colour(t);
    const a = this.arg(t, 'the argument of \\textcolor');
    return el('mrow', [a], { mathcolor: c });
  },
  colorbox(t) {
    const c = this.colour(t);
    return el('mrow', [this.text(t, '')], { mathbackground: c, class: 't-colorbox' });
  },
  hspace(t) {
    this.star();
    return space(this.length(t));
  },
  kern(t) {
    return space(this.kernLength(t));
  },
  mkern(t) {
    return space(this.kernLength(t));
  },
  mskip(t) {
    return space(this.kernLength(t));
  },
  hskip(t) {
    return space(this.kernLength(t));
  },
  ' '() {
    return mtext('\u00a0');
  },
  dots(t) {
    // amsmath's \dots: \cdots before an operator or a relation, else \ldots.
    const p = this.nextNoSpace();
    this.unget(p);
    let k = null;
    if (p.t === 'ch') k = /[+\-*=<>]/.test(p.v) ? 'bin' : null;
    else if (p.t === 'cs' && symbols.has(p.v)) k = symbols.get(p.v)[0];
    return mo(k === 'bin' || k === 'rel' ? '⋯' : '…', 'inner');
  },
  substack(t) {
    const open = this.nextNoSpace();
    if (!isCh(open, '{')) fail('tex.argument', t, '\\substack takes its lines in braces', 'write `\\substack{i<n \\\\ j<m}`');
    const rows = this.cells(open, (x) => isCh(x, '}'), {});
    const end = this.next();
    if (!isCh(end, '}')) fail('tex.unbalanced', open, 'this `{` is never closed', 'add the `}` that closes it');
    return this.mtable(rows, { cls: 't-substack' });
  },
  begin(t) {
    const name = this.textArg(t, '\\begin needs an environment name');
    if (has(NUMBERED_ENVS, name)) fail('tex.unsupported', t, `the environment ${name} is not supported`, NUMBERED_ENVS[name] ? `use \`${NUMBERED_ENVS[name]}\`, or \`aligned\` or \`gathered\`; Luccet numbers the equation, with an id after the closing \`$$\`` : 'commutative diagrams are not part of Luccet\'s math');
    const env = has(ENVS, name) ? ENVS[name] : null;
    if (!env) fail('tex.unknown', t, `\\begin{${name}} is not an environment Luccet knows`, 'the environments are matrix, pmatrix, bmatrix, Bmatrix, vmatrix, Vmatrix, smallmatrix, cases, dcases, rcases, aligned, alignedat, split, gathered, array, and in display math align*, gather* and equation*');
    if (env.block && !this.display) fail('tex.misplaced', t, `\\begin{${name}} is for display math`, `put it in a \`$$\` block, or use ${name.startsWith('gather') ? '`gathered`' : '`aligned`'} here`);
    let spec = null;
    if (env.spec) spec = this.colSpec(t);
    if (env.arg) this.textArg(t, `\\begin{${name}} needs its number of columns`);
    if (++this.depth > MAX_DEPTH) fail('tex.limit', t, `groups nest more than ${MAX_DEPTH} deep in this formula`, 'simplify the formula');
    this.scopes.push(new Map());
    const s = this.style;
    this.style = env.display ? 0 : env.small ? 2 : 1;
    let rows;
    let body;
    if (env.group) body = finish(this.row((x) => isCs(x, 'end')), this.style);
    else rows = this.cells(t, (x) => isCs(x, 'end'), env);
    this.style = s;
    const end = this.next();
    if (!isCs(end, 'end')) fail('tex.unbalanced', t, `\\begin{${name}} is never closed`, `add \`\\end{${name}}\``);
    const closing = this.textArg(end, '\\end needs an environment name');
    if (closing !== name) fail('tex.unbalanced', end, `\\begin{${name}} ends with \\end{${closing}}`, `close it with \`\\end{${name}}\``);
    this.scopes.pop();
    this.depth--;
    if (env.group) return row(body);
    const tbl = this.mtable(rows, env, spec);
    if (!env.fence) return tbl;
    return fenced(env.fence[0], env.fence[1], [tbl]);
  },
  end(t) {
    fail('tex.unbalanced', t, '`\\end` without its `\\begin`', 'remove it, or add the `\\begin{…}` it closes');
  },
  hline(t) {
    fail('tex.misplaced', t, '`\\hline` outside an array', 'it goes at the start of a row of an `array`');
  },
  '\\'(t) {
    fail('tex.misplaced', t, '`\\\\` outside an environment', this.display ? 'to break the formula into lines, put them in `\\begin{gathered}` … `\\end{gathered}` (or `aligned`)' : 'an inline formula is one line; break it in display math');
  },
  limits(t) {
    fail('tex.misplaced', t, `\\${t.v} follows something that is not an operator`, 'it goes right after an operator such as `\\sum` or `\\int`');
  },
  // Definitions.
  global(t) {
    const n = this.rawNoSpace();
    if (!(n.t === 'cs' && (n.v === 'def' || n.v === 'let' || n.v === 'gdef'))) fail('tex.macro', t, '\\global goes before \\def or \\let', 'write `\\global\\def\\name{…}`, or `\\gdef`');
    return COMMANDS[n.v].call(this, n, true);
  },
  def(t, global) {
    const name = this.rawNoSpace();
    if (name.t !== 'cs') fail('tex.macro', name === EOF ? t : name, `\\${t.v} needs the name of the macro to define`, `write \`\\${t.v}\\name{…}\``);
    let n = 0;
    for (;;) {
      const p = this.raw();
      if (isCh(p, '{')) {
        const body = params(this.balanced(p), n, name);
        return this.defineMacro(name.v, { n, opt: null, body }, global || t.v === 'gdef', t);
      }
      if (isCh(p, '#')) {
        const d = this.raw();
        if (d.t === 'ch' && +d.v === n + 1) {
          n++;
          continue;
        }
      }
      if (p === EOF) fail('tex.macro', t, `\\${t.v}\\${name.v} has no body`, `write \`\\${t.v}\\${name.v}{…}\``);
      fail('tex.unsupported', p, `\\${t.v}\\${name.v}'s parameters are not #1, #2 … in order`, 'Luccet reads plain parameters, #1#2…, and no delimited ones');
    }
  },
  gdef(t) {
    return COMMANDS.def.call(this, t, true);
  },
  newcommand(t) {
    const star = this.star();
    void star;
    const name = this.defName(t);
    const defined = this.isDefined(name.v);
    if (t.v === 'newcommand' && defined) fail('tex.macro', name, `\\${name.v} is already defined`, `use \\renewcommand to redefine it`);
    if (t.v === 'renewcommand' && !defined) fail('tex.macro', name, `\\${name.v} is not defined, so there is nothing to renew`, 'use \\newcommand');
    let n = 0;
    let opt = null;
    const count = this.optText();
    if (count !== null) {
      if (!/^[0-9]$/.test(count)) fail('tex.macro', name, `the number of parameters, [${count}], is not a digit`, 'write `[2]` for two parameters');
      n = +count;
      const p = this.peekNoSpaceRaw();
      if (isCh(p, '[')) opt = this.bracketed(this.rawNoSpace());
    }
    const open = this.rawNoSpace();
    if (!isCh(open, '{')) fail('tex.macro', open === EOF ? t : open, `\\${t.v}{\\${name.v}} needs its body in braces`, `write \`\\${t.v}{\\${name.v}}{…}\``);
    const body = params(this.balanced(open), n, name);
    if (t.v === 'providecommand' && defined) return null;
    return this.defineMacro(name.v, { n, opt, body }, false, t);
  },
  renewcommand(t) {
    return COMMANDS.newcommand.call(this, t);
  },
  providecommand(t) {
    return COMMANDS.newcommand.call(this, t);
  },
  DeclareMathOperator(t) {
    const limits = this.star();
    const name = this.defName(t);
    const open = this.rawNoSpace();
    if (!isCh(open, '{')) fail('tex.macro', t, '\\DeclareMathOperator needs the operator\'s text in braces', `write \`\\DeclareMathOperator{\\${name.v}}{${name.v}}\``);
    const text = this.balanced(open);
    const body = [{ t: 'cs', v: 'operatorname', at: t.at, end: t.end, prim: true }];
    if (limits) body.push({ t: 'ch', v: '*', at: t.at, end: t.end });
    body.push({ t: 'ch', v: '{', at: t.at, end: t.end }, ...text, { t: 'ch', v: '}', at: t.at, end: t.end });
    return this.defineMacro(name.v, { n: 0, opt: null, body }, false, t);
  },
  let(t, global) {
    const name = this.rawNoSpace();
    if (name.t !== 'cs') fail('tex.macro', name === EOF ? t : name, '\\let needs the name of the macro to define', 'write `\\let\\new\\old`');
    let target = this.rawNoSpace();
    if (isCh(target, '=')) target = this.raw();
    if (target.t === 'sp') target = this.raw();
    if (target === EOF) fail('tex.macro', t, `\\let\\${name.v} needs what it stands for`, `write \`\\let\\${name.v}\\old\``);
    let m;
    if (target.t === 'cs') {
      const user = this.lookup(target.v, target.prim);
      m = user ? Object.assign({}, user) : { n: 0, opt: null, alias: target.v };
    } else m = { n: 0, opt: null, body: [target] };
    return this.defineMacro(name.v, m, global, t);
  },
};
COMMANDS.choose = COMMANDS.over = function (t) {
  fail('tex.misplaced', t, `\\${t.v} cannot stand here`, `\\${t.v} goes between the two parts of a group: \`{a \\${t.v} b}\``);
};
COMMANDS.nolimits = COMMANDS.limits;
for (const o of [COMMANDS, ENVS, FUNCS, ACCENTS, TEXT_ACCENTS, XARROWS, FONT_CMDS, FONT_SWITCHES, TEXT_CMDS, STYLES, CLASS_CMDS, SPACES, BIG, UNSUPPORTED, NUMBERED_ENVS, BUILTIN, PAD]) Object.setPrototypeOf(o, null);

// kid in an <mstyle> of style s, keeping its class.
function styled(s, kid) {
  const n = el('mstyle', [kid], STYLE_ATTRS[s], kid.k);
  return n;
}

Object.assign(Parser.prototype, {
  kernLength(at) {
    const toks = [];
    for (let p = this.peekRaw(); p.t === 'ch' && /[-.0-9a-z]/.test(p.v); p = this.peekRaw()) toks.push(this.raw());
    if (!toks.length) {
      const s = this.textArg(at, `\\${at.v} needs a length`);
      return this.unitLength(at, s);
    }
    return this.unitLength(at, toks.map((x) => x.v).join(''));
  },
  unitLength(at, s) {
    const m = /^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]{2})$/.exec(s.trim());
    if (!m || !UNITS[m[2]]) fail('tex.argument', at, `\`${s}\` is not a length`, 'write a number and a unit: `1em`, `3pt`, `2mu`');
    return `${+(+m[1] * UNITS[m[2]]).toFixed(4)}em`;
  },

  // An array's column spec: [{align, line}] with line: a | before the column;
  // spec.end: a | after the last.
  colSpec(at) {
    const s = this.textArg(at, '\\begin{array} needs its columns, as `{lcr}`');
    const cols = [];
    let line = false;
    for (const c of s.replace(/\s+/g, '')) {
      if (c === '|') line = true;
      else if (c === 'l' || c === 'c' || c === 'r') cols.push({ align: c, line }), (line = false);
      else fail('tex.argument', at, `the column spec {${s}} has \`${c}\`, which Luccet does not read`, 'the columns are l, c and r, with | between them for a line');
    }
    cols.end = line;
    return cols;
  },

  // The rows of an environment, up to stop: [{cells: [[elements]], line, space}].
  cells(at, stop, env) {
    const rows = [];
    let cur = { cells: [], line: false, space: null };
    const cellStop = (x) => isCh(x, '&') || isCs(x, '\\') || isCs(x, 'cr') || isCs(x, 'newline') || stop(x);
    for (;;) {
      // \hline at the start of a row.
      if (!cur.cells.length) {
        for (;;) {
          const p = this.nextNoSpace();
          if (isCs(p, 'hline')) cur.line = true;
          else {
            this.unget(p);
            break;
          }
        }
      }
      this.scopes.push(new Map());
      const f = this.font;
      let kids = this.row(cellStop);
      this.font = f;
      this.scopes.pop();
      // An aligned environment's right-hand cells start after a relation's
      // left side: an empty atom keeps the relation's space before it.
      if (env.align && cur.cells.length % 2 === 1 && kids.length) kids = [el('mrow', []), ...kids];
      cur.cells.push(finish(kids, this.style));
      const t = this.next();
      if (isCh(t, '&')) continue;
      if (isCs(t, '\\') || isCs(t, 'cr') || isCs(t, 'newline')) {
        const sp = this.optText();
        if (sp) cur.space = this.unitLength(t, sp);
        rows.push(cur);
        cur = { cells: [], line: false, space: null };
        continue;
      }
      this.unget(t);
      break;
    }
    // A last row with nothing in it (after a final \\) is no row; its
    // \hline is a line under the table.
    if (cur.cells.length === 1 && !cur.cells[0].length && rows.length) {
      if (cur.line) rows[rows.length - 1].under = true;
    } else rows.push(cur);
    return rows;
  },

  mtable(rows, env, spec) {
    const trs = [];
    rows.forEach((r, i) => {
      const tds = r.cells.map((c, j) => {
        const cls = [];
        if (spec && spec[j]) {
          if (spec[j].align === 'l') cls.push('t-left');
          if (spec[j].align === 'r') cls.push('t-right');
          if (spec[j].line) cls.push('t-vline');
          if (j === spec.length - 1 && spec.end) cls.push('t-vline-end');
        }
        const kids = c.slice();
        if (j === 0 && r.space) kids.push(el('mspace', [], { depth: r.space }));
        return el('mtd', kids, cls.length ? { class: cls.join(' ') } : null);
      });
      const cls = [];
      if (r.line) cls.push('t-hline');
      if (r.under) cls.push('t-hline-end');
      trs.push(el('mtr', tds, cls.length ? { class: cls.join(' ') } : null));
    });
    const a = {};
    if (env.cls) a.class = env.cls;
    if (env.display) a.displaystyle = 'true';
    const tbl = el('mtable', trs, Object.keys(a).length ? a : null, 'inner');
    return env.small ? el('mstyle', [tbl], { scriptlevel: '1' }, 'inner') : tbl;
  },
});

// A row's spacing: TeX's that the operator dictionary does not give.
const THIN = '0.1667em';
function finish(kids, style) {
  if (!kids.length) return kids;
  const script = style >= 2;
  // Merged letters under \mathrm and the like: one <mi>.
  const merged = [];
  for (const n of kids) {
    const p = merged[merged.length - 1];
    if (n.m && p && p.m === n.m && n.t === 'mi' && p.t === 'mi') {
      p.c += n.c;
      p.a = null; // a name of several letters is upright already
    } else merged.push(n.m ? Object.assign({}, n) : n);
  }
  kids = merged;
  // A binary operator with no left operand, or before a relation, a closing
  // bracket or punctuation, is ordinary (TeX's rules 5 and 6).
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.k !== 'bin') continue;
    const p = i ? kids[i - 1].k : null;
    const x = i + 1 < kids.length ? kids[i + 1].k : null;
    if (!p || p === 'bin' || p === 'op' || p === 'rel' || p === 'open' || p === 'punct' || x === null || x === 'rel' || x === 'close' || x === 'punct') {
      n.k = 'ord';
      if (n.pad) n.pad = null;
      else setSpace(n, '0em', '0em');
    }
  }
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    const p = i ? kids[i - 1] : null;
    const x = i + 1 < kids.length ? kids[i + 1] : null;
    // Two relations in a row: no space between them (:=). In a script, no
    // space around a relation, an operator or punctuation (TeX's table).
    if (script && (n.k === 'rel' || n.k === 'bin' || n.k === 'punct')) {
      if (n.pad) n.pad = null;
      else setSpace(n, '0em', '0em');
    } else if (n.k === 'rel' && x && x.k === 'rel') setSpace(n, null, '0em'), setSpace(x, '0em', null);
    // Thin spaces: a function name and what follows; fractions and \left…\right
    // and their neighbours (not in scripts).
    if (p && thin(p, n, script)) out.push(space(THIN));
    if (n.pad) out.push(space(n.pad), n, space(n.pad));
    else out.push(n);
  }
  // No space before the first atom of a row or after the last, as in TeX.
  const first = out[0];
  const last = out[out.length - 1];
  if (first.k === 'rel' || first.k === 'punct' || first.k === 'op') setSpace(first, '0em', null);
  if (last.k === 'rel' || last.k === 'punct' || last.k === 'op') setSpace(last, null, '0em');
  return out;
}
// Does TeX put a thin space between atoms a and b that MathML will not?
function thin(a, b, script) {
  const ak = a.k;
  const bk = b.k;
  const selfA = a.t === 'mo' || (core(a) && !a.fn); // spaced by the dictionary
  const selfB = b.t === 'mo' || (core(b) && !b.fn);
  if (a.fn && (bk === 'ord' || bk === 'inner' || (bk === 'op' && !selfB))) return true;
  if (b.fn && (ak === 'ord' || ak === 'close' || ak === 'inner' || (ak === 'op' && !selfA))) return true;
  if (script) return false;
  if (ak === 'inner') return bk === 'ord' || bk === 'inner' || bk === 'open' || bk === 'punct';
  if (bk === 'inner') return ak === 'ord' || ak === 'close';
  return false;
}

// A bracketed row: \left…\right's stretchy fences around kids.
function fenced(open, close, kids) {
  const out = [];
  if (open) out.push(el('mo', open, { fence: 'true', form: 'prefix', stretchy: 'true', symmetric: 'true' }, 'open'));
  for (const k of kids) out.push(k);
  if (close) out.push(el('mo', close, { fence: 'true', form: 'postfix', stretchy: 'true', symmetric: 'true' }, 'close'));
  return el('mrow', out, null, 'inner');
}

// Text at the edge of an <mtext> is a no-break space: the browser drops a
// plain one there.
const edge = (s) => s.replace(/^ /, '\u00a0').replace(/ $/, '\u00a0');

const shown = (t) => (t.t === 'cs' ? `\\${t.v}` : t.v);

// Words people write for a symbol's command.
const WORDS = { infinity: 'infty', union: 'cup', intersection: 'cap', intersect: 'cap', integral: 'int', degree: 'circ', degrees: 'circ', and: 'land', or: 'lor', grad: 'nabla', root: 'sqrt', fraction: 'frac', arrow: 'to' };
Object.setPrototypeOf(WORDS, null);

// The known command nearest a name, for tex.unknown's hint.
function nearest(name, p) {
  if (has(WORDS, name)) return WORDS[name];
  let best = null;
  let bestD = name.length > 4 ? 3 : 2;
  const check = (c) => {
    if (Math.abs(c.length - name.length) >= bestD) return;
    const d = distance(name, c, bestD);
    if (d < bestD) (bestD = d), (best = c);
  };
  for (const c of symbols.keys()) check(c);
  for (const c of Object.keys(COMMANDS)) check(c);
  for (const c of Object.keys(FUNCS)) check(c);
  for (const c of Object.keys(ACCENTS)) check(c);
  for (const c of Object.keys(FONT_CMDS)) check(c);
  for (const c of Object.keys(TEXT_CMDS)) check(c);
  for (const c of Object.keys(BUILTIN)) check(c);
  for (const c of p.table.defs.keys()) check(c);
  return best;
}
// The edit distance with transpositions (\alpah is one step from \alpha),
// giving up at max.
function distance(a, b, max) {
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      if (cur[j] < low) low = cur[j];
    }
    if (low >= max) return max;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

// ---------------------------------------------------------------- writing

const ESC = /[&<>"]/g;
const escChar = (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
const esc = (s) => s.replace(ESC, escChar);

function write(n) {
  let s = `<${n.t}`;
  if (n.a) for (const k of Object.keys(n.a)) s += ` ${k}="${esc(String(n.a[k]))}"`;
  s += '>';
  if (typeof n.c === 'string') s += esc(n.c);
  else for (const c of n.c) s += write(c);
  return `${s}</${n.t}>`;
}

// ---------------------------------------------------------------- the API

// The results for a table with no macros, by display and TeX: notes repeat
// formulas, and an editor renders the whole note again on every change. One
// that drew on the table's reserve is not kept: it depends on the formulas
// before it. Results are shared, so callers must not change them.
const memo = new Map();
const MEMO_MAX = 5000;

function render(tex, opts) {
  const display = !!(opts && opts.display);
  const macros = (opts && opts.macros) || table(null, 0);
  const plain = macros.defs.size === 0;
  const key = (display ? 'D' : 'T') + tex;
  if (plain) {
    const hit = memo.get(key);
    if (hit) return hit;
  }
  let p = null;
  let r;
  try {
    p = new Parser(tex, macros, display, false);
    const kids = top(p);
    r = { mathml: `<math${display ? ' display="block"' : ''}>${kids.map(write).join('')}</math>`, defined: p.defined };
  } catch (e) {
    if (!e || !e.tex) throw e;
    r = { error: { code: e.code, at: e.at, end: e.end, message: e.message, hint: e.hint }, defined: !!(p && p.defined) };
  }
  if (plain && !r.defined && !(p && p.drawn)) {
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, r);
  }
  return r;
}

// A whole formula: in display math, lines broken with \\ are gathered.
function top(p) {
  const lineBreak = (x) => p.display && (isCs(x, '\\') || isCs(x, 'newline') || isCs(x, 'cr'));
  const lines = [finish(p.row(lineBreak), p.style)];
  for (;;) {
    const t = p.next();
    if (t === EOF) break;
    if (lineBreak(t)) {
      const sp = p.optText();
      void sp;
      lines.push(finish(p.row(lineBreak), p.style));
      continue;
    }
    break;
  }
  if (lines.length === 1) return lines[0];
  if (!lines[lines.length - 1].length) lines.pop();
  return [el('mtable', lines.map((l) => el('mtr', [el('mtd', l)])), { class: 't-gather', displaystyle: 'true' })];
}

// A :::macros body: its definitions are global; anything else is ignored.
function define(macros, tex) {
  try {
    top(new Parser(tex, macros, false, true));
    return null;
  } catch (e) {
    if (!e || !e.tex) throw e;
    return { code: e.code, at: e.at, end: e.end, message: e.message, hint: e.hint };
  }
}

module.exports = { render, table, define, copy };
