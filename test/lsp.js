#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The language server over stdio: spawns `node tern-cli.js lsp` and drives
// it as an editor would. Expectations come from the engine (cli/note.js
// `analyse`, the AST), never from the server:
//   - published diagnostics equal the engine's with cli/links.js's (what
//     `tern check` reports), mapped to LSP;
//   - links between files: an open document's text wins over its file's,
//     an open file exists, the other open notes are checked again;
//   - workspace/willRenameFiles: the edits, applied as a client does, give
//     the files tern mv writes; the workspace folders or the moved file's
//     folder; file operations check the open notes' links again;
//   - rename edits equal the engine's reference set, none in code or math;
//   - definition, references, hover, completion, documentSymbol,
//     foldingRange, documentHighlight, the `tern/outline` notification, the
//     pace of analyses (at once after a pause, every 150 ms at most);
//   - a single-file note's own vocabulary (window.TERN.schema);
//   - add-on transforms run for their own note only, data-lang's label
//     language, addon.remote;
//   - a non-note .html file, add-on caching, malformed input, shutdown, exit.
//
//   node test/lsp.js [--verbose]
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const note = require('../cli/note');
const links = require('../cli/links');
const fixture = require('./fixtures/schema');

const CLI = path.join(__dirname, '..', 'tern-cli.js');
const SAMPLES = path.join(__dirname, 'samples');
const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------- client

class Client {
  // `preload`: a module the server requires first (node -r), for a check that counts.
  constructor({ preload } = {}) {
    this.proc = spawn(process.execPath, [...(preload ? ['-r', preload] : []), CLI, 'lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.inbox = []; // notifications, and responses to no request (id null)
    this.log = []; // every notification, in order, with its arrival time
    this.waiters = [];
    this.garbage = ''; // anything on stdout that is not a framed message
    this.stderr = '';
    this.proc.stdout.on('data', (c) => this.data(c));
    this.proc.stderr.on('data', (c) => (this.stderr += c));
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
  }
  data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (let sep; (sep = this.buf.indexOf('\r\n\r\n')) >= 0; ) {
      const m = /^Content-Length: (\d+)$/.exec(this.buf.toString('ascii', 0, sep));
      if (!m) {
        this.garbage += this.buf.toString('utf8', 0, sep + 4);
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      const end = sep + 4 + Number(m[1]);
      if (this.buf.length < end) return;
      const msg = JSON.parse(this.buf.toString('utf8', sep + 4, end));
      this.buf = this.buf.subarray(end);
      const done = msg.id != null && !msg.method && this.pending.get(msg.id);
      if (done) this.pending.delete(msg.id), done(msg);
      else {
        if (msg.method) this.log.push({ msg, at: Date.now() });
        this.inbox.push(msg);
        this.waiters = this.waiters.filter((w) => !w());
      }
    }
  }
  write(text) {
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  }
  notify(method, params) {
    this.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
  // The whole response: {result} or {error}.
  send(method, params) {
    const id = ++this.id;
    this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no response`)), 5000);
      this.pending.set(id, (msg) => (clearTimeout(timer), resolve(msg)));
    });
  }
  async call(method, params) {
    const r = await this.send(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
    return r.result;
  }
  // The first message in the inbox matching `pred`, taken out of it.
  next(pred, ms = 5000) {
    return new Promise((resolve, reject) => {
      const take = () => {
        const i = this.inbox.findIndex(pred);
        return i >= 0 && (resolve(this.inbox.splice(i, 1)[0]), true);
      };
      if (take()) return;
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
      this.waiters.push(() => take() && (clearTimeout(timer), true));
    });
  }
  published(uri, ms) {
    return this.next((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri, ms).then((m) => m.params);
  }
  outline(uri, ms) {
    return this.next((m) => m.method === 'tern/outline' && m.params.uri === uri, ms).then((m) => m.params);
  }
  async open(file, text, version = 1) {
    const uri = pathToFileURL(file).href;
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'html', version, text } });
    return { uri, diagnostics: (await this.published(uri)).diagnostics };
  }
}

// ---------------------------------------------------------------- helpers

// The LSP form of an engine diagnostic, stated independently of the server:
// 0-based file range, severity number, code, source, the hint after the
// message and in `data`.
function expected(d) {
  const p = d.filePosition;
  const at = (q) => ({ line: Math.max(q.line - 1, 0), character: Math.max(q.column - 1, 0) });
  const out = { range: { start: at(p.start), end: at(p.end) }, severity: { error: 1, warning: 2, info: 3 }[d.severity], code: d.code, source: 'tern' };
  out.message = d.hint ? `${d.message}\n${d.hint}` : d.message;
  if (d.hint) out.data = { hint: d.hint };
  return out;
}
const sorted = (list) => list.map((x) => JSON.stringify(x)).sort();

// The position of the nth `needle` in the text, plus `plus` code units.
function locate(text, needle, { nth = 0, plus = 0 } = {}) {
  let i = -1;
  for (let k = 0; k <= nth; k++) if ((i = text.indexOf(needle, i + 1)) < 0) throw new Error(`"${needle}" #${nth} not in the note`);
  const before = text.slice(0, i + plus);
  return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 };
}

// A note position (1-based, note lines) as an LSP range in the file.
const fileRange = (a, p) => ({
  start: { line: p.start.line + a.line - 1, character: p.start.column - 1 },
  end: { line: p.end.line + a.line - 1, character: p.end.column - 1 },
});
const tn = (n) => (n.data && n.data.tern) || {};
// note.analyse, its links checked against the disk as `tern check` does,
// with what the add-on logs (to stderr) kept out of this harness's output.
function analyse(text, file) {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const a = note.analyse(text, file);
    if (a) a.diagnostics = links.merge(a.diagnostics, links.check(file, a, new links.Targets()));
    return a;
  } finally {
    process.stderr.write = write;
  }
}
// tern.outline with every line a file line.
function outlineOf(a) {
  const o = note.tern.outline(a.ast);
  for (const k in o) for (const e of o[k]) (e.line += a.line), e.endLine && (e.endLine += a.line);
  return o;
}
// LSP TextEdits applied to a text as a client does: lines and UTF-16 characters.
function applyEdits(text, edits) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const at = (p) => starts[p.line] + p.character;
  const sorted = [...edits].sort((x, y) => at(y.range.start) - at(x.range.start));
  return sorted.reduce((t, e) => t.slice(0, at(e.range.start)) + e.newText + t.slice(at(e.range.end)), text);
}
const doc = (uri) => ({ textDocument: { uri } });
const before = (p, q) => p.line < q.line || (p.line === q.line && p.character <= q.character);

// ---------------------------------------------------------------- fixtures

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-lsp-'));
fs.writeFileSync(path.join(DIR, 'tern.js'), ''); // the notes' tern.js, which link checking looks for
const ADDON = path.join(DIR, 'addon.js');
const writeAddon = (extra = '') =>
  fs.writeFileSync(
    ADDON,
    `// the fixture vocabulary (test/fixtures/schema.js) as an add-on
const S = ${JSON.stringify(fixture)};
for (const level of ['block', 'leaf', 'inline']) for (const name in S[level]) tern[level](name, S[level][name]);
tern.inline('hl', { tag: 'mark' });
console.log('addon-ran: this must reach stderr, not the protocol');
${extra}`,
  );
writeAddon();

// The reference note: a three-line head, a heading id, a theorem with a
// named closer, references in a paragraph, a heading, a table cell, two
// fragment links and a footnote, and `@rn` inside code and math, which no
// edit may touch. The emoji makes UTF-16 columns differ from code points.
const REFS = `<!doctype html><meta charset="utf-8">
<title>LSP test</title>
<script src="tern.js" data-use="addon.js"></script>
:::meta
title: LSP test
:::

## Kernel {#kernel}

:::theorem[Rank–nullity]{#rn}
By 😀 @kernel, see $@rn$ and \`@rn\` and @rn.
:::/theorem

## About @rn

| Name | Where |
|---|---|
| @rn | \`@rn\` |

Link: [the theorem](#rn), [again](<#rn> "t"){.x} and :kbd[C]{#k}.[^n]

[^n]: A footnote about @rn.

\`\`\`js
@rn
\`\`\`

$$
@rn = 1
$$ {#eq}

:::proof
See @eq and @nowhere.
:::

{#intro}
A paragraph with an id.

::toc
`;

const COMPLETE = `<script src="tern.js" data-use="addon.js"></script>
:::theorem[T]{#t1}
See @
::
Press :
\`\`\`js
@
\`\`\`
Math $x @y$ and code \`x @\` here.
Go [there](#
:::/
:::
`;

const ERRORS = `<!doctype html><meta charset="utf-8"><script src="tern.js" data-use="missing.js"></script>
# Errors

:::theorem[T] #rn .big
$$
x

y
$$

{#k!}
Text @dangling and [x](#nope).

:::proof
unclosed
`;

// ---------------------------------------------------------------- checks

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const c = new Client();
let refs; // {uri, text, a}

check('a request before initialize is refused', async () => {
  const r = await c.send('textDocument/hover', { ...doc('file:///x.html'), position: { line: 0, character: 0 } });
  assert.strictEqual(r.error && r.error.code, -32002);
});

check('initialize: UTF-16 positions, full sync, the features', async () => {
  const r = await c.call('initialize', { processId: process.pid, rootUri: null, capabilities: { general: { positionEncodings: ['utf-16'] } } });
  const k = r.capabilities;
  assert.strictEqual(k.positionEncoding, 'utf-16');
  assert.strictEqual(k.textDocumentSync.change, 1);
  for (const f of ['hoverProvider', 'definitionProvider', 'referencesProvider', 'documentSymbolProvider', 'foldingRangeProvider', 'workspaceSymbolProvider']) assert.ok(k[f], f);
  assert.deepStrictEqual(k.documentLinkProvider, { resolveProvider: false });
  assert.deepStrictEqual(k.codeActionProvider, { codeActionKinds: ['quickfix'] });
  assert.ok(k.renameProvider.prepareProvider);
  assert.deepStrictEqual(k.completionProvider.triggerCharacters, [':', '@'], 'the triggers: a name or an id starts; / and # are typed inside one');
  for (const op of ['willRename', 'didRename', 'didCreate', 'didDelete']) assert.deepStrictEqual(k.workspace.fileOperations[op], { filters: [{ scheme: 'file', pattern: { glob: '**' } }] }, op);
  assert.deepStrictEqual(k.workspace.workspaceFolders, { supported: true, changeNotifications: true });
  c.notify('initialized', {});
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!c.inbox.some((m) => m.method === 'client/registerCapability'), 'a client that cannot watch files is not asked to');
});

