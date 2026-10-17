#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The command line: `node tern-cli.js` new, check, parse, build, mv, search,
// index and corpus, spawned in a temporary directory, and the note-detection regex against
// test/fixtures/detect.json. Zero dependencies.
// `build --katex` is tested when the smoke tests' KaTeX copy exists
// (node_modules/.cache/tern-smoke/katex-*/dist), through a `katex` package
// on NODE_PATH; otherwise that part is skipped and says so.
//
//   node test/cli.js [--filter=TEXT]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tokenize, normalize, firstDifference } = require('./lib/html');
const { loadAll } = require('./lib/corpus');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tern-cli.js');
const tern = require(path.join(ROOT, 'tern.js'));
const { DETECT, detect, split } = require(path.join(ROOT, 'cli', 'note.js'));
const { decodeSource } = require(path.join(ROOT, 'cli', 'build.js'));
// KaTeX's pinned version and SRI hashes live in the add-on's table now.
const KATEX = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'addons', 'katex.js'), 'utf8');
  const g = (k) => (new RegExp(`${k}: '([^']+)'`).exec(src) || [])[1];
  return { version: g('version'), js: g('js'), css: g('css') };
})();
const FILTER = (process.argv.find((a) => a.startsWith('--filter=')) || '').slice(9);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-cli-'));
const at = (...p) => path.join(TMP, ...p);
// A note's local tern.js is written too, empty, unless { tern: false }: tern
// check reports a tern.js that is not there (link.missing, an error).
function write(rel, text, { tern = true } = {}) {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
  const m = tern && /<script\b[^<>]*\ssrc="((?:[^":/]+\/)*)tern\.js"/.exec(text);
  const stub = m && path.resolve(path.dirname(at(rel)), `${m[1]}tern.js`);
  if (stub && stub.startsWith(TMP) && !fs.existsSync(stub)) fs.writeFileSync(stub, '');
}
const read = (rel) => fs.readFileSync(at(rel), 'utf8');
function run(args, { cwd = TMP, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

class Skip extends Error {}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
const exits = (r, code, what) => ok(r.code === code, `${what}: exit ${r.code}, expected ${code}${r.err ? `; stderr: ${r.err.trim().split('\n')[0]}` : ''}`);
const FIRST = '<!doctype html><meta charset="utf-8">';

// Well-formed HTML: a doctype first; every element closed in order, except
// those whose tags are optional here (html, head, body).
function wellFormed(html) {
  const toks = tokenize(html);
  ok(toks[0] && toks[0].t === 'decl' && /^<!doctype html>$/i.test(toks[0].v), 'the page starts with <!doctype html>');
  const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
  const OPTIONAL = new Set(['html', 'head', 'body']);
  const stack = [];
  for (const t of toks) {
    if (t.t === 'open' && !VOID.has(t.name) && !OPTIONAL.has(t.name) && !t.selfClosed) stack.push(t.name);
    if (t.t === 'close' && !OPTIONAL.has(t.name)) {
      const top = stack.pop();
      ok(top === t.name, `</${t.name}> closes <${top}>`);
    }
  }
  ok(!stack.length, `unclosed: ${stack.join(', ')}`);
}

// The parts of a built page.
function pageParts(html) {
  const main = /<main class="tern">([\s\S]*)<\/main>\n<script type="text\/tern"/.exec(html);
  const src = /<script type="text\/tern" id="tern-source" data-line="(\d+)">([\s\S]*?)<\/script>/.exec(html);
  const diags = /<script type="application\/json" id="tern-diagnostics">([\s\S]*?)<\/script>/.exec(html);
  const head = html.slice(0, html.indexOf('<main class="tern">'));
  return { head, main: main && main[1], line: src && Number(src[1]), source: src && src[2], diagnostics: diags && JSON.parse(diags[1]) };
}

// ---------------------------------------------------------------- DETECT

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'detect.json'), 'utf8'));

test('detect.json: its pattern is cli/note.js DETECT', () => {
  eq(fixture.pattern, DETECT.source, 'pattern');
  eq(fixture.flags, DETECT.flags, 'flags');
});

test('detect.json: every case holds, for the published pattern and for detect()', () => {
  const re = new RegExp(fixture.pattern, fixture.flags); // as an editor builds it
  ok(fixture.match.length >= 15 && fixture.noMatch.length >= 15, 'the fixtures have their cases');
  for (const c of fixture.match) {
    const m = re.exec(c.line);
    ok(m && m[fixture.tagGroup] === c.tag, `${c.why}: ${m ? `captured ${m[fixture.tagGroup]}` : 'no match'} for ${c.line}`);
    const d = detect(c.line);
    ok(d && d.tag === c.tag && c.line.slice(d.index, d.index + d.tag.length) === c.tag, `detect(): ${c.why}`);
  }
  for (const c of fixture.noMatch) ok(!re.test(c.line) && !detect(c.line), `${c.why}: matched ${c.line}`);
  const covered = ['quotes', 'query', 'defer', 'async', 'upper case', 'mytern.js', 'tern.json', 'commented-out', 'middle of the line'];
  const whys = [...fixture.match, ...fixture.noMatch].map((c) => c.why).join('\n');
  for (const w of covered) ok(whys.includes(w), `a case about ${w}`);
});

test('DETECT takes linear time on pathological lines', () => {
  for (const line of ['<script '.repeat(40000), `${'<script '.repeat(40000)}src=tern.js>`, `<!-- ${'x - '.repeat(100000)}`, '<a>'.repeat(200000), `${'<script src="'.repeat(40000)}`]) {
    const t = process.hrtime.bigint();
    DETECT.test(line);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    ok(ms < 250, `${ms.toFixed(0)} ms on a ${line.length}-character line starting ${JSON.stringify(line.slice(0, 20))}`);
  }
});

// ---------------------------------------------------------------- new

const GUARDED = /<\/script>(<noscript>[\s\S]*<plaintext>)$/;

test('new: the canonical first line, loading the nearest tern.js above', () => {
  write('w/tern.js', '// stand-in\n');
  fs.mkdirSync(at('w/a/b'), { recursive: true });
  const r = run(['new', 'w/a/b/note.html']);
  exits(r, 0, 'new');
  eq(read('w/a/b/note.html'), `${FIRST}<script src="../../tern.js"></script>\n`, 'the file');
  ok(/created w\/a\/b\/note\.html, loading \.\.\/\.\.\/tern\.js/.test(r.out), `stdout: ${r.out}`);
  exits(run(['new', 'w/same.html']), 0, 'new next to tern.js');
  eq(read('w/same.html'), `${FIRST}<script src="tern.js"></script>\n`, 'tern.js in the same directory');
});

test('new: without a tern.js above, src="tern.js" and a note on stderr', () => {
  let found = false;
  for (let d = TMP; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tern.js'))) found = true;
    if (path.dirname(d) === d) break;
  }
  if (found) throw new Skip(`a tern.js exists above ${TMP}`);
  const r = run(['new', 'lone.html']);
  exits(r, 0, 'new');
  eq(read('lone.html'), `${FIRST}<script src="tern.js"></script>\n`, 'the file');
  ok(/no tern\.js in \. or above/.test(r.err), `stderr: ${r.err}`);
});

test('new: --tern, --use (commas, spaces, repeated) and --title', () => {
  write('o/a.js', '');
  const r = run(['new', 'o/n.html', '--tern=https://cdn.example/x/tern.js', '--use=a.js,b.css', '--use', 'c.js d.css', '--title=Linear maps: kernel & image']);
  exits(r, 0, 'new');
  eq(read('o/n.html'), `${FIRST}<script src="https://cdn.example/x/tern.js"></script>\n:::meta\ntitle: Linear maps: kernel & image\n:::\n\n:::use\na.js\nb.css\nc.js\nd.css\n:::\n\n`, 'the file');
  ok(/:::use names b\.css, which does not exist yet/.test(r.err) && !/names a\.js/.test(r.err), `stderr: ${r.err}`);
  const ast = JSON.parse(run(['parse', 'o/n.html', '--transformed']).out);
  eq(ast.data.tern.meta.title, 'Linear maps: kernel & image', 'the title read back');
});

