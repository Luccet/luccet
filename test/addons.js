#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Luccet's add-ons in addons/ (docs/addons.html), under node: each runs under
// the command line, as `luccet check` and `luccet build` run a note's add-ons,
// with no diagnostic and no change to the page; code.js's highlight.js table
// and mermaid.js's Mermaid table are well formed, and are the pinned
// versions' when those packages are in node_modules/.cache/luccet-smoke/
// (tools/hljs.js --check, tools/mermaid.js --check; skipped if not); and
// mermaid.js prints in luccet.css's print palette; and cite.js, a pure
// transform, lists and cites BibTeX and CSL-JSON sources as the page will.
// Their behaviour in the browser is test/smoke.js's.
//
//   node test/addons.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'addons');

let failed = 0;
const results = [];
function test(name, fn) {
  try {
    const note = fn();
    results.push(`✓ ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    failed++;
    results.push(`✗ ${name}\n  ${(e && e.message) || e}`);
  }
}

const addons = fs.readdirSync(DIR).filter((n) => n.endsWith('.js')).sort();

test('every add-on runs under luccet check and luccet build with no diagnostic', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luccet-addons-'));
  fs.writeFileSync(path.join(tmp, 'luccet.js'), ''); // the notes' luccet.js, for luccet check's link checking; its folder is the notes' project, which their add-ons must stay in
  try {
    for (const n of addons) {
      const note = path.join(tmp, `${n}.html`);
      fs.copyFileSync(path.join(DIR, n), path.join(tmp, n)); // beside the note, as a local add-on is
      const use = n;
      fs.writeFileSync(note, `<!doctype html><meta charset="utf-8"><title>T</title><script src="luccet.js" data-use="${use}"></script>\n\n# Hello\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`);
      const check = spawnSync(process.execPath, [path.join(ROOT, 'luccet-cli.js'), 'check', note], { encoding: 'utf8' });
      if (check.status !== 0 || !/0 errors, 0 warnings, 0 infos/.test(check.stdout + check.stderr)) throw new Error(`${n}: luccet check: ${check.stdout}${check.stderr}`);
      const out = path.join(tmp, `${n}.built.html`);
      const build = spawnSync(process.execPath, [path.join(ROOT, 'luccet-cli.js'), 'build', note, '-o', out], { encoding: 'utf8' });
      if (build.status !== 0) throw new Error(`${n}: luccet build: ${build.stdout}${build.stderr}`);
      if (/hljs-|t-mermaid|<svg/.test(fs.readFileSync(out, 'utf8'))) throw new Error(`${n}: luccet build wrote highlighting or a diagram, which are the browser's to do`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return `${addons.length} add-on(s)`;
});

test("code.js: the highlight.js table is well formed", () => {
  const src = fs.readFileSync(path.join(DIR, 'code.js'), 'utf8');
  const block = /\/\/ <hljs>[^\n]*\n([\s\S]*?)\n\s*\/\/ <\/hljs>/.exec(src);
  if (!block) throw new Error('no <hljs> table');
  const HLJS = new Function(`${block[1]}; return HLJS;`)();
  if (!/^\d+\.\d+\.\d+$/.test(HLJS.version)) throw new Error(`version ${HLJS.version}`);
  const sri = /^sha384-[A-Za-z0-9+/]{64}$/;
  if (!sri.test(HLJS.core)) throw new Error(`core hash ${HLJS.core}`);
  const core = new Set((/In the core: ([^.]+)\./.exec(block[1]) || [])[1].split(' '));
  const seen = new Map();
  for (const [name, [hash, ...aliases]] of Object.entries(HLJS.languages)) {
    if (!sri.test(hash)) throw new Error(`${name}: hash ${hash}`);
    if (core.has(name)) throw new Error(`${name} is in the core too`);
    for (const k of [name, ...aliases]) {
      if (k !== k.toLowerCase()) throw new Error(`${name}: "${k}" is not lower case`);
      if (seen.has(k)) throw new Error(`"${k}" names both ${seen.get(k)} and ${name}`);
      seen.set(k, name);
    }
  }
  return `highlight.js ${HLJS.version}: ${core.size} languages in the core, ${Object.keys(HLJS.languages).length} on demand`;
});

test("code.js: the table is the pinned version's (tools/hljs.js --check)", () => {
  const version = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(DIR, 'code.js'), 'utf8'))[1];
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '.cache', 'luccet-smoke', `highlightjs-${version}`, 'highlight.min.js'))) return `skipped: highlight.js ${version} is not cached; node tools/hljs.js --check fetches it`;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'hljs.js'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  return 'checked against the cached package';
});