// A client that can watch files is asked to watch notes, what they link to
// and what they load; a change to an add-on on disk then re-analyses the
// notes that load it, without a change to them. The workspace folders can
// change after initialize.
check('watched files: the registration, an add-on changed on disk; workspace folders added and removed', async () => {
  const F = path.join(DIR, 'watch');
  fs.mkdirSync(F, { recursive: true });
  fs.writeFileSync(path.join(F, 'tern.js'), '');
  fs.writeFileSync(path.join(F, 'vocab.js'), "tern.block('claim', { label: 'Claim' });\n");
  const T = '<script src="tern.js" data-use="vocab.js"></script>\n:::claim[C]{#c}\nx\n:::\n\nSee @c.\n';
  const w = new Client();
  await w.call('initialize', { processId: process.pid, rootUri: null, capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } });
  w.notify('initialized', {});
  const reg = await w.next((m) => m.method === 'client/registerCapability');
  assert.deepStrictEqual(reg.params, { registrations: [{ id: 'tern-watch', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*.{html,htm,md,markdown,js,mjs,css}' }] } }] });
  w.write(JSON.stringify({ jsonrpc: '2.0', id: reg.id, result: null }));
  const file = path.join(F, 'note.html');
  const { uri } = await w.open(file, T);
  const hover = async () => (await w.call('textDocument/hover', { ...doc(uri), position: locate(T, '@c', { plus: 1 }) })).contents.value;
  assert.ok((await hover()).includes('Claim — C'));
  fs.writeFileSync(path.join(F, 'vocab.js'), "tern.block('claim', { label: 'Lemma' });\n");
  w.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(path.join(F, 'vocab.js')).href, type: 2 }] });
  const again = await w.published(uri);
  assert.strictEqual(again.version, 1, 'the note analysed again, unchanged');
  assert.ok((await hover()).includes('Lemma — C'), 'with the add-on as it is on disk');
  // The folders: none at initialize; one added is searched, removed it is not.
  const names = async () => (await w.call('workspace/symbol', { query: '' })).map((s) => s.containerName);
  assert.deepStrictEqual(await names(), [file], 'only the open note, by its path: no workspace folder');
  fs.writeFileSync(path.join(F, 'other.html'), '<script src="tern.js"></script>\n# Other\n');
  w.notify('workspace/didChangeWorkspaceFolders', { event: { added: [{ uri: pathToFileURL(F).href, name: 'f' }], removed: [] } });
  assert.deepStrictEqual((await names()).sort(), ['note.html', 'other.html']);
  w.notify('workspace/didChangeWorkspaceFolders', { event: { added: [], removed: [{ uri: pathToFileURL(F).href, name: 'f' }] } });
  assert.deepStrictEqual(await names(), [file]);
  w.proc.kill();
});

check('published diagnostics and outlines equal the engine’s', async () => {
  const notes = fs
    .readdirSync(SAMPLES)
    .filter((f) => f.endsWith('.html') && !f.endsWith('.excerpt.html'))
    .map((f) => [path.join(SAMPLES, f), fs.readFileSync(path.join(SAMPLES, f), 'utf8')]);
  notes.push([path.join(DIR, 'refs.html'), REFS], [path.join(DIR, 'errors.html'), ERRORS], [path.join(DIR, 'crlf.html'), ERRORS.replace(/\n/g, '\r\n')]);
  let total = 0;
  for (const [file, text] of notes) {
    const { uri, diagnostics } = await c.open(file, text);
    const a = analyse(text, file);
    const want = a.diagnostics.map(expected);
    assert.deepStrictEqual(diagnostics, want, path.basename(file)); // in order: the server runs what note.analyse runs
    assert.deepStrictEqual(await c.outline(uri), { uri, version: 1, ...outlineOf(a) }, `${path.basename(file)} outline`);
    total += want.length;
    if (verbose) console.log(`    ${path.basename(file)}: ${want.length} diagnostics`);
  }
  const errors = analyse(ERRORS, path.join(DIR, 'errors.html')).diagnostics;
  for (const code of ['addon.failed', 'block.opener-junk', 'math.unclosed', 'attr.malformed', 'ref.dangling', 'block.unclosed'])
    assert.ok(errors.some((d) => d.code === code), `the error note reports ${code}`);
  assert.ok(total > 10);
});

check('tern/outline after analysis, with file lines', async () => {
  const file = path.join(DIR, 'outline.html');
  const uri = pathToFileURL(file).href;
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'html', version: 7, text: REFS } });
  const o = await c.outline(uri);
  assert.deepStrictEqual(o, { uri, version: 7, ...outlineOf(analyse(REFS, file)) });
  assert.strictEqual(o.headings[0].line, locate(REFS, '## Kernel').line + 1, 'a heading line is its 1-based file line');
  // Columns are 1-based UTF-16 file columns (JS string indices + 1), past the emoji.
  const lines = REFS.split('\n');
  const at = (line, col) => lines.slice(0, line - 1).join('\n').length + 1 + col - 1;
  const text = (e) => REFS.slice(at(e.line, e.col), at(e.endLine || e.line, e.end));
  assert.strictEqual(text(o.refs.find((r) => r.id === 'kernel')), '@kernel', 'a reference’s col and end');
  const inline = o.math.find((m) => !m.display);
  assert.deepStrictEqual([inline.tex, inline.line, inline.endLine, text(inline)], ['@rn', locate(REFS, '$@rn$').line + 1, locate(REFS, '$@rn$').line + 1, '$@rn$'], 'inline math: col and end');
  const display = o.math.find((m) => m.display);
  assert.deepStrictEqual([display.number, display.line, display.endLine, text(display)], ['(1)', locate(REFS, '$$\n@rn').line + 1, locate(REFS, '$$ {#eq}').line + 1, '$$\n@rn = 1\n$$ {#eq}'], 'display math: from the opener to after the closer’s attributes');
});

check('rename: edits equal the engine’s reference set, none in code or math', async () => {
  const file = path.join(DIR, 'refs.html');
  const uri = pathToFileURL(file).href;
  const a = analyse(REFS, file);
  refs = { uri, text: REFS, a };
  // The engine's reference set for `rn`: each ref's id, each fragment
  // link's `#rn`, and the declaration's `#rn`; never inside code or math.
  const lines = REFS.split('\n');
  const want = [];
  const chars = (line, col, n) => ({ range: { start: { line, character: col }, end: { line, character: col + n } }, newText: 'rank' });
  const atoms = [];
  note.tern.visit(a.ast, (n) => {
    if (!n.position) return false;
    const r = fileRange(a, n.position);
    if (n.type === 'ref' && n.id === 'rn') want.push(chars(r.start.line, r.start.character + 1, 2));
    if (n.type === 'link' && n.url === '#rn') want.push(chars(r.start.line, lines[r.start.line].indexOf('#rn', r.start.character) + 1, 2));
    if (n.attributes && n.attributes.id === 'rn') {
      const ip = fileRange(a, tn(n).idPosition);
      want.push(chars(ip.start.line, ip.start.character + 1, 2));
    }
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(n.type)) atoms.push(r);
  });
  assert.strictEqual(want.length, 7, 'four references, two fragment links, one declaration');
  for (const [needle, opts] of [['#rn}', { plus: 1 }], ['| @rn', { plus: 3 }], ['About @rn', { plus: 7 }], ['(<#rn>', { plus: 3 }]]) {
    const edit = await c.call('textDocument/rename', { ...doc(uri), position: locate(REFS, needle, opts), newName: 'rank' });
    assert.deepStrictEqual(sorted(edit.changes[uri]), sorted(want), `from ${needle}`);
  }
  const edits = want;
  for (const e of edits) for (const r of atoms) assert.ok(before(e.range.end, r.start) || before(r.end, e.range.start), 'an edit inside code or math');
  // Applied, the note resolves every reference to the new id, and the
  // `@rn` in code and math is untouched.
  const out = lines.slice();
  for (const e of edits.slice().sort((x, y) => y.range.start.line - x.range.start.line || y.range.start.character - x.range.start.character)) {
    const l = out[e.range.start.line];
    out[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
  }
  const b = analyse(out.join('\n'), file);
  assert.ok(b.ast.data.tern.ids.rank && !b.ast.data.tern.ids.rn);
  const uses = [];
  note.tern.visit(b.ast, (n) => {
    if (n.position && ((n.type === 'ref' && n.id === 'rank') || (n.type === 'link' && n.url === '#rank'))) uses.push(tn(n).resolved);
  });
  assert.deepStrictEqual(uses, [true, true, true, true, true, true], 'every reference resolves to the new id');
  assert.strictEqual((out.join('\n').match(/\$@rn\$|`@rn`|\n@rn\n|@rn = 1/g) || []).length, 5);
});

