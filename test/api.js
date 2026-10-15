#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Engine API behaviour that the corpus cannot express: a case cannot
// register a transform, and the corpus lint keeps runtime codes such as
// addon.failed out of it (test/run.js); nor can it bring a schema the
// fixtures don't hold (equations within sections, a label function under
// `within`, conflicting or invalid values). Runs on tern.js, or $TERN_ENGINE.
//
//   node test/api.js
'use strict';

const engine = require('./lib/engine');

const { tern, why } = engine.load();
if (!tern) {
  console.log(`✗ ${why}`);
  process.exit(2);
}

let failed = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`✓ ${name}`);
  } catch (e) {
    failed++;
    results.push(`✗ ${name}\n  ${(e && e.message) || e}`);
  }
}
function eq(a, b, what) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what}: got ${x}, want ${y}`);
}
// Registers transforms for one test and removes them after it.
function withTransforms(list, fn) {
  const off = list.map(([name, f, where]) => tern.transform(name, f, where));
  try {
    fn();
  } finally {
    for (const o of off.reverse()) o();
  }
}
const HEAD = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };

test('a registered transform that throws is addon.failed at line 0; the others still run', () => {
  withTransforms(
    [
      ['boom', () => { throw new Error('kaput'); }, { before: 'ids' }],
      ['after', (ast, ctx) => ctx.report('api.ran', ast, 'ran', null, 'info')],
    ],
    () => {
      const ds = tern.check('## A\n\nSee @a.\n');
      eq(ds.map((d) => d.code), ['addon.failed', 'api.ran'], 'codes (ids and refs ran: no ref.dangling)');
      const d = ds[0];
      eq([d.severity, d.message], ['error', 'the transform "boom" threw: kaput; the note renders without it'], 'severity and message');
      eq(d.position, HEAD, 'position: line 0, as the runtime positions add-on problems');
      eq(tern.toHTML('## A\n\nSee @a.\n', { positions: false }), '<h2 id="a">A</h2>\n<p>See <a class="t-ref" href="#a">A</a>.</p>\n', 'the note renders');
    },
  );
});

test('a thrown non-Error is shown as a string', () => {
  withTransforms([['str', () => { throw 'plain'; }]], () => {
    eq(tern.check('x\n').map((d) => d.message), ['the transform "str" threw: plain; the note renders without it'], 'message');
  });
});

test('one report per throw, each transform on its own', () => {
  withTransforms(
    [
      ['one', () => { throw new Error('a'); }],
      ['two', () => { throw new Error('b'); }],
    ],
    () => eq(tern.check('x\n').map((d) => d.message.slice(0, 26)), ['the transform "one" threw:', 'the transform "two" threw:'], 'two reports'),
  );
});

test('a function that catches its own error (as the CLI wraps add-on transforms) leaves nothing to report', () => {
  const seen = [];
  const wrap = (f) => (ast, ctx) => {
    try {
      return f(ast, ctx);
    } catch (e) {
      seen.push(e.message);
    }
  };
  withTransforms([['wrapped', wrap(() => { throw new Error('w'); })]], () => {
    eq(tern.check('x\n'), [], 'no engine diagnostic');
    eq(seen, ['w'], 'the wrapper saw the error once');
  });
});

// ---------------------------------------------------------------- within

// The labels of a note's counted elements and equations, in document order.
const labels = (src, schema) =>
  [...tern.toHTML(src, { schema }).matchAll(/<span class="t-(?:label|eqno)">([^<]*)<\/span>/g)].map((m) => m[1]);
const thm = (extra) => ({ block: { theorem: Object.assign({ counter: 'theorem', label: 'Theorem' }, extra) } });

test('within: equations follow an entry on the equation counter', () => {
  const schema = { block: { theorem: { counter: 'theorem', label: 'Theorem' }, eq: { counter: 'equation', within: 'h2' } } };
  const src = '$$ a $$ {#a}\n\n## One\n\n$$ b $$ {#b}\n\n$$ c $$ {#c}\n\n## Two\n\n$$ d $$ {#d}\n\nSee @c.\n';
  eq(labels(src, schema), ['(0.1)', '(1.1)', '(1.2)', '(2.1)'], 'equation numbers');
  eq(/href="#c">\(1\.2\)</.test(tern.toHTML(src, { schema })), true, 'the reference reads (1.2)');
});

test('within: a label function gets the number as shown', () => {
  const seen = [];
  const schema = thm({ within: 'h2', label: (n) => (seen.push(n), `Satz ${n}`) });
  eq(labels('## A\n\n:::theorem\n:::\n', schema), ['Satz 1.1'], 'label');
  eq(seen.includes('1.1'), true, 'n is "1.1"');
  const plain = [];
  labels(':::theorem\n:::\n', thm({ label: (n) => (plain.push(n), 'x') }));
  eq(plain.includes(1), true, 'without within, n stays a number');
});

test('within: entries that share a counter and disagree take the first', () => {
  const schema = { block: { theorem: { counter: 'theorem', label: 'Theorem', within: 'h2' }, lemma: { counter: 'theorem', label: 'Lemma', within: 'h3' } } };
  eq(labels('## A\n\n### a\n\n:::theorem\n:::\n\n:::lemma\n:::\n', schema), ['Theorem 1.1', 'Lemma 1.2'], 'labels');
});

test('within: a value other than h1-h6, or an entry with no counter, changes nothing', () => {
  for (const within of ['section', 'h7', 2, '', null, 'H2 '])
    eq(labels('## A\n\n:::theorem\n:::\n', thm({ within })), [within === 'H2 ' ? 'Theorem 1.1' : 'Theorem 1'], `within ${JSON.stringify(within)}`);
  eq(labels('## A\n\n:::proof\n:::\n', { block: { proof: { label: 'Proof', within: 'h2' } } }), ['Proof'], 'no counter');
});

test('within: a heading inside a dropped footnote definition counts for nothing', () => {
  const src = 'A[^a].\n\n[^a]: First.\n\n[^a]:\n    ## Dropped\n\n## One\n\n:::theorem\n:::\n';
  eq(labels(src, thm({ within: 'h2' })), ['Theorem 1.1'], 'labels');
});

// ---------------------------------------------------------------- tern.search

test('search.records: one entry per heading section and per block with an id, with note lines; a block without an id gives its text to its section', () => {
  const { ast } = tern.parse('Before any heading.\n\n# Triangles {#tri}\n\nThe hypotenuse: $c=\\sqrt{a^2+b^2}$.\n\n:::note[I.1]{#ex-1}\nProve Pythagoras\\\ntheorem.\n:::\n\n:::note\nNo id here.\n:::\n\n## Circles\n\nRound.\n');
  tern.transform(ast);
  const r = tern.search.records(ast, { url: 'a.html', title: 'Alpha' });
  eq(r.map((e) => [e.kind, e.id, e.line, e.endLine, e.label, e.title, e.text]), [
    ['page', '', 1, 19, 'Alpha', '', 'Before any heading.'],
    ['heading', 'tri', 3, 15, 'Triangles', '', 'The hypotenuse: c=\\sqrt{a^2+b^2}.\nNo id here.'],
    ['note', 'ex-1', 7, 10, 'note', 'I.1', 'Prove Pythagoras theorem.'],
    ['heading', 'circles', 16, 19, 'Circles', '', 'Round.'],
  ], 'entries');
  eq(JSON.parse(JSON.stringify(tern.search.index(r))).entries.length, 4, 'the index is plain data');
});

test('search.query: a word stands for the stems it begins, a title hit weighs more, a miss is empty', () => {
  const { ast } = tern.parse('# Triangles {#tri}\n\nA right triangle.\n\n:::note{#n}\nThe triangles inscribed in a circle.\n:::\n\n## Circles {#c}\n\nThe circumference is $2\\pi r$.\n');
  tern.transform(ast);
  const idx = tern.search.index(tern.search.records(ast, { url: 'a.html' }));
  eq(tern.search.query(idx, 'triangle').map((h) => h.entry.id), ['tri', 'n'], 'triangle finds triangles, the heading first');
  eq(tern.search.query(idx, 'triangles').map((h) => h.entry.id), ['tri', 'n'], 'the plural the same');
  eq(tern.search.query(idx, 'circ').map((h) => h.entry.id), ['c', 'n'], 'a prefix: circles, circumference, circle');
  eq(tern.search.query(idx, 'pi').map((h) => h.entry.id), ['c'], 'TeX as written');
  eq(tern.search.query(idx, 'circ', { limit: 1 }).length, 1, 'limit');
  eq(tern.search.query(idx, 'nothing'), [], 'a miss');
  eq(tern.search.query(idx, ''), [], 'no words');
  eq(tern.search.query(idx, 'triangle')[0].matched, ['triangl'], 'the stems matched');
});

test('search: words that name Object.prototype members are words like any, before and after a JSON round trip', () => {
  const { ast } = tern.parse('# The constructor {#c}\n\nA constructor, toString and hasOwnProperty; __proto__ too.\n\n## Other {#o}\n\nNothing of the kind.\n');
  tern.transform(ast);
  const idx = tern.search.index(tern.search.records(ast, { url: 'a.html' }));
  for (const q of ['constructor', 'tostring', 'hasownproperty', 'proto']) eq(tern.search.query(idx, q).map((h) => h.entry.id), ['c'], q);
  const back = JSON.parse(JSON.stringify(idx));
  eq(tern.search.query(back, 'constructor').map((h) => h.entry.id), ['c'], 'after JSON');
  eq(tern.search.query(back, 'valueof'), [], 'a prototype member that is not a word in the notes');
});

test('search.describe: the title, the description from the head else :::meta, the meta with the head over the block, every heading, the links each once', () => {
  const head = '<title>A &amp; B</title><meta name="description" content="Desc &amp; more"><meta name="robots" content="noindex">';
  const { ast } = tern.parse(':::meta\ndate: 2026-10-01\ndescription: from meta\n:::\n\n# One {#one}\n\nSee [x](x.html) and [y](x.html#y) and [x again](x.html) and [self](#one).\n\n:::note\n## Inner\n:::\n', { head });
  tern.transform(ast, { head });
  eq(tern.search.describe(head, ast), { title: 'A & B', description: 'Desc & more', meta: { date: '2026-10-01', description: 'Desc & more', robots: 'noindex' }, headings: [{ depth: 1, id: 'one', text: 'One' }, { depth: 2, id: 'inner', text: 'Inner' }], links: ['x.html', 'x.html#y'] }, 'with a head');
  const bare = tern.parse(':::meta\ndescription: from meta\n:::\n\n# T\n\nA [l](a.html).\n').ast;
  eq(tern.search.describe('', bare), { title: 'T', description: 'from meta', meta: { description: 'from meta' }, headings: [{ depth: 1, id: '', text: 'T' }], links: ['a.html'] }, 'no head, no transform: ids only where written');
  eq(tern.search.describe('', tern.parse('text\n').ast), { title: '', description: '', meta: {}, headings: [], links: [] }, 'nothing');
});

test('search.snippet and search.title', () => {
  const s = tern.search.snippet('Prove Pythagoras theorem using squares on the sides.', ['pythagora']);
  eq(s, { text: 'Prove Pythagoras theorem using squares on the sides.', marks: [[6, 16]] }, 'a short text whole, the word marked');
  const long = `${'word '.repeat(60)}Pythagoras ${'more '.repeat(60)}`;
  const cut = tern.search.snippet(long, ['pythagora'], { width: 60 });
  if (!/^…word (word )*Pythagoras( more)+…$/.test(cut.text)) throw new Error(`cut: ${JSON.stringify(cut.text)}`);
  eq(cut.text.slice(cut.marks[0][0], cut.marks[0][1]), 'Pythagoras', 'the mark in the cut text');
  const { ast } = tern.parse(':::meta\ntitle: From meta\n:::\n\n# First heading\n');
  eq(tern.search.title('<title>A &amp; B</title>', ast), 'A & B', 'the head title, entities decoded');
  eq(tern.search.title('', ast), 'From meta', 'the meta title');
  eq(tern.search.title('', tern.parse('# First heading\n').ast), 'First heading', 'the first heading');
  eq(tern.search.title('', tern.parse('text\n').ast), '', 'nothing');
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} API checks pass`);
process.exit(failed ? 1 : 0);
