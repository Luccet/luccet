#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Engine API behaviour that the corpus cannot express: a case cannot
// register a transform, and the corpus lint keeps runtime codes such as
// addon.failed out of it (test/run.js); nor can it bring a schema the
// fixtures don't hold (equations within sections, a label function under
// `within`, conflicting or invalid values). Runs on luccet.js, or $LUCCET_ENGINE.
//
//   node test/api.js
'use strict';

const engine = require('./lib/engine');

const { luccet, why } = engine.load();
if (!luccet) {
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
  const off = list.map(([name, f, where]) => luccet.transform(name, f, where));
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
      const ds = luccet.check('## A\n\nSee @a.\n');
      eq(ds.map((d) => d.code), ['addon.failed', 'api.ran'], 'codes (ids and refs ran: no ref.dangling)');
      const d = ds[0];
      eq([d.severity, d.message], ['error', 'the transform "boom" threw: kaput; the note renders without it'], 'severity and message');
      eq(d.position, HEAD, 'position: line 0, as the runtime positions add-on problems');
      eq(luccet.toHTML('## A\n\nSee @a.\n', { positions: false }), '<h2 id="a">A</h2>\n<p>See <a class="t-ref" href="#a">A</a>.</p>\n', 'the note renders');
    },
  );
});

test('a thrown non-Error is shown as a string', () => {
  withTransforms([['str', () => { throw 'plain'; }]], () => {
    eq(luccet.check('x\n').map((d) => d.message), ['the transform "str" threw: plain; the note renders without it'], 'message');
  });
});

test('one report per throw, each transform on its own', () => {
  withTransforms(
    [
      ['one', () => { throw new Error('a'); }],
      ['two', () => { throw new Error('b'); }],
    ],
    () => eq(luccet.check('x\n').map((d) => d.message.slice(0, 26)), ['the transform "one" threw:', 'the transform "two" threw:'], 'two reports'),
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
    eq(luccet.check('x\n'), [], 'no engine diagnostic');
    eq(seen, ['w'], 'the wrapper saw the error once');
  });
});

// ---------------------------------------------------------------- within

// The labels of a note's counted elements and equations, in document order.
const labels = (src, schema) =>
  [...luccet.toHTML(src, { schema }).matchAll(/<span class="t-(?:label|eqno)">([^<]*)<\/span>/g)].map((m) => m[1]);
const thm = (extra) => ({ block: { theorem: Object.assign({ counter: 'theorem', label: 'Theorem' }, extra) } });

