// SPDX-License-Identifier: MIT
// A note's links to files, checked against the disk, for `tern check`
// (docs/diagnostics.html#tools-codes):
//   link.missing   a relative URL names a file that does not exist, a folder
//                  with no index.html, or a name whose case differs from the
//                  file's (found on this disk, not on a host that tells case
//                  apart)
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
//     .find(file)              {kind: 'file'|'dir', actual} or null, actual
//                              the path as the disk spells it
//     .ids(file)               a Set, or null when the file has no ids to know
//   urls(a)                  the URLs of a note analysed as `a`, with where
//                            they are: [{url, what, position?, filePosition}]
//   resolve(file, url, targets)  what a URL from the note at `file` names, and
//                            its problem, if any
//   check(file, a, targets)  the link diagnostics of the note at `file`,
//                            analysed as `a`, in file order, each spanning
//                            its link (the tern.js line's: column 1)
//   merge(own, more)         a note's diagnostics and its link diagnostics,
//                            in file order
'use strict';

const fs = require('fs');
const path = require('path');
const { analyse, tern } = require('./note');

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//;
const URL_KEYS = ['href', 'src', 'poster', 'data'];
// A start tag, its quoted values whole, and a URL attribute in it.
const TAG = /<([a-zA-Z][^\s/>]*)(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g;
const URL_ATTR = /\s(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const decode = (s) => s.replace(/&(amp|quot|lt|gt|#39);/g, (_, k) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[k]);
// Comments blanked to spaces, so that offsets hold.
const uncomment = (html) => html.replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => c.replace(/[^\n]/g, ' '));

// Line and column (1-based, UTF-16) of an offset in text.
function lineCol(text, offset) {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - nl };
}

// Files as the checks read them. Each value is kept with a stamp of what it
// came from, and used while the stamp holds: a file's mtime and size, a
// folder's mtime, an open document's version. So one Targets serves a long
// run, such as the language server's, as well as one `tern check`.
//   opts.open(file)          an editor's text for the file, {text, stamp},
//                            or undefined: the editor's text wins over the
//                            disk's, and an open file exists
//   opts.analyse(text, file) analyses a note (default cli/note.js analyse)
class Targets {
  constructor({ open, analyse: run } = {}) {
    this.open = open || (() => undefined);
    this.run = run || ((text, file) => analyse(text, file));
    this.dirs = new Map(); // dir -> {stamp, names}
    this.notes = new Map(); // file -> {stamp, a}
    this.idSets = new Map(); // file -> {stamp, ids}
    this.pass = null; // during one check(): stamps already taken, by path
  }

  // A stat, taken once per check() pass.
  stat(file) {
    if (this.pass && this.pass.has(file)) return this.pass.get(file);
    const st = fs.statSync(file, { throwIfNoEntry: false }) || null;
    if (this.pass) this.pass.set(file, st);
    return st;
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

  // The note's analysis; `text` is what the caller read of it.
  analyse(file, text) {
    const src = this.source(file);
    const hit = this.notes.get(file);
    if (text === undefined && hit && hit.stamp === src.stamp) return hit.a;
    const a = this.run(text === undefined ? src.text() : text, file);
    this.notes.set(file, { stamp: src.stamp, a });
    return a;
  }

  // An analysis made elsewhere, of the file as it is now (the language
  // server's of an open document).
  remember(file, a) {
    this.notes.set(file, { stamp: this.source(file).stamp, a });
  }

  entries(dir) {
    const st = this.stat(dir);
    const stamp = st ? String(st.mtimeMs) : 'none';
    const hit = this.dirs.get(dir);
    if (hit && hit.stamp === stamp) return hit.names;
    let names = null;
    try {
      names = fs.readdirSync(dir);
    } catch {}
    this.dirs.set(dir, { stamp, names });
    return names;
  }

  // Segment by segment from the root, so that a name the disk spells in
  // another case is seen even where the disk ignores case.
  find(file) {
    if (this.open(file)) return { kind: 'file', actual: file };
    const { root } = path.parse(file);
    let at = root;
    for (const part of file.slice(root.length).split(path.sep).filter(Boolean)) {
      const names = this.entries(at);
      if (!names) return fs.existsSync(file) ? { kind: fs.statSync(file).isDirectory() ? 'dir' : 'file', actual: file } : null;
      const name = names.includes(part) ? part : names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (name === undefined) return null;
      at = path.join(at, name);
    }
    const st = this.stat(at);
    return st ? { kind: st.isDirectory() ? 'dir' : 'file', actual: at } : null;
  }

  ids(file) {
    const src = this.source(file);
    const hit = this.idSets.get(file);
    if (hit && hit.stamp === src.stamp) return hit.ids;
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
    this.idSets.set(file, { stamp: src.stamp, ids });
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

// The note's URLs: [{url, what, position?, filePosition, own}]. `what` names
// it in a message, %s standing for its path; `own` is true for a Tern link
// within the note, which the engine checks.
function urls(a) {
  const out = [];
  const point = (p) => ({ start: p, end: p });
  // The head and the tern.js tag, in file lines; the tag's items at column
  // 1, as addon.failed is.
  const head = uncomment(a.head);
  for (const m of head.matchAll(TAG)) {
    if (m[1].toLowerCase() === 'script' || m[1].toLowerCase() === 'base') continue;
    const span = { start: lineCol(a.head, m.index), end: lineCol(a.head, m.index + m[0].length) };
    for (const u of m[0].matchAll(URL_ATTR)) out.push({ url: decode(u[2] ?? u[3] ?? u[4]), what: `the ${u[1].toLowerCase()} of the head's <${m[1].toLowerCase()}>, %s,`, filePosition: span });
  }
  const attr = (k) => {
    const m = new RegExp(`\\s${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(a.tag);
    return m ? decode(m[1] ?? m[2] ?? m[3]) : null;
  };
  const src = attr('src');
  const tagAt = point({ line: a.line, column: 1 });
  if (src !== null) out.push({ url: src, what: 'the tern.js this note loads, %s,', filePosition: tagAt, tern: true });
  const css = attr('data-css');
  if (css) out.push({ url: css, what: 'the stylesheet in data-css, %s,', filePosition: tagAt });
  for (const entry of (attr('data-use') || '').split(/\s+/).filter(Boolean)) {
    if (/\.css(?:[?#]|$)/i.test(entry)) out.push({ url: entry, what: 'the add-on %s', filePosition: tagAt });
  }

  // The note, in note positions.
  const at = (offset) => {
    const lc = lineCol(a.note, offset);
    return { ...lc, offset };
  };
  const place = (start, end) => {
    const position = { start, end };
    return { position, filePosition: a.toFile(position) };
  };
  tern.visit(a.ast, (node) => {
    if (!node.position) return;
    const pos = (p) => ({ line: p.line, column: p.column, offset: p.offset });
    const [start, end] = [pos(node.position.start), pos(node.position.end)];
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
      out.push({ url: node.url, what: node.type === 'image' ? 'the image %s' : '%s', own: node.type === 'link' && node.url.startsWith('#'), ...place(start, end) });
    }
    if (node.attributes && typeof node.attributes === 'object' && node.type !== 'code') {
      for (const k of URL_KEYS) if (typeof node.attributes[k] === 'string') out.push({ url: node.attributes[k], what: `the ${k} %s`, ...place(start, end) });
    }
    if (node.type === 'html' && typeof node.value === 'string') {
      const value = uncomment(node.value);
      for (const m of value.matchAll(TAG)) {
        const from = node.position.start.offset + m.index;
        for (const u of m[0].matchAll(URL_ATTR)) out.push({ url: decode(u[2] ?? u[3] ?? u[4]), what: `the ${u[1].toLowerCase()} of <${m[1].toLowerCase()}>, %s,`, ...place(at(from), at(from + m[0].length)) });
      }
    }
  });
  return out;
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
    const dest = path.resolve(path.dirname(file), r.path);
    let found = targets.find(dest);
    out.dest = dest;
    if (found && (found.kind === 'dir' || r.path.endsWith('/'))) {
      out.dest = path.join(dest, 'index.html');
      found = targets.find(out.dest);
      if (!found || found.kind !== 'file') return { ...out, problem: 'no-index' };
    }
    if (!found) return { ...out, problem: 'missing' };
    if (found.actual !== out.dest) return { ...out, problem: 'case', actual: path.relative(path.dirname(file), found.actual).split(path.sep).join('/') };
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
  const say = (u, code, message, hint) => out.push({ code, severity: 'warning', message, hint, ...(u.position ? { position: u.position } : {}), filePosition: u.filePosition });
  for (const u of urls(a)) {
    if (u.own) continue;
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

module.exports = { Targets, urls, resolve, check, merge };