check('prepareRename and the names rename refuses', async () => {
  const { uri } = refs;
  const p = await c.call('textDocument/prepareRename', { ...doc(uri), position: locate(REFS, 'About @rn', { plus: 7 }) });
  assert.deepStrictEqual(p, { range: { start: locate(REFS, 'About @rn', { plus: 7 }), end: locate(REFS, 'About @rn', { plus: 9 }) }, placeholder: 'rn' });
  for (const bad of ['9x', 'a b', 'a-', 'x:y', 'kernel', '']) {
    const r = await c.send('textDocument/rename', { ...doc(uri), position: locate(REFS, '| @rn', { plus: 3 }), newName: bad });
    assert.ok(r.error, `"${bad}" is refused`);
  }
  const fn = await c.send('textDocument/prepareRename', { ...doc(uri), position: locate(REFS, '[^n]', { plus: 2 }) });
  assert.ok(fn.error && /footnote/.test(fn.error.message), 'a footnote id is generated');
  assert.strictEqual(await c.call('textDocument/prepareRename', { ...doc(uri), position: locate(REFS, 'A paragraph') }), null);
});

check('rename: a container name with its named closer', async () => {
  const { uri } = refs;
  const opener = locate(REFS, ':::theorem', { plus: 3 });
  const closer = locate(REFS, ':::/theorem', { plus: 4 });
  const want = [opener, closer].map((s) => ({ range: { start: s, end: { line: s.line, character: s.character + 7 } }, newText: 'lemma' }));
  for (const at of [opener, { ...closer, character: closer.character + 3 }]) {
    const edit = await c.call('textDocument/rename', { ...doc(uri), position: at, newName: 'lemma' });
    assert.deepStrictEqual(sorted(edit.changes[uri]), sorted(want));
  }
  const r = await c.send('textDocument/rename', { ...doc(uri), position: opener, newName: '1st' });
  assert.ok(r.error, 'a NAME starts with a letter');
});

check('rename: a heading slug gains an explicit id', async () => {
  const { uri } = refs;
  const edit = await c.call('textDocument/rename', { ...doc(uri), position: locate(REFS, '## About', { plus: 4 }), newName: 'about' });
  const end = locate(REFS, '## About @rn', { plus: 12 });
  assert.deepStrictEqual(edit.changes[uri], [{ range: { start: end, end }, newText: ' {#about}' }]);
});

check('definition: from a ref, a fragment link, a footnote reference, a closer', async () => {
  const { uri, a } = refs;
  const go = (needle, opts) => c.call('textDocument/definition', { ...doc(uri), position: locate(REFS, needle, opts) });
  const kernel = a.ast.children.find((n) => n.type === 'heading');
  assert.deepStrictEqual(await go('@kernel', { plus: 2 }), { uri, range: fileRange(a, tn(kernel).idPosition) });
  const rn = { uri, range: { start: locate(REFS, '#rn}'), end: locate(REFS, '#rn}', { plus: 3 }) } };
  assert.deepStrictEqual(await go('(#rn)', { plus: 2 }), rn);
  assert.deepStrictEqual(await go('@rn.', { plus: 1 }), rn);
  const def = await go('[^n]', { plus: 1 });
  assert.deepStrictEqual(def.range.start, locate(REFS, '[^n]:'));
  const opener = await go(':::/theorem', { plus: 6 });
  assert.deepStrictEqual(opener.range, { start: locate(REFS, ':::theorem', { plus: 3 }), end: locate(REFS, ':::theorem', { plus: 10 }) });
  assert.strictEqual(await go('@nowhere', { plus: 2 }), null);
});

check('references: every use, the declaration on request', async () => {
  const { uri } = refs;
  const at = { ...doc(uri), position: locate(REFS, '#rn}', { plus: 1 }) };
  const uses = await c.call('textDocument/references', { ...at, context: { includeDeclaration: false } });
  const all = await c.call('textDocument/references', { ...at, context: { includeDeclaration: true } });
  assert.strictEqual(uses.length, 6);
  assert.strictEqual(all.length, 7);
  assert.ok(uses.every((l) => l.uri === uri));
  const lines = new Set(uses.map((l) => l.range.start.line));
  for (const needle of ['By 😀', '## About', '| @rn', 'Link:', '[^n]: A']) assert.ok(lines.has(locate(REFS, needle).line), needle);
  const k = await c.call('textDocument/references', { ...doc(uri), position: locate(REFS, '## Kernel'), context: { includeDeclaration: false } });
  assert.deepStrictEqual(k.map((l) => l.range.start), [locate(REFS, '@kernel')]);
});

// The engine's reference set again, as highlights: the declaration's `#rn`
// is written (3), each ref's extent and each fragment link's `#rn` read (2).
check('documentHighlight: an id’s declaration and uses, an element’s name and closer', async () => {
  const { uri, a } = refs;
  const lines = REFS.split('\n');
  const want = [];
  note.tern.visit(a.ast, (n) => {
    if (!n.position) return false;
    const r = fileRange(a, n.position);
    if (n.type === 'ref' && n.id === 'rn') want.push({ range: r, kind: 2 });
    if (n.type === 'link' && n.url === '#rn') {
      const k = lines[r.start.line].indexOf('#rn', r.start.character);
      want.push({ range: { start: { line: r.start.line, character: k }, end: { line: r.start.line, character: k + 3 } }, kind: 2 });
    }
    if (n.attributes && n.attributes.id === 'rn') want.push({ range: fileRange(a, tn(n).idPosition), kind: 3 });
  });
  assert.strictEqual(want.length, 7, 'four references, two fragment links, one declaration');
  const hl = (needle, opts) => c.call('textDocument/documentHighlight', { ...doc(uri), position: locate(REFS, needle, opts) });
  for (const [needle, opts] of [['#rn}', { plus: 1 }], ['| @rn', { plus: 3 }], ['the theorem]', {}], ['(<#rn>', { plus: 3 }]]) {
    const got = await hl(needle, opts);
    assert.deepStrictEqual(sorted(got), sorted(want), `from ${needle}`);
    assert.strictEqual(got[0].kind, 3, 'the declaration first');
  }
  const name = (s, n) => ({ start: s, end: { line: s.line, character: s.character + n } });
  const theorem = [
    { range: name(locate(REFS, ':::theorem', { plus: 3 }), 7), kind: 3 },
    { range: name(locate(REFS, ':::/theorem', { plus: 4 }), 7), kind: 2 },
  ];
  assert.deepStrictEqual(await hl(':::/theorem', { plus: 5 }), theorem);
  assert.deepStrictEqual(await hl(':::theorem', { plus: 5 }), theorem);
  assert.deepStrictEqual(await hl('@nowhere', { plus: 1 }), [{ range: name(locate(REFS, '@nowhere'), 8), kind: 2 }], 'a dangling reference: its uses');
  assert.strictEqual(await hl('A paragraph'), null);
  // The capability, from a server of its own.
  const other = new Client();
  const r = await other.call('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  assert.strictEqual(r.capabilities.documentHighlightProvider, true);
  other.proc.kill();
});

check('hover: label, title, kind and file line', async () => {
  const { uri } = refs;
  const h = await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, '| @rn', { plus: 3 }) });
  const line = locate(REFS, ':::theorem').line + 1;
  assert.ok(h.contents.value.includes('Theorem 1 — Rank–nullity'), h.contents.value);
  assert.ok(h.contents.value.includes('theorem') && h.contents.value.includes(`line ${line}`), h.contents.value);
  assert.deepStrictEqual(h.range, { start: locate(REFS, '| @rn', { plus: 2 }), end: locate(REFS, '| @rn', { plus: 5 }) });
  const eq = await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, '@eq', { plus: 1 }) });
  assert.ok(eq.contents.value.includes('(1)'), eq.contents.value);
  const head = await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, '@kernel', { plus: 1 }) });
  assert.ok(head.contents.value.includes('Kernel') && head.contents.value.includes('heading'), head.contents.value);
  assert.strictEqual(await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, 'A paragraph') }), null);
});

check('completion: names by level, closers, ids; never in code or math', async () => {
  const file = path.join(DIR, 'complete.html');
  const { uri } = await c.open(file, COMPLETE);
  const labels = async (needle, opts) => (await c.call('textDocument/completion', { ...doc(uri), position: locate(COMPLETE, needle, opts) })).map((i) => i.label);
  const ids = await c.call('textDocument/completion', { ...doc(uri), position: locate(COMPLETE, 'See @', { plus: 5 }) });
  const t1 = ids.find((i) => i.label === 't1');
  assert.ok(t1 && t1.detail === 'Theorem 1 — T', JSON.stringify(t1));
  assert.deepStrictEqual(t1.textEdit.range, { start: locate(COMPLETE, 'See @', { plus: 5 }), end: locate(COMPLETE, 'See @', { plus: 5 }) });
  const leaf = await labels('\n::\n', { plus: 3 });
  assert.ok(leaf.includes('toc') && leaf.includes('video') && !leaf.includes('theorem'), 'leaf names');
  const inline = await labels('Press :', { plus: 7 });
  assert.ok(inline.includes('hl') && inline.includes('kbd') && !inline.includes('section'), 'inline names');
  const block = await labels('\n:::\n', { plus: 4 });
  for (const n of ['theorem', 'proof', 'section', 'details', 'meta', 'macros', '/theorem']) assert.ok(block.includes(n), `:::${n}`);
  assert.deepStrictEqual(await labels(':::/', { plus: 4 }), ['/theorem']);
  assert.ok((await labels('(#', { plus: 2 })).includes('t1'), 'ids in a fragment link');
  assert.deepStrictEqual(await labels('```js\n@', { plus: 7 }), [], 'in a fence');
  assert.deepStrictEqual(await labels('$x @', { plus: 4 }), [], 'in math');
  assert.deepStrictEqual(await labels('`x @', { plus: 4 }), [], 'in a code span');
});

