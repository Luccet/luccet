// SPDX-License-Identifier: MIT
// What every command needs from a note file: whether a file is a note, where
// the note starts, the add-ons its tern.js line loads, the engine run on it,
// and positions in the file rather than in the note; and where the notes
// under a folder are. Node only.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tern = require('../tern.js');
const sandbox = require('./sandbox');
const { scanUse } = require('../src/use');

// The line that makes an HTML file a note: it holds a <script> that tern.js
// would start from. Published for editors (docs/tools.html#detection) with
// fixtures in test/fixtures/detect.json; editors match it per line,
// case-insensitively. Group 1 is the tag. A line counts when:
//   - a <script> tag on it has a src whose file name is tern.js (any path,
//     any quotes, a query or fragment allowed; not mytern.js, tern.json);
//   - the tag is not inside a comment opened earlier on the line;
//   - it has no async, defer or type=module (tern.js would not capture the
//     note) and no data-built (a page written by `tern build` is not a note).
// The tag must be on one line and hold no < or >; a comment that spans
// lines is not seen. Each attempt stops at the next < or >, so a line costs
// linear time.
const DETECT =
  /^(?:[^<]|<(?!!--)|<!--(?:[^-]|-(?!->))*-->)*?(<script(?=[\s>/])(?![^<>]*\s(?:async|defer|data-built)(?=[\s=>/]|$))(?![^<>]*\stype\s*=\s*["']?module(?=["'\s>/]|$))[^<>]*?\ssrc\s*=\s*(["']?)(?:[^"'\s<>]*\/)?tern\.js(?:[?#][^"'\s<>]*)?\2(?=[\s>/])[^<>]*>)/i;

// DETECT on one line: {index, tag} for the tern.js tag, or null.
function detect(line) {
  const m = DETECT.exec(line);
  return m ? { index: m[0].length - m[1].length, tag: m[1] } : null;
}

// Why a file is not a note, when it nearly is: a tern.js tag DETECT refuses.
function notNote(text) {
  const m = /<script\b[^<>]*\ssrc\s*=\s*["']?(?:[^"'\s<>]*\/)?tern\.js(?:[?#][^"'\s<>]*)?(?=["'\s>/])[^<>]*>/i.exec(String(text));
  if (!m) return 'no line loads tern.js';
  if (/\sdata-built\b/i.test(m[0])) return 'it is a page written by tern build; check its source note';
  const how = /\s(async|defer)(?=[\s=>/]|$)/i.exec(m[0]) || /\stype\s*=\s*["']?(module)/i.exec(m[0]);
  if (how) return `it loads tern.js with ${how[1].toLowerCase()}, so tern.js does not render it; use a plain <script src>`;
  return 'its tern.js tag is commented out or not on one line';
}

// Splits a file into the preserved head and the note. Returns null when no
// line loads tern.js. `line` is the number of file lines before the note, so
// note line n is file line n + line.
function split(text) {
  text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let i = -1;
  let d = null;
  while (++i < lines.length && !(d = detect(lines[i])));
  if (!d) return null;
  let at = 0;
  for (let k = 0; k <= i; k++) at = text.indexOf('\n', at) + 1 || text.length;
  return {
    head: [...lines.slice(0, i), lines[i].slice(0, d.index)].join('\n'),
    tag: d.tag,
    note: at > 0 ? text.slice(at) : '',
    line: i + 1,
  };
}

// The tag's attributes: data-use (space-separated add-ons, query strings
// dropped), data-css, data-katex … Values are decoded as HTML decodes them
// (the character references a tag line plausibly holds).
const REFS = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decodeRefs = (s) =>
  s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|quot|apos|lt|gt));/g, (m, d, h, n) => {
    if (n) return REFS[n];
    const c = d ? Number(d) : parseInt(h, 16);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
  });
function attributes(tag) {
  const out = {};
  const re = /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m; (m = re.exec(tag)); ) out[m[1].toLowerCase()] = decodeRefs(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

// The project a note's local head scripts and add-ons must stay in: the
// folder of the tern.js its tag names, when that is a relative path (the
// site root a static host would serve it from); else the repository the note
// is in; else the note's own folder. A root-relative URL (/lib/x.js) resolves
// against it, and a path that leaves it is not read: a note cannot make the
// tools read a file outside its project and run it as code.
function projectRoot(dir, tag) {
  const src = (attributes(tag).src || '').replace(/[?#].*$/, '');
  if (src && !isRemote(src) && !src.startsWith('/')) return path.dirname(path.resolve(dir, src));
  return repository(dir) || path.resolve(dir);
}

// A local file's path, or null when it lies outside the project root.
function locate(dir, url, root) {
  const file = url.startsWith('/') ? path.join(root, url) : path.resolve(dir, url);
  const rel = path.relative(root, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : file;
}

// The head's classic scripts before the tern.js tag, in document order:
// {src, body, line, column}. Comments are skipped; a module, a data block,
// and an async or defer script (which runs after tern.js has read
// window.TERN) are left out.
const JS_TYPE = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript|javascript1\.[0-5]))?$/i;
function headScripts(head) {
  head = String(head || '');
  const out = [];
  for (const m of head.matchAll(/<!--[\s\S]*?(?:-->|$)|<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    if (m[0][1] === '!') continue;
    const a = attributes(m[1]);
    if (!JS_TYPE.test((a.type || '').trim()) || (a.src !== undefined && ('async' in a || 'defer' in a))) continue;
    const before = head.slice(0, m.index);
    out.push({ src: a.src === undefined ? null : a.src, body: m[2], line: (before.match(/\n/g) || []).length + 1, column: m.index - before.lastIndexOf('\n') });
  }
  return out;
}

const isRemote = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

// Why the note's scripts were not run, as the addon.failed message: the
// sandbox timed out, crashed, or could not start (cli/sandbox.js). `kept`
// says that the vocabulary of the last analysis stands in.
const failMessage = (kind, kept) => {
  const what = kept ? 'its vocabulary is kept from its last analysis, its transforms are missing' : 'its vocabulary and transforms are missing';
  return kind === 'timeout'
    ? `the note's scripts did not finish in 2 s, so they were not run; ${what}`
    : kind === 'crash'
      ? `the note's scripts used too much memory or crashed the sandbox, so they were not run; ${what}`
      : kind === 'unavailable'
        ? `the script sandbox is not available, so the note's scripts were not run; ${what}`
        : kind === 'tripped'
          ? `the script sandbox died three times in a row, so the note's scripts were not run for a minute; ${what}`
          : `the note's scripts could not be run in the sandbox, so ${what}`;
};

// A note file's text, read as UTF-8, with a warning when it is not: a UTF-16
// byte order mark (the file is not read as a note), or bytes that are not
// UTF-8, read as U+FFFD. Throws what readFileSync throws.
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { text: buf.toString('utf8'), warning: `${file} is UTF-16 (it starts with a byte order mark); Tern reads UTF-8, so it is not read as a note` };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), warning: null };
  } catch {
    const text = buf.toString('utf8');
    const n = (text.match(/\uFFFD/g) || []).length;
    return { text, warning: `${file} is not valid UTF-8; ${n} byte sequence${n === 1 ? '' : 's'} that ${n === 1 ? 'is' : 'are'} not ${n === 1 ? 'was' : 'were'} read as U+FFFD` };
  }
}

// The note's own code the sandbox must run, read here (the sandbox child
// cannot read files): the head's classic scripts and the script add-ons of
// data-use, each {url, code} in document order, and the problems that are the
// host's to see — a remote script or add-on (not run under node), a local one
// that cannot be read. `dataUse/Lang/Katex` build the add-ons' tern.config;
// `hasCode` is false when there is nothing to run (the analysis stays here).
// A `seq` orders every script, add-on and problem as it appears, so the
// problems the host finds here and those the sandbox finds there merge back
// into document order; `vocabSeq` is where a window.TERN problem belongs,
// after the head scripts and before the add-ons.
function collect(tag, dir, head, note) {
  const scripts = [];
  const addons = [];
  const problems = [];
  const files = []; // the local files read, absolute: an editor watches them
  const attrs = attributes(tag);
  const root = projectRoot(dir, tag);
  const outside = `outside the project (${root})`;
  let seq = 0;
  for (const s of headScripts(head)) {
    const at = { kind: 'head', line: s.line, column: s.column, seq: seq++ };
    const url = s.src === null ? `inline script on line ${s.line}` : s.src;
    if (s.src === null) {
      scripts.push({ url, code: s.body, line: s.line, column: s.column, seq: at.seq });
      continue;
    }
    if (isRemote(s.src)) {
      problems.push({ ...at, severity: 'info', url, message: `the head script ${url} is not run under node, so vocabulary it declares in window.TERN.schema is unknown here` });
      continue;
    }
    const file = locate(dir, s.src.replace(/[?#].*$/, ''), root);
    if (!file) {
      problems.push({ ...at, severity: 'warning', url, message: `the head script ${url} is ${outside}, so it is not run` });
      continue;
    }
    files.push(file);
    try {
      scripts.push({ url, code: fs.readFileSync(file, 'utf8'), line: s.line, column: s.column, seq: at.seq });
    } catch {
      problems.push({ ...at, severity: 'warning', url, message: `the head script ${url} cannot be read (${file})` });
    }
  }
  const vocabSeq = seq - 0.5;
  for (const entry of (attrs['data-use'] || '').split(/\s+/).filter(Boolean)) {
    const url = entry.replace(/[?#].*$/, '');
    if (/\.css$/i.test(url)) continue; // a stylesheet; anything else is a script
    if (isRemote(url)) {
      problems.push({ kind: 'remote', url, message: `the add-on ${url} is not loaded under node; names it declares are unknown to tern check`, seq: seq++ });
      continue;
    }
    const file = locate(dir, url, root);
    if (!file) {
      problems.push({ url, message: outside, seq: seq++ });
      continue;
    }
    files.push(file);
    try {
      addons.push({ url, code: fs.readFileSync(file, 'utf8'), seq: seq++ });
    } catch (e) {
      problems.push({ url, message: e && e.code === 'EISDIR' ? `${file} is a directory` : `cannot read ${file}`, seq: seq++ });
    }
  }
  // The leading `:::use` block's entries (src/use.js), after the tag's, each
  // at its line in the note so a problem with one points there.
  const use = scanUse(note || '', { eof: true }).entries;
  for (const e of use) {
    const span = { start: { line: e.line, column: e.column, offset: e.offset }, end: { line: e.line, column: e.column + e.url.length, offset: e.offset + e.url.length } };
    const url = e.url.replace(/[?#].*$/, '');
    if (/\.css$/i.test(url)) continue;
    if (isRemote(url)) {
      problems.push({ kind: 'remote', url, message: `the add-on ${url} is not loaded under node; names it declares are unknown to tern check`, seq: seq++, position: span });
      continue;
    }
    const file = locate(dir, url, root);
    if (!file) {
      problems.push({ url, message: outside, seq: seq++, position: span });
      continue;
    }
    files.push(file);
    try {
      addons.push({ url: e.url, code: fs.readFileSync(file, 'utf8'), seq: seq++, position: span });
    } catch (err) {
      problems.push({ url, message: err && err.code === 'EISDIR' ? `${file} is a directory` : `cannot read ${file}`, seq: seq++, position: span });
    }
  }
  const dataUse = [attrs['data-use'], ...use.map((e) => e.url)].filter(Boolean).join(' ') || undefined;
  return {
    scripts,
    addons,
    problems,
    files,
    vocabSeq,
    use,
    dataUse,
    dataLang: attrs['data-lang'] !== undefined ? attrs['data-lang'].trim() : undefined,
    dataKatex: attrs['data-katex'],
    hasCode: scripts.length > 0 || addons.length > 0,
  };
}

// A vocabulary problem as the commands print it: the code, severity and
// message of its diagnostic.
function loadingDiagnostic(p) {
  if (p.kind === 'head') return { code: 'head.script', severity: p.severity, message: p.message };
  if (p.kind === 'remote') return { code: 'addon.remote', severity: 'info', message: p.message };
  if (p.kind === 'sandbox') return { code: 'addon.failed', severity: 'error', message: p.message };
  if (p.kind === 'transform') return { code: 'addon.failed', severity: 'error', message: `the transform "${p.name}" of the add-on ${p.url} threw: ${p.message}` };
  return { code: 'addon.failed', severity: 'error', message: `the add-on ${p.url} did not load: ${p.message}` };
}

// A note position as a file position: lines move by the head's lines;
// columns and UTF-16 code units are the same (the head ends at a line break).
const toFile = (pos, line) => ({
  start: { line: pos.start.line + line, column: pos.start.column },
  end: { line: pos.end.line + line, column: pos.end.column },
});

// Parses and transforms a note file, with its vocabulary and its label
// language. Returns null when the file is not a note. When the note has its
// own code to run (head scripts, script add-ons), that runs in the sandbox
// (cli/sandbox.js), which parses and transforms there and returns the AST and
// diagnostics as data, or, when the code adds no transform and its schema is
// plain data, returns the schema and the note is parsed here with it; a note
// with no code is parsed here, where no untrusted code runs.
// `opts.noScripts` skips the code (an empty vocabulary); `opts.hostParse`
// false keeps the whole analysis in the sandbox (the tests compare the two);
// `opts.transform` false stops after parsing (tern parse). Diagnostics carry
// `filePosition` beside the note's `position`, in document order; the problems
// loading vocabulary come first, with only a filePosition (command-line codes,
// beside the browser's addon.failed: the browser runs this code itself):
//   - an add-on that is missing or throws, a transform of one that throws, or
//     the sandbox refusing to run the code: `addon.failed`, an error;
//   - a remote add-on: `addon.remote`, an info at the tern.js line;
//   - a head script: `head.script`, an info or a warning at its <script>.
// `.demo` is window.ternDocs.demo, a documentation add-on's schema, or null.
// `.vocab` is the vocabulary the analysis used, {stamp, schema, lang, ran,
// hostParse}: `stamp` tells the head and the code apart from another's, `ran`
// is false when the sandbox did not run the code, and `hostParse` is true
// when it ran the code and the note was parsed here. A caller that analyses the
// same note again passes the last one as `opts.lastVocab`: when the code
// fails to run and the stamp still holds, that vocabulary stands in, so an
// editor keeps a note's names while a script of it is stuck. `.files` are
// the local script and add-on files the analysis read.
// analyseAsync is the same over the sandbox's asynchronous bridge, for the
// language server; analyse blocks, for the tools.
function analyse(text, file, opts = {}) {
  const s = prepare(text, file, opts);
  if (!s) return null;
  return finish(s, s.req ? sandbox.analyse(s.req) : null);
}

async function analyseAsync(text, file, opts = {}) {
  const s = prepare(text, file, opts);
  if (!s) return null;
  return finish(s, s.req ? await sandbox.analyseAsync(s.req) : null);
}

// What the sandbox is asked, or nothing when the note has no code to run.
function prepare(text, file, opts) {
  const parts = split(text);
  if (!parts) return null;
  const dir = file ? path.dirname(path.resolve(file)) : process.cwd();
  const c = collect(parts.tag, dir, parts.head, parts.note);
  const transform = opts.transform !== false;
  const stamp = crypto
    .createHash('sha1')
    .update(JSON.stringify([parts.head, c.dataUse ?? null, c.dataLang ?? null, c.dataKatex ?? null, c.scripts.map((s) => s.code), c.addons.map((a) => a.code)]))
    .digest('hex');
  const req = opts.noScripts || !c.hasCode ? null : { note: parts.note, head: parts.head, dataUse: c.dataUse, dataLang: c.dataLang, dataKatex: c.dataKatex, scripts: c.scripts, addons: c.addons, vocabSeq: c.vocabSeq, transform, hostParse: opts.hostParse !== false };
  return { parts, c, transform, stamp, req, opts };
}

// The analysis from the sandbox's reply (null when it was not asked).
function finish({ parts, c, transform, stamp, opts }, r) {
  let schema = { block: {}, leaf: {}, inline: {} };
  let lang = c.dataLang || undefined;
  let demo = null;
  let ternDocs = null;
  let all;
  let problems = c.problems;
  let ran = true;

  // No code, scripts turned off, or the sandbox could not run the code: parse
  // here with an empty vocabulary (a note that declares none is unaffected),
  // or with the last one when it is given and the code has not changed.
  const here = () => {
    const options = { schema, head: parts.head, lang };
    const parsed = tern.parse(parts.note, options);
    if (!transform) {
      all = parsed.diagnostics;
      return parsed.ast;
    }
    tern.transform(parsed.ast, options);
    all = parsed.diagnostics.concat(parsed.ast.data.tern.diagnostics);
    return parsed.ast;
  };

  let ast;
  let failures = [];
  if (!r) {
    ast = here();
  } else if (r.failed) {
    ran = false;
    const last = opts.lastVocab && opts.lastVocab.stamp === stamp && opts.lastVocab.schema ? opts.lastVocab : null;
    if (last) {
      schema = last.schema;
      lang = last.lang == null ? undefined : last.lang;
    }
    ast = here();
    problems = problems.concat([{ kind: 'sandbox', message: failMessage(r.failed, !!last) }]);
  } else if (r.hostParse) {
    // The code ran there and declared plain data: the note is parsed here.
    // The diagnostics are copies, as the sandbox's reply would hold, so the
    // filePosition set on them below stays off the tree's own.
    schema = r.schema;
    lang = r.lang == null ? undefined : r.lang;
    ternDocs = r.ternDocs || null;
    demo = ternDocs && ternDocs.demo ? ternDocs.demo : null;
    ast = here();
    all = all.map((d) => ({ ...d }));
    problems = problems.concat(r.problems);
  } else {
    schema = r.schema;
    lang = r.lang == null ? undefined : r.lang;
    ternDocs = r.ternDocs || null;
    demo = ternDocs && ternDocs.demo ? ternDocs.demo : null;
    ast = r.ast;
    all = r.diagnostics;
    problems = problems.concat(r.problems);
    failures = r.failures || [];
  }
  // Loading problems in document order (their seq, set by collect and echoed
  // by the sandbox), then any transform failure, as they run last.
  problems = problems.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).concat(failures.map((f) => ({ kind: 'transform', ...f })));

  const options = { schema, head: parts.head, lang };
  const at = (d) => d.position.start.offset;
  all.sort((a, b) => at(a) - at(b) || a.position.end.offset - b.position.end.offset || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const d of all) d.filePosition = toFile(d.position, parts.line);
  const point = (line, column) => ({ start: { line, column }, end: { line, column } });
  // A problem with a `:::use` add-on points at its line: the host's carry the
  // position; the sandbox's name the add-on, and match by URL.
  const usePos = new Map((c.addons || []).filter((a) => a.position).map((a) => [a.url, a.position]));
  const where = (p) => {
    const pos = p.position || usePos.get(p.url);
    if (pos) return toFile(pos, parts.line);
    return p.kind === 'head' ? point(p.line, p.column) : point(parts.line, 1);
  };
  const loading = problems.map((p) => ({ ...loadingDiagnostic(p), filePosition: where(p) }));
  const vocab = { stamp, schema, lang: lang === undefined ? null : lang, ran, hostParse: !!(r && r.hostParse) };
  return { ...parts, schema, opts: options, ast, demo, ternDocs, use: c.use, files: c.files, vocab, diagnostics: loading.concat(all), toFile: (pos) => toFile(pos, parts.line) };
}

// The .html files under dir, sorted, skipping dot-directories and
// node_modules; symbolic links to directories are not followed.
function* htmlFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(p);
    else if (/\.html?$/i.test(e.name)) {
      if (e.isFile()) yield p;
      else if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(p).isFile()) yield p;
        } catch {}
      }
    }
  }
}

// The repository dir is in: the nearest folder at or above it holding .git.
function repository(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

module.exports = { DETECT, detect, notNote, split, attributes, headScripts, collect, loadingDiagnostic, analyse, analyseAsync, readText, htmlFiles, repository, tern, shutdown: sandbox.shutdown, clean: sandbox.clean };
