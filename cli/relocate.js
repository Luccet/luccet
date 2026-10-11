// SPDX-License-Identifier: MIT
// What moving files and folders asks of the notes, for tern mv
// (docs/tools.html#mv): the text edits that keep every relative URL
// pointing where it did. Two kinds:
//   - a URL into a moved file or folder, from any note;
//   - a moved note's own relative URLs: its targets stay, but the note
//     moves, so its links, images, tern.js, add-ons and head scripts are
//     written from its new folder.
// An edit replaces the path of one URL as written (cli/links.js urls),
// keeping its query and fragment, its quotes or <…>, and whether it
// percent-escapes; nothing else in the file changes, and its line breaks
// stay its own. Pure: paths and texts in, edits out. Notes are parsed, not
// transformed, so their add-ons do not run.
//
//   relocate(notes, moves) -> [{file, moved, edits, base, lost}], for the
//                             notes with an edit or a URL left alone
//     notes  [{file, text}], absolute paths before the move
//     moves  [{from, to}], absolute paths; a folder moves with what it holds
//     moved  the note's path after the move
//     edits  [{from, to, text, was, line, column}]: from and to are offsets
//            in the text as given; line and column are the file's, 1-based
//     base   true when the note has a <base href>: its URLs do not resolve
//            from its folder, so they are left alone
//     lost   [{line, column, url}]: URLs that move but whose writing could
//            not be found, left alone
//   apply(text, edits) -> the text with the edits made
'use strict';

const path = require('path');
const links = require('./links');

function relocate(notes, moves) {
  const map = (p) => {
    for (const m of moves) {
      if (p === m.from) return m.to;
      if (p.startsWith(m.from + path.sep)) return m.to + p.slice(m.from.length);
    }
    return p;
  };
  const out = [];
  for (const { file, text } of notes) {
    const a = links.parsed(text);
    if (!a) continue;
    const moved = map(file);
    const norm = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const start = { head: 0, tag: a.head.length, note: norm.length - a.note.length };
    const base = /<base\s[^<>]*\bhref\s*=/i.test(a.head.replace(/<!--[\s\S]*?(?:-->|$)/g, ''));
    const edits = [];
    const lost = [];
    let based = false;
    for (const u of links.urls(a)) {
      const r = links.parse(u.url);
      if (!r || !r.path) continue;
      const old = path.resolve(path.dirname(file), r.path);
      const target = map(old);
      if (target === old && moved === file) continue;
      if (base) {
        based = true;
        continue;
      }
      if (!u.span) {
        lost.push({ ...u.filePosition.start, url: u.url });
        continue;
      }
      const from = start[u.span.in] + u.span.from;
      const written = norm.slice(from, start[u.span.in] + u.span.to);
      const was = written.slice(0, pathEnd(written));
      let rel = path.relative(path.dirname(moved), target).split(path.sep).join('/') || '.';
      if (was.endsWith('/') && !rel.endsWith('/')) rel += '/';
      if (was.startsWith('./') && !rel.startsWith('.')) rel = `./${rel}`;
      const now = encode(rel, was, u.span.quote);
      if (now !== was) edits.push({ from, to: from + was.length, text: now, was });
    }
    if (!edits.length && !based && !lost.length) continue;
    const raw = rawOffsets(String(text), norm);
    for (const e of edits) {
      const lc = lineCol(norm, e.from);
      Object.assign(e, { from: raw(e.from), to: raw(e.to), line: lc.line, column: lc.column });
    }
    out.push({ file, moved, edits, base: based, lost });
  }
  return out;
}

// Where a URL's path ends as written: at its first ? or # not escaped.
function pathEnd(written) {
  for (let i = 0; i < written.length; i++) {
    if (written[i] === '\\') i++;
    else if (written[i] === '?' || written[i] === '#') return i;
  }
  return written.length;
}

// A path written as the URL it replaces was: percent-escaped if that one
// was; otherwise as it is, with only what its place cannot hold escaped (a
// space in a bare destination, a quote in a quoted value, ? and #, which
// would start a query or a fragment).
function encode(rel, was, quote) {
  const segments = rel.split('/');
  if (/%[0-9a-f]{2}/i.test(was)) return segments.map((s) => (s === '.' || s === '..' ? s : encodeURIComponent(s))).join('/');
  const unsafe = { '"': /["?#%]/g, "'": /['?#%]/g, '<': /[<>\n?#%]/g, ' ': /[\s"'?#%]/g, '': /[\s"'<>{}?#%]/g }[quote] || /[\s?#%]/g;
  let out = rel.replace(unsafe, (c) => encodeURIComponent(c));
  if (quote === '' && out.split('(').length !== out.split(')').length) out = out.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  return out;
}

// Offsets in the normalised text (no BOM, \n line breaks) as offsets in
// the text as given.
function rawOffsets(raw, norm) {
  if (raw === norm) return (n) => n;
  const at = new Array(norm.length + 1);
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let n = 0; n < norm.length; n++) {
    at[n] = i;
    i += raw[i] === '\r' && raw[i + 1] === '\n' ? 2 : 1;
  }
  at[norm.length] = raw.length;
  return (n) => at[n];
}

function lineCol(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}

function apply(text, edits) {
  let out = text;
  for (const e of [...edits].sort((x, y) => y.from - x.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

module.exports = { relocate, apply };