check('documentSymbol: headings by depth, containers and leaves', async () => {
  const { uri } = refs;
  const syms = await c.call('textDocument/documentSymbol', doc(uri));
  const names = (list) => list.map((s) => s.name);
  assert.deepStrictEqual(names(syms), ['meta', 'Kernel', 'About Theorem 1']);
  const [, kernel, about] = syms;
  assert.deepStrictEqual(names(kernel.children), ['Theorem 1 — Rank–nullity']);
  assert.strictEqual(kernel.children[0].detail, ':::theorem #rn');
  assert.deepStrictEqual(names(about.children), ['Proof', 'toc']);
  assert.strictEqual(kernel.range.end.line, locate(REFS, ':::/theorem').line, 'a section ends at its last block');
  assert.strictEqual(about.range.end.line, locate(REFS, '::toc').line);
});

check('foldingRange: blocks and heading sections', async () => {
  const { uri } = refs;
  const folds = (await c.call('textDocument/foldingRange', doc(uri))).map((f) => `${f.startLine}-${f.endLine}`);
  const L = (needle, nth) => locate(REFS, needle, { nth }).line;
  const want = {
    theorem: `${L(':::theorem')}-${L(':::/theorem')}`,
    table: `${L('| Name')}-${L('| @rn')}`,
    fence: `${L('```js')}-${L('```', 1)}`,
    math: `${L('$$\n')}-${L('$$ {#eq}')}`,
    proof: `${L(':::proof')}-${L(':::\n', 1)}`,
    kernel: `${L('## Kernel')}-${L(':::/theorem')}`,
    about: `${L('## About')}-${L('::toc')}`,
  };
  for (const k in want) assert.ok(folds.includes(want[k]), `${k} ${want[k]} in ${folds}`);
});

// The client paces its changes (Neovim sends one every 150 ms at most), so
// the server does not wait for a quiet spell on top of it.
check('didChange: a change after a pause is analysed at once; while changes keep coming, an analysis every 150 ms at most, of the text as it is then, and the last text is analysed', async () => {
  const file = path.join(DIR, 'pace.html');
  const head = '<script src="tern.js"></script>\n';
  const text = (v) => `${head}# Fine\n\n${':::proof\n'.repeat(v - 1)}`; // version v has v - 1 unclosed blocks
  const change = (v) => c.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text: text(v) }] });
  const unclosed = (p) => p.diagnostics.filter((d) => d.code === 'block.unclosed').length;
  const { uri } = await c.open(file, text(1));
  await c.outline(uri);
  await new Promise((r) => setTimeout(r, 200));
  const sent = Date.now();
  change(2);
  const one = await c.published(uri);
  assert.strictEqual(one.version, 2);
  assert.ok(Date.now() - sent < 120, `published ${Date.now() - sent} ms after a change that came after a pause`);
  await c.outline(uri);
  // Twenty changes, 30 ms apart, for 600 ms.
  await new Promise((r) => setTimeout(r, 200));
  const mark = c.log.length;
  for (let v = 3; v <= 22; v++) {
    if (v > 3) await new Promise((r) => setTimeout(r, 30));
    change(v);
  }
  const seen = [];
  while (!seen.length || seen[seen.length - 1].version !== 22) seen.push(await c.published(uri));
  while ((await c.outline(uri)).version !== 22);
  await new Promise((r) => setTimeout(r, 250));
  const all = c.log.slice(mark).filter((m) => m.msg.params.uri === uri && m.msg.method === 'textDocument/publishDiagnostics').map((m) => m.msg.params);
  const versions = all.map((p) => p.version);
  assert.strictEqual(all.length, seen.length, `nothing after the last text: ${versions}`);
  assert.ok(all.length >= 3 && all.length <= 7, `published while the changes came, every 150 ms at most: versions ${versions}`);
  assert.deepStrictEqual(versions, [...versions].sort((a, b) => a - b), 'in order');
  for (const p of all) assert.strictEqual(unclosed(p), p.version - 1, `version ${p.version}: the text as it was then`);
});

check('a non-note .html file gets no diagnostics and no outline', async () => {
  const file = path.join(DIR, 'page.html');
  const { uri, diagnostics } = await c.open(file, '<!doctype html>\n<p>Hello @x and :::nope</p>\n<script src="app.js"></script>\n');
  assert.deepStrictEqual(diagnostics, []);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!c.log.some((m) => m.msg.method === 'tern/outline' && m.msg.params.uri === uri));
  assert.deepStrictEqual(await c.call('textDocument/documentSymbol', doc(uri)), []);
  assert.strictEqual(await c.call('textDocument/hover', { ...doc(uri), position: { line: 1, character: 10 } }), null);
});

check('add-ons are cached by mtime and reloaded when they change', async () => {
  const uri = pathToFileURL(path.join(DIR, 'complete.html')).href;
  const at = { ...doc(uri), position: locate(COMPLETE, '\n:::\n', { plus: 4 }) };
  assert.ok(!(await c.call('textDocument/completion', at)).some((i) => i.label === 'remark'));
  writeAddon("tern.block('remark', {});");
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(ADDON, t, t);
  c.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: COMPLETE }] });
  await c.published(uri); // the answer comes from the last analysis, so wait for the change's
  assert.ok((await c.call('textDocument/completion', at)).some((i) => i.label === 'remark'));
});

// The sandbox's asynchronous bridge: a note whose script never returns does
// not stop the server answering, from its last analysis; the vocabulary of
// that analysis stands in for the stuck one, until the head or an add-on
// changes; a change made while an analysis runs is analysed after it.
check('a stuck script: requests are answered meanwhile, the last vocabulary is kept until the head or add-ons change, a change during the analysis is analysed after it', async () => {
  fs.writeFileSync(path.join(DIR, 'slow.js'), "tern.block('theorem', { tag: 'section', counter: 'theorem', label: 'Theorem' });\ntern.transform('slow', function (ast) { if (JSON.stringify(ast).includes('SLOW')) for (;;) {} });\n");
  const HEAD = '<script src="tern.js" data-use="slow.js"></script>\n';
  const A = `${HEAD}:::theorem[T]{#t1}\nx\n:::\n\nSee @t1.\n:::\n`;
  const B = `${A}SLOW\n`;
  const C = `<title>changed head</title>\n${B}`;
  const file = path.join(DIR, 'slow.html');
  const { uri, diagnostics } = await c.open(file, A);
  assert.deepStrictEqual(diagnostics.map((d) => d.code), ['block.stray-closer']);
  const hover = async (text) => (await c.call('textDocument/hover', { ...doc(uri), position: locate(text, '@t1', { plus: 1 }) })).contents.value;
  const names = async (text) => (await c.call('textDocument/completion', { ...doc(uri), position: locate(text, '\n:::\n', { plus: 4 }) })).filter((i) => i.label === 'theorem').map((i) => i.detail);
  assert.ok((await hover(A)).includes('Theorem 1 — T'));
  assert.deepStrictEqual(await names(A), ['schema → <section>']);

  // B's transform spins until the sandbox cuts it off (2 s): hover answers
  // at once meanwhile, from A's analysis.
  c.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: B }] });
  await new Promise((r) => setTimeout(r, 200)); // the analysis runs
  const t0 = Date.now();
  assert.ok((await hover(B)).includes('Theorem 1 — T'), 'answered from the last analysis');
  assert.ok(Date.now() - t0 < 1000, `answered while the script ran (${Date.now() - t0} ms)`);
  // C, sent while B's analysis runs, is analysed after it: B's publication
  // keeps A's vocabulary (the head and the add-on are the same), C's does
  // not (its head changed).
  c.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: C }] });
  const b = await c.published(uri);
  assert.strictEqual(b.version, 2);
  assert.deepStrictEqual(b.diagnostics.map((d) => d.code), ['addon.failed', 'block.stray-closer']);
  assert.ok(b.diagnostics[0].message.includes('did not finish in 2 s') && b.diagnostics[0].message.includes('its vocabulary is kept from its last analysis'), b.diagnostics[0].message);
  assert.deepStrictEqual(await names(C), ['schema → <section>'], 'the vocabulary kept: the names are known (the trigger read from the text as it is, C)');
  const cc = await c.published(uri);
  assert.strictEqual(cc.version, 3);
  assert.ok(cc.diagnostics[0].code === 'addon.failed' && cc.diagnostics[0].message.includes('its vocabulary and transforms are missing'), cc.diagnostics[0].message);
  assert.deepStrictEqual(await names(C), [], 'the head changed: nothing stands in');
  // Back to a note that runs: the vocabulary is its own again.
  c.notify('textDocument/didChange', { textDocument: { uri, version: 4 }, contentChanges: [{ text: A }] });
  assert.deepStrictEqual((await c.published(uri)).diagnostics.map((d) => d.code), ['block.stray-closer']);
  assert.deepStrictEqual(await names(A), ['schema → <section>']);
  c.notify('textDocument/didClose', doc(uri));
  await c.published(uri);
});