test("mermaid.js: the Mermaid table is well formed", () => {
  const src = fs.readFileSync(path.join(DIR, 'mermaid.js'), 'utf8');
  const block = /\/\/ <mermaid>[^\n]*\n([\s\S]*?)\n\s*\/\/ <\/mermaid>/.exec(src);
  if (!block) throw new Error('no <mermaid> table');
  const MERMAID = new Function(`${block[1]}; return MERMAID;`)();
  if (!/^\d+\.\d+\.\d+$/.test(MERMAID.version)) throw new Error(`version ${MERMAID.version}`);
  if (!/^sha384-[A-Za-z0-9+/]{64}$/.test(MERMAID.sri)) throw new Error(`hash ${MERMAID.sri}`);
  return `Mermaid ${MERMAID.version}`;
});

test("mermaid.js: the table is the pinned version's (tools/mermaid.js --check)", () => {
  const version = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(DIR, 'mermaid.js'), 'utf8'))[1];
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '.cache', 'luccet-smoke', `mermaid-${version}`, 'dist', 'mermaid.min.js'))) return `skipped: Mermaid ${version} is not cached; node tools/mermaid.js --check fetches it`;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mermaid.js'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  return 'checked against the cached package';
});

test("mermaid.js: its print palette is luccet.css's (its own colours as they are, the system's as browsers print them)", () => {
  const src = fs.readFileSync(path.join(DIR, 'mermaid.js'), 'utf8');
  const PRINT = new Function(`return ${/const PRINT = (\{[\s\S]*?\});/.exec(src)[1]}`)();
  const long = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h);
  const want = require('./lib/palette').printPalette();
  const keys = new Set([...Object.keys(PRINT), ...Object.keys(want)]);
  const off = [];
  for (const k of keys) {
    if (!/^#[0-9a-f]{6}$/.test(PRINT[k] || '')) off.push(`--t-${k}: ${PRINT[k]} is not #rrggbb`);
    else if (/^#/.test(want[k] || '') && PRINT[k] !== long(want[k])) off.push(`--t-${k}: ${PRINT[k]}, luccet.css prints ${want[k]}`);
  }
  if (PRINT.bg !== '#ffffff' || PRINT.fg !== '#000000') off.push(`Canvas and CanvasText print white and black, not ${PRINT.bg} and ${PRINT.fg}`);
  if (off.length) throw new Error(off.join('; '));
});

// ---------------------------------------------------------------- cite.js

// cite.js with the real engine: window.luccet is luccet.js itself, so its
// transforms register with it, as in a browser (test/smoke.js has the page).
const vm = require('vm');
const luccet = require('../luccet.js');
function loadCite(LUCCET) {
  const ctx = { window: { luccet, LUCCET: LUCCET || {} }, console };
  ctx.window.window = ctx.window;
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'cite.js'), 'utf8'), ctx, { filename: 'cite.js' });
}
const html = (src, opts) => luccet.toHTML(src, Object.assign({ positions: false }, opts));
const codes = (src, opts) => luccet.check(src, opts).map((d) => `${d.position.start.line}:${d.position.start.column} ${d.code}`);
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const BIB = `:::bibliography
@string{cj = "The Computer Journal"}
@article{knuth84,
  author = {Knuth, Donald E.}, title = {Literate {P}rogramming},
  journal = cj, volume = 27, number = 2, pages = {97--111}, year = 1984,
  doi = {10.1093/comjnl/27.2.97}
}
@book{lamport94, author = "Leslie Lamport", title = "{\\LaTeX}: A Document Preparation System", publisher = {Addison-Wesley}, edition = {2nd}, year = 1994}
@inproceedings{vdb, author = {Jan van der Berg and M{\\"u}ller, Hans-Peter and others}, title = {Caf\\'e culture}, booktitle = {Proc. of Things}, pages = {1-10}, year = {2001}, month = jan}
@phdthesis{uncited, author = {A. Person}, title = {A thesis}, school = {MIT}, year = 2010}
:::
`;

