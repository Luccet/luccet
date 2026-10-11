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
//   new Targets()            files as `tern check` reads them, each once:
//     .analyse(file, text?)    cli/note.js analyse(), or null for a non-note
//     .find(file)              {kind: 'file'|'dir', actual} or null, actual
//                              the path as the disk spells it
//     .ids(file)               a Set, or null when the file has no ids to know
//   urls(a)                  the URLs of a note analysed as `a`, with where
//                            they are: [{url, what, position?, filePosition}]
//   resolve(file, url, targets)  what a URL from the note at `file` names, and
//                            its problem, if any
//   check(file, a, targets)  the link diagnostics of the note at `file`,
//                            analysed as `a`, in file order
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

class Targets {
  constructor() {
    this.dirs = new Map(); // dir -> its entries' names, or null
    this.notes = new Map(); // file -> analyse() or null
    this.idSets = new Map(); // file -> Set or null
  }

  analyse(file, text) {
    if (!this.notes.has(file)) {
      if (text === undefined) {
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          text = '';
        }
      }
      this.notes.set(file, analyse(text, file));
    }
    return this.notes.get(file);
  }

  entries(dir) {
    if (!this.dirs.has(dir)) {
      let names = null;
      try {
        names = fs.readdirSync(dir);
      } catch {}
      this.dirs.set(dir, names);
    }
    return this.dirs.get(dir);
  }

  // Segment by segment from the root, so that a name the disk spells in
  // another case is seen even where the disk ignores case.
  find(file) {
    const { root } = path.parse(file);
    let at = root;
    for (const part of file.slice(root.length).split(path.sep).filter(Boolean)) {
      const names = this.entries(at);
      if (!names) return fs.existsSync(file) ? { kind: fs.statSync(file).isDirectory() ? 'dir' : 'file', actual: file } : null;
      const name = names.includes(part) ? part : names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (name === undefined) return null;
      at = path.join(at, name);
    }
    let st;
    try {
      st = fs.statSync(at);
    } catch {
      return null;
    }
    return { kind: st.isDirectory() ? 'dir' : 'file', actual: at };
  }

  ids(file) {
    if (this.idSets.has(file)) return this.idSets.get(file);
    let ids = null;
    if (/\.html?$/i.test(file)) {
      const a = this.analyse(file);
      if (a) {
        ids = new Set(Object.keys(a.ast.data.tern.ids));
        const html = tern.emit(a.ast, { ...a.opts, positions: false });
        for (const m of html.matchAll(/<[a-zA-Z][^<>]*?\sid="([^"]*)"/g)) ids.add(decode(m[1]));
      } else {
        let text = '';
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {}
        ids = new Set();
        for (const m of uncomment(text).matchAll(TAG)) {
          for (const a of m[0].matchAll(/\s(id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
            if (a[1].toLowerCase() === 'id' || m[1].toLowerCase() === 'a') ids.add(decode(a[2] ?? a[3] ?? a[4]));
          }
        }
      }
    } else if (/\.(md|markdown)$/i.test(file)) {
      try {
        ids = markdownAnchors(fs.readFileSync(file, 'utf8'));
      } catch {}
    }
    this.idSets.set(file, ids);
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
    for (const u of m[0].matchAll(URL_ATTR)) out.push({ url: decode(u[2] ?? u[3] ?? u[4]), what: `the ${u[1].toLowerCase()} of the head's <${m[1].toLowerCase()}>, %s,`, filePosition: point(lineCol(a.head, m.index)) });
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
  const place = (start) => {
    const position = point(start);
    return { position, filePosition: a.toFile(position) };
  };
  tern.visit(a.ast, (node) => {
    if (!node.position) return;
    const start = { line: node.position.start.line, column: node.position.start.column, offset: node.position.start.offset };
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
      out.push({ url: node.url, what: node.type === 'image' ? 'the image %s' : '%s', own: node.type === 'link' && node.url.startsWith('#'), ...place(start) });
    }
    if (node.attributes && typeof node.attributes === 'object' && node.type !== 'code') {
      for (const k of URL_KEYS) if (typeof node.attributes[k] === 'string') out.push({ url: node.attributes[k], what: `the ${k} %s`, ...place(start) });
    }
    if (node.type === 'html' && typeof node.value === 'string') {
      const value = uncomment(node.value);
      for (const m of value.matchAll(TAG)) {
        for (const u of m[0].matchAll(URL_ATTR)) out.push({ url: decode(u[2] ?? u[3] ?? u[4]), what: `the ${u[1].toLowerCase()} of <${m[1].toLowerCase()}>, %s,`, ...place(at(node.position.start.offset + m.index)) });
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
  const key = (d) => [d.filePosition.start.line, d.filePosition.start.column];
  return out.sort((x, y) => key(x)[0] - key(y)[0] || key(x)[1] - key(y)[1]);
}

module.exports = { Targets, urls, resolve, check };