// Between a keystroke and the next analysis, completion reads the trigger
// from the text as it is and answers from the last analysis; a rename waits
// for the analysis, since its edits must match the text.
check('before the next analysis: completion from the text as it is, a rename after the analysis', async () => {
  const file = path.join(DIR, 'typing.html');
  const A = '<script src="tern.js" data-use="addon.js"></script>\n:::theorem[T]{#t1}\nx\n:::\n\nSee @t1.\n';
  const { uri } = await c.open(file, A);
  await c.outline(uri);
  // Two lines typed at the top, then `@` on a new last line: the ids come
  // from the last analysis, the range from the text as it is.
  const B = `Intro.\n\n${A}Also @`;
  c.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: B }] });
  const at = locate(B, 'Also @', { plus: 6 });
  const items = await c.call('textDocument/completion', { ...doc(uri), position: at });
  const t1 = items.find((i) => i.label === 't1');
  assert.ok(t1, 'the id of the last analysis');
  assert.deepStrictEqual(t1.textEdit.range, { start: at, end: at }, 'the range on the text as it is');
  // The rename's edits are at the new lines: it waited for the analysis.
  const edit = await c.call('textDocument/rename', { ...doc(uri), position: locate(B, 'See @t1', { plus: 5 }), newName: 'first' });
  assert.deepStrictEqual(
    sorted(edit.changes[uri].map((e) => e.range.start)),
    sorted([locate(B, '{#t1}', { plus: 2 }), locate(B, 'See @t1', { plus: 5 })]),
  );
  assert.strictEqual((await c.published(uri)).version, 2);
  c.notify('textDocument/didClose', doc(uri));
  await c.published(uri);
});

// A head script before the tern.js line declares the note's vocabulary.
const theorem = (label, more = '') =>
  `<!doctype html><meta charset="utf-8">
<script>
window.TERN = { schema: { block: { theorem: { tag: 'section', counter: 'theorem', label: '${label}', ref: '{label} {n}' }${more} } } };
</script>
<script src="tern.js"></script>
:::theorem[Main]{#main}
Body.
:::

See @main.
`;

check('a single-file note declares its vocabulary in window.TERN.schema', async () => {
  const file = path.join(DIR, 'single.html');
  const SINGLE = theorem('Theorem');
  const { uri, diagnostics } = await c.open(file, SINGLE);
  assert.deepStrictEqual(diagnostics, [], 'no head.script, addon.failed or name noise');
  assert.deepStrictEqual(analyse(SINGLE, file).diagnostics, []);
  const names = async (text) => (await c.call('textDocument/completion', { ...doc(uri), position: locate(text, '\n:::\n', { plus: 4 }) })).filter((i) => i.detail.startsWith('schema'));
  assert.deepStrictEqual((await names(SINGLE)).map((i) => [i.label, i.detail]), [['theorem', 'schema → <section>']]);
  const hover = async (text) => (await c.call('textDocument/hover', { ...doc(uri), position: locate(text, '@main', { plus: 2 }) })).contents.value;
  assert.ok((await hover(SINGLE)).includes('Theorem 1 — Main'), await hover(SINGLE));
  // A didChange to the head script changes the vocabulary.
  const NEXT = theorem('Satz', ", lemma: { counter: 'theorem', label: 'Lemma' }");
  c.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: NEXT }] });
  assert.deepStrictEqual((await c.published(uri)).diagnostics, []); // the answers come from the last analysis: wait for the change's
  assert.ok((await hover(NEXT)).includes('Satz 1 — Main'), await hover(NEXT));
  assert.deepStrictEqual((await names(NEXT)).map((i) => i.label), ['theorem', 'lemma']);
  // A local head script is stamped like an add-on: an edit on disk is seen.
  const VOCAB = path.join(DIR, 'vocab.js');
  fs.writeFileSync(VOCAB, "window.TERN = { schema: { block: { claim: { label: 'Claim' } } } };");
  const SRC = '<script src="vocab.js"></script>\n<script src="tern.js"></script>\n:::claim\nx\n:::\n';
  const src = await c.open(path.join(DIR, 'single-src.html'), SRC);
  const labels = async () => (await c.call('textDocument/completion', { ...doc(src.uri), position: locate(SRC, '\n:::\n', { plus: 4 }) })).map((i) => i.label);
  assert.ok((await labels()).includes('claim') && !(await labels()).includes('axiom'));
  fs.writeFileSync(VOCAB, "window.TERN = { schema: { block: { claim: { label: 'Claim' }, axiom: {} } } };");
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(VOCAB, t, t);
  c.notify('textDocument/didChange', { textDocument: { uri: src.uri, version: 2 }, contentChanges: [{ text: SRC }] });
  await c.published(src.uri);
  assert.ok((await labels()).includes('axiom'));
});

// An add-on's tern.transform runs for its own note, on every analysis (the
// add-ons are cached), and never for another note in the same process; the
// label language is data-lang's, as in tern.js; a remote add-on is an info.
check('add-on transforms run for their note only; data-lang sets the label language; a remote add-on is addon.remote', async () => {
  fs.writeFileSync(path.join(DIR, 'stamp.js'), "tern.transform('stamp', (ast, ctx) => ctx.report('stamp.ran', ast.children[0], `stamped in ${ctx.lang}`, null, 'info'));\n");
  const A = `<!doctype html><meta charset="utf-8"><script>window.TERN = { lang: 'fr', schema: { block: { theorem: { counter: 'theorem', label: { de: 'Satz', fr: 'Théorème', en: 'Theorem' } } } } };</script>
<script src="tern.js" data-lang="de" data-use="stamp.js https://cdn.example/remote.js"></script>
:::theorem{#t}
x
:::

See @t.
`;
  const B = A.replace(' data-use="stamp.js https://cdn.example/remote.js"', '');
  const fa = path.join(DIR, 'stamped.html');
  const a = await c.open(fa, A);
  assert.deepStrictEqual(a.diagnostics, analyse(A, fa).diagnostics.map(expected));
  assert.deepStrictEqual(
    a.diagnostics.map((d) => [d.code, d.severity, d.range.start.line, d.message]),
    [
      ['addon.remote', 3, 1, 'the add-on https://cdn.example/remote.js is not loaded under node; names it declares are unknown to tern check'],
      ['stamp.ran', 3, 2, 'stamped in de'],
    ],
  );
  const b = await c.open(path.join(DIR, 'unstamped.html'), B);
  assert.deepStrictEqual(b.diagnostics, [], 'the other note gets no stamp');
  c.notify('textDocument/didChange', { textDocument: { uri: a.uri, version: 2 }, contentChanges: [{ text: `${A}\nMore.\n` }] });
  assert.ok((await c.published(a.uri)).diagnostics.some((d) => d.code === 'stamp.ran'), 'the cached add-on’s transform runs again');
  const hover = (await c.call('textDocument/hover', { ...doc(b.uri), position: locate(B, '@t', { plus: 1 }) })).contents.value;
  assert.ok(hover.includes('Satz 1'), hover);
});

check('links between files: checked as tern check does; an open document wins over its file, an open file exists, other notes are checked again', async () => {
  const L = path.join(DIR, 'links');
  fs.mkdirSync(L, { recursive: true });
  const B = '<script src="../tern.js"></script>\n# B\n\n:::div{#known}\nx\n:::\n';
  fs.writeFileSync(path.join(L, 'b.html'), B);
  const A = '<script src="../tern.js"></script>\n# A\n\n[known](b.html#known), [later](b.html#later), [new](new.html).\n';
  const fa = path.join(L, 'a.html');
  const a = await c.open(fa, A);
  const codes = (list) => list.map((d) => [d.code, d.message]);
  assert.deepStrictEqual(codes(a.diagnostics), [
    ['link.dangling', 'b.html has no element with the id later\ncheck the id after #: ids are case-sensitive'],
    ['link.missing', 'new.html does not exist\nfix the path: it resolves from the folder of this note'],
  ]);
  assert.deepStrictEqual(a.diagnostics, analyse(A, fa).diagnostics.map(expected), 'what tern check reports');
  const later = locate(A, '[later]');
  assert.deepStrictEqual(a.diagnostics[0].range, { start: later, end: locate(A, ', [new]') }, 'the range spans the link');

  // b.html opened with an unsaved #later: a.html is published again without its warning.
  const b = await c.open(path.join(L, 'b.html'), B.replace('{#known}', '{#known}\n:::\n\n:::div{#later}\ny'));
  assert.deepStrictEqual(b.diagnostics, []);
  assert.deepStrictEqual(codes((await c.published(a.uri)).diagnostics).map(([k]) => k), ['link.missing'], 'b.html’s text, not its file');
  // An edit to b.html that drops #known.
  c.notify('textDocument/didChange', { textDocument: { uri: b.uri, version: 2 }, contentChanges: [{ text: B.replace('#known', '#gone') }] });
  assert.deepStrictEqual(codes((await c.published(a.uri)).diagnostics).map(([k, m]) => (k === 'link.dangling' ? m.split('\n')[0] : k)), ['b.html has no element with the id known', 'b.html has no element with the id later', 'link.missing']);
  // new.html open, never saved: it exists. Closed: it does not.
  const n = await c.open(path.join(L, 'new.html'), '<script src="../tern.js"></script>\n# New\n');
  assert.deepStrictEqual(n.diagnostics, []);
  assert.ok(!(await c.published(a.uri)).diagnostics.some((d) => d.code === 'link.missing'), 'an open file exists');
  c.notify('textDocument/didClose', doc(n.uri));
  assert.deepStrictEqual((await c.published(n.uri)).diagnostics, [], 'cleared on close');
  assert.ok((await c.published(a.uri)).diagnostics.some((d) => d.code === 'link.missing'), 'closed, never saved: missing again');
  // Written to disk by something else; the next save is when the server looks.
  fs.writeFileSync(path.join(L, 'new.html'), '<script src="../tern.js"></script>\n# New\n');
  c.notify('textDocument/didSave', doc(b.uri));
  assert.ok(!(await c.published(a.uri)).diagnostics.some((d) => d.code === 'link.missing'), 'on disk now');
  c.notify('textDocument/didClose', doc(b.uri));
  await c.published(b.uri);
  assert.deepStrictEqual(codes((await c.published(a.uri)).diagnostics).map(([k]) => k), ['link.dangling'], 'b.html closed: its file again, which has #known');
  c.notify('textDocument/didClose', doc(a.uri));
  await c.published(a.uri);

  // An untitled document has no folder, so no link is checked.
  const u = 'untitled:Untitled-1';
  c.notify('textDocument/didOpen', { textDocument: { uri: u, languageId: 'html', version: 1, text: '<script src="tern.js"></script>\n[x](nope.html)\n' } });
  assert.deepStrictEqual((await c.published(u)).diagnostics, []);
  c.notify('textDocument/didClose', doc(u));
  await c.published(u);
});