test('glossary.js: under luccet check and luccet build, :term[x] is a link to the glossary page (page= as written; a page that is not there is link.missing), ::glossary stays empty, and luccet index gathers the terms', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luccet-glossary-'));
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'luccet-cli.js'), ...args], { cwd: tmp, encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(tmp, 'luccet.js'), '');
    fs.copyFileSync(path.join(DIR, 'glossary.js'), path.join(tmp, 'glossary.js'));
    const use = 'glossary.js';
    fs.writeFileSync(path.join(tmp, 'a.html'), `<!doctype html><meta charset="utf-8"><title>A</title><script src="luccet.js" data-use="${use}"></script>\n# A {#top}\n\nA :dfn[truism] is obvious. Every :term[truism] and :term[kernels]{title=kernel} links.\n\n::glossary\n`);
    fs.writeFileSync(path.join(tmp, 'b.html'), `<!doctype html><meta charset="utf-8"><title>B</title><script src="luccet.js" data-use="${use}?page=/wiki/glossary.html"></script>\nSee :term[truism].\n`);
    let r = cli(['check', 'a.html']);
    assert(r.status === 0 && /link\.missing/.test(r.stdout) && /glossary\.html does not exist/.test(r.stdout), `a missing glossary page is link.missing: ${r.stdout}${r.stderr}`);
    fs.writeFileSync(path.join(tmp, 'glossary.html'), `<!doctype html><meta charset="utf-8"><script src="luccet.js" data-use="${use}"></script>\n::glossary\n`);
    r = cli(['check', 'a.html', 'b.html', 'glossary.html']);
    assert(r.status === 0 && /3 notes: 0 errors, 0 warnings, 0 infos/.test(r.stderr), `with the page: ${r.stdout}${r.stderr}`);
    r = cli(['build', 'a.html']);
    assert(r.status === 0, `luccet build: ${r.stderr}`);
    const links = [...r.stdout.matchAll(/<span class="term" data-t="term"([^>]*)><a href="([^"]*)">([^<]*)<\/a><\/span>/g)].map((m) => `${m[3]}→${m[2]}${/ title="([^"]*)"/.test(m[1]) ? ` (${/ title="([^"]*)"/.exec(m[1])[1]})` : ''}`);
    assert(links.join(' ') === 'truism→glossary.html kernels→glossary.html (kernel)', `the uses in the built page: ${links.join(' ')}; the entry's # is added when the page shows`);
    assert(/<div class="glossary t-glossary" data-t="glossary" role="region" aria-label="Glossary"><\/div>|<div id="[^"]*" class="glossary t-glossary"[^>]*><\/div>|<div class="glossary"[^>]*><\/div>/.test(r.stdout), `the leaf, empty: ${/<div[^>]*glossary[^>]*>[^]*?<\/div>/.exec(r.stdout)}`);
    assert(/<a href="\/wiki\/glossary\.html">truism<\/a>/.test(cli(['build', 'b.html']).stdout), 'page= as written');
    r = cli(['index', '.']);
    assert(r.status === 0 && /3 notes, [0-9]+ entries, 1 term → /.test(r.stderr), `luccet index: ${r.stderr}`);
    const g = JSON.parse(fs.readFileSync(path.join(tmp, 'glossary.json'), 'utf8'));
    assert(g.terms.length === 1 && g.terms[0].term === 'truism' && g.terms[0].url === 'a.html' && g.terms[0].id === 'top', `glossary.json: ${JSON.stringify(g.terms)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cite.js: a BibTeX bibliography lists the cited sources in author order, formatted; @key reads [n], ref=number n, ref=title the title', () => {
  loadCite();
  const out = html(`See @vdb, @knuth84, @knuth84{ref=number}, @knuth84{ref=title} and @knuth84{ref=label}.\n\n${BIB}`);
  const li = [...out.matchAll(/<li id="([^"]+)" class="bib numeric" data-t="bib"><span class="t-label">(\[\d\])<\/span> ([^]*?)<\/li>/g)].map((m) => [m[1], m[2], m[3]]);
  assert(li.map((x) => x[0]).join() === 'knuth84,vdb', `entries ${li.map((x) => x[0]).join()}: expected the two cited, Knuth before van der Berg, uncited left out`);
  assert(li[0][1] === '[1]' && li[1][1] === '[2]', `labels ${li.map((x) => x[1])}`);
  assert(li[0][2] === 'Knuth, D. E. (1984). Literate Programming. <em>The Computer Journal</em>, 27(2), 97–111. <a href="https://doi.org/10.1093/comjnl/27.2.97">https://doi.org/10.1093/comjnl/27.2.97</a>', `Knuth: ${li[0][2]}`);
  assert(li[1][2] === 'van der Berg, J., Müller, H.-P., et al. (2001). Café culture. In <em>Proc. of Things</em> (pp. 1–10).', `van der Berg: ${li[1][2]}`);
  const refs = [...out.matchAll(/<a class="t-ref cite" href="#(\w+)">([^<]*)<\/a>/g)].map((m) => `${m[1]}=${m[2]}`);
  assert(refs.join(' ') === 'vdb=[2] knuth84=[1] knuth84=1 knuth84=Literate Programming knuth84=[1]', `citations ${refs.join(' ')}`);
  assert(/<section class="t-block bibliography" data-t="bibliography" role="doc-bibliography"><div class="t-title">References<\/div><ul class="t-block bib-list" data-t="bib-list" role="list">/.test(out), `the block: ${out.slice(out.indexOf('<section'), out.indexOf('<section') + 200)}`);
  assert(!/sort=|style=/.test(out), 'the options are not written to the page');
  assert(codes(`See @knuth84.\n\n${BIB}`).length === 0, `diagnostics ${codes(`See @knuth84.\n\n${BIB}`)}`);
  assert(/<div class="t-title">Literatur<\/div>/.test(html(`@knuth84\n\n${BIB}`, { lang: 'de' })), 'the heading follows the label language');
  assert(/<div class="t-title">Quellen<\/div>/.test(html(`@knuth84\n\n${BIB.replace(':::bibliography', ':::bibliography[Quellen]')}`)), 'a written title is the heading');
});

test('cite.js: sort=cited numbers in the order of first citation, `all` lists every source, a second block keeps counting', () => {
  loadCite();
  const out = html(`@vdb then @knuth84.\n\n${BIB.replace(':::bibliography', ':::bibliography{sort=cited all}')}`);
  const ids = [...out.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]);
  assert(ids.join() === 'vdb,knuth84,lamport94,uncited', `order ${ids.join()}: cited first in citation order, then the rest by author`);
  assert(/href="#vdb">\[1\]<\/a> then <a class="t-ref cite" href="#knuth84">\[2\]/.test(out), 'the numbers follow the list');
  const src = html(`@vdb\n\n${BIB.replace(':::bibliography', ':::bibliography{sort=source all}')}`);
  assert([...src.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]).join() === 'knuth84,lamport94,vdb,uncited', 'sort=source keeps the order written');
});

test('cite.js: style=author-year cites (Author, Year), ref=label the narrative form, ref=number the year; two authors, et al., no date', () => {
  loadCite();
  const CSL = `:::bibliography[Sources]{style=author-year}
[{"id": "k", "type": "article-journal", "title": "Literate programming", "author": [{"family": "Knuth", "given": "Donald E."}], "container-title": "The Computer Journal", "volume": "27", "issue": "2", "page": "97-111", "issued": {"date-parts": [[1984]]}, "DOI": "10.1093/comjnl/27.2.97"},
 {"id": "two", "type": "book", "title": "Two authors", "author": [{"family": "Abel", "given": "N."}, {"family": "Borel", "given": "É."}], "issued": {"date-parts": [[1900]]}, "publisher": "Springer"},
 {"id": "three", "type": "chapter", "title": "Three authors", "author": [{"family": "Zed", "given": "A."}, {"family": "Yu"}, {"literal": "The Group"}], "container-title": "A Book", "page": "5"}]
:::
`;
  const out = html(`@k, @k{ref=label}, @k{ref=number}, @two, @three and @three{ref=full}.\n\n${CSL}`);
  const refs = [...out.matchAll(/<a class="t-ref cite" href="#(\w+)">([^<]*)<\/a>/g)].map((m) => m[2]);
  assert(refs.join(' | ') === '(Knuth, 1984) | Knuth (1984) | 1984 | (Abel and Borel, 1900) | (Zed et al., n.d.) | Zed et al. (n.d.). Three authors', `citations ${refs.join(' | ')}`);
  const li = [...out.matchAll(/<li id="([^"]+)" class="bib author-year" data-t="bib">([^]*?)<\/li>/g)].map((m) => [m[1], m[2]]);
  assert(li.map((x) => x[0]).join() === 'two,k,three', `author order ${li.map((x) => x[0]).join()}`);
  assert(!/t-label/.test(out), 'author-year entries have no number label');
  assert(li[1][1] === 'Knuth, D. E. (1984). Literate programming. <em>The Computer Journal</em>, 27(2), 97–111. <a href="https://doi.org/10.1093/comjnl/27.2.97">https://doi.org/10.1093/comjnl/27.2.97</a>', `Knuth: ${li[1][1]}`);
  assert(li[0][1] === 'Abel, N. and Borel, É. (1900). <em>Two authors</em>. Springer.', `Abel: ${li[0][1]}`);
  assert(li[2][1] === 'Zed, A., Yu, and The Group (n.d.). Three authors. In <em>A Book</em> (p. 5).', `Zed: ${li[2][1]}`);
  assert(/<div class="t-title">Sources<\/div>/.test(out), 'the written title');
});

test('cite.js: window.LUCCET.bib is a shared source, BibTeX text or CSL items, listed by the first block; an empty block lists from it alone', () => {
  loadCite({ bib: '@book{shared, author = {Ada Lovelace}, title = {Notes}, year = 1843, publisher = {Taylor}}' });
  let out = html('@shared\n\n:::bibliography\n:::\n');
  assert(/<li id="shared" class="bib numeric" data-t="bib"><span class="t-label">\[1\]<\/span> Lovelace, A\. \(1843\)\. <em>Notes<\/em>\. Taylor\.<\/li>/.test(out), `from LUCCET.bib: ${out}`);
  loadCite({ bib: [{ id: 'csl', type: 'report', title: 'A report', number: '7', publisher: 'NIST', issued: { raw: '2020' } }] });
  out = html('@csl and @k\n\n:::bibliography\n@misc{k, title = {In the note}, year = 1999}\n:::\n');
  const ids = [...out.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]);
  assert(ids.join() === 'csl,k', `both sources: ${ids.join()}`);
  assert(/A report \(7\)\. NIST\./.test(out) && /\(2020\)/.test(out), `the report: ${out}`);
  out = html('@csl and @k\n\n:::bibliography\n@misc{k, title = {In the note}, year = 1999}\n:::\n\n:::bibliography{all}\n@misc{z, title = {Z}}\n:::\n');
  assert([...out.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]).join() === 'csl,k,z', `the page's sources go with the first block alone: ${[...out.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]).join()}`);
  loadCite();
});

