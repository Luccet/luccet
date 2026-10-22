// SPDX-License-Identifier: MIT
// A note's links to files, checked against the disk, for `tern check`
// (docs/diagnostics.html#tools-codes):
//   link.missing   a relative URL names a file that does not exist, a folder
//                  with no index.html, or a name whose case differs from the
//                  file's (found on this disk, not on a host that tells case
//                  apart); an error for the tern.js the note loads, since
//                  the note does not render, a warning otherwise
//   link.dangling  its fragment names no id in the file it points at
// A Tern link to `#id` in the note itself is the engine's (ref.dangling).
//
// The links: Tern links and images; the href, src, poster and data of
// elements; href and src in raw HTML, in the note and in the head; the
// tern.js tag's src and data-css, and its stylesheet add-ons. Head scripts
// and script add-ons are not, being head.script's and addon.failed's. Not
// checked: URLs with a scheme or starting with // (elsewhere) or / (they
// depend on where the site is served), and a note with a <base href>, whose
// URLs do not resolve from its folder.
//
// The ids a fragment may name: a note's registry and the ids in its HTML;
// another HTML file's id attributes and <a name>s; a Markdown file's GitHub
// heading anchors. #top, which every browser takes to the top, always.
//
//   new Targets(opts)        files as the checks read them (below):
//     .analyse(file, text?)    cli/note.js analyse(), or null for a non-note
//     .remember(file, a)       an analysis of the file as it is now
//     .parsed(file)            {text, a}: the file's text and parsed(text)
//     .find(dir, rel)          what a relative path names from a folder:
//                              {kind: 'file'|'dir', actual, exact} or null,
//                              actual the path as the disk spells it, exact
//                              false when a segment differs in case alone
//     .ids(file)               a Set, or null when the file has no ids to know
//     .during(fn)              fn(), with each file's stat taken once
//   urls(a)                  the URLs of a note analysed as `a`, with where
//                            they are and where they are written; one list
//                            per analysis, shared: read it, do not change it
//   spanRange(a, span)       where a URL's span is written, as file positions
//                            {start: {line, column}, end}, 1-based, UTF-16
//   fragmentSpan(a, u)       the span of the fragment of urls() entry u, after
//                            its #, or null when it has none
//   parsed(text)             a note parsed, not transformed, for urls()
//   parse(url)               what a relative URL names: {path, frag}, or null
//   resolve(file, url, targets)  what a URL from the note at `file` names, and
//                            its problem, if any
//   check(file, a, targets)  the link diagnostics of the note at `file`,
//                            analysed as `a`, in file order, each spanning
//                            its link (the tern.js line's: column 1)
//   merge(own, more)         a note's diagnostics and its link diagnostics,
//                            in file order
//   lineCol(text, offset)    the line and column (1-based, UTF-16) of an
//                            offset in text
'use strict';