test('new --guarded: the guard follows the tag on the tern.js line, and the file is still a note', () => {
  write('g/tern.js', '');
  exits(run(['new', 'g/n.html', '--guarded', '--title=Guarded']), 0, 'new --guarded');
  const text = read('g/n.html');
  const first = text.split('\n')[0];
  ok(first.startsWith(`${FIRST}<script src="tern.js"></script><noscript>`), `first line: ${first}`);
  ok(GUARDED.test(first) && /self\.tern\|\|document\.write\(/.test(first), 'the guard script and its <plaintext>');
  ok(fixture.match.some((c) => c.line === first), 'detect.json holds the line tern new --guarded writes');
  const parts = split(text);
  ok(parts && parts.line === 1 && parts.tag === '<script src="tern.js">' && parts.head === FIRST, 'split() finds the tag on line 1');
  ok(parts.note.startsWith(':::meta\ntitle: Guarded'), 'the note starts on line 2');
  const c = run(['check', 'g/n.html']);
  exits(c, 0, 'check');
  ok(/1 note: 0 errors/.test(c.err), `check: ${c.err}`);
});

test('new: refusals and usage errors', () => {
  write('r/tern.js', '');
  write('r/old.html', 'keep me');
  fs.mkdirSync(at('r/dir.html'), { recursive: true });
  exits(run(['new', 'r/old.html']), 1, 'an existing file');
  eq(read('r/old.html'), 'keep me', 'the existing file');
  exits(run(['new', 'r/old.html', '--force']), 0, 'an existing file with --force');
  eq(read('r/old.html'), `${FIRST}<script src="tern.js"></script>\n`, 'the overwritten file');
  exits(run(['new', 'r/dir.html']), 1, 'a directory');
  exits(run(['new', 'r/nowhere/n.html']), 1, 'a missing directory');
  const notTern = run(['new', 'r/min.html', '--tern=lib/tern.min.js']);
  exits(notTern, 1, '--tern naming another file');
  ok(/must name a file called tern\.js/.test(notTern.err) && !fs.existsSync(at('r/min.html')), 'nothing written for --tern=lib/tern.min.js');
  for (const args of [['new'], ['new', 'r/'], ['new', '.'], ['new', 'r/..'], ['new', 'a.html', 'b.html'], ['new', 'r/t.html', '--title='], ['new', 'r/t.html', '--bogus']]) {
    const r = run(args);
    exits(r, 2, args.join(' '));
    ok(/usage: tern new FILE/.test(r.err), `${args.join(' ')} prints the synopsis`);
  }
});

// ---------------------------------------------------------------- check

// Note line n is file line n + 1 below the canonical first line.
const PROBLEMS = `${FIRST}<script src="tern.js"></script>
# Problems

See @nowhere.

:::aside
never closed
`;

test('check: file:line:col, severity, code, message, the hint indented; exit 1 on an error', () => {
  write('c/p.html', PROBLEMS);
  const r = run(['check', 'c/p.html']);
  exits(r, 1, 'check');
  const lines = r.out.trimEnd().split('\n');
  eq(lines.length, 4, `lines of output (${r.out})`);
  ok(/^c\/p\.html:4:5: warning ref\.dangling: \S/.test(lines[0]), `line 1: ${lines[0]}`);
  ok(/^ {4}\S/.test(lines[1]), `the hint, indented: ${lines[1]}`);
  ok(/^c\/p\.html:6:1: error block\.unclosed: /.test(lines[2]), `line 3: ${lines[2]}`);
  ok(/1 note: 1 error, 1 warning, 0 infos/.test(r.err), `summary: ${r.err}`);
});

test('search: FILE:LINE, the label and id, the passage; file lines; exit 1 on a miss; --json; --limit', () => {
  write('s/alpha.html', `${FIRST}<title>Alpha</title><script src="tern.js"></script>\n# Triangles {#tri}\n\nThe hypotenuse: $c=\\sqrt{a^2+b^2}$.\n\n:::note[I.1]{#ex-1}\nProve Pythagoras theorem using\\\nsquares.\n:::\n`);
  write('s/beta.html', `${FIRST}<script src="tern.js"></script>\n# Circles\n\nThe triangles inscribed in a circle on a diameter are right triangles.\n`);
  write('s/plain.html', 'not a note', { tern: false });
  let r = run(['search', 'pythag', 's']);
  exits(r, 0, 'a hit');
  eq(r.out, 's/alpha.html:6: note I.1 (#ex-1)\n    Prove Pythagoras theorem using squares.\n', 'the hit, at the file line of the block, the hard break a space');
  ok(/tern search: 2 notes, 3 entries: 1 result\n$/.test(r.err), `summary: ${r.err}`);
  r = run(['search', 'triangle', 's']);
  exits(r, 0, 'two hits');
  eq(r.out.split('\n').filter((l) => /^s\//.test(l)), ['s/alpha.html:2: Triangles (#tri)', 's/beta.html:2: Circles (#circles)'], 'the heading first (a title hit weighs more), then beta');
  r = run(['search', 'triangle', 's', '--limit=1', '--json']);
  exits(r, 0, 'json');
  const hits = JSON.parse(r.out);
  eq(hits.length, 1, '--limit');
  eq([hits[0].file, hits[0].line, hits[0].endLine, hits[0].id, hits[0].kind, hits[0].label, hits[0].page, hits[0].snippet], ['s/alpha.html', 2, 10, 'tri', 'heading', 'Triangles', 'Alpha', 'The hypotenuse: c=\\sqrt{a^2+b^2}.'], 'the fields');
  ok(hits[0].score > 0 && hits[0].marks.length === 0, 'score and marks (the match is in the title, not the text)');
  r = run(['search', 'nothingofthesort', 's']);
  exits(r, 1, 'a miss');
  eq(r.out, '', 'nothing printed');
  ok(/0 results/.test(r.err), r.err);
  r = run(['search', 'pythag', 's/plain.html']);
  exits(r, 1, 'a named non-note');
  ok(/plain\.html is not a note/.test(r.err), r.err);
  r = run(['search', 'pythag'], { cwd: path.join(TMP, 's') });
  exits(r, 0, 'the current folder by default');
  r = run(['search']);
  exits(r, 2, 'no query');
  r = run(['search', '--', 's']);
  exits(r, 2, 'a query with no word');
  r = run(['search', 'x', 's', '--limit=0']);
  exits(r, 2, '--limit=0');
  r = run(['search', 'x', 'nowhere']);
  exits(r, 2, 'a missing path');
});

// Today, as tern index dates a file outside a repository: YYYY-MM-DD, local time.
const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

test('index: notes.json and search.json, paths relative to -o, titles, descriptions and dates from the head and :::meta, links to notes in the catalogue, noindex left out; --check; search --index', () => {
  write('i/a.html', `${FIRST}<title>A note</title><meta name="description" content="About A &amp; B"><script src="tern.js"></script>\n:::meta\ndate: 2026-01-02\n:::\n\n# Alpha {#alpha}\n\nSee [b](sub/b.html), [c](c.html#secret), [the readme](README.md), [b again](sub/b.html?x) and [nowhere](https://example.com/x.html).\n\n:::note[I.1]{#ex-1}\nProve Pythagoras theorem.\n:::\n`);
  write('i/sub/b.html', `${FIRST}<script src="../tern.js"></script>\n:::meta\ntitle: Bee\ndescription: From meta\n:::\n\n# Bee\n\nBack to [a](../a.html).\n`);
  write('i/c.html', `${FIRST}<title>Private</title><meta name="robots" content="noindex, follow"><script src="tern.js"></script>\n# Secret {#secret}\n\nNot listed.\n`);
  write('i/plain.html', 'not a note', { tern: false });
  let r = run(['index', 'i']);
  exits(r, 0, 'index');
  eq(r.err, 'tern index: 2 notes, 3 entries; 1 noindex → i/notes.json, i/search.json\n', 'the summary');
  const notes = JSON.parse(read('i/notes.json'));
  eq(notes.tern, tern.version, 'the version that wrote it');
  eq(notes.notes.map((n) => [n.url, n.title, n.description, n.date, n.links]), [['a.html', 'A note', 'About A & B', '2026-01-02', ['sub/b.html']], ['sub/b.html', 'Bee', 'From meta', TODAY, ['a.html']]], 'the catalogue: the head\'s title and description, else :::meta\'s; the meta date, else the file\'s day; links to notes in the catalogue only, as paths like the notes\', each once');
  eq(notes.notes[0].headings, [{ depth: 1, id: 'alpha', text: 'Alpha' }], 'the headings');
  ok(read('i/notes.json').endsWith('}\n') && read('i/notes.json').includes('\n  "notes": [\n    {\n      "url": "a.html",'), 'notes.json is pretty-printed');
  const idx = JSON.parse(read('i/search.json'));
  eq([idx.tern, idx.notes], [tern.version, [{ url: 'a.html', title: 'A note' }, { url: 'sub/b.html', title: 'Bee' }]], 'the index names its notes');
  eq(idx.entries.map((e) => [e.url, e.id, e.line, e.endLine, e.kind, e.label]), [['a.html', 'alpha', 6, 13, 'heading', 'Alpha'], ['a.html', 'ex-1', 10, 12, 'note', 'note'], ['sub/b.html', 'bee', 7, 10, 'heading', 'Bee']], 'the entries, at file lines (a section ends on the line after the final newline, as tern search prints it)');
  eq(Object.keys(idx.terms), Object.keys(idx.terms).slice().sort(), 'the terms are sorted');
  ok(Array.isArray(idx.lengths) && idx.lengths.length === 3 && idx.avg > 0, 'lengths and avg');
  ok(/\n "pythagora": \[\[1,1\]\],?\n/.test(read('i/search.json')), `one term per line: ${read('i/search.json').slice(0, 200)}`);
  r = run(['index', 'i', '--check']);
  exits(r, 0, '--check, up to date');
  eq(r.err, 'tern index: 2 notes, 3 entries; 1 noindex; both files are up to date\n', 'the check\'s summary');
  write('i/sub/b.html', `${FIRST}<script src="../tern.js"></script>\n:::meta\ntitle: Bee\ndescription: From meta\n:::\n\n# Bee\n\nBack to [a](../a.html), and a new word: quux.\n`);
  r = run(['index', 'i', '--check']);
  exits(r, 1, '--check, stale');
  eq(r.err, 'tern index: i/search.json is stale: run tern index i\ntern index: 2 notes, 3 entries; 1 noindex; 1 of 2 files to write\n', 'the stale file named (the catalogue did not change)');
  fs.rmSync(at('i/notes.json'));
  r = run(['index', 'i', '--check']);
  exits(r, 1, '--check, missing');
  ok(/tern index: i\/notes\.json is missing: run tern index i\n/.test(r.err) && /2 of 2 files to write/.test(r.err), r.err);
  ok(!fs.existsSync(at('i/notes.json')), '--check wrote nothing');
  r = run(['index', 'i/a.html', 'i/sub', '-o', 'i/out']);
  exits(r, 0, '-o');
  eq(JSON.parse(read('i/out/notes.json')).notes.map((n) => [n.url, n.links]), [['../a.html', ['../sub/b.html']], ['../sub/b.html', ['../a.html']]], 'paths relative to -o, which is created');
  r = run(['index', 'i/plain.html']);
  exits(r, 0, 'a named non-note');
  ok(/plain\.html is not a note/.test(r.err) && /0 notes, 0 entries/.test(r.err), r.err);
  r = run(['index', 'i', '-o', 'i/a.html']);
  exits(r, 2, '-o a file');
  r = run(['index', 'nowhere']);
  exits(r, 2, 'a missing path');
  // tern search --index: the same hits from the file, no note read.
  r = run(['index', 'i']);
  exits(r, 0, 'index again');
  fs.rmSync(at('i/a.html'));
  r = run(['search', 'pythag', '--index=i/search.json']);
  exits(r, 0, 'a hit from the index, the note gone');
  eq(r.out, 'i/a.html:10: note I.1 (#ex-1)\n    Prove Pythagoras theorem.\n', 'the hit, at its file line, the path relative to the current folder');
  eq(r.err, 'tern search: 2 notes, 3 entries in i/search.json: 1 result\n', 'the summary');
  r = run(['search', 'bee', '--index=search.json', '--json'], { cwd: path.join(TMP, 'i') });
  exits(r, 0, 'json');
  const hits = JSON.parse(r.out);
  eq([hits[0].file, hits[0].line, hits[0].endLine, hits[0].id, hits[0].label, hits[0].page, hits[0].snippet], ['sub/b.html', 7, 10, 'bee', 'Bee', 'Bee', 'Back to a, and a new word: quux.'], 'the fields');
  r = run(['search', 'nothingofthesort', '--index=i/search.json']);
  exits(r, 1, 'a miss');
  r = run(['search', 'quux', 'i', '--index=i/search.json']);
  exits(r, 2, '--index with a PATH');
  write('i/old.json', JSON.stringify({ tern: '0.1.0', notes: [], entries: [], terms: {}, lengths: [], avg: 0 }), { tern: false });
  r = run(['search', 'quux', '--index=i/old.json']);
  exits(r, 2, 'another version series');
  ok(/old\.json was written by tern 0\.1\.0 and this is /.test(r.err), r.err);
  write('i/notes.txt', '{"a": 1}', { tern: false });
  r = run(['search', 'quux', '--index=i/notes.txt']);
  exits(r, 2, 'not an index');
  ok(/is not a search index/.test(r.err), r.err);
  r = run(['search', 'quux', '--index=i/plain.html']);
  exits(r, 2, 'not JSON');
  r = run(['search', 'quux', '--index=i/none.json']);
  exits(r, 2, 'a missing index');
});

test('index: in a git repository, tracked files only; the date is the last commit\'s day, or today for a file with changes; --all', () => {
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: at('gi'), encoding: 'utf8' });
  fs.mkdirSync(at('gi'), { recursive: true });
  const init = git('init', '-q');
  if (init.error || init.status !== 0) throw new Skip('git is not available');
  write('gi/t.html', `${FIRST}<title>Tracked</title><script src="tern.js"></script>\n# T\n\nTracked.\n`);
  write('gi/u.html', `${FIRST}<title>Untracked</title><script src="tern.js"></script>\n# U\n\nNot added.\n`);
  write('gi/secret.html', `${FIRST}<title>Ignored</title><script src="tern.js"></script>\n# S\n\nIgnored.\n`);
  write('gi/.gitignore', 'secret.html\n', { tern: false });
  ok(git('add', 't.html', 'tern.js', '.gitignore').status === 0, 'git add');
  let r = run(['index', 'gi']);
  exits(r, 0, 'index, staged but not committed');
  eq(JSON.parse(read('gi/notes.json')).notes.map((n) => [n.url, n.date]), [['t.html', TODAY]], 'the tracked note alone, dated today (no commit yet)');
  eq(r.err, 'tern index: 1 note, 1 entry; 2 left out (not tracked by git) → gi/notes.json, gi/search.json\n', 'the summary counts the files left out');
  r = run(['index', 'gi', '--all']);
  exits(r, 0, '--all');
  eq(JSON.parse(read('gi/notes.json')).notes.map((n) => n.url), ['secret.html', 't.html', 'u.html'], '--all indexes every file');
  r = run(['index', 'gi/u.html', 'gi']);
  exits(r, 0, 'a file named');
  eq(JSON.parse(read('gi/notes.json')).notes.map((n) => n.url), ['u.html', 't.html'], 'a file named on the command line is indexed, tracked or not');
  ok(git('commit', '-q', '-m', 'one', '--date=2024-05-06T12:00:00+00:00').status === 0, 'git commit');
  r = run(['index', 'gi']);
  exits(r, 0, 'index after a commit');
  eq(JSON.parse(read('gi/notes.json')).notes.map((n) => [n.url, n.date]), [['t.html', '2024-05-06']], 'the day of the last commit');
  write('gi/t.html', `${FIRST}<title>Tracked</title><script src="tern.js"></script>\n# T\n\nTracked, and changed.\n`);
  const old = new Date('2020-01-02T12:00:00Z');
  fs.utimesSync(at('gi/t.html'), old, old); // not the modification day: the commit to come is today's
  r = run(['index', 'gi']);
  exits(r, 0, 'index with a change');
  eq(JSON.parse(read('gi/notes.json')).notes.map((n) => [n.url, n.date]), [['t.html', TODAY]], 'a changed tracked file is dated today, whatever its modification time');
  fs.utimesSync(at('gi/u.html'), old, old);
  r = run(['index', 'gi/u.html', 'gi']);
  exits(r, 0, 'an untracked file named');
  eq(JSON.parse(read('gi/notes.json')).notes.find((n) => n.url === 'u.html').date, '2020-01-02', 'a file git does not know is dated by its modification time');
});

test('check --fail-on and --quiet', () => {
  write('c/warn.html', `${FIRST}<script src="tern.js"></script>\nSee @nowhere.\n`);
  write('c/info.html', `${FIRST}<script src="tern.js"></script>\nA \\(x\\) here.\n`);
  exits(run(['check', 'c/warn.html']), 0, 'a warning, default --fail-on=error');
  exits(run(['check', 'c/warn.html', '--fail-on=warning']), 1, 'a warning, --fail-on=warning');
  exits(run(['check', 'c/info.html', '--fail-on=warning']), 0, 'an info, --fail-on=warning');
  exits(run(['check', 'c/info.html', '--fail-on=info']), 1, 'an info, --fail-on=info');
  exits(run(['check', 'c/info.html', '--fail-on=fatal']), 2, '--fail-on=fatal');
  const q = run(['check', 'c/p.html', 'c/warn.html', '--quiet']);
  exits(q, 1, '--quiet');
  eq(q.out.trimEnd().split('\n').filter((l) => !l.startsWith(' ')).length, 1, `--quiet prints only errors: ${q.out}`);
  eq(q.err, '', '--quiet stderr');
  eq(run(['check', 'c/warn.html', '--quiet']).out, '', '--quiet with only a warning');
});

test('check --json: the diagnostics array, with file and filePosition', () => {
  const r = run(['check', 'c/p.html', 'c/warn.html', '--json']);
  exits(r, 1, 'check --json');
  const list = JSON.parse(r.out);
  eq(list.map((d) => [d.file, d.code, d.severity, d.filePosition.start.line, d.position.start.line]), [
    ['c/p.html', 'ref.dangling', 'warning', 4, 3],
    ['c/p.html', 'block.unclosed', 'error', 6, 5],
    ['c/warn.html', 'ref.dangling', 'warning', 2, 1],
  ], 'diagnostics');
  ok(list.every((d) => d.message && d.hint && d.position.start.offset >= 0), 'message, hint and position on each');
  eq(JSON.parse(run(['check', 'c/warn.html', '--json', '--quiet']).out), [], '--json --quiet with only a warning');
});

test('check: directories are searched; non-notes skipped, with a note when named', () => {
  write('d/a.html', `${FIRST}<script src="../tern.js"></script>\nSee @x.\n`);
  write('d/sub/b.htm', `${FIRST}<script src="../../tern.js"></script>\n:::x\n`);
  write('d/sub/plain.html', '<!doctype html><p>not a note</p>\n');
  write('d/sub/notes.txt', `${FIRST}<script src="tern.js"></script>\n:::x\n`);
  write('d/node_modules/m.html', `${FIRST}<script src="tern.js"></script>\n:::x\n`);
  write('d/.cache/h.html', `${FIRST}<script src="tern.js"></script>\n:::x\n`);
  write('d/deferred.html', `${FIRST}<script defer src="tern.js"></script>\n# x\n`);
  const r = run(['check', 'd', '--json']);
  exits(r, 1, 'check d');
  eq([...new Set(JSON.parse(r.out).map((d) => d.file))], ['d/a.html', path.join('d', 'sub', 'b.htm')], 'files with diagnostics');
  ok(!/skipped/.test(r.err) && /2 notes/.test(r.err), `no notes about files found in a directory: ${r.err}`);
  const named = run(['check', 'd/sub/plain.html', 'd/deferred.html']);
  exits(named, 0, 'named non-notes');
  ok(/d\/sub\/plain\.html is not a note \(no line loads tern\.js\); skipped/.test(named.err), `stderr: ${named.err}`);
  ok(/d\/deferred\.html is not a note \(it loads tern\.js with defer/.test(named.err), `stderr: ${named.err}`);
  ok(/no notes found/.test(named.err), 'no notes found');
  exits(run(['check', 'd/missing.html']), 2, 'a missing path');
  exits(run(['check']), 2, 'no path');
});

// An add-on that declares vocabulary, touches browser globals while it
// loads, and logs (to stderr: stdout carries JSON).
const ADDON = `
tern.block('box', { tag: 'aside', counter: 'box', label: 'Box', css: '.box { border: 1px solid }', dom(el) { el.dataset.ran = 'yes'; } });
tern.block('blinker', { tag: 'blink' });
customElements.define('x-box', class extends HTMLElement {});
document.addEventListener('DOMContentLoaded', () => {});
console.log('the add-on loaded');
`;

test('check: add-ons load through data-use, and their schema reaches the diagnostics', () => {
  write('a/box.js', ADDON);
  write('a/theme.css', '');
  write('a/n.html', `${FIRST}<script src="tern.js" data-use="box.js?x=1 theme.css"></script>\n:::blinker\nhi\n:::\n`);
  const r = run(['check', 'a/n.html', '--json']);
  exits(r, 0, 'check');
  const list = JSON.parse(r.out); // the add-on's console.log went to stderr
  eq(list.map((d) => [d.code, d.filePosition.start.line, d.filePosition.start.column]), [['tag.not-allowed', 2, 4]], 'the schema gives blinker <blink>');
  ok(/the add-on loaded/.test(r.err), 'the add-on ran (its log on stderr)');
  const ast = JSON.parse(run(['parse', 'a/n.html', '--transformed']).out);
  write('a/box.html', `${FIRST}<script src="tern.js" data-use="box.js"></script>\n:::box[T]\nx\n:::\n`);
  eq(JSON.parse(run(['parse', 'a/box.html', '--transformed']).out).children[0].data.tern.text, 'Box 1', 'the label from the add-on');
  ok(ast.type === 'root', 'parse');
});

test('check: a missing or failing add-on is addon.failed at the tern.js line', () => {
  write('a/missing.html', `<html lang="en">\n${FIRST}<script src="tern.js" data-use="nope.js"></script>\n# x\n`);
  write('a/throws.js', "tern.block('ok', {});\nthrow new Error('boom');\n");
  write('a/throws.html', `${FIRST}<script src="tern.js" data-use="throws.js"></script>\n# x\n`);
  const r = run(['check', 'a/missing.html', 'a/throws.html']);
  exits(r, 1, 'check');
  const lines = r.out.trimEnd().split('\n');
  ok(/^a\/missing\.html:2:1: error addon\.failed: the add-on nope\.js did not load: cannot read /.test(lines[0]), `line 1: ${lines[0]}`);
  ok(/^a\/throws\.html:1:1: error addon\.failed: the add-on throws\.js did not load: it threw: boom/.test(lines[1]), `line 2: ${lines[1]}`);
});

// What a note's code throws or logs reaches the terminal through the tools:
// the control characters that would drive it (ESC, C1, the rest of C0 but
// tab and newline) are taken out on every path, so a note you have not read
// cannot retitle or clear the terminal.
test('check, parse, build: terminal control characters in what an add-on throws or logs are stripped from messages, the console relay and --json', () => {
  write('esc/evil.js', "console.log('title \\x1b]0;OWNED\\x07 end');\nthrow new Error('clear \\x1b[2J\\x9b31m\\x00 done');\n");
  write('esc/n.html', `${FIRST}<script src="tern.js" data-use="evil.js"></script>\n# x\n`);
  const bad = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
  const r = run(['check', 'esc/n.html']);
  exits(r, 1, 'check');
  ok(!bad.test(r.out + r.err), `control characters in the output: ${JSON.stringify(r.out + r.err)}`);
  ok(/it threw: clear \[2J31m done/.test(r.out), `the message, cleaned: ${r.out}`);
  ok(/^title \]0;OWNED end$/m.test(r.err), `the console line, cleaned: ${r.err}`);
  const j = run(['check', 'esc/n.html', '--json']);
  ok(/clear \[2J31m done/.test(JSON.parse(j.out)[0].message), `--json: ${j.out}`);
  for (const args of [['parse', 'esc/n.html'], ['build', 'esc/n.html']]) {
    const p = run(args);
    ok(!bad.test(p.err) && /clear \[2J31m done/.test(p.err), `${args[0]}: ${JSON.stringify(p.err)}`);
  }
});

// A note's own code runs in the sandbox (cli/sandbox.js): a sealed context
// inside a --permission child. It sees no Node, cannot touch the disk, and a
// script or transform that never returns is cut off.
test("check: a note's scripts run sandboxed — no process, no file writes", () => {
  const marker = at('sb/escaped');
  write('sb/break.js', `try { var P = tern.block.constructor('return process')(); if (P) P.mainModule.require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); } catch (e) {}\ntern.block('box', { tag: 'aside', counter: 'box', label: 'reached ' + (typeof globalThis.process) });\n`);
  write('sb/n.html', `${FIRST}<script src="tern.js" data-use="break.js"></script>\n:::box[T]{#k}\nx\n:::\n`);
  exits(run(['check', 'sb/n.html']), 0, 'the note checks clean: the add-on ran, confined');
  ok(!fs.existsSync(marker), 'the add-on could not reach the disk');
  const main = pageParts(run(['build', 'sb/n.html']).out).main;
  ok(/reached undefined/.test(main), `no process in the sandbox: ${main}`);
});

test('check, build: a leading :::use block lists add-ons like data-use; a missing one is addon.failed at its line; a late block is use.late', () => {
  write('u/box.js', "tern.block('box', { label: 'Box' });\n");
  write('u/theme.css', '');
  write('u/n.html', `${FIRST}<script src="tern.js"></script>\n:::meta\ntitle: U\n:::\n\n:::use\nbox.js?x=1\ntheme.css nope.js\n:::\n\n:::box[T]\nx\n:::\n`);
  const r = run(['check', 'u/n.html']);
  exits(r, 1, 'check');
  ok(/^u\/n\.html:8:11: error addon\.failed: the add-on nope\.js did not load: cannot read /m.test(r.out), `stdout: ${r.out}`);
  ok(!/name\.unknown/.test(r.out), 'box.js loaded from :::use, so :::box is known');
  const b = run(['build', 'u/n.html']);
  exits(b, 0, 'build');
  ok(/<script data-built src="tern\.js" data-use="box\.js\?x=1 theme\.css nope\.js"><\/script><script src="box\.js\?x=1"><\/script><script src="nope\.js"><\/script>/.test(b.out), `the tag and the static add-on tags: ${b.out.slice(0, 400)}`);
  ok(/<link rel="stylesheet" href="theme\.css">/.test(b.out) && !/data-t="use"/.test(b.out) && /<span class="t-label">Box<\/span>/.test(b.out), 'the stylesheet, no :::use in the body, the add-on applied');
  write('u/late.html', `${FIRST}<script src="tern.js"></script>\nText.\n\n:::use\nbox.js\n:::\n`);
  const l = run(['check', 'u/late.html']);
  ok(/^u\/late\.html:4:1: warning use\.late: /m.test(l.out), `stdout: ${l.out}`);
  // tern mv rewrites a :::use entry as it does data-use's, query string kept.
  write('u/m.html', `${FIRST}<script src="tern.js"></script>\n:::use\nbox.js?x=1\n:::\n`);
  const mv = run(['mv', 'u/box.js', 'u/lib/box.js']);
  exits(mv, 0, 'mv');
  ok(/^u\/m\.html:3:1: box\.js → lib\/box\.js/m.test(mv.out) && /^:::use\nlib\/box\.js\?x=1\n:::$/m.test(read('u/m.html')), `mv: ${mv.out}\n${read('u/m.html')}`);
});

// src/use.js scans the text for the leading :::use block before the parse,
// as the browser does: a CRLF file and the closer rule must read as the
// parser's (block.js), or the tools silently lose the note's vocabulary.
test('check, build: a :::use block in a CRLF note loads its add-ons; only ::: or :::/use closes it, as the parser reads it', () => {
  write('crlf/box.js', "tern.block('box', { label: 'Box' });\n");
  write('crlf/n.html', `${FIRST}<script src="tern.js"></script>\r\n:::meta\r\ntitle: CRLF\r\n:::\r\n:::use\r\nbox.js\r\n:::\r\n\r\n:::box[T]\r\nx\r\n:::\r\n`);
  const r = run(['check', 'crlf/n.html']);
  exits(r, 0, 'check');
  ok(/0 errors, 0 warnings/.test(r.err), `clean: ${r.out}${r.err}`);
  ok(/<span class="t-label">Box<\/span>/.test(run(['build', 'crlf/n.html']).out), 'the add-on applied');
  // `:::/meta` does not close `:::use`: the line is an entry, as the parser
  // records it, reported as an add-on that cannot be read, and box.js after it loads.
  write('crlf/m.html', `${FIRST}<script src="tern.js"></script>\n:::use\n:::/meta\nbox.js\n:::\n\n:::box[T]\nx\n:::\n`);
  const m = run(['check', 'crlf/m.html']);
  exits(m, 1, 'check');
  ok(/^crlf\/m\.html:3:1: error addon\.failed: the add-on :::\/meta did not load: cannot read /m.test(m.out), `another block's closer is an entry: ${m.out}`);
  ok(/<span class="t-label">Box<\/span>/.test(run(['build', 'crlf/m.html']).out), 'box.js after it is loaded');
  // The scan itself, on text with its CR kept (the tools normalise line
  // endings before they scan; another caller may not).
  const { scanUse } = require(path.join(ROOT, 'src', 'use.js'));
  eq(scanUse(':::use\r\na.js b.js\r\n:::\r\n\r\nText.\r\n').entries.map((e) => [e.url, e.line, e.column]), [['a.js', 2, 1], ['b.js', 2, 6]], 'CRLF entries');
  eq(scanUse(':::use\n:::/meta\nc.js\n:::/use\nText.\n').entries.map((e) => e.url), [':::/meta', 'c.js'], 'only ::: or :::/use closes the block');
});

test('check: a transform that never returns is addon.failed, not a hang', () => {
  write('sb/spin.js', "tern.transform('spin', function () { while (true) {} });\n");
  write('sb/spin.html', `${FIRST}<script src="tern.js" data-use="spin.js"></script>\n# x\n`);
  const t0 = Date.now();
  const r = run(['check', 'sb/spin.html']);
  ok(Date.now() - t0 < 8000, `cut off well before the wedged deadline (${Date.now() - t0}ms)`);
  exits(r, 1, 'check');
  ok(/error addon\.failed: the note's scripts did not finish in 2 s/.test(r.out), `timeout: ${r.out}`);
});

test('check: a note that crashes the sandbox is addon.failed, and the run goes on', () => {
  write('sb/bomb.js', 'tern.transform(\'bomb\', function () { var a = []; for (;;) a.push(new Array(1e6).fill(7)); });\n');
  write('sb/bomb.html', `${FIRST}<script src="tern.js" data-use="bomb.js"></script>\n# x\n`);
  write('sb/fine.js', "tern.block('aside', { tag: 'aside', label: 'OK' });\n");
  write('sb/fine.html', `${FIRST}<script src="tern.js" data-use="fine.js"></script>\n:::aside{#a}\nx\n:::\n`);
  const r = run(['check', 'sb/bomb.html', 'sb/fine.html']);
  exits(r, 1, 'check');
  ok(/sb\/bomb\.html:1:1: error addon\.failed: the note's scripts used too much memory or crashed/.test(r.out), `crash: ${r.out}`);
  ok(!/sb\/fine\.html/.test(r.out), `the next note is fine, on a fresh child: ${r.out}`);
});

// Three children dead before their first answer, in a row, trip the
// breaker: the next notes' scripts are not run, said once, and the run goes on.
test('check: a sandbox child dying three times in a row trips the breaker; the next note is addon.failed without a child', () => {
  write('sb/bomb.js', 'tern.transform(\'bomb\', function () { var a = []; for (;;) a.push(new Array(1e6).fill(7)); });\n');
  for (const n of [1, 2, 3]) write(`sb/bomb${n}.html`, `${FIRST}<script src="tern.js" data-use="bomb.js"></script>\n# ${n}\n`);
  write('sb/after.js', "tern.block('aside', { tag: 'aside', label: 'OK' });\n");
  write('sb/after.html', `${FIRST}<script src="tern.js" data-use="after.js"></script>\n:::aside{#a}\nx\n:::\n`);
  const r = run(['check', 'sb/bomb1.html', 'sb/bomb2.html', 'sb/bomb3.html', 'sb/after.html']);
  exits(r, 1, 'check');
  eq((r.out.match(/used too much memory or crashed/g) || []).length, 3, `three crashes: ${r.out}`);
  ok(/sb\/after\.html:1:1: error addon\.failed: the script sandbox died three times in a row, so the note's scripts were not run for a minute; its vocabulary and transforms are missing/.test(r.out), `tripped: ${r.out}`);
  eq((r.err.match(/tern: the script sandbox died 3 times in a row before answering; notes are analysed without their own scripts for 60 s/g) || []).length, 1, `said once: ${r.err}`);
  // Two crashes, then an answer: no trip.
  const ok2 = run(['check', 'sb/bomb1.html', 'sb/bomb2.html', 'sb/after.html', 'sb/bomb3.html', 'sb/after.html']);
  ok(!/died/.test(ok2.err) && !/sb\/after\.html/.test(ok2.out), `an answer resets the count: ${ok2.out}${ok2.err}`);
});

test('check, build, parse, index, mv: a file that is not UTF-8 is said on stderr; a UTF-16 file is not a note', () => {
  fs.mkdirSync(at('enc'), { recursive: true });
  write('enc/tern.js', '');
  fs.writeFileSync(at('enc/latin.html'), Buffer.concat([Buffer.from(`${FIRST}<script src="tern.js"></script>\n# Caf`), Buffer.from([0xe9]), Buffer.from(' {#cafe}\n\nSee @cafe.\n')]));
  fs.writeFileSync(at('enc/wide.html'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${FIRST}<script src="tern.js"></script>\n# W\n`, 'utf16le')]));
  const r = run(['check', 'enc/latin.html', 'enc/wide.html']);
  exits(r, 0, 'check');
  ok(/^tern check: enc\/latin\.html is not valid UTF-8; 1 byte sequence that is not was read as U\+FFFD$/m.test(r.err), `latin-1: ${r.err}`);
  ok(/^tern check: enc\/wide\.html is UTF-16 \(it starts with a byte order mark\); Tern reads UTF-8, so it is not read as a note$/m.test(r.err) && /wide\.html is not a note/.test(r.err), `utf-16: ${r.err}`);
  ok(/0 errors, 0 warnings/.test(r.err), 'the latin-1 note is checked, its byte read as U+FFFD');
  ok(/^tern build: enc\/latin\.html is not valid UTF-8/m.test(run(['build', 'enc/latin.html']).err), 'build');
  ok(/^tern parse: enc\/latin\.html is not valid UTF-8/m.test(run(['parse', 'enc/latin.html']).err), 'parse');
  ok(/^tern index: enc\/latin\.html is not valid UTF-8/m.test(run(['index', 'enc', '-o', 'enc/out']).err), 'index');
  ok(/^tern mv: enc\/latin\.html is not valid UTF-8/m.test(run(['mv', '--dry-run', 'enc/wide.html', 'enc/w2.html', '--root=enc']).err), 'mv');
});

test('build --json, mv --json, index --json: one object on stdout, the lines on stderr as before', () => {
  write('j/tern.js', '');
  write('j/a.html', `${FIRST}<script src="tern.js"></script>\n# A {#a}\n\nSee @nowhere, [b](b.html) and $x$.\n`);
  write('j/b.html', `${FIRST}<script src="tern.js"></script>\n# B\n\n[a](a.html#a)\n`);
  // build: the page in the object without -o; with -o, written, and `out` names it.
  let r = run(['build', 'j/a.html', '--json']);
  exits(r, 0, 'build --json');
  let j = JSON.parse(r.out);
  eq([j.file, j.out, j.math, j.warnings], ['j/a.html', null, { total: 1, prerendered: 0, engine: null }, []], 'the object');
  eq(j.diagnostics.map((d) => [d.file, d.code, d.severity, d.filePosition.start.line]), [['j/a.html', 'ref.dangling', 'warning', 4]], 'the diagnostics as check --json gives them');
  ok(/<!doctype html>/i.test(j.html) && /data-built/.test(j.html), 'the page is in html');
  r = run(['build', 'j/a.html', '-o', 'j/dist/', '--json']);
  exits(r, 0, 'build -o --json');
  j = JSON.parse(r.out);
  eq([j.out, j.html, j.warnings.length], [path.join('j/dist/', 'a.html'), undefined, 1], 'written to -o: no html in the object, the relative-URL warning');
  ok(/^tern build: wrote j\/dist\/a\.html/m.test(r.err), 'the summary on stderr');
  // mv: the moves, the edits and what is left alone.
  write('j/README.md', 'see a.html\n', { tern: false });
  r = run(['mv', '--dry-run', '--json', 'j/a.html', 'j/sub/a.html', '--root=j']);
  exits(r, 0, 'mv --json');
  j = JSON.parse(r.out);
  eq(j, {
    dryRun: true,
    moves: [{ from: 'j/a.html', to: 'j/sub/a.html' }],
    edits: [
      { file: 'j/sub/a.html', line: 1, column: 51, was: 'tern.js', text: '../tern.js' },
      { file: 'j/sub/a.html', line: 4, column: 19, was: 'b.html', text: '../b.html' },
      { file: 'j/b.html', line: 4, column: 5, was: 'a.html', text: 'sub/a.html' },
    ],
    left: [{ file: 'j/README.md', names: ['a.html'], reason: 'names a.html but is not a note, so it is left as it is; look at it' }],
  }, 'the object');
  ok(!/would move/.test(r.out) && /^tern mv: 1 move, 3 links in 2 notes; a dry run/m.test(r.err), 'no lines on stdout; the summary on stderr');
  // index: the summary, --check's stale files.
  r = run(['index', 'j', '-o', 'j/idx', '--json']);
  exits(r, 0, 'index --json');
  j = JSON.parse(r.out);
  eq(j, { notes: 2, entries: 2, leftOut: 0, noindex: 0, unreadable: false, files: { notes: 'j/idx/notes.json', search: 'j/idx/search.json' }, wrote: true }, 'the object');
  write('j/b.html', `${FIRST}<script src="tern.js"></script>\n# B\n\n[a](a.html#a) and more.\n`);
  r = run(['index', 'j', '-o', 'j/idx', '--check', '--json']);
  exits(r, 1, 'index --check --json, stale');
  j = JSON.parse(r.out);
  eq([j.wrote, j.stale], [false, ['j/idx/search.json']], 'the stale file named');
});

test('check --no-scripts: a note is analysed without running its add-ons', () => {
  write('ns/box.js', "tern.block('blinker', { tag: 'blink' });\n");
  write('ns/n.html', `${FIRST}<script src="tern.js" data-use="box.js"></script>\n:::blinker\nhi\n:::\n`);
  eq(JSON.parse(run(['check', 'ns/n.html', '--json']).out).map((d) => d.code), ['tag.not-allowed'], 'with scripts: the schema gives blinker <blink>');
  const r = run(['check', 'ns/n.html', '--no-scripts', '--json']);
  eq(JSON.parse(r.out), [], 'no-scripts: blinker is an unknown block, so no schema and no tag.not-allowed');
  exits(r, 0, 'no-scripts exit 0');
});

// A single-file note's vocabulary, from a head script.
test('check: a single-file note declares its vocabulary in window.TERN.schema', () => {
  write('s/n.html', `${FIRST}<script>window.TERN = { schema: { block: { theorem: { tag: 'section', counter: 'theorem', label: 'Theorem' } }, leaf: { toc: { tag: 'nav', transform: 'toc' } } } };</script>
<script src="tern.js"></script>
::toc

## Results

:::theorem[Rank-nullity]{#rn}
x
:::

By @rn.
`);
  const r = run(['check', 's/n.html']);
  exits(r, 0, 'check');
  eq(r.out, '', 'no diagnostics');
  const main = pageParts(run(['build', 's/n.html']).out).main;
  ok(main.includes('<a class="t-ref" href="#rn">Theorem 1</a>') && main.includes('<span class="t-label">Theorem 1</span>'), `the reference reads Theorem 1: ${main}`);
  ok(/<nav class="toc"[^>]*><ol><li><a href="#results">Results<\/a>/.test(main), 'the toc from the head');
});

test("check: window.TERN.schema wins over an add-on's entry; head scripts run in order, remote ones are not", () => {
  write('s/satz.js', "tern.block('theorem', { counter: 'theorem', label: 'Satz' });\ntern.block('lemma', { counter: 'theorem', label: 'Lemma' });\n");
  write('s/vocab.js', "window.TERN = { schema: { block: { theorem: { counter: 'theorem', label: (n) => `Theorem ${n}` } } } };\n");
  write('s/o.html', `${FIRST}
<script src="vocab.js"></script>
<script src="https://cdn.example/x.js"></script>
  <script>window.TERN.seen = typeof tern; nope();</script>
<script src="tern.js" data-use="satz.js"></script>
:::theorem{#a}
x
:::

:::lemma{#b}
y
:::

See @a and @b.
`);
  const r = run(['check', 's/o.html', '--json']);
  exits(r, 0, 'check');
  eq(JSON.parse(r.out).map((d) => [d.code, d.severity, d.filePosition.start.line, d.filePosition.start.column]), [
    ['head.script', 'info', 3, 1],
    ['head.script', 'warning', 4, 3],
  ], 'the remote head script, and the one that threw');
  const b = run(['build', 's/o.html']);
  const main = pageParts(b.out).main;
  ok(main.includes('href="#a">Theorem 1</a>') && main.includes('href="#b">Lemma 2</a>'), `the head's theorem, the add-on's lemma, one counter: ${main}`);
  ok(/the head script inline script on line 4 threw under node: nope is not defined/.test(b.err), `build warns: ${b.err}`);
});

// The label language, in src/runtime.js's order: data-lang on the tag (even
// empty), else window.TERN.lang, is the transforms' `lang`; then the engine
// tries :::meta lang, then <html lang> (a head that sets lang wins over
// :::meta, so the two are not combined here).
const LANGS = "{ de: 'Satz', fr: 'Théorème', es: 'Teorema', it: 'Teorema (it)', en: 'Theorem' }";
function langNote({ dataLang, ternLang, metaLang, htmlLang, use = '' }) {
  const own = `window.TERN = { ${ternLang ? `lang: '${ternLang}', ` : ''}schema: { block: { theorem: { tag: 'section', counter: 'theorem', label: ${LANGS} } } } };`;
  const attr = (dataLang === undefined ? '' : ` data-lang="${dataLang}"`) + (use ? ` data-use="${use}"` : '');
  return `<!doctype html>${htmlLang ? `<html lang="${htmlLang}">` : ''}<meta charset="utf-8"><script>${own}</script>\n<script src="tern.js"${attr}></script>\n${metaLang ? `:::meta\nlang: ${metaLang}\n:::\n\n` : ''}:::theorem{#t}\nx\n:::\n\nSee @t.\n`;
}
const theoremLabel = (ast) => ast.children.find((n) => n.name === 'theorem').data.tern.text;

test('check, parse, build: the label language is data-lang, then window.TERN.lang, then :::meta, then <html lang>, as in tern.js', () => {
  const cases = [
    [{ dataLang: 'de', ternLang: 'fr', metaLang: 'es' }, 'Satz 1', 'data-lang wins'],
    [{ ternLang: 'fr', metaLang: 'es' }, 'Théorème 1', 'window.TERN.lang, without data-lang'],
    [{ dataLang: '', ternLang: 'fr', metaLang: 'es' }, 'Teorema 1', 'an empty data-lang hides window.TERN.lang, as config.lang = "" does'],
    [{ metaLang: 'es' }, 'Teorema 1', ':::meta lang'],
    [{ ternLang: 'fr', htmlLang: 'it' }, 'Théorème 1', 'window.TERN.lang over <html lang>'],
    [{ dataLang: 'de', htmlLang: 'it' }, 'Satz 1', 'data-lang over <html lang>'],
    [{ htmlLang: 'it' }, 'Teorema (it) 1', '<html lang>'],
    [{}, 'Theorem 1', 'none: en'],
  ];
  cases.forEach(([c, want, why], i) => {
    write(`l/${i}.html`, langNote(c));
    eq(theoremLabel(JSON.parse(run(['parse', `l/${i}.html`, '--transformed']).out)), want, `parse: ${why}`);
  });
  const b = run(['build', 'l/0.html']);
  exits(b, 0, 'build');
  const main = pageParts(b.out).main;
  ok(main.includes('<span class="t-label">Satz 1</span>') && main.includes('href="#t">Satz 1</a>'), `build: the label and the reference read Satz 1: ${main}`);
  // tern check reads the same: an add-on transform reports ctx.lang.
  write('l/lang.js', "tern.transform('lang', (ast, ctx) => ctx.report('lang.seen', ast, `lang ${ctx.lang}`, null, 'info'));\n");
  write('l/t.html', langNote({ dataLang: 'de', ternLang: 'fr', use: 'lang.js' }));
  eq(JSON.parse(run(['check', 'l/t.html', '--json']).out).map((d) => d.message), ['lang de'], 'check: ctx.lang');
});

test('check: window.TERN.schema.strict turns on name.unknown, over an add-on', () => {
  write('st/strict.js', 'tern.schema.strict = true;\n');
  const note = (own, use) => `${FIRST}<script>window.TERN = ${own};</script><script src="tern.js"${use ? ' data-use="strict.js"' : ''}></script>\n:::nope\nx\n:::\n`;
  write('st/on.html', note('{ schema: { strict: true } }'));
  write('st/addon.html', note('{}', true));
  write('st/off.html', note('{ schema: { strict: false } }', true));
  write('st/none.html', note('{ schema: {} }'));
  const codes = (f) => JSON.parse(run(['check', f, '--json']).out).map((d) => [d.code, d.severity, d.filePosition.start.line, d.filePosition.start.column]);
  eq(codes('st/on.html'), [['name.unknown', 'info', 2, 4]], 'strict: true');
  eq(codes('st/addon.html'), [['name.unknown', 'info', 2, 4]], "an add-on's tern.schema.strict");
  eq(codes('st/off.html'), [], "strict: false wins over the add-on's");
  eq(codes('st/none.html'), [], 'no strict');
});

// An add-on transform (tern.transform): it runs, in its place in the order,
// for the note that loads it, and no other.
const STAMP = `tern.leaf('toc', { tag: 'nav', transform: 'toc' });
tern.transform('stamp', (ast, ctx) => {
  const h = ast.children.find((n) => n.type === 'heading');
  h.children = [{ type: 'text', value: 'Stamped' }];
  ctx.report('stamp.ran', h, 'the stamp ran', null, 'info');
}, { before: 'toc' });
`;

test("check, parse, build: an add-on's transforms run for its note only; one that throws is addon.failed", () => {
  write('x/stamp.js', STAMP);
  const body = '::toc\n\n## Plain\n\nSee @nowhere.\n';
  write('x/a.html', `${FIRST}<script src="tern.js" data-use="stamp.js"></script>\n${body}`);
  write('x/b.html', `${FIRST}<script src="tern.js"></script>\n${body}`);
  const r = run(['check', 'x/a.html', 'x/b.html', '--json']);
  exits(r, 0, 'check');
  eq(JSON.parse(r.out).map((d) => [d.file, d.code]), [['x/a.html', 'stamp.ran'], ['x/a.html', 'ref.dangling'], ['x/b.html', 'ref.dangling']], 'the transform runs for a.html, not for b.html checked after it');
  const main = pageParts(run(['build', 'x/a.html']).out).main;
  ok(/<h2 id="plain">Stamped<\/h2>/.test(main) && /<nav class="toc"[^>]*><ol><li><a href="#plain">Stamped<\/a>/.test(main), `build: the heading, and the toc built after the stamp: ${main}`);
  const ast = JSON.parse(run(['parse', 'x/a.html', '--transformed']).out);
  eq(ast.children[1].children[0].value, 'Stamped', 'parse --transformed');
  eq(JSON.parse(run(['parse', 'x/a.html']).out).children[1].children[0].value, 'Plain', 'parse without --transformed runs no transform');
  // In process: the engine holds no add-on transform after an analysis.
  const note = require(path.join(ROOT, 'cli', 'note.js'));
  const before = tern.transforms.join();
  const a = note.analyse(read('x/a.html'), at('x/a.html'));
  ok(a.diagnostics.some((d) => d.code === 'stamp.ran'), 'analyse ran the transform');
  eq(tern.transforms.join(), before, 'tern.transforms after analyse');
  // A transform that throws is skipped and reported; the others run.
  write('x/boom.js', "tern.transform('boom', () => { throw new Error('kaput'); });\ntern.transform('later', (ast, ctx) => ctx.report('later.ran', ast, 'later ran', null, 'info'));\n");
  write('x/boom.html', `${FIRST}<script src="tern.js" data-use="boom.js"></script>\n# Boom\n`);
  const t = run(['check', 'x/boom.html']);
  exits(t, 1, 'check a throwing transform');
  const lines = t.out.trimEnd().split('\n');
  eq(lines[0], 'x/boom.html:1:1: error addon.failed: the transform "boom" of the add-on boom.js threw: kaput', 'the throwing transform');
  ok(lines.some((l) => /info later\.ran/.test(l)), `the transform after it ran: ${t.out}`);
  const bb = run(['build', 'x/boom.html']);
  ok(bb.err.includes('tern build: the transform "boom" of the add-on boom.js threw: kaput; the page is written without it\n'), `build warns: ${bb.err}`);
  // The calls replay in order: one anchored to a transform its add-on then removed still runs.
  write('x/undo.js', "const off = tern.transform('first', (ast, ctx) => ctx.report('first.ran', ast, 'first ran', null, 'info'));\ntern.transform('second', (ast, ctx) => ctx.report('second.ran', ast, 'second ran', null, 'info'), { after: 'first' });\noff();\n");
  write('x/undo.html', `${FIRST}<script src="tern.js" data-use="undo.js"></script>\n# Undo\n`);
  eq(JSON.parse(run(['check', 'x/undo.html', '--json']).out).map((d) => d.code), ['second.ran'], 'a removed transform does not run; the one after it does');
  // tern.transform's own checks throw at the add-on's top level, as in a browser.
  write('x/builtin.js', "tern.block('kept', {});\ntern.transform('figures', () => {});\n");
  write('x/builtin.html', `${FIRST}<script src="tern.js" data-use="builtin.js"></script>\n# B\n`);
  ok(/error addon\.failed: the add-on builtin\.js did not load: it threw: tern\.transform: "figures" is a built-in transform/.test(run(['check', 'x/builtin.html']).out), 'a built-in name');
});

test('check: every data-use entry not ending in .css is a script, .mjs and no extension included; one that cannot run says why', () => {
  write('m/mod.mjs', "tern.block('frommjs', { tag: 'aside' });\n");
  write('m/plain', "tern.block('fromplain', { tag: 'aside' });\n");
  write('m/esm.mjs', 'export const x = 1;\n');
  fs.mkdirSync(at('m/dir'), { recursive: true });
  write('m/THEME.CSS', '');
  write('m/n.html', `${FIRST}<script>window.TERN = { schema: { strict: true } };</script><script src="tern.js" data-use="mod.mjs plain esm.mjs nothere dir THEME.CSS"></script>\n:::frommjs\nx\n:::\n\n:::fromplain\ny\n:::\n`);
  const r = run(['check', 'm/n.html']);
  exits(r, 1, 'check');
  const lines = r.out.trimEnd().split('\n');
  eq(lines.length, 3, `three problems, no name.unknown: ${r.out}`);
  ok(/^m\/n\.html:1:1: error addon\.failed: the add-on esm\.mjs did not load: it does not parse as a classic script, which is how tern\.js runs an add-on: Unexpected token 'export'$/.test(lines[0]), `esm.mjs: ${lines[0]}`);
  ok(/^m\/n\.html:1:1: error addon\.failed: the add-on nothere did not load: cannot read \S+nothere$/.test(lines[1]), `nothere: ${lines[1]}`);
  ok(/^m\/n\.html:1:1: error addon\.failed: the add-on dir did not load: \S+dir is a directory$/.test(lines[2]), `dir: ${lines[2]}`);
});

test('check: a remote add-on is addon.remote, an info, so --fail-on decides; build warns', () => {
  write('rm/n.html', `${FIRST}<script src="tern.js" data-use="https://cdn.example/x.js?v=1 //cdn.example/y.js https://cdn.example/t.css"></script>\n# Remote\n`);
  const r = run(['check', 'rm/n.html']);
  exits(r, 0, 'check, default --fail-on');
  eq(r.out.trimEnd().split('\n'), [
    'rm/n.html:1:1: info addon.remote: the add-on https://cdn.example/x.js is not loaded under node; names it declares are unknown to tern check',
    'rm/n.html:1:1: info addon.remote: the add-on //cdn.example/y.js is not loaded under node; names it declares are unknown to tern check',
  ], 'the diagnostics');
  exits(run(['check', 'rm/n.html', '--fail-on=info']), 1, '--fail-on=info');
  eq(run(['check', 'rm/n.html', '--quiet']).out, '', '--quiet');
  const b = run(['build', 'rm/n.html']);
  exits(b, 0, 'build');
  ok(b.err.includes('tern build: the add-on https://cdn.example/x.js is not loaded under node, so the page uses its names without its schema'), `build warns: ${b.err}`);
});

// ---------------------------------------------------------------- links

// A small site: two notes with ids, a folder with its index, an empty folder,
// a plain HTML page, a Markdown file and an image.
function linkSite(dir) {
  write(`${dir}/maps.html`, `${FIRST}<script src="tern.js"></script>\n# Linear maps {#maps}\n\n:::div{#thm-rn}\nx\n:::\n\n<p id="raw-id">raw</p>\n`);
  write(`${dir}/vectors/index.html`, `${FIRST}<script src="../tern.js"></script>\n# Basis\n`);
  fs.mkdirSync(at(dir, 'empty'), { recursive: true });
  write(`${dir}/plain.html`, '<!doctype html><h2 id="plain">x</h2><a name="old">y</a>\n');
  write(`${dir}/README.md`, '# Readme\n\n## Getting started\n\n```\n## Not a heading\n```\n');
  write(`${dir}/img/kernel.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
}

test('check: links to other files: link.missing and link.dangling, warnings in file order; good links pass', () => {
  linkSite('lk');
  write(
    'lk/notes.html',
    `${FIRST}<script src="tern.js"></script>\n# Notes {#top-h}\n\n` +
      'Good: [a](maps.html) [b](maps.html#thm-rn) [c](maps.html#raw-id) [d](vectors/) [e](vectors) [f](maps.html#top) [g](README.md#getting-started) ' +
      '[h](plain.html#plain) [i](plain.html#old) [j](maps.html?x=1#maps) [k](https://example.com/x) [l](/abs.html) [m](mailto:a@b.c) ![n](img/kernel.svg) [o](#top-h) [p](./maps.html#thm-rn) [q](%6Daps.html).\n\n' +
      'Bad: [a](nope.html) [b](maps.html#thm-nope) [c](Maps.html) [d](empty/) [e](README.md#not-a-heading) ![f](img/missing.png).\n\n' +
      '::video{src=media/tide.mp4}\n\n' +
      '<p><a href="maps.html#raw-nope">x</a> <img src="img/raw.png"> <a href="#nope-here">y</a></p>\n' +
      '<!-- <a href="commented.html">x</a> -->\n\n' +
      '```html\n<a href="in-code.html">x</a>\n```\n',
  );
  const r = run(['check', 'lk/notes.html']);
  exits(r, 0, 'warnings, default --fail-on=error');
  eq(r.out.trimEnd().split('\n').filter((l) => !l.startsWith(' ')), [
    'lk/notes.html:6:6: warning link.missing: nope.html does not exist',
    'lk/notes.html:6:21: warning link.dangling: maps.html has no element with the id thm-nope',
    'lk/notes.html:6:45: warning link.missing: Maps.html is spelt maps.html on this disk; a host that tells case apart will not find it',
    'lk/notes.html:6:60: warning link.missing: empty/ has no index.html',
    'lk/notes.html:6:72: warning link.dangling: README.md has no heading with the anchor not-a-heading',
    'lk/notes.html:6:101: warning link.missing: the image img/missing.png does not exist',
    'lk/notes.html:8:1: warning link.missing: the src media/tide.mp4 does not exist',
    'lk/notes.html:10:4: warning link.dangling: maps.html has no element with the id raw-nope',
    'lk/notes.html:10:39: warning link.missing: the src of <img>, img/raw.png, does not exist',
    'lk/notes.html:10:63: warning link.dangling: this note has no element with the id nope-here',
  ], 'the link diagnostics');
  ok(r.out.includes('\n    write it as the disk does: maps.html\n'), `a hint: ${r.out}`);
  ok(/1 note: 0 errors, 10 warnings, 0 infos/.test(r.err), `summary: ${r.err}`);
  exits(run(['check', 'lk/notes.html', '--fail-on=warning']), 1, '--fail-on=warning');
  const list = JSON.parse(run(['check', 'lk/notes.html', '--json']).out);
  const off = list.filter((d) => !(d.hint && d.position && d.position.start.line + 1 === d.filePosition.start.line));
  ok(!off.length, `in the note: a note position and a file position: ${JSON.stringify(off)}`);
  const all = run(['check', 'lk']);
  ok(/3 notes: 0 errors, 10 warnings, 0 infos/.test(all.err), `the folder: ${all.err}`);
});

test("check: the head's links, the tern.js it loads, data-css and stylesheet add-ons; a <base href> turns link checking off", () => {
  write('lh/style.css', '');
  write('lh/n.html', `${FIRST}\n<link rel="stylesheet" href="style.css"><link rel="icon" href="icon.png">\n<script src="lib/tern.js" data-css="tern.css" data-use="style.css themes/nord.css https://cdn.example/x.css"></script>\n# x\n`, { tern: false });
  const r = run(['check', 'lh/n.html', '--json']);
  eq(JSON.parse(r.out).map((d) => [d.code, d.severity, d.filePosition.start.line, d.filePosition.start.column, d.message, 'position' in d]), [
    ['link.missing', 'warning', 2, 41, "the href of the head's <link>, icon.png, does not exist", false],
    ['link.missing', 'error', 3, 1, 'the tern.js this note loads, lib/tern.js, does not exist, so the note does not render', false],
    ['link.missing', 'warning', 3, 1, 'the stylesheet in data-css, tern.css, does not exist', false],
    ['link.missing', 'warning', 3, 1, 'the add-on themes/nord.css does not exist', false],
  ], 'the head and the tern.js line');
  exits(r, 1, 'a missing tern.js fails the default check');
  write('lh/lib/tern.js', '');
  exits(run(['check', 'lh/n.html']), 0, 'with tern.js there, the other links are warnings');
  write('lh/cased.html', `${FIRST}<script src="Lib/tern.js"></script>\n# x\n`, { tern: false });
  eq(JSON.parse(run(['check', 'lh/cased.html', '--json']).out).map((d) => [d.code, d.severity, d.message]), [
    ['link.missing', 'error', 'the tern.js this note loads, Lib/tern.js, is spelt lib/tern.js on this disk; a host that tells case apart will not find it'],
  ], 'a tern.js in another case: an error too');
  write('lh/based.html', `${FIRST}<base href="https://example.com/"><script src="lib/tern.js"></script>\n[x](nope.html)\n`, { tern: false });
  eq(JSON.parse(run(['check', 'lh/based.html', '--json']).out), [], 'a <base href>: nothing');
});

// ---------------------------------------------------------------- mv

const T_LINE = `${FIRST}<script src="tern.js" data-use="theme.css"></script>\n`;
function mvSite(dir) {
  write(`${dir}/theme.css`, '');
  write(`${dir}/img/kernel.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  write(`${dir}/index.html`, `${T_LINE}# Index\n\nSee [maps](maps.html#thm-rn), [again](./maps.html), <a href="maps.html">raw</a> and [basis](vectors/basis.html).\n`);
  write(
    `${dir}/maps.html`,
    `${FIRST}\r\n<link rel="stylesheet" href="theme.css">\r\n<script src="tern.js" data-use="theme.css"></script>\r\n# Linear maps {#maps}\r\n\r\n:::div{#thm-rn}\r\n` +
      'Back to [the index](index.html), [itself](maps.html#maps), ![k](img/kernel.svg){.w} and [ext](https://x.org/a.html).\r\n:::\r\n',
  );
  write(`${dir}/vectors/basis.html`, `${FIRST}<script src="../tern.js"></script>\n# Basis {#b}\n\n[Maps](../maps.html#thm-rn), [index](../index.html) and [span](span.html).\n`);
  write(`${dir}/vectors/span.html`, `${FIRST}<script src="../tern.js"></script>\n# Span\n\n[basis](basis.html#b).\n`);
}

test('mv: a note moved into a new folder; the links to it and its own rewritten, CRLF kept; --dry-run changes nothing', () => {
  mvSite('mv1');
  write('mv1/README.md', '# Site\n\nStart at [the maps](maps.html).\n');
  const before = read('mv1/index.html');
  const dry = run(['mv', '--dry-run', 'mv1/maps.html', 'mv1/linear/maps.html', '--root=mv1']);
  exits(dry, 0, 'mv --dry-run');
  ok(dry.out.startsWith('would move mv1/maps.html → mv1/linear/maps.html\n'), `dry run: ${dry.out}`);
  ok(/a dry run, so nothing changed/.test(dry.err) && read('mv1/index.html') === before && fs.existsSync(at('mv1/maps.html')), 'nothing changed');
  const r = run(['mv', 'mv1/maps.html', 'mv1/linear/maps.html', '--root=mv1']);
  exits(r, 0, 'mv');
  eq(r.out.trimEnd().split('\n'), [
    'moved mv1/maps.html → mv1/linear/maps.html',
    'mv1/index.html:4:12: maps.html → linear/maps.html',
    'mv1/index.html:4:39: ./maps.html → ./linear/maps.html',
    'mv1/index.html:4:62: maps.html → linear/maps.html',
    'mv1/linear/maps.html:2:30: theme.css → ../theme.css',
    'mv1/linear/maps.html:3:14: tern.js → ../tern.js',
    'mv1/linear/maps.html:3:33: theme.css → ../theme.css',
    'mv1/linear/maps.html:7:21: index.html → ../index.html',
    'mv1/linear/maps.html:7:65: img/kernel.svg → ../img/kernel.svg',
    'mv1/vectors/basis.html:4:8: ../maps.html → ../linear/maps.html',
  ], 'the moves and the edits');
  ok(/1 move, 9 links in 3 notes/.test(r.err), `summary: ${r.err}`);
  ok(r.err.includes('tern mv: mv1/README.md names maps.html but is not a note, so it is left as it is; look at it'), `a file that is not a note: ${r.err}`);
  eq(read('mv1/README.md'), '# Site\n\nStart at [the maps](maps.html).\n', 'and left as it is');
  ok(!fs.existsSync(at('mv1/maps.html')), 'moved');
  eq(read('mv1/index.html').split('\n')[3], 'See [maps](linear/maps.html#thm-rn), [again](./linear/maps.html), <a href="linear/maps.html">raw</a> and [basis](vectors/basis.html).', 'index.html');
  eq(read('mv1/linear/maps.html').split('\r\n').slice(1, 3).concat(read('mv1/linear/maps.html').split('\r\n')[6]), [
    '<link rel="stylesheet" href="../theme.css">',
    '<script src="../tern.js" data-use="../theme.css"></script>',
    'Back to [the index](../index.html), [itself](maps.html#maps), ![k](../img/kernel.svg){.w} and [ext](https://x.org/a.html).',
  ], 'the moved note, its \\r\\n line breaks kept');
  const c = run(['check', 'mv1', '--fail-on=warning']);
  exits(c, 0, `tern check after the move: ${c.out}`);
});

test('mv: a folder moves with what it holds; an image; two notes moved together; how a URL is written is kept', () => {
  mvSite('mv2');
  exits(run(['mv', 'mv2/vectors', 'mv2/linalg/', '--root=mv2']), 0, 'a folder into a new one');
  eq(read('mv2/linalg/vectors/span.html').split('\n')[3], '[basis](basis.html#b).', 'a link inside the folder stays');
  eq(read('mv2/linalg/vectors/basis.html').split('\n')[3], '[Maps](../../maps.html#thm-rn), [index](../../index.html) and [span](span.html).', 'links out of it');
  ok(read('mv2/index.html').includes('[basis](linalg/vectors/basis.html)'), 'a link into it');
  exits(run(['mv', 'mv2/img/kernel.svg', 'mv2/img/kernel map.svg', '--root=mv2']), 0, 'an image, to a name with a space');
  ok(read('mv2/maps.html').includes('![k](img/kernel%20map.svg){.w}'), 'a bare destination escapes the space');
  fs.mkdirSync(at('mv2/archive'));
  const r = run(['mv', 'mv2/index.html', 'mv2/maps.html', 'mv2/archive', '--root=mv2']);
  exits(r, 0, 'two notes into a folder');
  ok(read('mv2/archive/index.html').includes('See [maps](maps.html#thm-rn), [again](./maps.html), <a href="maps.html">raw</a>'), 'links between them, from their new folder');
  ok(read('mv2/archive/maps.html').includes('Back to [the index](index.html)'), 'and back');
  write('mv2/style.html', `${FIRST}<script src="tern.js"></script>\n[a](<my notes.html>), [b](my%20notes.html), <a href='my notes.html'>c</a>.\n`);
  write('mv2/my notes.html', `${FIRST}<script src="tern.js"></script>\n# Notes\n`);
  exits(run(['mv', 'mv2/my notes.html', 'mv2/old/my files.html', '--root=mv2']), 0, 'a name with a space');
  eq(read('mv2/style.html').split('\n')[1], "[a](<old/my files.html>), [b](old/my%20files.html), <a href='old/my files.html'>c</a>.", 'angle brackets, percent-escapes and quotes kept');
  exits(run(['check', 'mv2', '--fail-on=warning']), 0, 'tern check after the moves');
});

test('mv: the repository FROM is in, else the current folder; --root', () => {
  write('mv3/repo/.git', 'gitdir: elsewhere\n');
  write('mv3/repo/a.html', `${FIRST}<script src="tern.js"></script>\n[b](b.html)\n`);
  write('mv3/repo/b.html', `${FIRST}<script src="tern.js"></script>\n# B\n`);
  write('mv3/outside.html', `${FIRST}<script src="tern.js"></script>\n[b](repo/b.html)\n`);
  exits(run(['mv', 'mv3/repo/b.html', 'mv3/repo/c.html']), 0, 'mv in a repository');
  ok(read('mv3/repo/a.html').includes('[b](c.html)'), 'a note in the repository');
  ok(read('mv3/outside.html').includes('[b](repo/b.html)'), 'a note outside it is not searched');
  write('mv3/outside2.html', `${FIRST}<script src="tern.js"></script>\n[c](repo/c.html)\n`);
  exits(run(['mv', 'mv3/repo/c.html', 'mv3/repo/d.html', '--root=mv3']), 0, '--root');
  ok(read('mv3/outside2.html').includes('[c](repo/d.html)') && read('mv3/repo/a.html').includes('[b](d.html)'), 'both, under --root');
});

test('mv: refusals (exit 1) and usage errors (exit 2)', () => {
  write('mv4/a.html', `${FIRST}<script src="tern.js"></script>\n# A\n`);
  write('mv4/b.html', `${FIRST}<script src="tern.js"></script>\n# B\n`);
  write('mv4/d/x.html', `${FIRST}<script src="../tern.js"></script>\n# X\n`);
  const refused = (args, message) => {
    const r = run(['mv', ...args, '--root=mv4']);
    exits(r, 1, args.join(' '));
    eq(r.err.trim(), `tern mv: ${message}`, args.join(' '));
  };
  refused(['mv4/a.html', 'mv4/b.html'], 'mv4/b.html exists; move or remove it first');
  refused(['mv4/d', 'mv4/d/e'], 'cannot move mv4/d into itself');
  refused(['mv4/a.html', 'mv4/a.html'], 'mv4/a.html is already there');
  const usage = (args, message) => {
    const r = run(['mv', ...args]);
    exits(r, 2, args.join(' '));
    ok(r.err.startsWith(`tern mv: ${message}`), `${args.join(' ')}: ${r.err}`);
  };
  usage(['mv4/a.html'], 'give FROM and TO');
  usage(['mv4/nope.html', 'mv4/c.html'], 'cannot read mv4/nope.html: no such file or directory');
  usage(['mv4/a.html', 'mv4/b.html', 'mv4/c.html'], 'with several FROMs, TO must be a folder that exists');
  fs.mkdirSync(at('mv4/e'), { recursive: true });
  usage(['mv4/d', 'mv4/d/x.html', 'mv4/e'], 'mv4/d/x.html is inside mv4/d; name only mv4/d');
  usage(['mv4/a.html', 'mv4/c.html', '--root=mv4/nope'], '--root mv4/nope is not a folder');
  ok(fs.existsSync(at('mv4/a.html')) && fs.existsSync(at('mv4/d/x.html')), 'nothing moved');
  // A move that fails undoes those before it (a folder that cannot be
  // written to; root writes anyway, so not as root).
  if (process.getuid && process.getuid() !== 0) {
    fs.mkdirSync(at('mv4/ro'));
    fs.writeFileSync(at('mv4/ro/first.html'), '');
    fs.chmodSync(at('mv4/ro'), 0o555);
    try {
      const r = run(['mv', 'mv4/a.html', 'mv4/ro/first.html', 'mv4/e', '--root=mv4']);
      exits(r, 1, 'a move that fails');
      ok(/nothing was moved, and the links are left as they were/.test(r.err) && r.out === '', `says so: ${r.err}`);
      ok(fs.existsSync(at('mv4/ro/first.html')) && fs.existsSync(at('mv4/a.html')) && !fs.existsSync(at('mv4/e/a.html')), 'the first move undone');
    } finally {
      fs.chmodSync(at('mv4/ro'), 0o755);
    }
  }
});

// ---------------------------------------------------------------- parse

test('parse: the AST as JSON, parsed or transformed, pretty or compact', () => {
  write('p/box.js', ADDON);
  const head = `<html lang="de">\n${FIRST}`;
  const note = ':::box[Titel]{#b}\nSiehe @b und $x$.\n:::\n';
  write('p/n.html', `${head}<script src="tern.js" data-use="box.js"></script>\n${note}`);
  const schema = { block: { box: { tag: 'aside', counter: 'box', label: 'Box' }, blinker: { tag: 'blink' } }, leaf: {}, inline: {} };
  const parsed = tern.parse(note, { schema, head }).ast;
  const r = run(['parse', 'p/n.html']);
  exits(r, 0, 'parse');
  eq(JSON.parse(r.out), JSON.parse(JSON.stringify(parsed)), 'the parsed AST');
  ok(r.out.split('\n').length > 20, 'pretty by default');
  const c = run(['parse', 'p/n.html', '--compact']);
  eq(c.out.trimEnd().split('\n').length, 1, '--compact is one line');
  const transformed = JSON.parse(JSON.stringify(tern.transform(tern.parse(note, { schema, head }).ast, { schema, head })));
  eq(JSON.parse(run(['parse', 'p/n.html', '--transformed']).out), transformed, 'the transformed AST');
  write('p/plain.html', '<p>plain</p>\n');
  exits(run(['parse', 'p/plain.html']), 2, 'a non-note');
  exits(run(['parse', 'p/missing.html']), 2, 'a missing file');
  exits(run(['parse']), 2, 'no FILE');
});

// ---------------------------------------------------------------- build

const BUILD_NOTE = `:::meta
title: Gebaut
lang: de
author: O. C.
:::

# Gebaut {#top}

:::box[Erste]{#b1}
Inside $x^2$ and @nowhere.[^1]
:::

$$ \\int_0^1 x\\,dx $$ {#eq}

See @b1 and @eq.

<script>window.__script = (window.__script || 0) + 1;</script>

~~~
Source text that must survive: </script> </SCRIPT <!-- and <\\/script> and <\\\\!--.
~~~

[^1]: A footnote.
`;

test('build: the page parses; main.tern is tern.toHTML; the source and diagnostics survive; the head is written', () => {
  write('b/tern.js', '');
  write('b/box.js', ADDON);
  const head = FIRST;
  write('b/n.html', `${head}<script src="tern.js" data-use="box.js theme.css"></script>\n${BUILD_NOTE}`);
  const r = run(['build', 'b/n.html', '-o', 'b/out.html']);
  exits(r, 0, 'build');
  ok(/b\/n\.html:11:18: warning ref\.dangling/.test(r.err), `diagnostics on stderr: ${r.err}`);
  ok(/wrote b\/out\.html; 2 formulas$/m.test(r.err), `summary: ${r.err}`);
  const html = read('b/out.html');
  wellFormed(html);
  const p = pageParts(html);
  const schema = { block: { box: { tag: 'aside', counter: 'box', label: 'Box' }, blinker: { tag: 'blink' } }, leaf: {}, inline: {} };
  const want = tern.toHTML(BUILD_NOTE, { schema, head });
  if (p.main !== want) throw new Error(`main.tern differs from tern.toHTML at ${JSON.stringify(firstDifference(normalize(p.main || ''), normalize(want)))}`);
  eq(p.line, 1, 'data-line');
  eq(decodeSource(p.source), BUILD_NOTE, 'the source, decoded');
  ok(!/<\/script|<!--/i.test(p.source), 'the source holds no </script or <!--');
  eq(p.diagnostics.map((d) => [d.code, d.position.start.line]), [['ref.dangling', 10]], 'the diagnostics, with note positions');
  // The head: prelude, :::meta, viewport, colour scheme, tern's sheets, tern.js, add-ons.
  ok(p.head.startsWith('<!doctype html><html lang="de"><meta charset="utf-8">'), `head start: ${p.head.slice(0, 80)}`);
  ok(p.head.includes('<title>Gebaut</title>') && p.head.includes('<meta name="author" content="O. C.">'), ':::meta written');
  ok(p.head.includes('<meta name="viewport"') && p.head.includes('<meta name="color-scheme" content="light dark">'), 'viewport and color-scheme');
  ok(p.head.includes(`<style id="tern-style">\n${tern.css}</style>\n<link rel="stylesheet" href="theme.css">`), 'tern.css inlined, then the CSS add-on');
  ok(p.head.includes('<script data-built src="tern.js" data-use="box.js theme.css"></script><script src="box.js"></script>\n'), 'tern.js with data-built, then the script add-on');
  // stdout without -o; the built page is not a note.
  eq(run(['build', 'b/n.html']).out, html, 'the page on stdout');
  ok(/it is a page written by tern build/.test(run(['check', 'b/out.html']).err), 'check skips the built page');
});

test('build: the head wins over :::meta, a head link to tern.css is the base, tern goes before author CSS', () => {
  write('h/n.html', `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Head</title><link rel="stylesheet" href="../tern.css"><style>p{}</style>\n<script src="tern.js" data-use="x.css"></script>\n:::meta\ntitle: Note\nlang: de\n:::\n# Hi\n`);
  const r = run(['build', 'h/n.html']);
  exits(r, 0, 'build');
  const { head } = pageParts(r.out);
  ok(/<title>Head<\/title>/.test(head) && (head.match(/<title>/g) || []).length === 1 && /<html lang="fr">/.test(head), 'the head wins');
  ok(!/<style id="tern-style">/.test(head), 'tern.css is not inlined');
  ok(head.includes('<link rel="stylesheet" href="../tern.css">\n<link rel="stylesheet" href="x.css"><style>p{}</style>'), `the CSS add-on after the tern.css link: ${head}`);
  write('h/m.html', `<!doctype html><meta charset="utf-8"><style>p{}</style>\n<script src="tern.js"></script>\n# Hi\n`);
  const m = pageParts(run(['build', 'h/m.html']).out).head;
  ok(m.indexOf('<style id="tern-style">') < m.indexOf('<style>p{}</style>'), 'tern.css before the author stylesheet');
  write('h/q.html', `<script src="tern.js"></script>\n# Quirky\n`);
  const q = run(['build', 'h/q.html']);
  ok(q.out.startsWith('<!doctype html><meta charset="utf-8">'), 'a doctype and charset added');
  ok(q.err.includes('tern build: the note has no <!doctype html>; the page adds it\n') && q.err.includes('tern build: the note has no <meta charset>; the page adds <meta charset="utf-8">\n'), `a warning for each: ${q.err}`);
  write('h/c.html', `<!doctype html><title>C</title>\n<script src="tern.js"></script>\n# No charset\n`);
  const c = run(['build', 'h/c.html']);
  ok(c.out.startsWith('<!doctype html><meta charset="utf-8"><title>C</title>'), 'the charset added after the doctype');
  ok(/has no <meta charset>/.test(c.err) && !/has no <!doctype/.test(c.err), `only the charset warning: ${c.err}`);
  ok(!/has no/.test(run(['build', 'h/m.html']).err), 'no warning when both are there');
});

test('build --katex: formulas pre-rendered to HTML and MathML, with data-tex and KaTeX CSS under SRI', () => {
  const cache = path.join(ROOT, 'node_modules', '.cache', 'tern-smoke');
  const version = fs.existsSync(cache) && fs.readdirSync(cache).find((d) => /^katex-\d/.test(d) && fs.existsSync(path.join(cache, d, 'dist', 'katex.js')));
  // Without the package, --katex leaves the formulas to tern.js and says why.
  write('k/n.html', `${FIRST}<script src="tern.js"></script>\n:::macros\n\\newcommand{\\RR}{\\mathbb{R}}\n:::\n\n# Top $x^2$\n\nInline $x \\in \\RR$ and display:\n\n$$ \\sum_{i=1}^n i $$\n`);
  const without = run(['build', 'k/n.html', '--katex']);
  exits(without, 0, 'build --katex without katex');
  ok(/the katex package cannot be required/.test(without.err) && !/class="katex"/.test(without.out), 'no pre-rendering');
  if (!version) throw new Skip('no KaTeX in node_modules/.cache/tern-smoke (run the smoke tests once)');
  const pkg = at('kx', 'node_modules', 'katex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'katex', version: version.slice(6), main: 'dist/katex.js' }));
  try {
    fs.symlinkSync(path.join(cache, version, 'dist'), path.join(pkg, 'dist'), 'dir');
  } catch {
    fs.cpSync(path.join(cache, version, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  }
  const env = { NODE_PATH: at('kx', 'node_modules') };
  const r = run(['build', 'k/n.html', '--katex'], { env });
  exits(r, 0, 'build --katex');
  ok(/3 formulas, 3 pre-rendered/.test(r.err), `summary: ${r.err}`);
  const p = pageParts(r.out);
  const spans = [...p.main.matchAll(/<span class="t-math"( data-display)? data-pos="[^"]*" data-tex="([^"]*)"><span class="katex(-display)?">/g)].map((m) => m[2]);
  eq(spans, ['x^2', 'x \\in \\RR', '\\sum_{i=1}^n i'], 'pre-rendered formulas and their data-tex');
  ok((p.main.match(/<math xmlns=/g) || []).length === 3 && /class="katex-html"/.test(p.main), 'HTML and MathML');
  if (version === 'katex-0.19.0') ok(p.head.includes(`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css" integrity="${KATEX.css}" crossorigin="anonymous">\n<style id="tern-style">`), "KaTeX's CSS with the runtime's SRI, before tern.css");
  ok(/<script data-built src="tern\.js">/.test(r.out), 'data-built with no formulas left');
  // A formula KaTeX rejects is left to tern.js, which then needs KaTeX.
  write('k/bad.html', `${FIRST}<script src="tern.js"></script>\nGood $x$, bad $\\left( x$.\n`);
  const bad = run(['build', 'k/bad.html', '--katex'], { env });
  ok(/k\/bad\.html:2:15: warning math\.error: KaTeX cannot typeset this formula/.test(bad.err), `stderr: ${bad.err}`);
  ok(/<script data-built src="tern\.js">/.test(bad.out) && /data-pos="1:15">\\left\( x<\/span>/.test(bad.out), 'the bad formula left as TeX (rendered only if the note loads a math add-on)');
  write('k/none.html', `${FIRST}<script src="tern.js" data-katex="none"></script>\nNo $x$.\n`);
  ok(/data-katex="none"/.test(run(['build', 'k/none.html', '--katex'], { env }).err), 'data-katex="none" is not pre-rendered');
});

test('build --math=mathml: formulas pre-rendered to native MathML with Temml, self-contained', () => {
  const cache = path.join(ROOT, 'node_modules', '.cache', 'tern-smoke');
  const version = fs.existsSync(cache) && fs.readdirSync(cache).find((d) => /^temml-\d/.test(d) && fs.existsSync(path.join(cache, d, 'dist', 'temml.cjs')));
  write('m/n.html', `${FIRST}<script src="tern.js"></script>\n:::macros\n\\newcommand{\\RR}{\\mathbb{R}}\n:::\n\n# Top $x^2$\n\nInline $x \\in \\RR$ and display:\n\n$$ \\sum_{i=1}^n i $$\n`);
  // Without the package, --math=mathml leaves the formulas to tern.js and says why.
  const without = run(['build', 'm/n.html', '--math=mathml']);
  exits(without, 0, 'build --math=mathml without temml');
  ok(/the temml package cannot be required/.test(without.err) && !/<math/.test(without.out), 'no pre-rendering');
  // A bad engine name is a usage error.
  const bogus = run(['build', 'm/n.html', '--math=latex']);
  exits(bogus, 2, '--math=latex');
  ok(/--math must be katex or mathml/.test(bogus.err), `usage: ${bogus.err}`);
  if (!version) throw new Skip('no Temml in node_modules/.cache/tern-smoke (run the smoke tests once)');
  const pkg = at('tx', 'node_modules', 'temml');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'temml', version: version.slice(6), main: 'dist/temml.cjs' }));
  try {
    fs.symlinkSync(path.join(cache, version, 'dist'), path.join(pkg, 'dist'), 'dir');
  } catch {
    fs.cpSync(path.join(cache, version, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  }
  const env = { NODE_PATH: at('tx', 'node_modules') };
  const r = run(['build', 'm/n.html', '--math=mathml'], { env });
  exits(r, 0, 'build --math=mathml');
  ok(/3 formulas, 3 pre-rendered as MathML/.test(r.err), `summary: ${r.err}`);
  const p = pageParts(r.out);
  const spans = [...p.main.matchAll(/<span class="t-math"( data-display)? data-pos="[^"]*" data-tex="([^"]*)"><math/g)].map((m) => m[2]);
  eq(spans, ['x^2', 'x \\in \\RR', '\\sum_{i=1}^n i'], 'pre-rendered formulas and their data-tex');
  ok((p.main.match(/<math\b/g) || []).length === 3, 'three <math> elements');
  ok(/annotation encoding="application\/x-tex"/.test(p.main), 'the TeX kept in an annotation');
  // KaTeX off; its stylesheet and script never referenced; Temml inlined.
  ok(/<script data-built src="tern\.js">/.test(r.out), 'data-built; the MathML is in the page');
  ok(!/katex\.min\.(js|css)/.test(r.out), 'no KaTeX asset referenced');
  ok(/<style id="tern-temml-style">/.test(p.head) && /url\(data:font\/woff2;base64,/.test(p.head), "Temml's CSS inlined with its font as a data URL");
  // A formula Temml rejects stays as its TeX source; the page still turns KaTeX off.
  write('m/bad.html', `${FIRST}<script src="tern.js"></script>\nGood $x$, bad $\\left( x$.\n`);
  const bad = run(['build', 'm/bad.html', '--math=mathml'], { env });
  ok(/m\/bad\.html:2:15: warning math\.error: Temml cannot render this formula/.test(bad.err), `stderr: ${bad.err}`);
  ok(/<script data-built src="tern\.js">/.test(bad.out) && /data-pos="1:15">\\left\( x<\/span>/.test(bad.out), 'the bad formula left as TeX source');
});

test('build: refusals and usage errors', () => {
  write('e/plain.html', '<p>plain</p>\n');
  write('e/n.html', `${FIRST}<script src="tern.js"></script>\n# x\n`);
  exits(run(['build', 'e/plain.html']), 2, 'a non-note');
  exits(run(['build', 'e/n.html', '-o', 'e/n.html']), 2, '-o the note itself');
  eq(read('e/n.html'), `${FIRST}<script src="tern.js"></script>\n# x\n`, 'the note');
  exits(run(['build']), 2, 'no FILE');
  fs.mkdirSync(at('e/dist'));
  exits(run(['build', 'e/n.html', '-o', 'e/dist']), 0, '-o a directory');
  ok(fs.existsSync(at('e/dist/n.html')), 'written as dist/n.html');
});

test('build -o: a trailing slash or an existing directory is a directory, created if missing; otherwise a file, its directory created', () => {
  write('o2/n.html', `${FIRST}<script src="tern.js"></script>\n# x\n`);
  const d = run(['build', 'o2/n.html', '-o', 'o2/site/notes/']);
  exits(d, 0, '-o a missing directory/');
  ok(fs.statSync(at('o2/site/notes/n.html')).isFile(), 'written as o2/site/notes/n.html');
  ok(/wrote o2\/site\/notes\/n\.html;/.test(d.err), `stderr: ${d.err}`);
  exits(run(['build', 'o2/n.html', '-o', 'o2/site/notes']), 0, '-o the existing directory, without a slash');
  exits(run(['build', 'o2/n.html', '-o', 'o2/deep/er/page.html']), 0, '-o a file in a missing directory');
  ok(fs.statSync(at('o2/deep/er/page.html')).isFile(), 'written as o2/deep/er/page.html');
  const f = run(['build', 'o2/n.html', '-o', 'o2/bare']);
  exits(f, 0, '-o a missing name without a slash');
  ok(fs.statSync(at('o2/bare')).isFile(), 'written as the file o2/bare');
  ok(f.err.includes('tern build: o2/bare is written as a file; end -o with / to write n.html into a directory of that name'), `the hint: ${f.err}`);
  ok(!/is written as a file/.test(d.err), 'no hint for a directory');
  const g = run(['build', 'o2/n.html', '-o', 'o2/n.html/x.html']);
  exits(g, 2, '-o under a file');
  ok(/tern build: cannot create the directory o2\/n\.html: a file is in the way/.test(g.err), `stderr: ${g.err}`);
});

// ---------------------------------------------------------------- corpus

// A documentation page (docs/README.md "Live examples") whose add-on exposes
// a demo schema, as docs.js does.
const F3 = '```';
const DEMO_ADDON = `tern.leaf('toc', { tag: 'nav', transform: 'toc' });\nwindow.ternDocs = { demo: ${JSON.stringify(require('./fixtures/schema'))} };\n`;
const DOC_PAGE = [
  `${FIRST}<script src="../tern.js" data-use="demo.js"></script>`,
  `${F3}tern {.live}`,
  'Before any heading.',
  F3,
  '',
  '## Fenced code {#fence}',
  '',
  `\`\`\`\`\`tern {.live}`,
  `\`\`\`\`tern`,
  'inner',
  `\`\`\`\``,
  `\`\`\`\`\``,
  '',
  `\`\`\`\`tern {.live spec="syntax-blocks#fence syntax-blocks#r5"}`,
  `${F3}js`,
  'x',
  F3,
  `\`\`\`\``,
  '',
  `${F3}tern {.live #own expect="block.unclosed"}`,
  ':::note',
  'open',
  F3,
  '',
  `${F3}tern {.live schema=demo}`,
  ':::theorem{#t}',
  'x',
  ':::',
  '',
  'See @t.',
  F3,
  '',
  `${F3}tern {.live head="<title>Head</title>" expect=meta.conflict}`,
  ':::meta',
  'title: Meta',
  ':::',
  F3,
  '',
  `${F3}tern {.live}`,
  'two trailing spaces  ',
  'and\ta tab',
  F3,
  '',
  `${F3}tern`,
  'not live',
  F3,
  '',
  `${F3}js {.live}`,
  'not tern',
  F3,
  '',
].join('\n');

test('corpus: live examples become corpus cases (ids, spec, options, blocks) that parse and pass', () => {
  write('c/docs/demo.js', DEMO_ADDON);
  write('c/docs/page.html', DOC_PAGE);
  const r = run(['corpus', 'c/docs/page.html']);
  exits(r, 0, 'corpus');
  ok(/tern corpus: 7 cases from 1 page/.test(r.err), `the summary: ${r.err}`);
  write('c/out1/a.txt', r.out);
  const { cases, errors } = loadAll(at('c/out1'));
  eq(errors.map((e) => e.message), [], 'the cases parse');
  eq(cases.map((c) => c.id), ['docs/page-1', 'docs/page-fence-1', 'docs/page-fence-2', 'docs/page-own', 'docs/page-fence-4', 'docs/page-fence-5', 'docs/page-fence-6'], 'ids: the heading id and a number, or the fence #id');
  const by = Object.fromEntries(cases.map((c) => [c.id, c]));
  eq(by['docs/page-fence-2'].spec, ['syntax-blocks#fence', 'syntax-blocks#r5'], 'spec= is the spec line');
  eq(by['docs/page-fence-1'].spec, ['page#fence'], 'else the section the example is in');
  eq(by['docs/page-1'].spec, ['page#top'], 'before any heading: the top of the page');
  eq([...by['docs/page-1'].options], ['schema=none'], 'schema=none by default');
  eq([...by['docs/page-fence-4'].options], [], 'schema=demo runs with the fixture schema');
  eq(by['docs/page-fence-5'].head, '<title>Head</title>', 'head= is the html head block');
  eq(by['docs/page-fence-5'].diagnostics.map((d) => d.code), ['meta.conflict'], 'the head reaches the engine');
  eq([...by['docs/page-fence-6'].options], ['schema=none', 'escaped'], 'trailing spaces and a tab: escaped');
  eq(by['docs/page-fence-6'].source, 'two trailing spaces  \nand\ta tab\n', 'the escaped source decodes to the example');
  eq(by['docs/page-fence-1'].source, '````tern\ninner\n````\n', 'a source with a four-backtick fence');
  ok(r.out.includes('`````tern\n````tern\ninner'), 'is fenced with five backticks');
  eq(by['docs/page-own'].diagnostics.map((d) => [d.code, d.severity, d.position.start.line]), [['block.unclosed', 'error', 1]], 'the diagnostics block from expect, positioned by the engine');
  // As test/run.js runs a case: the diagnostics match exactly.
  const fixture = require('./fixtures/schema');
  for (const c of cases) {
    const schema = c.options.has('schema=none') ? { block: {}, leaf: {}, inline: {} } : fixture;
    const got = tern.check(c.source, { schema, head: c.head }).map((d) => `${d.position.start.line}:${d.position.start.column} ${d.severity} ${d.code}`);
    const want = (c.diagnostics || []).map((d) => `${d.position.start.line}:${d.position.start.column} ${d.severity} ${d.code}`);
    eq(got, want, `${c.id} passes`);
  }
  // --out writes DIR/docs-PAGE.txt, the same text; a page in examples/ gets examples- in its ids.
  write('c/examples/demo.js', DEMO_ADDON);
  write('c/examples/lecture.html', `${FIRST}<script src="../tern.js"></script>\n${F3}tern {.live}\nx\n${F3}\n`);
  const o = run(['corpus', 'c/docs/page.html', 'c/examples', '--out=c/out2/sub']);
  exits(o, 0, 'corpus --out');
  eq(fs.readFileSync(at('c/out2/sub/docs-page.txt'), 'utf8'), r.out, '--out writes what stdout prints');
  const lecture = fs.readFileSync(at('c/out2/sub/docs-examples-lecture.txt'), 'utf8');
  ok(/^## docs\/examples-lecture-1$/m.test(lecture), 'examples/lecture.html: docs/examples-lecture-1');
  ok(/^spec: guide#top$/m.test(lecture), 'a page outside docs/ cites the guide');
  eq(o.out, '', 'nothing on stdout with --out');
});

test('corpus: an example that does not match its expect, or has no schema, is reported and left out (exit 1); usage', () => {
  write('c/bad/page.html', [`${FIRST}<script src="tern.js"></script>`, `${F3}tern {.live expect="block.unclosed"}`, 'fine', F3, '', `${F3}tern {.live schema=demo}`, 'x', F3, '', `${F3}tern {.live schema=mine}`, 'y', F3, '', `${F3}tern {.live}`, 'z', F3, ''].join('\n'));
  const r = run(['corpus', 'c/bad/page.html']);
  exits(r, 1, 'corpus with problems');
  const lines = r.err.trimEnd().split('\n');
  ok(lines.some((l) => /^c\/bad\/page\.html:2: example page-1: expect="block\.unclosed" but the engine reports nothing/.test(l)), `the mismatch, at its file line: ${r.err}`);
  ok(lines.some((l) => /^c\/bad\/page\.html:6: schema=demo, but the page's add-ons expose no demo schema/.test(l)), 'schema=demo without docs.js');
  ok(lines.some((l) => /^c\/bad\/page\.html:10: schema="mine" is not a schema/.test(l)), 'an unknown schema');
  eq((r.out.match(/^## /gm) || []).length, 1, 'only the good example is a case');
  write('c/bad/plain.html', '<!doctype html><p>not a note</p>\n');
  const n = run(['corpus', 'c/bad/plain.html']);
  exits(n, 0, 'a file that is not a note');
  ok(/is not a note/.test(n.err), 'says why');
  exits(run(['corpus']), 2, 'no path');
  exits(run(['corpus', 'c/nowhere.html']), 2, 'a missing file');
  exits(run(['corpus', 'c/bad/page.html', '--bogus']), 2, 'an unknown option');
});

// Output piped to a reader that closes early (tern parse big.html | head):
// the command ends quietly, exit 0, no trace, instead of an unhandled EPIPE.
test('parse | head: a reader that closes early ends the command quietly, exit 0, nothing on stderr', async () => {
  const { spawn } = require('child_process');
  write('pipe/big.html', `${FIRST}<script src="tern.js"></script>\n${'A paragraph of text, repeated so that the AST is many pipe buffers long.\n\n'.repeat(20000)}`);
  const child = spawn(process.execPath, [CLI, 'parse', 'pipe/big.html'], { cwd: TMP, env: { ...process.env, NODE_PATH: '' } });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdout.destroy(); // the reader is gone: the next write gets EPIPE
  const code = await new Promise((resolve) => child.on('close', resolve));
  eq(code, 0, `exit code; stderr: ${err.slice(0, 200)}`);
  eq(err, '', 'stderr');
});

test('usage: help, unknown commands, --help, --version', () => {
  const h = run(['help']);
  exits(h, 0, 'help');
  for (const c of ['new', 'check', 'parse', 'build', 'corpus', 'lsp']) ok(h.out.includes(`tern ${c}`), `usage names ${c}`);
  exits(run([]), 0, 'no command');
  exits(run(['bogus']), 2, 'an unknown command');
  exits(run(['usage']), 2, 'usage is not a command');
  for (const c of ['new', 'check', 'parse', 'build', 'mv', 'search', 'index', 'corpus', 'lsp']) {
    const r = run([c, '--help']);
    exits(r, 0, `${c} --help`);
    ok(r.out.startsWith(`usage: tern ${c}`), `${c} --help prints its synopsis`);
  }
  eq(run(['lsp', '-h']).out, 'usage: tern lsp [--stdio]\n', 'lsp -h');
  for (const args of [['lsp', '--bogus'], ['lsp', 'extra']]) {
    const r = run(args);
    exits(r, 2, args.join(' '));
    ok(/usage: tern lsp/.test(r.err), `${args.join(' ')} prints the synopsis`);
  }
  eq(run(['--version']).out, `${tern.version}\n`, '--version');
});

// ---------------------------------------------------------------- run

// Tests run in order; one that must wait on a child (a pipe closed early)
// returns a promise.
(async () => {
  let failed = 0;
  let skipped = 0;
  let ran = 0;
  for (const t of tests) {
    if (FILTER && !t.name.includes(FILTER)) continue;
    ran++;
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      if (e instanceof Skip) {
        skipped++;
        console.log(`- ${t.name} (skipped: ${e.message})`);
        continue;
      }
      failed++;
      console.log(`✗ ${t.name}\n    ${e.message}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${ran - failed - skipped}/${ran} CLI tests pass${skipped ? `; ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
})();