check('willRenameFiles: tern mv’s edits, for the files where they are; the workspace folders, else the moved file’s folder', async () => {
  const W = path.join(DIR, 'workspace');
  const files = {
    'tern.js': '',
    'notes/b.html': '<script src="../tern.js"></script>\n# B\n\n[a](a.html), ![k](img/k.svg)\n',
    'notes/img/k.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'other/c.html': '<!doctype html>\r\n<script src="../tern.js"></script>\r\n# C\r\n\r\n[b](../notes/b.html#top) and <a href=\'../notes/b.html\'>b</a>\r\n',
    'other/based.html': '<base href="/">\n<script src="../tern.js"></script>\n[b](../notes/b.html)\n',
    'other/plain.html': '<p><a href="../notes/b.html">not a note</a>\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(W, rel)), { recursive: true });
    fs.writeFileSync(path.join(W, rel), text);
  }
  const A = '<script src="../tern.js"></script>\n# A\n\n🙂 [b](b.html) [unsaved](<b.html#top>)\n';
  const fa = path.join(W, 'notes', 'a.html');
  fs.writeFileSync(fa, '<script src="../tern.js"></script>\n# A\n');
  const w = new Client();
  await w.call('initialize', { processId: process.pid, rootUri: null, workspaceFolders: [{ uri: pathToFileURL(W).href, name: 'w' }], capabilities: {} });
  w.notify('initialized', {});
  const a = await w.open(fa, A);
  const uri = (rel) => pathToFileURL(path.join(W, rel)).href;
  const rename = (from, to) => w.call('workspace/willRenameFiles', { files: [{ oldUri: uri(from), newUri: uri(to) }] });
  // The result, applied: each file's text as tern mv writes it.
  const after = (edit) => {
    const out = {};
    for (const [u, edits] of Object.entries(edit.changes)) out[path.relative(W, fileURLToPath(u)).split(path.sep).join('/')] = applyEdits(u === a.uri ? A : fs.readFileSync(fileURLToPath(u), 'utf8'), edits);
    return out;
  };

  const edit = await rename('notes/b.html', 'notes/sub/b2.html');
  assert.deepStrictEqual(after(edit), {
    'notes/a.html': A.replace('(b.html)', '(sub/b2.html)').replace('<b.html#top>', '<sub/b2.html#top>'),
    'notes/b.html': files['notes/b.html'].replace('../tern.js', '../../tern.js').replace('(a.html)', '(../a.html)').replace('(img/k.svg)', '(../img/k.svg)'),
    'other/c.html': files['other/c.html'].replace('../notes/b.html#top', '../notes/sub/b2.html#top').replace("'../notes/b.html'", "'../notes/sub/b2.html'"),
  });
  assert.deepStrictEqual(edit.changes[a.uri][0].range, { start: locate(A, 'b.html'), end: locate(A, 'b.html', { plus: 6 }) }, 'the open note’s text, UTF-16 columns');
  const told = await w.next((m) => m.method === 'window/showMessage');
  assert.strictEqual(told.params.type, 2);
  assert.strictEqual(told.params.message, 'tern: other/based.html has a <base href>, so its URLs do not resolve from its folder; they are left as they are');

  const folder = await w.call('workspace/willRenameFiles', { files: [{ oldUri: `${uri('notes')}/`, newUri: `${uri('docs')}/` }] });
  assert.deepStrictEqual(Object.keys(after(folder)), ['other/c.html'], 'a folder, its URI ending in /: the links into it; those inside it hold');
  assert.strictEqual(await rename('other/plain.html', 'other/plain2.html'), null, 'nothing links to it');
  assert.strictEqual(await w.call('workspace/willRenameFiles', { files: [{ oldUri: 'untitled:x', newUri: uri('x.html') }] }, null), null);
  await w.next((m) => m.method === 'window/showMessage'); // the <base> note again, for the folder
  w.proc.kill();

  // No workspace: the moved file's repository, else its folder.
  const M = path.join(DIR, 'moved');
  fs.mkdirSync(M, { recursive: true });
  fs.writeFileSync(path.join(M, 'x.html'), '<script src="../tern.js"></script>\n# X\n');
  fs.writeFileSync(path.join(M, 'y.html'), '<script src="../tern.js"></script>\n[x](x.html)\n');
  const r = await c.call('workspace/willRenameFiles', { files: [{ oldUri: pathToFileURL(path.join(M, 'x.html')).href, newUri: pathToFileURL(path.join(M, 'z.html')).href }] });
  assert.deepStrictEqual(r, { changes: { [pathToFileURL(path.join(M, 'y.html')).href]: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } }, newText: 'z.html' }] } });

  // A file made, renamed or deleted: the open notes' links are checked again.
  const y = await c.open(path.join(M, 'y.html'), '<script src="../tern.js"></script>\n[x](x.html) [new](new.html)\n');
  assert.deepStrictEqual(y.diagnostics.map((d) => d.code), ['link.missing']);
  fs.writeFileSync(path.join(M, 'new.html'), '');
  c.notify('workspace/didCreateFiles', { files: [{ uri: pathToFileURL(path.join(M, 'new.html')).href }] });
  assert.deepStrictEqual((await c.published(y.uri)).diagnostics, [], 'didCreateFiles');
  fs.renameSync(path.join(M, 'x.html'), path.join(M, 'z.html'));
  c.notify('workspace/didRenameFiles', { files: [{ oldUri: pathToFileURL(path.join(M, 'x.html')).href, newUri: pathToFileURL(path.join(M, 'z.html')).href }] });
  assert.deepStrictEqual((await c.published(y.uri)).diagnostics.map((d) => d.code), ['link.missing'], 'didRenameFiles');
  c.notify('textDocument/didClose', doc(y.uri));
  await c.published(y.uri);
});

// Workspace-wide requests read every note of the workspace; what they make
// of one, its URLs (cli/links.js urls()) and its outline, is kept with its
// analysis, so a second request over notes that have not changed makes
// neither again. A preload counts the server's calls of tern.visit (urls()
// walks the tree) and tern.outline, in a file, written before the response.
check("workspace: a second references or workspace/symbol request makes no unchanged note's URLs or outline again; an edited note's are made anew", async () => {
  const W = path.join(DIR, 'kept');
  const N = 6;
  const text = (i, more = '') => `<script src="tern.js"></script>\n# Note ${i} {#n${i}}\n\nSee [zero](n0.html#n0) and [next](n${(i + 1) % N}.html).${more}\n`;
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, 'tern.js'), '');
  for (let i = 0; i < N; i++) fs.writeFileSync(path.join(W, `n${i}.html`), text(i));
  const LOG = path.join(DIR, 'kept-calls.txt');
  const PRELOAD = path.join(DIR, 'kept-count.js');
  fs.writeFileSync(LOG, '');
  fs.writeFileSync(PRELOAD, `const fs = require('fs');\nconst tern = require(${JSON.stringify(path.join(__dirname, '..', 'tern.js'))});\nfor (const k of ['visit', 'outline']) {\n  const f = tern[k];\n  tern[k] = function () {\n    fs.appendFileSync(${JSON.stringify(LOG)}, k + '\\n');\n    return f.apply(this, arguments);\n  };\n}\n`);
  const calls = () => {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    return { visit: lines.filter((l) => l === 'visit').length, outline: lines.filter((l) => l === 'outline').length };
  };
  const w = new Client({ preload: PRELOAD });
  await w.call('initialize', { processId: process.pid, rootUri: null, workspaceFolders: [{ uri: pathToFileURL(W).href, name: 'w' }], capabilities: {} });
  w.notify('initialized', {});
  const z = await w.open(path.join(W, 'n0.html'), text(0));
  const refs = () => w.call('textDocument/references', { ...doc(z.uri), position: locate(text(0), '{#n0}', { plus: 2 }), context: { includeDeclaration: false } });
  const symbols = () => w.call('workspace/symbol', { query: 'Note' });
  const first = await refs();
  assert.strictEqual(first.length, N, 'a link to #n0 in every note');
  let was = calls();
  assert.ok(was.visit >= N, `the first request makes every note's URLs: ${JSON.stringify(was)}`);
  assert.deepStrictEqual(sorted(await refs()), sorted(first), 'the second references request');
  assert.deepStrictEqual(calls(), was, 'the second references request made no URLs');
  const s1 = await symbols();
  assert.strictEqual(s1.length, N, 'a heading in every note');
  was = calls();
  assert.deepStrictEqual(await symbols(), s1, 'the second workspace/symbol request');
  assert.deepStrictEqual(calls(), was, 'the second workspace/symbol request made no outline');
  // An edit: the edited note's URLs and outline are made anew, and only its.
  // What making its URLs takes is counted here, on the same text; the server
  // has finished with the analysis once it answers a request after it.
  const edited = text(0, ' Again [here](#n0) and [zero](n0.html#n0).');
  const engine = require('../tern.js');
  const visit = engine.visit;
  let one = 0;
  engine.visit = function () {
    one++;
    return visit.apply(this, arguments);
  };
  try {
    links.urls(links.parsed(edited));
  } finally {
    engine.visit = visit;
  }
  w.notify('textDocument/didChange', { textDocument: { uri: z.uri, version: 2 }, contentChanges: [{ text: edited }] });
  await w.published(z.uri);
  await w.send('tern/none', {});
  was = calls();
  assert.strictEqual((await refs()).length, N + 2, 'the two new links to #n0');
  const after = calls();
  assert.strictEqual(after.visit - was.visit, one, "references after the edit: the edited note's URLs alone");
  assert.strictEqual((await symbols()).length, N);
  assert.strictEqual(calls().outline - after.outline, 1, "workspace/symbol after the edit: the edited note's outline alone");
  w.proc.kill();
});

