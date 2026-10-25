#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The TeX translator (src/tex.js, docs/math.html) beyond the corpus's cases:
// every symbol command translates; random TeX never throws and always gives
// well-formed MathML or a tex.* error; what could hang or overflow (a macro
// that uses itself, deep nesting, a long formula) stops in time; a typo's
// hint names the command meant. The output for each construct is the
// corpus's (test/corpus/tex.txt); the look, the smoke tests'.
//
//   node test/tex.js [--seconds=N]
'use strict';

const engine = require('./lib/engine');

const { luccet, why } = engine.load();
if (!luccet) {
  console.log(`✗ ${why}`);
  process.exit(2);
}
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '').slice(10)) || 3;

let failed = 0;
const results = [];
function test(name, fn) {
  const problems = [];
  try {
    const note = fn(problems);
    if (!problems.length) return void results.push(`✓ ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    problems.push((e && e.stack) || String(e));
  }
  failed++;
  results.push(`✗ ${name}\n  ${problems.slice(0, 8).join('\n  ')}`);
}

const CODES = new Set(['tex.unknown', 'tex.unsupported', 'tex.unbalanced', 'tex.argument', 'tex.script', 'tex.misplaced', 'tex.macro', 'tex.limit']);

// Well formed: every tag closed in order, only MathML's elements, attributes
// quoted, no raw `<` or `&` in text.
const ELEMENTS = new Set('math mrow mi mn mo mtext mspace msub msup msubsup munder mover munderover mfrac msqrt mroot mstyle mpadded mphantom mtable mtr mtd'.split(' '));
function wellFormed(s) {
  const stack = [];
  const re = /<(\/?)([a-z]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>|([^<]+)/gy;
  let m;
  let end = 0;
  while ((m = re.exec(s))) {
    end = re.lastIndex;
    if (m[4] !== undefined) {
      if (/&(?!amp;|lt;|gt;|quot;)/.test(m[4])) return `a raw & in text: ${m[4].slice(0, 40)}`;
      continue;
    }
    if (!ELEMENTS.has(m[2])) return `<${m[2]}> is not an element the translator writes`;
    if (m[1]) {
      if (stack.pop() !== m[2]) return `</${m[2]}> closes the wrong element`;
    } else stack.push(m[2]);
  }
  if (end !== s.length) return `unparsable at ${end}: ${s.slice(end, end + 40)}`;
  if (stack.length) return `<${stack.pop()}> is not closed`;
  if (!s.startsWith('<math') || !s.endsWith('</math>')) return 'not one <math> element';
  return null;
}

function check(tex, opts, p) {
  let r;
  try {
    r = luccet.tex(tex, opts);
  } catch (e) {
    p.push(`${JSON.stringify(tex)} threw: ${(e && e.message) || JSON.stringify(e)}`);
    return null;
  }
  if (r.mathml !== undefined) {
    const bad = wellFormed(r.mathml);
    if (bad) p.push(`${JSON.stringify(tex)}: ${bad}`);
  } else if (!r.error || !CODES.has(r.error.code) || !(r.error.at >= 0 && r.error.end >= r.error.at && r.error.end <= tex.length) || !r.error.message || !r.error.hint) {
    p.push(`${JSON.stringify(tex)}: neither MathML nor a well-formed error: ${JSON.stringify(r)}`);
  }
  return r;
}

test('every symbol command translates on its own, in display and inline math, to well-formed MathML', (p) => {
  for (const [name] of luccet.tex.symbols) {
    if (!/^[A-Za-z]+$/.test(name)) continue;
    for (const display of [false, true]) {
      const r = check(`\\${name}`, { display }, p);
      if (r && r.error) p.push(`\\${name}: ${r.error.code} ${r.error.message}`);
    }
  }
  return `${luccet.tex.symbols.length} symbols`;
});

test('every symbol typed as its own character translates as its command does (for a character several commands share, the first of them)', (p) => {
  const first = new Map();
  for (const [, ch, k] of luccet.tex.symbols) if (!first.has(ch)) first.set(ch, k);
  for (const [name, ch, k] of luccet.tex.symbols) {
    if (!/^[A-Za-z]+$/.test(name) || /[\s{}\\$&#^_%~]/.test(ch) || first.get(ch) !== k) continue;
    const a = luccet.tex(`\\${name}`);
    const b = luccet.tex(ch);
    if (a.mathml !== b.mathml && !(a.mathml && b.mathml && a.mathml.replace(/ mathvariant="normal"/, '') === b.mathml.replace(/ mathvariant="normal"/, ''))) p.push(`\\${name} and ${ch}: ${a.mathml} vs ${b.mathml}`);
  }
});

// Random TeX from what formulas are made of: commands that take arguments,
// symbols, braces, scripts, environments, macro definitions, junk.
const PIECES = [
  ...'abcxyzAB0123456789+-=<>()[]|/.,;:!?\'~ '.split(''),
  '{', '}', '{', '}', '^', '_', '&', '\\\\', '#', '$', '%\n', '\\',
  '\\frac', '\\sqrt', '\\sqrt[3]', '\\left(', '\\right)', '\\left.', '\\right|', '\\middle|', '\\big(', '\\Bigr]',
  '\\sum', '\\int', '\\lim', '\\limits', '\\nolimits', '\\sin', '\\operatorname{f}', '\\operatorname*', '\\mathop', '\\mathrel',
  '\\alpha', '\\Gamma', '\\infty', '\\to', '\\le', '\\cdot', '\\not', '\\dots', '\\ldots', '\\prime',
  '\\hat', '\\vec', '\\widehat', '\\overline', '\\underbrace', '\\overset', '\\stackrel', '\\xrightarrow', '\\xleftarrow[a]',
  '\\mathbb', '\\mathbf', '\\mathrm', '\\boldsymbol', '\\rm', '\\bf', '\\text{', '\\text{a $x$}', '\\textbf', '\\mbox',
  '\\,', '\\!', '\\quad', '\\hspace{1em}', '\\kern-3mu', '\\phantom', '\\color{red}', '\\textcolor{#f00}', '\\colorbox{blue}',
  '\\boxed', '\\cancel', '\\displaystyle', '\\scriptstyle', '\\binom', '\\choose', '\\over', '\\cfrac', '\\dfrac',
  '\\begin{matrix}', '\\begin{pmatrix}', '\\begin{cases}', '\\begin{aligned}', '\\begin{array}{l|c}', '\\hline', '\\end{matrix}', '\\end{pmatrix}', '\\end{cases}', '\\end{aligned}', '\\end{array}', '\\begin{bogus}', '\\substack{',
  '\\def\\a#1{#1#1}', '\\gdef\\b{\\b}', '\\newcommand{\\c}[2][x]{#1#2}', '\\renewcommand', '\\let\\d\\alpha', '\\a', '\\b', '\\c', '\\d', '\\global',
  '\\tag{1}', '\\href{x}{y}', '\\label{a}', '\\foo', '\\constructor', '\\toString', '\\__proto__', '\\hasOwnProperty',
];
function random(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 4294967296);
}

test(`random TeX (${SECONDS} s): no throw, well-formed MathML or a tex.* error, no formula over 50 ms`, (p) => {
  const rnd = random(20261025);
  const end = Date.now() + SECONDS * 1000;
  let n = 0;
  let slow = 0;
  while (Date.now() < end && p.length < 8) {
    const len = 1 + Math.floor(rnd() * 24);
    let tex = '';
    for (let i = 0; i < len; i++) tex += PIECES[Math.floor(rnd() * PIECES.length)];
    const t0 = Date.now();
    check(tex, { display: rnd() < 0.5, macros: rnd() < 0.2 ? { '\\R': '\\mathbb{R}', '\\n': '\\left\\| #1 \\right\\|' } : undefined }, p);
    const ms = Date.now() - t0;
    if (ms > 50) slow++, p.push(`${JSON.stringify(tex)} took ${ms} ms`);
    n++;
  }
  return `${n} formulas${slow ? `, ${slow} slow` : ''}`;
});

test('what could hang or overflow stops in time with tex.limit: a macro that uses itself, one that doubles, deep nesting', (p) => {
  const cases = [
    ['\\def\\a{\\a}\\a', 'tex.limit'],
    ['\\def\\a{x\\a x}\\a', 'tex.limit'],
    ['\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\d\\d}\\def\\d{\\e\\e}\\def\\e{\\f\\f}\\def\\f{\\g\\g}\\def\\g{xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a', null],
    ['{'.repeat(5000) + 'x' + '}'.repeat(5000), 'tex.limit'],
    ['\\left('.repeat(500) + 'x' + '\\right)'.repeat(500), 'tex.limit'],
    ['\\sqrt{'.repeat(300) + 'x' + '}'.repeat(300), 'tex.limit'],
    ['x^{'.repeat(300) + '2' + '}'.repeat(300), 'tex.limit'],
  ];
  for (const [tex, code] of cases) {
    const t0 = Date.now();
    const r = check(tex, {}, p);
    const ms = Date.now() - t0;
    if (ms > 500) p.push(`${tex.slice(0, 40)}… took ${ms} ms`);
    if (r && code && (!r.error || r.error.code !== code)) p.push(`${tex.slice(0, 40)}…: ${r.error ? r.error.code : 'MathML'}, not ${code}`);
  }
});

test('a long formula translates in linear time', (p) => {
  const unit = 'a_{i} + \\frac{x^2}{y} - \\sqrt{z} \\cdot \\alpha ';
  const time = (n) => {
    const tex = unit.repeat(n) + `%${n}`; // a new formula each time: no cache
    const t0 = process.hrtime.bigint();
    check(tex, {}, p);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(200);
  const small = Math.max(time(1000), 1);
  const big = time(8000);
  if (big / small > 16) p.push(`8× the formula took ${(big / small).toFixed(1)}× the time (${small.toFixed(1)} → ${big.toFixed(1)} ms)`);
  return `${big.toFixed(1)} ms for ${unit.length * 8000} characters`;
});

test("a typo's hint names the command meant", (p) => {
  for (const [typo, meant] of [['\\alpah', 'alpha'], ['\\frc', 'frac'], ['\\thetha', 'theta'], ['\\infinity', 'infty'], ['\\lamda', 'lambda'], ['\\rightarow', 'rightarrow']]) {
    const r = luccet.tex(typo);
    if (!r.error || r.error.code !== 'tex.unknown' || !r.error.hint.includes(`\`\\${meant}\``)) p.push(`${typo}: ${JSON.stringify(r.error)}`);
  }
});

test('a page macro with no body, or with a name that is not one, is left out; the rest are used', (p) => {
  const r = luccet.tex('\\R + \\x', { macros: { '\\R': '\\mathbb{R}', '\\x': 3, 'not a name': 'y' } });
  if (!r.error || r.error.code !== 'tex.unknown' || !/\\x/.test(r.error.message)) p.push(`\\x should be unknown: ${JSON.stringify(r)}`);
  const ok = luccet.tex('\\R', { macros: { '\\R': '\\mathbb{R}' } });
  if (ok.mathml !== '<math><mi>ℝ</mi></math>') p.push(`\\R: ${ok.mathml}`);
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} TeX checks pass`);
process.exit(failed ? 1 : 0);