const fs = require('fs');
const { scanUse } = require('../src/use');
const path = require('path');
const { analyse, split, tern } = require('./note');

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//;
const URL_KEYS = ['href', 'src', 'poster', 'data'];
// A start tag, its quoted values whole, and a URL attribute in it.
const TAG = /<([a-zA-Z][^\s/>]*)(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g;
const URL_ATTR = /\s(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const URL_ATTR_D = new RegExp(URL_ATTR.source, 'gid'); // with the values' offsets
const decode = (s) => s.replace(/&(amp|quot|lt|gt|#39);/g, (_, k) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[k]);
// Comments blanked to spaces, so that offsets hold.
const uncomment = (html) => html.replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => c.replace(/[^\n]/g, ' '));

// Line and column (1-based, UTF-16) of an offset in text, by a binary
// search of the text's line starts. urls() asks this of every URL, of the
// head and the note in turn, so the last few texts' tables are kept: a slice
// and split per call made a note's URLs cost time quadratic in its length.
const tables = []; // [{text, starts}], newest first
function lineStarts(text) {
  for (const t of tables) if (t.text === text) return t.starts;
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  tables.unshift({ text, starts });
  if (tables.length > 4) tables.pop();
  return starts;
}
function lineCol(text, offset) {
  const starts = lineStarts(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

// Files as the checks read them. Each value is kept with a stamp of what it
// came from, and used while the stamp holds: a file's mtime and size, a
// folder's mtime, an open document's version. So one Targets serves a long
// run, such as the language server's, as well as one `tern check`. Each
// table keeps its last MAX entries, so a long run over a large workspace
// does not grow without end.
//   opts.open(file)          an editor's text for the file, {text, stamp},
//                            or undefined: the editor's text wins over the
//                            disk's, and an open file exists
//   opts.analyse(text, file) analyses a note (default cli/note.js analyse)
const MAX = 512;
class Targets {
  constructor({ open, analyse: run } = {}) {
    this.open = open || (() => undefined);
    this.run = run || ((text, file) => analyse(text, file));
    this.dirs = new Map(); // dir -> {stamp, names}
    this.notes = new Map(); // file -> {stamp, a}
    this.idSets = new Map(); // file -> {stamp, ids}
    this.parsedNotes = new Map(); // file -> {stamp, text, a}
    this.pass = null; // during one check(): stamps already taken, by path
  }

  // A table entry, set or refreshed as the newest; the oldest goes past MAX.
  keep(table, key, value) {
    table.delete(key);
    table.set(key, value);
    if (table.size > MAX) table.delete(table.keys().next().value);
    return value;
  }

  // A stat, taken once per check() pass.
  stat(file) {
    if (this.pass && this.pass.has(file)) return this.pass.get(file);
    const st = fs.statSync(file, { throwIfNoEntry: false }) || null;
    if (this.pass) this.pass.set(file, st);
    return st;
  }

  // fn(), with every file's stat taken once: a check, a search over the workspace.
  during(fn) {
    if (this.pass) return fn();
    this.pass = new Map();
    try {
      return fn();
    } finally {
      this.pass = null;
    }
  }

  // A file's stamp and a reader of its text.
  source(file) {
    const o = this.open(file);
    if (o) return { stamp: `open ${o.stamp}`, text: () => o.text };
    const st = this.stat(file);
    if (!st) return { stamp: 'none', text: () => '' };
    return {
      stamp: `${st.mtimeMs} ${st.size}`,
      text: () => {
        try {
          return fs.readFileSync(file, 'utf8');
        } catch {
          return '';
        }
      },
    };
  }

  // The note's analysis; `text` is what the caller read of it. An
  // analysis of the same text, made while the stamp holds, is reused: a note
  // that `tern check` reads after a link to it was checked is not analysed
  // twice.
  analyse(file, text) {
    const src = this.source(file);
    const hit = this.notes.get(file);
    if (hit && hit.stamp === src.stamp && (text === undefined || hit.text === text)) return this.keep(this.notes, file, hit).a;
    const read = text === undefined ? src.text() : text;
    const a = this.run(read, file);
    this.keep(this.notes, file, { stamp: src.stamp, text: read, a });
    return a;
  }

  // An analysis made elsewhere, of the file as it is now (the language
  // server's of an open document).
  remember(file, a) {
    this.keep(this.notes, file, { stamp: this.source(file).stamp, a });
  }

  // The file's text and the note parsed, not transformed (parsed() below),
  // `a` null for a file that is not a note: its URLs and outline, with no
  // code of it run. For a search over every note of a workspace.
  parsed(file) {
    const src = this.source(file);
    const hit = this.parsedNotes.get(file);
    if (hit && hit.stamp === src.stamp) return this.keep(this.parsedNotes, file, hit);
    const text = src.text();
    return this.keep(this.parsedNotes, file, { stamp: src.stamp, text, a: parsed(text) });
  }

  entries(dir) {
    const st = this.stat(dir);
    const stamp = st ? String(st.mtimeMs) : 'none';
    const hit = this.dirs.get(dir);
    if (hit && hit.stamp === stamp) return this.keep(this.dirs, dir, hit).names;
    let names = null;
    try {
      names = fs.readdirSync(dir);
    } catch {}
    this.keep(this.dirs, dir, { stamp, names });
    return names;
  }

  // The segments of a relative path, walked from the note's folder as it
  // was given, so that a name the disk spells in another case is seen even
  // where the disk ignores case. Only what the author wrote is walked: the
  // folder above is taken as it is, since a temporary folder's short name
  // (RUNNER~1 on Windows) or a symbolic link (/var on macOS) spells it
  // otherwise than the disk's listing without being a mistake of the note.
  find(dir, rel) {
    let at = dir;
    let exact = true;
    const parts = String(rel).split('/').filter((p) => p && p !== '.');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '..') {
        at = path.dirname(at);
        continue;
      }
      const candidate = path.join(at, part);
      if (this.open(candidate)) {
        at = candidate;
        continue;
      }
      const names = this.entries(at);
      if (!names) return null;
      const name = names.includes(part) ? part : names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (name === undefined) return null;
      if (name !== part) exact = false;
      at = path.join(at, name);
    }
    if (this.open(at)) return { kind: 'file', actual: at, exact };
    const st = this.stat(at);
    return st ? { kind: st.isDirectory() ? 'dir' : 'file', actual: at, exact } : null;
  }

  ids(file) {
    const src = this.source(file);
    const hit = this.idSets.get(file);
    if (hit && hit.stamp === src.stamp) return this.keep(this.idSets, file, hit).ids;
    let ids = null;
    if (/\.html?$/i.test(file)) {
      const a = this.analyse(file);
      if (a) {
        ids = new Set(Object.keys(a.ast.data.tern.ids));
        const html = tern.emit(a.ast, { ...a.opts, positions: false });
        for (const m of html.matchAll(/<[a-zA-Z][^<>]*?\sid="([^"]*)"/g)) ids.add(decode(m[1]));
      } else {
        ids = new Set();
        for (const m of uncomment(src.text()).matchAll(TAG)) {
          for (const x of m[0].matchAll(/\s(id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
            if (x[1].toLowerCase() === 'id' || m[1].toLowerCase() === 'a') ids.add(decode(x[2] ?? x[3] ?? x[4]));
          }
        }
      }
    } else if (/\.(md|markdown)$/i.test(file)) ids = markdownAnchors(src.text());
    this.keep(this.idSets, file, { stamp: src.stamp, ids });
    return ids;
  }
}

// GitHub's heading anchors in a Markdown file.
function markdownAnchors(text) {
  const ids = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length))) {
      fence = fence ? null : f[1];
      continue;
    }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const slug = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    ids.add(n ? `${slug}-${n}` : slug);
  }
  return ids;
}

// The note's URLs: [{url, what, own, check, position?, filePosition, span}].
// `what` names it in a message, %s standing for its path; `own` is true for
// a Tern link within the note, which the engine checks; `check` is false for
// head scripts and script add-ons, which head.script and addon.failed
// report. `span` is where the URL is written, for tern mv to rewrite it:
// {in: 'head' | 'tag' | 'note', from, to, quote}, offsets in a.head, a.tag
// or a.note, quote one of " ' < (a Tern link's <…>), '' (bare) or ' ' (an
// entry of data-use's list); null when it cannot be placed. The list is
// made once per analysis and shared, so callers read it and do not change
// it: a check, a search over the workspace and the language server's
// refresh ask again of notes that have not changed.
const urlsOf = new WeakMap(); // analysis -> its URLs
function urls(a) {
  let list = urlsOf.get(a);
  if (!list) urlsOf.set(a, (list = noteUrls(a)));
  return list;
}

function noteUrls(a) {
  const out = [];
  const point = (p) => ({ start: p, end: p });
  const value = (m, g) => (m[g] !== undefined ? g : m[g + 1] !== undefined ? g + 1 : g + 2); // the group that matched
  const QUOTE = ['"', "'", ''];
  // The head and the tern.js tag, in file lines; the tag's items at column
  // 1, as addon.failed is.
  const head = uncomment(a.head);
  for (const m of head.matchAll(TAG)) {
    const name = m[1].toLowerCase();
    if (name === 'base') continue;
    const at = { start: lineCol(a.head, m.index), end: lineCol(a.head, m.index + m[0].length) };
    for (const u of m[0].matchAll(URL_ATTR_D)) {
      const g = value(u, 2);
      const span = { in: 'head', from: m.index + u.indices[g][0], to: m.index + u.indices[g][1], quote: QUOTE[g - 2] };
      out.push({ url: decode(u[g]), what: `the ${u[1].toLowerCase()} of the head's <${name}>, %s,`, check: name !== 'script', filePosition: at, span });
    }
  }
  const attr = (k) => {
    const m = new RegExp(`\\s${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'id').exec(a.tag);
    if (!m) return null;
    const g = value(m, 1);
    return { value: decode(m[g]), raw: m[g], from: m.indices[g][0], to: m.indices[g][1], quote: QUOTE[g - 1] };
  };
  const tagAt = point({ line: a.line, column: 1 });
  const src = attr('src');
  if (src) out.push({ url: src.value, what: 'the tern.js this note loads, %s,', tern: true, filePosition: tagAt, span: { in: 'tag', from: src.from, to: src.to, quote: src.quote } });
  const css = attr('data-css');
  if (css && css.value) out.push({ url: css.value, what: 'the stylesheet in data-css, %s,', filePosition: tagAt, span: { in: 'tag', from: css.from, to: css.to, quote: css.quote } });
  const use = attr('data-use');
  if (use)
    for (const e of use.raw.matchAll(/\S+/g)) {
      const entry = decode(e[0]);
      out.push({ url: entry, what: 'the add-on %s', check: /\.css(?:[?#]|$)/i.test(entry), filePosition: tagAt, span: { in: 'tag', from: use.from + e.index, to: use.from + e.index + e[0].length, quote: ' ' } });
    }

  // The note, in note positions.
  const at = (offset) => ({ ...lineCol(a.note, offset), offset });
  const place = (start, end) => {
    const position = { start, end };
    return { position, filePosition: a.toFile(position) };
  };
  // The leading `:::use` block's entries, as data-use's: a stylesheet is
  // checked; a script is addon.failed's. Bare, so tern mv rewrites them.
  for (const e of a.use || []) {
    const start = { line: e.line, column: e.column, offset: e.offset };
    const end = { line: e.line, column: e.column + e.url.length, offset: e.offset + e.url.length };
    out.push({ url: e.url, what: 'the add-on %s', check: /\.css(?:[?#]|$)/i.test(e.url), ...place(start, end), span: { in: 'note', from: e.offset, to: e.offset + e.url.length, quote: '' } });
  }
  tern.visit(a.ast, (node) => {
    if (!node.position) return;
    const pos = (p) => ({ line: p.line, column: p.column, offset: p.offset });
    const [start, end] = [pos(node.position.start), pos(node.position.end)];
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
      out.push({ url: node.url, what: node.type === 'image' ? 'the image %s' : '%s', own: node.type === 'link' && node.url.startsWith('#'), ...place(start, end), span: destination(a.note, node) });
    }
    if (node.attributes && typeof node.attributes === 'object' && node.type !== 'code') {
      for (const k of URL_KEYS) if (typeof node.attributes[k] === 'string') out.push({ url: node.attributes[k], what: `the ${k} %s`, ...place(start, end), span: attribute(a.note, node, k) });
    }
    if (node.type === 'html' && typeof node.value === 'string') {
      const html = uncomment(node.value);
      const base = node.position.start.offset;
      const placed = a.note.slice(base, base + node.value.length) === node.value;
      for (const m of html.matchAll(TAG)) {
        const from = base + m.index;
        for (const u of m[0].matchAll(URL_ATTR_D)) {
          const g = value(u, 2);
          const span = placed ? { in: 'note', from: from + u.indices[g][0], to: from + u.indices[g][1], quote: QUOTE[g - 2] } : null;
          out.push({ url: decode(u[g]), what: `the ${u[1].toLowerCase()} of <${m[1].toLowerCase()}>, %s,`, ...place(at(from), at(from + m[0].length)), span });
        }
      }
    }
  });
  return out;
}

// Where a span of urls() is written, as file positions: the head's lines are
// the file's first; the tag is on the tern.js line, after what the head
// holds of it; a note line n is file line n + a.line.
function spanRange(a, span) {
  const at = (off) => {
    if (span.in === 'head') return lineCol(a.head, off);
    if (span.in === 'tag') return { line: a.line, column: a.head.length - a.head.lastIndexOf('\n') + off };
    const p = lineCol(a.note, off);
    return { line: p.line + a.line, column: p.column };
  };
  return { start: at(span.from), end: at(span.to) };
}

// The fragment of a URL as written: the span after its first `#` (a Tern
// link may escape one as `\#`, which is not it), or null without one.
function fragmentSpan(a, u) {
  if (!u.span || !u.url.includes('#')) return null;
  const text = u.span.in === 'head' ? a.head : u.span.in === 'tag' ? a.tag : a.note;
  const written = text.slice(u.span.from, u.span.to);
  for (let i = 0; i < written.length; i++) {
    if (written[i] === '\\') i++;
    else if (written[i] === '#') return { in: u.span.in, from: u.span.from + i + 1, to: u.span.to };
  }
  return null;
}

// Where a Tern link's or image's destination is written: after the `](`
// that ends its text, as <…> or a bare run with balanced parentheses. A
// candidate counts when the engine reads it as the node's URL.
function destination(note, node) {
  const s = node.position.start.offset;
  const slice = note.slice(s, node.position.end.offset);
  for (let i = slice.lastIndexOf(']('); i >= 0; i = i > 0 ? slice.lastIndexOf('](', i - 1) : -1) {
    let j = i + 2;
    while (/\s/.test(slice[j] || '')) j++;
    let from = j;
    let to;
    let quote = '';
    if (slice[j] === '<') {
      from = j + 1;
      to = slice.indexOf('>', from);
      quote = '<';
      if (to < 0) continue;
    } else {
      let depth = 0;
      for (to = j; to < slice.length; to++) {
        const c = slice[to];
        if (c === '\\') to++;
        else if (/\s/.test(c)) break;
        else if (c === '(') depth++;
        else if (c === ')' && !depth--) break;
      }
    }
    const raw = quote ? `<${slice.slice(from, to)}>` : slice.slice(from, to);
    let read = null;
    tern.visit(tern.parse(`[x](${raw})`).ast, (n) => {
      if (n.type === 'link' && read === null) read = n.url;
    });
    if (read === node.url) return { in: 'note', from: s + from, to: s + to, quote };
  }
  return null;
}

// Where an element's URL attribute is written: in the attribute group on its
// first line.
function attribute(note, node, key) {
  const s = node.position.start.offset;
  const nl = note.indexOf('\n', s);
  const line = note.slice(s, nl < 0 ? note.length : nl);
  for (const m of line.matchAll(new RegExp(`(?:^|[\\s{])${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s}]+))`, 'gd'))) {
    const g = m[1] !== undefined ? 1 : m[2] !== undefined ? 2 : 3;
    if (m[g] === node.attributes[key]) return { in: 'note', from: s + m.indices[g][0], to: s + m.indices[g][1], quote: ['"', "'", ''][g - 1] };
  }
  return null;
}

// A note parsed but not transformed, its add-ons not run: its URLs are
// syntax, and this reads them at no risk (tern mv).
function parsed(text) {
  const parts = split(text);
  if (!parts) return null;
  const { ast } = tern.parse(parts.note, { head: parts.head });
  const shift = (p) => ({ line: p.line + parts.line, column: p.column });
  // The leading `:::use` block's entries, as analyse() carries them (urls() reads them).
  const use = scanUse(parts.note, { eof: true }).entries;
  return { ...parts, ast, use, toFile: (pos) => ({ start: shift(pos.start), end: shift(pos.end) }) };
}

// What a URL names: null when it is not checked, else {path, frag}: path ''
// for the note itself, frag null without a #.
function parse(url) {
  url = url.trim();
  if (!url || SCHEME.test(url) || url.startsWith('/')) return null;
  const hash = url.indexOf('#');
  let p = (hash < 0 ? url : url.slice(0, hash)).replace(/\?.*$/, '');
  let frag = hash < 0 ? null : url.slice(hash + 1);
  try {
    p = decodeURIComponent(p);
  } catch {}
  if (frag !== null) {
    try {
      frag = decodeURIComponent(frag);
    } catch {}
  }
  return { path: p, frag };
}

// A URL from the note at `file`, against the disk: null when it is not
// checked, else {path, frag, dest, problem}. problem is null, 'missing',
// 'no-index' (a folder without index.html), 'case' (with `actual`, the
// path as the disk spells it, relative to the note) or 'dangling'.
function resolve(file, url, targets) {
  const r = parse(url);
  if (!r || (!r.path && r.frag === null)) return null;
  const out = { ...r, dest: file, problem: null };
  if (r.path) {
    const dir = path.dirname(file);
    const dest = path.resolve(dir, r.path);
    let found = targets.find(dir, r.path);
    out.dest = dest;
    if (found && (found.kind === 'dir' || r.path.endsWith('/'))) {
      out.dest = path.join(dest, 'index.html');
      found = targets.find(dir, `${r.path.replace(/\/+$/, '')}/index.html`);
      if (!found || found.kind !== 'file') return { ...out, problem: 'no-index' };
    }
    if (!found) return { ...out, problem: 'missing' };
    if (!found.exact) return { ...out, problem: 'case', actual: path.relative(dir, found.actual).split(path.sep).join('/') };
  }
  if (!r.frag || r.frag.toLowerCase() === 'top') return out;
  const ids = targets.ids(out.dest);
  return ids && !ids.has(r.frag) ? { ...out, problem: 'dangling' } : out;
}

function check(file, a, targets) {
  if (/<base\s[^<>]*\bhref\s*=/i.test(uncomment(a.head))) return [];
  targets.pass = new Map();
  try {
    return checkLinks(file, a, targets);
  } finally {
    targets.pass = null;
  }
}

function checkLinks(file, a, targets) {
  const out = [];
  const say = (u, code, message, hint) => out.push({ code, severity: u.tern ? 'error' : 'warning', message, hint, ...(u.position ? { position: u.position } : {}), filePosition: u.filePosition });
  for (const u of urls(a)) {
    if (u.own || u.check === false) continue;
    const r = resolve(file, u.url, targets);
    if (!r || !r.problem) continue;
    const named = u.what.replace('%s', r.path);
    if (r.problem === 'no-index') say(u, 'link.missing', `${named} has no index.html`, 'link to a file in the folder, or add its index.html');
    else if (r.problem === 'missing') say(u, 'link.missing', `${named} does not exist${u.tern ? ', so the note does not render' : ''}`, 'fix the path: it resolves from the folder of this note');
    else if (r.problem === 'case') say(u, 'link.missing', `${named} is spelt ${r.actual} on this disk; a host that tells case apart will not find it`, `write it as the disk does: ${r.actual}`);
    else if (/\.(md|markdown)$/i.test(r.dest)) say(u, 'link.dangling', `${r.path || 'this note'} has no heading with the anchor ${r.frag}`, 'check the anchor after #: GitHub makes it from the heading, in lower case with hyphens');
    else say(u, 'link.dangling', `${r.path || 'this note'} has no element with the id ${r.frag}`, 'check the id after #: ids are case-sensitive');
  }
  return out.sort(before);
}

const before = (x, y) => x.filePosition.start.line - y.filePosition.start.line || x.filePosition.start.column - y.filePosition.start.column;

// A note's diagnostics with its link diagnostics merged in at their file
// positions; the note's keep their order.
function merge(own, more) {
  const out = [];
  let i = 0;
  for (const d of own) {
    while (i < more.length && before(more[i], d) < 0) out.push(more[i++]);
    out.push(d);
  }
  return out.concat(more.slice(i));
}

module.exports = { Targets, urls, spanRange, fragmentSpan, parse, parsed, resolve, check, merge, lineCol };