// Across files: a link `page.html#id` is a reference to the id in that
// file. Definition goes there, references and rename reach every note of
// the workspace that links to the id, and document links say where each
// URL goes. The expectations come from the texts, not from the server.
check('across files: definition, references and rename follow page.html#id; document links', async () => {
  const W = path.join(DIR, 'across');
  const files = {
    'tern.js': '',
    'a.html': '<script src="tern.js" data-use="addon.js"></script>\n# A {#a}\n\nSee [known](b.html#known), [b](b.html), [heading](notes.md#second-part), [plain](plain.html#pid), [me](#a), [out](https://example.org/x#y), [gone](nope.html#z), [root](/r.html#q).\n',
    'b.html': '<script src="tern.js"></script>\n# B\n\n:::div{#known}\nx\n:::\n\nSee @known and [k](#known) and [self](b.html#known).\n',
    'c.html': '<script src="tern.js"></script>\n# C\n\n[c](<b.html#known> "t") and <a href="b.html#known">raw</a> and [other](b.html#other).\n',
    'notes.md': '# First part\n\n## Second part\n\ntext\n',
    'plain.html': '<!doctype html>\n<p><span id="pid">here</span></p>\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(W, rel)), { recursive: true });
    fs.writeFileSync(path.join(W, rel), text);
  }
  fs.copyFileSync(ADDON, path.join(W, 'addon.js'));
  const w = new Client();
  await w.call('initialize', { processId: process.pid, rootUri: null, workspaceFolders: [{ uri: pathToFileURL(W).href, name: 'w' }], capabilities: {} });
  w.notify('initialized', {});
  const uri = (rel) => pathToFileURL(path.join(W, rel)).href;
  const A = files['a.html'];
  const B = files['b.html'];
  const C = files['c.html'];
  const a = await w.open(path.join(W, 'a.html'), A);
  assert.deepStrictEqual(a.diagnostics.map((d) => d.code), ['link.missing'], 'only nope.html is missing');
  const go = (needle, opts) => w.call('textDocument/definition', { ...doc(a.uri), position: locate(A, needle, opts) });
  // Definition: the id's declaration in b.html, b.html's first line, the Markdown heading, the plain file's id attribute.
  assert.deepStrictEqual(await go('b.html#known', { plus: 8 }), { uri: uri('b.html'), range: { start: locate(B, '#known}'), end: locate(B, '#known}', { plus: 6 }) } });
  assert.deepStrictEqual(await go('[b](b.html)', { plus: 5 }), { uri: uri('b.html'), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
  assert.deepStrictEqual(await go('notes.md#second-part', { plus: 12 }), { uri: uri('notes.md'), range: { start: { line: 2, character: 0 }, end: { line: 2, character: 14 } } });
  assert.deepStrictEqual(await go('plain.html#pid', { plus: 12 }), { uri: uri('plain.html'), range: { start: { line: 1, character: 3 }, end: { line: 1, character: 17 } } });
  assert.strictEqual(await go('nope.html#z', { plus: 10 }), null, 'a missing file');
  assert.strictEqual(await go('/r.html#q', { plus: 8 }), null, 'a root-relative URL is not resolved');
  assert.strictEqual(await go('example.org', { plus: 3 }), null);

  // References of #known: from the link in a.html, and from the declaration in b.html, the same set.
  const frag = (text, rel, needle, nth = 0) => ({ uri: uri(rel), range: { start: locate(text, needle, { nth, plus: needle.indexOf('#') + 1 }), end: locate(text, needle, { nth, plus: needle.length }) } });
  const want = sorted([
    { uri: uri('b.html'), range: { start: locate(B, '@known'), end: locate(B, '@known', { plus: 6 }) } },
    { uri: uri('b.html'), range: { start: locate(B, '[k](#known)'), end: locate(B, '[k](#known)', { plus: 11 }) } },
    frag(B, 'b.html', 'b.html#known'),
    frag(A, 'a.html', 'b.html#known'),
    frag(C, 'c.html', 'b.html#known', 0),
    frag(C, 'c.html', 'b.html#known', 1),
  ]);
  const refs = await w.call('textDocument/references', { ...doc(a.uri), position: locate(A, 'b.html#known', { plus: 9 }), context: { includeDeclaration: false } });
  assert.deepStrictEqual(sorted(refs), want, 'from the link');
  const b = await w.open(path.join(W, 'b.html'), B);
  assert.deepStrictEqual(b.diagnostics, []);
  const all = await w.call('textDocument/references', { ...doc(b.uri), position: locate(B, '#known}', { plus: 2 }), context: { includeDeclaration: true } });
  assert.deepStrictEqual(sorted(all), sorted([...want.map((s) => JSON.parse(s)), { uri: uri('b.html'), range: { start: locate(B, '#known}'), end: locate(B, '#known}', { plus: 6 }) } }]), 'from the declaration, with it');

  // Rename from the link in a.html: b.html's declaration and uses, and every fragment, in the files where they are.
  const edit = await w.call('textDocument/rename', { ...doc(a.uri), position: locate(A, 'b.html#known', { plus: 9 }), newName: 'k2' });
  assert.deepStrictEqual(Object.keys(edit.changes).sort(), [uri('a.html'), uri('b.html'), uri('c.html')].sort());
  const after = (rel, text) => applyEdits(text, edit.changes[uri(rel)]);
  assert.strictEqual(after('a.html', A), A.replace('b.html#known', 'b.html#k2'));
  assert.strictEqual(after('b.html', B), B.split('known').join('k2'));
  assert.strictEqual(after('c.html', C), C.split('b.html#known').join('b.html#k2'));
  const checked = analyse(after('b.html', B), path.join(W, 'b.html'));
  assert.ok(checked.ast.data.tern.ids.k2 && !checked.ast.data.tern.ids.known && !checked.diagnostics.some((d) => d.code === 'ref.dangling'), 'b.html renamed consistently');
  // The same from b.html's own reference; a link to a file that is not a note is refused; a dangling fragment has nothing to rename from.
  const fromB = await w.call('textDocument/rename', { ...doc(b.uri), position: locate(B, '@known', { plus: 3 }), newName: 'k2' });
  assert.deepStrictEqual(sorted(Object.entries(fromB.changes).flatMap(([u, es]) => es.map((e) => ({ u, ...e })))), sorted(Object.entries(edit.changes).flatMap(([u, es]) => es.map((e) => ({ u, ...e })))));
  const plain = await w.send('textDocument/rename', { ...doc(a.uri), position: locate(A, 'plain.html#pid', { plus: 12 }), newName: 'x' });
  assert.ok(plain.error && plain.error.code === -32803 && /plain\.html is not a note/.test(plain.error.message), JSON.stringify(plain));
  const cc = await w.open(path.join(W, 'c.html'), C);
  assert.deepStrictEqual(cc.diagnostics.map((d) => d.code), ['link.dangling']);
  assert.strictEqual(await w.call('textDocument/rename', { ...doc(cc.uri), position: locate(C, 'b.html#other', { plus: 9 }), newName: 'x' }), null, 'no such id in b.html');

  // Document links: each URL as written, with where it goes.
  const dl = await w.call('textDocument/documentLink', doc(a.uri));
  const by = Object.fromEntries(dl.map((l) => [A.split('\n')[l.range.start.line].slice(l.range.start.character, l.range.end.character), l.target]));
  assert.deepStrictEqual(by, {
    'tern.js': uri('tern.js'),
    'addon.js': uri('addon.js'),
    'b.html#known': `${uri('b.html')}#known`,
    'b.html': uri('b.html'),
    'notes.md#second-part': `${uri('notes.md')}#second-part`,
    'plain.html#pid': `${uri('plain.html')}#pid`,
    '#a': `${a.uri}#a`,
    'https://example.org/x#y': 'https://example.org/x#y',
  });
  w.proc.kill();
});

// Code actions: the fixes cli/language.js offers for a diagnostic, each a
// quickfix whose edit, applied, removes the diagnostic; and the disk's
// spelling for a link in another case.
check('codeAction: quickfixes for dangling references, undefined footnotes, unclosed blocks and math, opener junk, unknown names and a link’s case', async () => {
  const Q = path.join(DIR, 'fix');
  fs.mkdirSync(Q, { recursive: true });
  fs.writeFileSync(path.join(Q, 'tern.js'), '');
  fs.writeFileSync(path.join(Q, 'Other.html'), '<script src="tern.js"></script>\n# O\n');
  const T = `<script>window.TERN = { schema: { strict: true, block: { theorem: {} }, leaf: {}, inline: { kbd: {} } } };</script><script src="tern.js"></script>
# Kernel {#kernel}

See @kernl, @nowhere, text[^x] and :kdb[x]; [o](other.html).

:::theorm[T] #rn .big
x

$$
y = 2

:::aside
z
:::
`;
  const file = path.join(Q, 'fix.html');
  const { uri, diagnostics } = await c.open(file, T);
  const codes = diagnostics.map((d) => d.code);
  for (const code of ['ref.dangling', 'footnote.undefined', 'name.unknown', 'link.missing', 'block.opener-junk', 'block.unclosed', 'math.unclosed']) assert.ok(codes.includes(code), code);
  const actions = async (d) => c.call('textDocument/codeAction', { ...doc(uri), range: d.range, context: { diagnostics: [d] } });
  const fixed = (action) => applyEdits(T, action.edit.changes[uri]);
  const count = (text, code) => analyse(text, file).diagnostics.filter((d) => d.code === code).length;
  const titles = {};
  for (const d of diagnostics) {
    const list = await actions(d);
    titles[`${d.code} ${d.range.start.line}:${d.range.start.character}`] = list.map((x) => x.title + (x.isPreferred ? ' *' : ''));
    for (const x of list) {
      assert.strictEqual(x.kind, 'quickfix');
      assert.deepStrictEqual(x.diagnostics, [d]);
      assert.strictEqual(count(fixed(x), d.code), count(T, d.code) - 1, `"${x.title}" leaves ${d.code}: ${fixed(x)}`);
    }
  }
  assert.deepStrictEqual(titles, {
    'ref.dangling 3:4': ['Change to @kernel *', 'Write \\@kernl: not a reference'],
    'ref.dangling 3:12': ['Write \\@nowhere: not a reference *'],
    'footnote.undefined 3:26': ['Add the definition [^x]: *'],
    'name.unknown 3:36': ['Change to kbd *'],
    'link.missing 3:44': ['Write it as the disk does: Other.html *'],
    'name.unknown 5:3': ['Change to theorem *'],
    'block.unclosed 5:0': ['Close it with :::/theorm *'],
    'block.opener-junk 5:13': ['Write the attributes in braces: {#rn .big} *'],
    'math.unclosed 8:0': ['Close it with $$ *'],
  });
  // The escape is right when the text is not a reference: no diagnostic, and the text reads @kernl.
  const esc = (await actions(diagnostics[0])).find((x) => x.title.startsWith('Write'));
  assert.ok(fixed(esc).includes('\\@kernl') && count(fixed(esc), 'ref.dangling') === 1, fixed(esc));
  // Without the client's diagnostics, the range picks them; a range with none gets [].
  const byRange = await c.call('textDocument/codeAction', { ...doc(uri), range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } }, context: { diagnostics: [] } });
  assert.deepStrictEqual(byRange.map((x) => x.title), ['Change to @kernel', 'Write \\@kernl: not a reference', 'Write \\@nowhere: not a reference']);
  assert.deepStrictEqual(await c.call('textDocument/codeAction', { ...doc(uri), range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, context: { diagnostics: [] } }), []);
  c.notify('textDocument/didClose', doc(uri));
  await c.published(uri);
});