test('within: equations follow an entry on the equation counter', () => {
  const schema = { block: { theorem: { counter: 'theorem', label: 'Theorem' }, eq: { counter: 'equation', within: 'h2' } } };
  const src = '$$ a $$ {#a}\n\n## One\n\n$$ b $$ {#b}\n\n$$ c $$ {#c}\n\n## Two\n\n$$ d $$ {#d}\n\nSee @c.\n';
  eq(labels(src, schema), ['(0.1)', '(1.1)', '(1.2)', '(2.1)'], 'equation numbers');
  eq(/href="#c">\(1\.2\)</.test(luccet.toHTML(src, { schema })), true, 'the reference reads (1.2)');
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

// ---------------------------------------------------------------- luccet.search

test('search.records: one entry per heading section and per block with an id, with note lines; a block without an id gives its text to its section', () => {
  const { ast } = luccet.parse('Before any heading.\n\n# Triangles {#tri}\n\nThe hypotenuse: $c=\\sqrt{a^2+b^2}$.\n\n:::note[I.1]{#ex-1}\nProve Pythagoras\\\ntheorem.\n:::\n\n:::note\nNo id here.\n:::\n\n## Circles\n\nRound.\n');
  luccet.transform(ast);
  const r = luccet.search.records(ast, { url: 'a.html', title: 'Alpha' });
  eq(r.map((e) => [e.kind, e.id, e.line, e.endLine, e.label, e.title, e.text]), [
    ['page', '', 1, 19, 'Alpha', '', 'Before any heading.'],
    ['heading', 'tri', 3, 15, 'Triangles', '', 'The hypotenuse: c=\\sqrt{a^2+b^2}.\nNo id here.'],
    ['note', 'ex-1', 7, 10, 'note', 'I.1', 'Prove Pythagoras theorem.'],
    ['heading', 'circles', 16, 19, 'Circles', '', 'Round.'],
  ], 'entries');
  eq(JSON.parse(JSON.stringify(luccet.search.index(r))).entries.length, 4, 'the index is plain data');
});

test('search.query: a word stands for the stems it begins, a title hit weighs more, a miss is empty', () => {
  const { ast } = luccet.parse('# Triangles {#tri}\n\nA right triangle.\n\n:::note{#n}\nThe triangles inscribed in a circle.\n:::\n\n## Circles {#c}\n\nThe circumference is $2\\pi r$.\n');
  luccet.transform(ast);
  const idx = luccet.search.index(luccet.search.records(ast, { url: 'a.html' }));
  eq(luccet.search.query(idx, 'triangle').map((h) => h.entry.id), ['tri', 'n'], 'triangle finds triangles, the heading first');
  eq(luccet.search.query(idx, 'triangles').map((h) => h.entry.id), ['tri', 'n'], 'the plural the same');
  eq(luccet.search.query(idx, 'circ').map((h) => h.entry.id), ['c', 'n'], 'a prefix: circles, circumference, circle');
  eq(luccet.search.query(idx, 'pi').map((h) => h.entry.id), ['c'], 'TeX as written');
  eq(luccet.search.query(idx, 'circ', { limit: 1 }).length, 1, 'limit');
  eq(luccet.search.query(idx, 'nothing'), [], 'a miss');
  eq(luccet.search.query(idx, ''), [], 'no words');
  eq(luccet.search.query(idx, 'triangle')[0].matched, ['triangl'], 'the stems matched');
});

test('search: folding: accents in either Unicode form, ligatures, full-width letters, Turkish İ and ё meet their plain forms; Han, Kana and Hangul runs are searched as pairs; snippets mark the pairs as one range', () => {
  eq(luccet.search.fold('Café café ﬁne İstanbul ISTANBUL Ёлка ＡＢＣ Straße'), 'cafe cafe fine istanbul istanbul елка abc straße', 'fold');
  eq(luccet.search.tokens('Café, the café!'), ['caf', 'the', 'caf'], 'one stem for both forms');
  eq(luccet.search.tokens('東京タワーは高い。'), ['東京', '京タ', 'タワ', 'ワー', 'ーは', 'は高', '高い'], 'bigrams over a run, the prolonged sound mark included');
  eq(luccet.search.tokens('한국어 검색 日本 x 1 ab'), ['한국', '국어', '검색', '日本', 'ab'], 'runs split by spaces; a one-letter word dropped, a one-character run kept');
  eq(luccet.search.tokens('日'), ['日'], 'a single character');
  eq(luccet.search.tokens('नमस्ते'), ['नमस्ते'], 'other scripts keep their marks and stand whole');
  const { ast } = luccet.parse('# Café {#c}\n\nThe café in İstanbul.\n\n## 東京 {#t}\n\n東京タワーは高い。한국어 검색。\n');
  luccet.transform(ast);
  const idx = luccet.search.index(luccet.search.records(ast, { url: 'a.html' }));
  for (const q of ['cafe', 'café', 'café', 'CAFÉ']) eq(luccet.search.query(idx, q).map((h) => h.entry.id), ['c'], `${q} finds the café`);
  for (const q of ['istanbul', 'İstanbul', 'ISTANBUL']) eq(luccet.search.query(idx, q).map((h) => h.entry.id), ['c'], `${q} finds İstanbul`);
  for (const q of ['東京', '東京タワー', '京', 'タワー', '검색', '한국어']) eq(luccet.search.query(idx, q).map((h) => h.entry.id), ['t'], `${q} finds the Japanese section`);
  eq(luccet.search.query(idx, '京都'), [], 'a pair not in the text misses');
  const m = luccet.search.query(idx, '東京タワー')[0].matched;
  eq(m.sort(), ['タワ', 'ワー', '京タ', '東京'], 'the pairs matched');
  eq(luccet.search.snippet('東京タワーは高い。', m), { text: '東京タワーは高い。', marks: [[0, 5]] }, 'touching pairs marked as one range');
  eq(luccet.search.snippet('Visit 東京 and the café now.', ['東京', 'caf']), { text: 'Visit 東京 and the café now.', marks: [[6, 8], [17, 22]] }, 'the word as written, in its own form, is marked whole');
});

test('glossary.terms: a dfn is defined by its paragraph, by the paragraph after its heading or by its cell, title= being the canonical term; a titled definition block defines its title by its body, a dfn of the same term inside it being no second term; anchors: the term\'s id, its block\'s, its section\'s; uses; key and slug', () => {
  const src = '# Intro {#intro}\n\nA :dfn[truism] is obvious; so are :dfn[truisms]{title=truism #tr}.\n\n- An item with :dfn[widget]: a thing.\n\n:::definition[Kernel]{#k}\nThe :dfn[kernel] of $T$: the $v$ with $T(v)=0$. Its :dfn[nullity] is a number.\n:::\n\n:::definition\nNo title, a :dfn[stray] one.\n:::\n\n## :dfn[Heading term] {#ht}\n\nThe paragraph after.\n\n:::note{#n1}\nA :dfn[nested] term.\n:::\n\n| :dfn[cell] | x |\n|---|---|\n| 1 | 2 |\n\nUses: :term[truism], :term[Kernels]{title=kernel} and :term[nothing].\n';
  const { ast } = luccet.parse(src);
  luccet.transform(ast);
  const list = luccet.glossary.terms(ast);
  eq(
    list.map((t) => [t.term, t.key, t.slug, t.id, t.line, t.how]),
    [
      ['truism', 'truism', 'glossary-truism', 'intro', 3, 'dfn'],
      ['truism', 'truism', 'glossary-truism', 'tr', 3, 'dfn'],
      ['widget', 'widget', 'glossary-widget', 'intro', 5, 'dfn'],
      ['Kernel', 'kernel', 'glossary-kernel', 'k', 7, 'definition'],
      ['nullity', 'nullity', 'glossary-nullity', 'k', 8, 'dfn'],
      ['stray', 'stray', 'glossary-stray', 'intro', 12, 'dfn'],
      ['Heading term', 'heading term', 'glossary-heading-term', 'ht', 15, 'dfn'],
      ['nested', 'nested', 'glossary-nested', 'n1', 20, 'dfn'],
      ['cell', 'cell', 'glossary-cell', 'ht', 23, 'dfn'],
    ],
    'the terms in note order: title= as the term, the block\'s title as its term and its own dfn of it skipped, anchors from the term, the block or the section',
  );
  const html = (t) => luccet.emit({ type: 'root', children: t.definition }, { positions: false }).trim();
  eq(html(list[0]), '<p>A <dfn class="dfn" data-t="dfn">truism</dfn> is obvious; so are <dfn id="tr" class="dfn" data-t="dfn" title="truism">truisms</dfn>.</p>', 'the paragraph a dfn stands in');
  eq(html(list[3]), '<p>The <dfn class="dfn" data-t="dfn">kernel</dfn> of <span class="t-math" data-tex="T"><math><mi>T</mi></math></span>: the <span class="t-math" data-tex="v"><math><mi>v</mi></math></span> with <span class="t-math" data-tex="T(v)=0"><math><mi>T</mi><mo stretchy="false">(</mo><mi>v</mi><mo stretchy="false">)</mo><mo>=</mo><mn>0</mn></math></span>. Its <dfn class="dfn" data-t="dfn">nullity</dfn> is a number.</p>', "the block's body, without its title");
  eq(html(list[6]), '<p>The paragraph after.</p>', 'the paragraph after a heading');
  eq(html(list[8]), '<p><dfn class="dfn" data-t="dfn">cell</dfn></p>', 'a cell, as a paragraph');
  eq(/"position"|Position"/.test(JSON.stringify(list)), false, 'no positions in the definitions');
  eq(luccet.glossary.uses(ast).map((u) => [u.term, u.key, u.line]), [['truism', 'truism', 27], ['kernel', 'kernel', 27], ['nothing', 'nothing', 27]], 'the uses, title= as the term');
  eq(luccet.glossary.terms(ast, { blocks: ['note'] }).filter((t) => t.how !== 'dfn'), [], 'blocks= names the blocks that define; one without a title defines nothing');
  eq(luccet.glossary.terms(ast, { blocks: ['note'] }).map((t) => t.term).includes('kernel'), true, 'then the dfn inside the definition block is a term of its own');
  eq([luccet.glossary.key('  Café  AU lait '), luccet.glossary.slug('Abelian group'), luccet.glossary.slug('Café au lait!'), luccet.glossary.slug('東京'), luccet.glossary.slug('')], ['cafe au lait', 'glossary-abelian-group', 'glossary-cafe-au-lait', 'glossary-東京', 'glossary-term'], 'key and slug');
});

test('search.format and glossary.format: the number of the format luccet index writes, which a reader of any version of the same major takes; 1 since 1.0', () => {
  eq([luccet.search.format, luccet.glossary.format], [1, 1], 'the formats');
  eq([Number.isInteger(luccet.search.format) && luccet.search.format > 0, Number.isInteger(luccet.glossary.format) && luccet.glossary.format > 0], [true, true], 'positive integers, written as JSON');
});

test('search: words that name Object.prototype members are words like any, before and after a JSON round trip', () => {
  const { ast } = luccet.parse('# The constructor {#c}\n\nA constructor, toString and hasOwnProperty; __proto__ too.\n\n## Other {#o}\n\nNothing of the kind.\n');
  luccet.transform(ast);
  const idx = luccet.search.index(luccet.search.records(ast, { url: 'a.html' }));
  for (const q of ['constructor', 'tostring', 'hasownproperty', 'proto']) eq(luccet.search.query(idx, q).map((h) => h.entry.id), ['c'], q);
  const back = JSON.parse(JSON.stringify(idx));
  eq(luccet.search.query(back, 'constructor').map((h) => h.entry.id), ['c'], 'after JSON');
  eq(luccet.search.query(back, 'valueof'), [], 'a prototype member that is not a word in the notes');
});

test('search.describe: the title, the description from the head else :::meta, the meta with the head over the block, every heading, the links each once', () => {
  const head = '<title>A &amp; B</title><meta name="description" content="Desc &amp; more"><meta name="robots" content="noindex">';
  const { ast } = luccet.parse(':::meta\ndate: 2026-10-01\ndescription: from meta\n:::\n\n# One {#one}\n\nSee [x](x.html) and [y](x.html#y) and [x again](x.html) and [self](#one).\n\n:::note\n## Inner\n:::\n', { head });
  luccet.transform(ast, { head });
  eq(luccet.search.describe(head, ast), { title: 'A & B', description: 'Desc & more', meta: { date: '2026-10-01', description: 'Desc & more', robots: 'noindex' }, headings: [{ depth: 1, id: 'one', text: 'One' }, { depth: 2, id: 'inner', text: 'Inner' }], links: ['x.html', 'x.html#y'] }, 'with a head');
  const bare = luccet.parse(':::meta\ndescription: from meta\n:::\n\n# T\n\nA [l](a.html).\n').ast;
  eq(luccet.search.describe('', bare), { title: 'T', description: 'from meta', meta: { description: 'from meta' }, headings: [{ depth: 1, id: '', text: 'T' }], links: ['a.html'] }, 'no head, no transform: ids only where written');
  eq(luccet.search.describe('', luccet.parse('text\n').ast), { title: '', description: '', meta: {}, headings: [], links: [] }, 'nothing');
});

test('search.snippet and search.title', () => {
  const s = luccet.search.snippet('Prove Pythagoras theorem using squares on the sides.', ['pythagora']);
  eq(s, { text: 'Prove Pythagoras theorem using squares on the sides.', marks: [[6, 16]] }, 'a short text whole, the word marked');
  const long = `${'word '.repeat(60)}Pythagoras ${'more '.repeat(60)}`;
  const cut = luccet.search.snippet(long, ['pythagora'], { width: 60 });
  if (!/^…word (word )*Pythagoras( more)+…$/.test(cut.text)) throw new Error(`cut: ${JSON.stringify(cut.text)}`);
  eq(cut.text.slice(cut.marks[0][0], cut.marks[0][1]), 'Pythagoras', 'the mark in the cut text');
  const { ast } = luccet.parse(':::meta\ntitle: From meta\n:::\n\n# First heading\n');
  eq(luccet.search.title('<title>A &amp; B</title>', ast), 'A & B', 'the head title, entities decoded');
  eq(luccet.search.title('', ast), 'From meta', 'the meta title');
  eq(luccet.search.title('', luccet.parse('# First heading\n').ast), 'First heading', 'the first heading');
  eq(luccet.search.title('', luccet.parse('text\n').ast), '', 'nothing');
});

test('search.snippet: a long unbroken token costs linear time; a word that stems to a matched stem is marked', () => {
  const long = `${'a'.repeat(50000)} rank nullity ${'b'.repeat(50000)}`;
  const t = process.hrtime.bigint();
  const s = luccet.search.snippet(long, ['rank']);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (ms > 100) throw new Error(`${ms.toFixed(0)} ms for 100,000 letters, expected well under 100 (the old regex took seconds)`);
  eq(s.text.slice(s.marks[0][0], s.marks[0][1]), 'rank', 'the mark in the cut text');
  eq(luccet.search.snippet('The studies of study.', ['study']).marks, [[4, 11], [15, 20]], 'studies (stem study) and study both marked');
});

// ---------------------------------------------------------------- limits

// Inline constructs nest at most 1,000 deep: past that, a construct is its
// source text with nesting.limit, so the tree stays one that recursive
// readers (JSON.stringify, visit, outline, search) can walk.
test('nesting: 10,000 nested emphasis, spans and inline elements parse with one nesting.limit, and every reader walks the tree', () => {
  const inputs = { strong: '**'.repeat(10000) + 'x' + '**'.repeat(10000), spans: '['.repeat(5000) + 'x' + ']{.c}'.repeat(5000), elements: ':a['.repeat(3000) + 'x' + ']'.repeat(3000) };
  for (const [name, src] of Object.entries(inputs)) {
    const { ast, diagnostics } = luccet.parse(`${src}\n`);
    eq(diagnostics.map((d) => d.code), ['nesting.limit'], `${name}: the diagnostic, once`);
    JSON.stringify(ast); // the documented promise: serialisable
    let deepest = 0;
    const stack = [[ast, 0]];
    while (stack.length) {
      const [n, k] = stack.pop();
      deepest = Math.max(deepest, k);
      for (const c of n.children || []) stack.push([c, k + 1]);
    }
    if (deepest < 1000 || deepest > 1010) throw new Error(`${name}: the tree is ${deepest} deep, expected about 1,000`);
    let visited = 0;
    luccet.visit(ast, () => visited++);
    if (visited < 1000) throw new Error(`${name}: visit saw ${visited} nodes`);
    luccet.outline(ast);
    luccet.transform(ast);
    const recs = luccet.search.records(ast, { url: 'a.html' });
    luccet.search.describe('', ast);
    if (!recs.length || !/x/.test(recs[0].text)) throw new Error(`${name}: records ${JSON.stringify(recs).slice(0, 100)}`);
    const html = luccet.toHTML(`${src}\n`, { positions: false });
    if (!html.includes('x')) throw new Error(`${name}: the content is gone`);
  }
  // A long paragraph with many sequential constructs is not nesting: no limit.
  eq(luccet.parse('*a* '.repeat(3000)).diagnostics, [], 'sequential emphasis');
});

// A reference copies its target's title, a toc entry a heading's text: at
// most 200 characters each, so a 60 KB heading referenced 10,000 times
// cannot amplify into output no browser can hold.
test('limits: a reference or toc entry copies at most 200 characters of its target, with an ellipsis', () => {
  const big = 'word '.repeat(12000).trim();
  const src = `## ${big} {#h}\n\n::toc\n\n${'@h '.repeat(10000)}\n`;
  const t0 = Date.now();
  const html = luccet.toHTML(src, { positions: false, schema: { leaf: { toc: { transform: 'toc', depth: '2-3' } } } });
  const ms = Date.now() - t0;
  if (html.length > 5e6 || ms > 5000) throw new Error(`${html.length} characters in ${ms} ms`);
  const ref = /<a class="t-ref" href="#h">([^<]*)<\/a>/.exec(html)[1];
  const toc = /<li><a href="#h">([^<]*)<\/a>/.exec(html)[1];
  eq([ref.length, ref.endsWith('…'), toc.length, toc.endsWith('…')], [201, true, 201, true], 'the copies: 200 characters and an ellipsis');
  eq(luccet.toHTML('## Short {#s}\n\nSee @s.\n', { positions: false }), '<h2 id="s">Short</h2>\n<p>See <a class="t-ref" href="#s">Short</a>.</p>\n', 'a short title whole');
  // Code and an image's alt in a copied title count too.
  const code = luccet.toHTML(`## \`${'c'.repeat(300)}\` {#c}\n\nSee @c.\n`, { positions: false });
  eq(/<a class="t-ref" href="#c"><code>([^<]*)<\/code>/.exec(code)[1].length, 201, 'a code span cut');
});

// The emitter has an output budget, 64 M characters unless maxOutput says
// otherwise: past it the HTML stops and the tree carries output.limit.
test('emit: opts.strings overrides the emitter\'s words, whatever the language', () => {
  const html = luccet.toHTML('Text.[^a]\n\n- [ ] x\n\n[^a]: Note.\n', { positions: false, strings: { footnotes: 'Notes', back: 'Up', todo: 'Open' } });
  eq(html.includes('aria-label="Notes"') && html.includes('aria-label="Up"') && html.includes('aria-label="Open"'), true, `the words given: ${html}`);
  const de = luccet.toHTML('Text.[^a]\n\n[^a]: Note.\n', { positions: false, lang: 'de', strings: { back: 'Hoch' } });
  eq(de.includes('aria-label="Fußnoten"') && de.includes('aria-label="Hoch"'), true, `one word given, the rest in German: ${de}`);
});

test('limits: emit stops at maxOutput with output.limit on the tree, where it used to throw a RangeError', () => {
  const { ast } = luccet.parse(`${'x'.repeat(5000)}\n`);
  luccet.transform(ast);
  const html = luccet.emit(ast, { maxOutput: 1000 });
  eq(html.length, 1000, 'cut at the budget');
  eq(ast.data.luccet.diagnostics.map((d) => [d.code, d.severity, d.position.start.line]), [['output.limit', 'error', 1]], 'the diagnostic');
  eq(luccet.emit(luccet.transform(luccet.parse('x\n').ast), { maxOutput: 1000 }), '<p>x</p>\n', 'under the budget: as always');
  eq(luccet.toHTML(`${'y'.repeat(5000)}\n`, { maxOutput: 100 }).length, 100, 'through toHTML');
  eq(luccet.toHTML('z\n', { maxOutput: 'no' }), '<p>z</p>\n', 'a value that is not a number means the default');
});

test('safe: attributes that drive the host page are dropped, attribute names are read without case, and idPrefix keeps ids and fragment links apart', () => {
  const html = luccet.toHTML(':::x\ny\n:::\n', { safe: true, positions: false, schema: { block: { x: { attrs: { Href: 'javascript:alert(1)', title: 'ok', ONCLICK: 'go()', Form: 'f' } } } } });
  eq(html, '<div class="t-block x" data-t="x" title="ok"><p>y</p>\n</div>\n', 'Href, ONCLICK and Form dropped, title kept');
  const p = luccet.toHTML('## A {#a}\n\nSee @a, [b](#a) and [c](x.html#a)[^f].\n\n[^f]: note\n', { safe: true, idPrefix: 'c1-', positions: false });
  eq(
    p,
    '<h2 id="c1-a">A</h2>\n<p>See <a class="t-ref" href="#c1-a">A</a>, <a href="#c1-a">b</a> and <a href="x.html#a">c</a><sup class="t-fnref"><a role="doc-noteref" id="c1-fnref-f" href="#c1-fn-f">1</a></sup>.</p>\n<section class="t-footnotes" role="doc-endnotes" aria-label="Footnotes"><ol>\n<li id="c1-fn-f"><p>note <a class="t-fnback" href="#c1-fnref-f" aria-label="Back to the text">↩</a></p>\n</li>\n</ol></section>\n',
    "every id and fragment link prefixed; another page's fragment untouched",
  );
  eq(luccet.toHTML('x\n', { idPrefix: 7 }), '<p>x</p>\n', 'a prefix that is not a string is none');
});

test('parse: maxDepth is a finite number of 1 or more, else 64; a schema label function that throws is addon.failed once per element', () => {
  for (const v of ['abc', Infinity, 0, -1, true, null]) eq(luccet.parse('> > > x', { maxDepth: v }).diagnostics, [], `maxDepth ${String(v)}: the default`);
  for (const v of [2, '2', 2.7]) eq(luccet.parse('> > > x', { maxDepth: v }).diagnostics.map((d) => d.code), ['nesting.limit'], `maxDepth ${String(v)}: two`);
  const schema = { block: { thm: { counter: 'thm', label: () => { throw new Error('kaput'); } } } };
  const src = ':::thm\nx\n:::\n\nSee @k.\n\n:::thm{#k}\ny\n:::\n';
  const ds = luccet.check(src, { schema });
  eq(ds.map((d) => [d.code, d.severity, d.position.start.line]), [['addon.failed', 'error', 1], ['addon.failed', 'error', 7]], 'once per element, at the element');
  eq(ds[0].message, 'the label function of "thm" threw: kaput; the element has no label', 'the message');
  eq(luccet.toHTML(src, { schema, positions: false }).includes('href="#k">2</a>'), true, 'the reference falls back to the number');
});

test('visit: an explicit stack, pre-order with (node, index, parent), false skips the children, and a child list read live', () => {
  const { ast } = luccet.parse('# A\n\n> ## B\n>\n> C *d*\n\nE\n');
  const seen = [];
  luccet.visit(ast, (n, i, p) => {
    seen.push(`${n.type}${i === null ? '' : `[${i}]`}${p ? `<${p.type}` : ''}`);
    if (n.type === 'blockquote') return false;
  });
  eq(seen, ['root', 'heading[0]<root', 'text[0]<heading', 'blockquote[1]<root', 'paragraph[2]<root', 'text[0]<paragraph'], 'order, indices, parents, skip');
  const names = [];
  luccet.visit(ast, 'paragraph', (n, i, p) => {
    names.push(i);
    if (i === 2) p.children.push({ type: 'paragraph', children: [{ type: 'text', value: 'late' }] }); // a sibling added while visiting is visited
  });
  eq(names, [1, 2, 3], 'the paragraph inside the quote, then the two at the root');
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} API checks pass`);
process.exit(failed ? 1 : 0);