test('cite.js: cite.syntax, cite.duplicate, cite.key and cite.empty at the entry\'s line; the engine\'s ref.dangling for an unknown key; entries carry their line', () => {
  loadCite();
  const src = `# T\n\n@weird and @nope.\n\n:::bibliography{all}\n\n@article{broken, title = {no closing\n@misc{weird:key, title = {Odd}, year = 2000}\n@misc{a, title = {A}}\n@misc{a, title = {Again}}\n@ junk\n:::\n\n:::bibliography\n:::\n`;
  const got = codes(src);
  assert(got.join(' | ') === '3:1 ref.dangling | 3:12 ref.dangling | 7:1 cite.syntax | 8:1 cite.key | 10:1 cite.duplicate | 11:1 cite.syntax | 14:1 cite.empty', `diagnostics ${got.join(' | ')}`);
  const d = luccet.check(src);
  assert(d.find((x) => x.code === 'cite.syntax').severity === 'warning' && d.find((x) => x.code === 'cite.empty').severity === 'info', 'severities');
  assert(/a brace is not closed/.test(d[2].message) && /given twice/.test(d.find((x) => x.code === 'cite.duplicate').message), 'messages');
  const out = luccet.toHTML(src);
  assert(/<li class="bib numeric" data-t="bib" data-pos="8:1"><span class="t-label">\[2\]<\/span> Odd\. \(2000\)\./.test(out), `the unreachable key is listed without an id, at its line: ${out}`);
  assert(/<li id="a" class="bib numeric" data-t="bib" data-pos="9:1/.test(out), 'an entry carries its line as its position');
  const { ast } = luccet.parse(src);
  luccet.transform(ast);
  assert(ast.data.luccet.ids.a && ast.data.luccet.ids.a.line === 9, `the id registry has the entry at its line: ${JSON.stringify(ast.data.luccet.ids.a)}`);
  const json = codes('@x\n\n:::bibliography\n[{"id": "x", "title": "No comma" "type": "book"}]\n:::\n');
  assert(json.join() === '1:1 ref.dangling,4:1 cite.syntax', `bad JSON: ${json.join()}`);
});

test('cite.js: under luccet check and luccet build, through the sandbox: the same list and the diagnostics with file lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luccet-cite-'));
  try {
    fs.writeFileSync(path.join(tmp, 'luccet.js'), '');
    fs.copyFileSync(path.join(DIR, 'cite.js'), path.join(tmp, 'cite.js'));
    const use = 'cite.js';
    const note = path.join(tmp, 'note.html');
    fs.writeFileSync(note, `<!doctype html><meta charset="utf-8"><script>window.LUCCET = {bib: '@book{shared, author = {Ada Lovelace}, title = {Notes}, year = 1843}'};</script><script src="luccet.js" data-use="${use}"></script>\n\nSee @knuth84, @shared and @gone.\n\n${BIB.replace(/:::\n$/, '@junk\n:::\n')}`);
    const check = spawnSync(process.execPath, [path.join(ROOT, 'luccet-cli.js'), 'check', note], { encoding: 'utf8' });
    const lines = (check.stdout + check.stderr).split('\n').filter((l) => /^\S.*:\d+:\d+: (?:warning|error|info) /.test(l));
    assert(/note\.html:3:\d+: warning ref\.dangling/.test(lines[0]) && /note\.html:15:1: warning cite\.syntax: .*@junk is not followed by "\{"/.test(lines[1]) && lines.length === 2, `luccet check:\n${check.stdout}${check.stderr}`);
    const out = path.join(tmp, 'built.html');
    const build = spawnSync(process.execPath, [path.join(ROOT, 'luccet-cli.js'), 'build', note, '-o', out], { encoding: 'utf8' });
    assert(build.status === 0, `luccet build: ${build.stdout}${build.stderr}`);
    const page = fs.readFileSync(out, 'utf8');
    assert(/<li id="knuth84" class="bib numeric" data-t="bib"[^>]*><span class="t-label">\[1\]<\/span> Knuth, D\. E\. \(1984\)\./.test(page) && /<li id="shared" class="bib numeric"[^>]*><span class="t-label">\[2\]<\/span> Lovelace, A\. \(1843\)\. <em>Notes<\/em>\./.test(page), `the built page: ${page.slice(page.indexOf('<section'), page.indexOf('</section>'))}`);
    assert(/href="#knuth84">\[1\]<\/a>, <a class="t-ref cite" href="#shared">\[2\]<\/a> and @gone\./.test(page), 'the citations on the built page');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} add-on checks pass`);
process.exit(failed ? 1 : 0);