check('workspace/symbol: headings and blocks with an id or a title, across the workspace’s notes and the open ones', async () => {
  const S = path.join(DIR, 'symbols');
  fs.mkdirSync(path.join(S, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(S, 'tern.js'), '');
  fs.writeFileSync(path.join(S, 'one.html'), '<script src="tern.js"></script>\n# Kernel {#kernel}\n\n:::theorem[Rank–nullity]{#rn}\nx\n:::\n\n::toc\n');
  fs.writeFileSync(path.join(S, 'sub', 'two.html'), '<script src="../tern.js"></script>\n## Kernels again\n\n:::proof{#p1}\ny\n:::\n');
  fs.writeFileSync(path.join(S, 'plain.html'), '<h1>Kernel</h1>\n');
  const w = new Client();
  await w.call('initialize', { processId: process.pid, rootUri: null, workspaceFolders: [{ uri: pathToFileURL(S).href, name: 's' }], capabilities: {} });
  w.notify('initialized', {});
  const names = async (query) => (await w.call('workspace/symbol', { query })).map((s) => `${s.containerName}: ${s.name} (${s.kind}) ${s.location.range.start.line}-${s.location.range.end.line}`).sort();
  assert.deepStrictEqual(await names('kern'), ['one.html: Kernel (15) 1-1', 'sub/two.html: Kernels again (15) 1-1']);
  assert.deepStrictEqual(await names('#p'), ['sub/two.html: proof #p1 (5) 3-5']);
  assert.deepStrictEqual(await names('rank'), ['one.html: Rank–nullity #rn (5) 3-5']);
  assert.deepStrictEqual(await names(''), ['one.html: Kernel (15) 1-1', 'one.html: Rank–nullity #rn (5) 3-5', 'sub/two.html: Kernels again (15) 1-1', 'sub/two.html: proof #p1 (5) 3-5'], 'every symbol; ::toc has neither id nor title; plain.html is not a note');
  // An open note outside the workspace counts, as it is in the editor.
  const o = await w.open(path.join(DIR, 'outside.html'), '<script src="tern.js"></script>\n# Outside {#out}\n');
  assert.ok((await names('outside')).some((s) => s.includes('Outside')));
  const r = (await w.call('workspace/symbol', { query: 'outside' }))[0];
  assert.strictEqual(r.location.uri, o.uri);
  w.proc.kill();
});

check('initializationOptions.noScripts: a note’s own code is not run', async () => {
  // An inline head script turns on strict mode; with it, an unknown block is
  // name.unknown. The default server runs it; a noScripts server does not.
  const text = `<!doctype html><meta charset="utf-8"><script>window.TERN = { schema: { strict: true } };</script><script src="tern.js"></script>\n:::madeup\nx\n:::\n`;
  const d = await c.open(path.join(DIR, 'ns-default.html'), text);
  assert.ok(d.diagnostics.some((x) => x.code === 'name.unknown'), 'default: the inline script runs, strict is on, madeup is unknown');

  const ns = new Client();
  await ns.call('initialize', { processId: process.pid, rootUri: null, capabilities: {}, initializationOptions: { noScripts: true } });
  ns.notify('initialized', {});
  const d2 = await ns.open(path.join(DIR, 'ns-off.html'), text);
  assert.ok(!d2.diagnostics.some((x) => x.code === 'name.unknown'), 'noScripts: the script does not run, so strict is off and madeup is not flagged');
  ns.proc.kill();
});

check('malformed input and unknown documents get errors, not a crash', async () => {
  c.write('{not json');
  const e = await c.next((m) => m.id === null && m.error);
  assert.strictEqual(e.error.code, -32700);
  c.proc.stdin.write('X-Nothing: 1\r\n\r\n');
  c.notify('tern/unknown', {});
  c.notify('textDocument/didChange', { textDocument: { uri: 'file:///never-opened.html', version: 1 }, contentChanges: [{ text: 'x' }] });
  assert.strictEqual((await c.send('tern/unknown', {})).error.code, -32601);
  assert.strictEqual((await c.send('textDocument/hover', { ...doc('file:///never-opened.html'), position: { line: 0, character: 0 } })).error.code, -32602);
  assert.ok((await c.send('textDocument/definition', null)).error);
  assert.ok((await c.send('textDocument/rename', { ...doc(refs.uri), position: { line: 9999, character: 0 } })).result === null);
  assert.ok((await c.call('textDocument/documentSymbol', doc(refs.uri))).length, 'still serving');
  // A request with an id and no method, or a method that is not a string,
  // is answered -32600, so a client does not wait forever; a response, which
  // the server never asked for, is dropped.
  c.write(JSON.stringify({ jsonrpc: '2.0', id: 777 }));
  assert.strictEqual((await c.next((m) => m.id === 777)).error.code, -32600);
  c.write(JSON.stringify({ jsonrpc: '2.0', id: 778, method: 5 }));
  assert.strictEqual((await c.next((m) => m.id === 778)).error.code, -32600);
  c.write(JSON.stringify({ jsonrpc: '2.0', id: 779, result: null }));
  // A didChange with a range, where the server asked for the full text, is
  // logged and ignored: the document keeps its text.
  const before = await c.call('textDocument/documentSymbol', doc(refs.uri));
  c.notify('textDocument/didChange', { textDocument: { uri: refs.uri, version: 99 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, rangeLength: 1, text: 'x' }] });
  await new Promise((r) => setTimeout(r, 250));
  assert.deepStrictEqual(await c.call('textDocument/documentSymbol', doc(refs.uri)), before, 'the text unchanged');
  assert.ok(/1 change\(s\) with a range ignored/.test(c.stderr), 'the range change logged');
});

check('stdout carries only protocol messages', async () => {
  assert.strictEqual(c.garbage, '');
  assert.ok(c.stderr.includes('addon-ran'), 'the add-on’s console.log went to stderr');
});

check('shutdown, then exit with code 0', async () => {
  assert.strictEqual(await c.call('shutdown', null), null);
  assert.strictEqual((await c.send('textDocument/hover', { ...doc(refs.uri), position: { line: 0, character: 0 } })).error.code, -32600);
  c.notify('exit', null);
  const code = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.strictEqual(code, 0);
});

async function main() {
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${name}\n    ${String((e && e.message) || e).split('\n').join('\n    ')}`);
      if (verbose && e && e.stack) console.log(e.stack);
    }
  }
  if (c.proc.exitCode === null) c.proc.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
  if (failed && c.stderr) console.log(`\nserver stderr:\n${c.stderr.replace(/^.*addon-ran.*\n/gm, '')}`);
  console.log(`\n${checks.length - failed}/${checks.length} LSP checks pass`);
  process.exit(failed ? 1 : 0);
}

main();
