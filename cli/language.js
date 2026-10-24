// SPDX-License-Identifier: MIT
// The language features of a note (docs/tools.html#language): an index of
// one analysis, its ids, references and element names at exact columns, and
// definition, references, highlights, hover, rename, completion, symbols,
// folds and the outline over it. `luccet lsp` (cli/lsp.js) maps the answers
// onto the protocol; an editor runs this module in a browser worker, so it
// uses no Node built-ins and requires only the engine and its allowlists.
//
// Positions are LSP's: {line, character}, a 0-based file line and a UTF-16
// column, as the engine's columns are; note line n is file line n + the
// head's line count (cli/note.js). Ranges are {start, end}. Every feature
// takes the index, or null for a file that is not a note.
'use strict';

const luccet = require('../luccet.js');
const { ALLOW } = require('../src/schema'); // the HTML element allowlists, for completion and hover

const IDENT = /^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u; // an id that `{#id}` and `@id` accept
const NAME = /^\p{L}[\p{L}\p{M}\p{N}_-]*$/u;
const LEVEL = { containerDirective: 'block', leafDirective: 'leaf', textDirective: 'inline' };
const USES = new Set(['ref', 'link', 'footnote']); // what references an id
const OPAQUE = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html']); // no Luccet syntax inside
const FOLDS = new Set(['containerDirective', 'code', 'math', 'table', 'list', 'footnoteDefinition']);
const NESTS = new Set(['blockquote', 'list', 'listItem', 'cell', 'footnoteDefinition']); // block parents

const tn = (n) => (n.data && n.data.luccet) || {};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// What a rename or a prepareRename cannot do: code 'invalid' for a new name
// that is not one (LSP -32602), 'refused' for an id it cannot reach (LSP
// -32803). The message says why, for the person renaming.
class LanguageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LanguageError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- the index

// What the features read from one analysis, in the engine's note offsets:
// the registry, the element holding each id and where it is written, and
// every occurrence of an id or a name: its extent [s, e] and the characters
// [from, to) a rename replaces.
// `a` is what cli/note.js `analyse` returns, or the same built by hand:
// {note, line, ast, diagnostics, schema}, with the note's text after the
// luccet.js line, the tag's 1-based file line, the transformed AST, its
// diagnostics (note `position`s; block.unclosed is read) and the schema the
// analysis used (the engine's registry when absent). null gives null. The
// index holds AST nodes: it is built and used where the AST lives.
function index(a) {
  if (!a) return null;
  const { src, starts } = lines(a.note);
  const ids = (a.ast.data && a.ast.data.luccet && a.ast.data.luccet.ids) || {};
  const holders = new Map();
  const occ = [];
  const ends = new Map(); // an end offset -> the innermost container ending there
  luccet.visit(a.ast, (n) => {
    if (!n.position) return false; // copied text: reference text, toc entries
    const t = tn(n);
    const s = n.position.start.offset;
    const e = n.position.end.offset;
    if (n.type === 'ref') occ.push({ kind: 'ref', id: n.id, s, e, from: s + 1, to: s + 1 + n.id.length });
    else if (n.type === 'link') {
      const f = fragment(src, n);
      if (f) occ.push({ kind: 'link', s, e, ...f });
    } else if (n.type === 'footnoteReference' && t.target) occ.push({ kind: 'footnote', id: t.target, s, e, from: s + 2, to: s + 2 + n.label.length });
    if (LEVEL[n.type] && !t.implicit) {
      const np = n.type === 'textDirective' ? { s: s + 1, e: s + 1 + n.name.length } : t.namePosition && { s: t.namePosition.start.offset, e: t.namePosition.end.offset };
      if (np) occ.push({ kind: 'name', node: n, ...np, from: np.s, to: np.e });
      if (n.type === 'containerDirective') ends.set(e, n);
    }
    // The holder of an id is the element the registry records it at.
    const id = n.attributes && n.attributes.id !== undefined ? String(n.attributes.id) : n.type.startsWith('footnote') ? t.id : undefined;
    const r = id !== undefined && own(ids, id) ? ids[id] : null;
    if (r) {
      const w = ((r.explicit && t.idPosition) || n.position).start;
      if (!holders.has(id) || (w.line === r.line && w.column === r.column)) holders.set(id, n);
    }
  });
  // A named closer is read back from the source at its container's end: the
  // AST records neither its position nor whether the container was closed.
  const unclosed = new Set((a.diagnostics || []).filter((d) => d.code === 'block.unclosed' && d.position).map((d) => d.position.start.offset));
  for (const [end, n] of ends) {
    const k = end - n.name.length;
    if (!unclosed.has(n.position.start.offset) && src.slice(k - 4, end) === `:::/${n.name}`) occ.push({ kind: 'closer', node: n, s: k, e: end, from: k, to: end });
  }
  // Declarations: the `#id` or `id=` item; a footnote's `[^label]:`; a slug's
  // heading. A heading is also a hit area for its own id.
  const decls = new Map();
  for (const [id, n] of holders) {
    const t = tn(n);
    const s = n.position.start.offset;
    let d = { id, node: n, s, e: n.position.end.offset, generated: !ids[id].explicit };
    if (ids[id].explicit && t.idPosition) {
      const p = t.idPosition;
      const q = /["']/.test(src[p.start.offset + 3]) && src[p.start.offset] !== '#';
      const from = p.start.offset + (src[p.start.offset] === '#' ? 1 : q ? 4 : 3);
      d = { ...d, s: p.start.offset, e: p.end.offset, from, to: p.end.offset - (q ? 1 : 0) };
    } else if (n.type === 'footnoteDefinition') d = { ...d, e: s + n.label.length + 4, from: s + 2, to: s + 2 + n.label.length };
    else if (n.type === 'heading') d.slug = true;
    decls.set(id, d);
    if (d.from !== undefined) occ.push({ kind: 'decl', id, s: d.s, e: d.e, from: d.from, to: d.to });
    if (n.type === 'heading') occ.push({ kind: 'decl', id, s, e: n.position.end.offset, from: s, to: n.position.end.offset });
  }
  return { line: Number(a.line) || 0, src, starts, schema: a.schema || luccet.schema, ast: a.ast, ids, holders, decls, occ };
}

// A note's text as the parser normalises it, with where its lines start.
function lines(note) {
  const src = String(note ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return { src, starts };
}

// The `#id` of a fragment link as written: after the `](` that ends its text,
// whitespace and an optional `<`. The AST records no destination position.
function fragment(src, n) {
  if (typeof n.url !== 'string' || n.url.length < 2 || n.url[0] !== '#') return null;
  const last = n.children && n.children[n.children.length - 1];
  let k = last && last.position ? last.position.end.offset : n.position.start.offset + 1;
  if (src.slice(k, k + 2) !== '](') return null;
  for (k += 2; /\s/.test(src[k] || ''); ) k++;
  if (src[k] === '<') k++;
  if (src[k] !== '#') return null;
  let e = ++k;
  while (e < n.position.end.offset && !/[\s)>]/.test(src[e])) e++;
  let id = n.url.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // not UTF-8 percent-encoding: compared as written, as the refs transform does
  }
  return { id, from: k, to: e };
}

// Offsets and positions: line l of the note is file line l + d.line.
function point(d, off) {
  const s = d.starts;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + d.line, character: off - s[lo] };
}
const range = (d, s, e) => ({ start: point(d, s), end: point(d, e) });

// A position as a note offset: a column past the line's end is its end; a
// line outside the note (the head, or past the end) is -1.
function offset(d, p) {
  const l = p && p.line - d.line;
  if (!(Number.isInteger(l) && l >= 0 && l < d.starts.length)) return -1;
  const end = l + 1 < d.starts.length ? d.starts[l + 1] - 1 : d.src.length;
  return Math.min(d.starts[l] + Math.max(0, p.character | 0), end);
}

// The innermost occurrence at a position, its end included.
function hit(d, p) {
  const off = d ? offset(d, p) : -1;
  let best = null;
  for (const o of off < 0 ? [] : d.occ) if (o.s <= off && off <= o.e && (!best || o.e - o.s < best.e - best.s)) best = o;
  return best;
}

// ---------------------------------------------------------------- features

// The plain text of inline content, as a title or a label shows it.
function plain(nodes) {
  let s = '';
  for (const n of nodes || []) {
    if (n.type === 'image') s += n.alt || '';
    else if (n.type === 'break') s += ' ';
    else if (n.type === 'ref' && !n.children) s += `@${n.id}`;
    else if (typeof n.value === 'string' && n.type !== 'html') s += n.value;
    else if (n.type !== 'footnoteReference') s += plain(n.children);
  }
  return s;
}
const clip = (s) => ((s = s.replace(/\s+/g, ' ').trim()).length > 80 ? `${s.slice(0, 79)}…` : s);

// What a reference shows of its target: the label and the
// title, "Theorem 2 — Rank–nullity"; a heading's text; an equation's number.
function describe(n) {
  const t = tn(n);
  const kids = n.children || [];
  let title = '';
  if (n.type === 'containerDirective') title = kids[0] && kids[0].data && kids[0].data.directiveLabel ? plain(kids[0].children) : '';
  else if (n.type === 'code') title = t.title ? plain(t.title) : '';
  else if (n.type === 'footnoteDefinition') title = plain(kids[0] && kids[0].children);
  else if (n.type !== 'paragraph' && n.type !== 'table') title = plain(kids);
  const label = n.type === 'footnoteDefinition' && t.number ? `Footnote ${t.number}` : t.text;
  return [label, clip(title)].filter(Boolean).join(' — ');
}
const md = (s) => s.replace(/[\\`*_[\]<>#|]/g, '\\$&');

// idAt(d, pos) -> the id at pos (a reference, a fragment link, a footnote
// reference or a declaration), or null: what references and rename act on.
function idAt(d, pos) {
  const h = hit(d, pos);
  return h && h.id !== undefined ? h.id : null;
}

// declaration(d, id) -> range | null: where the id is declared in the note.
function declaration(d, id) {
  const decl = d && d.decls.get(id);
  return decl ? range(d, decl.s, decl.e) : null;
}

// definition(d, pos) -> range | null: an id's declaration, or a named
// closer's opening name.
function definition(d, pos) {
  const h = hit(d, pos);
  if (!h) return null;
  const to = h.kind === 'closer' ? d.occ.find((o) => o.kind === 'name' && o.node === h.node) : h.id !== undefined && d.decls.get(h.id);
  return to ? range(d, to.s, to.e) : null;
}

// references(d, pos, {includeDeclaration}) -> range[] | null: every use of
// the id at pos, the declaration first on request; null off an id.
function references(d, pos, opts) {
  const h = hit(d, pos);
  if (!h || h.id === undefined) return null;
  const out = d.occ.filter((o) => USES.has(o.kind) && o.id === h.id).map((o) => range(d, o.s, o.e));
  const decl = d.decls.get(h.id);
  if (decl && opts && opts.includeDeclaration) out.unshift(range(d, decl.s, decl.e));
  return out;
}

// highlights(d, pos) -> [{range, kind}] | null: the id at pos, its
// declaration 'write' and its uses 'read', each as references gives it but
// a fragment link's `#id` rather than the whole link; or an element's name
// 'write' and its named closer 'read', as definition goes from one to the
// other.
function highlights(d, pos) {
  const h = hit(d, pos);
  if (!h) return null;
  if (h.node) return d.occ.filter((o) => o.node === h.node).map((o) => ({ range: range(d, o.s, o.e), kind: o.kind === 'name' ? 'write' : 'read' }));
  const out = [];
  const decl = d.decls.get(h.id);
  if (decl) out.push({ range: range(d, decl.s, decl.e), kind: 'write' });
  for (const o of d.occ) if (USES.has(o.kind) && o.id === h.id) out.push({ range: o.kind === 'link' ? range(d, o.from - 1, o.to) : range(d, o.s, o.e), kind: 'read' });
  return out;
}

// hover(d, pos) -> {markdown, range} | null: what a reference reaches (its
// label, title, kind and file line), or what an element name resolves to.
function hover(d, pos) {
  const h = hit(d, pos);
  if (!h) return null;
  let markdown;
  if (h.node) {
    const n = h.node;
    const t = tn(n);
    const level = LEVEL[n.type];
    const how = own(d.schema[level] || {}, n.name) ? 'declared in the schema' : ALLOW[level].has(n.name) ? 'an HTML element' : 'no schema entry';
    const written = `${n.type === 'textDirective' ? ':' : ':'.repeat(t.colons || 2)}${n.name}`;
    markdown = t.tag ? `\`${written}\` → \`<${t.tag}>\`, ${how}${t.text ? ` · ${md(t.text)}` : ''}` : `\`${written}\`, a core block`;
  } else {
    const n = d.holders.get(h.id);
    if (!n) markdown = `\`@${h.id}\` names no id in this note`;
    else markdown = `**${md(describe(n) || h.id)}**\n\n${md(d.ids[h.id].kind)} · \`#${h.id}\` · line ${n.position.start.line + d.line}`;
  }
  return { markdown, range: range(d, h.s, h.e) };
}

// Rename: an id with its declaration and every reference, or one
// element's name with its named closer. Generated ids have nothing to edit.
function target(d, pos) {
  const h = hit(d, pos);
  if (!h) return null;
  if (h.node) return { h, name: h.node.name, occ: d.occ.filter((o) => o.node === h.node) };
  const decl = d.decls.get(h.id);
  if (decl && decl.generated && !decl.slug) throw new LanguageError('refused', `"${h.id}" is generated from a footnote label; it cannot be renamed`);
  return { h, id: h.id, decl };
}

// prepareRename(d, pos) -> {range, placeholder} | null: the characters a
// rename replaces and the name they hold.
function prepareRename(d, pos) {
  const t = target(d, pos);
  return t && { range: range(d, t.h.from, t.h.to), placeholder: t.name || t.id };
}

// rename(d, pos, newName) -> [{range, newText}] | null: the edits, in no
// particular order; none inside code or math, which hold no references.
function rename(d, pos, newName) {
  const t = target(d, pos);
  if (!t) return null;
  const to = newName;
  if (typeof to !== 'string') throw new LanguageError('invalid', 'rename needs a newName');
  const edit = (from, end, newText = to) => ({ range: range(d, from, end), newText });
  if (t.name) {
    if (!NAME.test(to)) throw new LanguageError('invalid', `"${to}" is not an element name: a letter, then letters, digits, _ or -`);
    return t.occ.map((o) => edit(o.from, o.to));
  }
  if (!IDENT.test(to) || to.endsWith('-')) throw new LanguageError('invalid', `"${to}" is not an id @ can reach: a letter or _, then letters, digits, _ or -, not ending in -`);
  if (to !== t.id && own(d.ids, to)) throw new LanguageError('invalid', `the id "${to}" is already used in this note`);
  const edits = [];
  const decl = t.decl;
  if (decl && decl.slug) {
    const attrs = Object.keys(decl.node.attributes || {}).filter((k) => k !== 'id');
    if (attrs.length || tn(decl.node).idPosition) throw new LanguageError('refused', `the heading's id is its slug; write {#${t.id}} in its attribute group first`);
    edits.push(edit(decl.e, decl.e, ` {#${to}}`));
  } else if (decl) edits.push(edit(decl.from, decl.to));
  for (const o of d.occ) if ((o.kind === 'ref' || o.kind === 'link') && o.id === t.id) edits.push(edit(o.from, o.to));
  return edits;
}

// completion(d, pos, now?) -> [{label, kind, detail, sortText, filterText,
// range, newText}]: element names after `:::`, `::` and `:`, the open
// containers' named closers, and ids after `@` or `](#`. Never inside code,
// math, raw HTML or a raw body, which the AST tells. `range` is what the
// item replaces, from the trigger to pos. Kinds: 'name' (the schema), 'core'
// (meta, macros), 'element' (the HTML allowlist), 'closer', 'id'.
// `now`, {note, line}, is the text as it is when the index is of an older
// one (an editor between a keystroke and the next analysis): the trigger and
// the range are read from it, the names, ids, open containers and opaque
// spans from the index, at the same offset.
function completion(d, pos, now) {
  if (!d) return [];
  const cur = now && typeof now.note === 'string' ? { ...lines(now.note), line: Number.isInteger(now.line) ? now.line : d.line } : d;
  const off = offset(cur, pos);
  if (off < 0 || opaque(d, Math.min(off, d.src.length))) return [];
  const bol = cur.starts[pos.line - cur.line];
  const before = cur.src.slice(bol, off);
  const items = [];
  const add = (from, kind, sort) => (label, detail) =>
    items.push({ label, kind, detail, sortText: `${sort}${label}`, filterText: label, range: range(cur, from, off), newText: label });
  let m;
  if ((m = /^[\s>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(:{2,})(\/?)([\p{L}\p{M}\p{N}_-]*)$/u.exec(before))) {
    const from = off - m[2].length - m[3].length;
    if (m[1].length >= 3) {
      const close = add(from, 'closer', '0');
      for (const n of open(d, Math.min(bol, d.src.length))) close(`/${n.name}`, `closes :::${n.name} (line ${n.position.start.line + d.line})`);
      if (!m[2]) names(d, 'block', from, add);
    } else if (!m[2]) names(d, 'leaf', from, add);
  } else if ((m = /(?:^|[^A-Za-z0-9_:/]):([\p{L}\p{M}\p{N}_-]*)$/u.exec(before))) names(d, 'inline', off - m[1].length, add);
  else if ((m = /(?:^|[^A-Za-z0-9_./@-])@([\p{L}\p{M}\p{N}_-]*)$/u.exec(before) || /\]\(#([^\s()<>]*)$/u.exec(before))) {
    const id = add(off - m[1].length, 'id', '');
    for (const k in d.ids) {
      const n = d.holders.get(k);
      if (d.ids[k].kind !== 'footnoteReference' && IDENT.test(k)) id(k, (n && describe(n)) || d.ids[k].kind);
    }
  }
  return items;
}

// The names of a level: the schema (head and add-ons), the core blocks, the allowlist.
function names(d, level, from, add) {
  const seen = new Set();
  const put = (fn) => (name, detail) => seen.has(name) || (seen.add(name), fn(name, detail));
  const schema = d.schema[level] || {};
  const mine = put(add(from, 'name', '1'));
  for (const k of Object.keys(schema)) mine(k, `schema${schema[k] && schema[k].tag ? ` → <${schema[k].tag}>` : ''}`);
  if (level === 'block') for (const k of ['meta', 'macros']) put(add(from, 'core', '2'))(k, 'core');
  for (const k of ALLOW[level]) put(add(from, 'element', '3'))(k, `<${k}>`);
}

// The containers open at a line, innermost first.
function open(d, bol) {
  const out = [];
  luccet.visit(d.ast, (n) => {
    if (!n.position || n.position.start.offset >= bol || n.position.end.offset < bol) return n.type === 'root' ? undefined : false;
    if (n.type === 'containerDirective' && !tn(n).implicit) out.unshift(n);
  });
  return out;
}

// Whether an offset is inside code, math, raw HTML or a raw body.
function opaque(d, off) {
  const line = point(d, off).line - d.line + 1;
  let inside = false;
  luccet.visit(d.ast, (n) => {
    if (inside || !n.position) return false;
    const { start, end } = n.position;
    const holds = start.offset < off && (off < end.offset || (off === end.offset && off === d.src.length)); // an open block runs to the end
    if (n.type !== 'root' && !holds) return false;
    if (OPAQUE.has(n.type) || (typeof n.value === 'string' && LEVEL[n.type] && start.line < line && line < end.line)) inside = true;
  });
  return inside;
}

// actions(d, diag) -> [{title, edits: [{range, newText}], preferred}]: the
// mechanical fixes of one of the note's diagnostics (one with a note
// `position`), none for most. A reference to no id: a near id, or the
// escape its hint suggests; a footnote without a definition: the definition,
// at the end; an unclosed container or display math: its closer, where it
// runs out; an unknown name: a near name of its level; an opener's junk
// that reads as attributes: in braces. `preferred` marks the first choice.
function actions(d, diag) {
  if (!d || !diag || !diag.position) return [];
  const s = diag.position.start.offset;
  const e = diag.position.end.offset;
  const out = [];
  const edit = (from, to, newText) => ({ range: range(d, from, to), newText });
  const act = (title, edits, preferred = false) => out.push({ title, edits, preferred });
  switch (diag.code) {
    case 'ref.dangling': {
      const name = d.src.slice(s + 1, e);
      const ids = Object.keys(d.ids).filter((k) => d.ids[k].kind !== 'footnoteReference' && IDENT.test(k));
      for (const id of near(name, ids)) act(`Change to @${id}`, [edit(s + 1, e, id)], out.length === 0);
      act(`Write \\@${name}: not a reference`, [edit(s, s, '\\')], out.length === 0);
      break;
    }
    case 'footnote.undefined': {
      const label = d.src.slice(s + 2, e - 1);
      const end = d.src.length;
      act(`Add the definition [^${label}]:`, [edit(end, end, `${d.src.endsWith('\n') || !end ? '' : '\n'}\n[^${label}]: `)], true);
      break;
    }
    case 'block.unclosed':
    case 'math.unclosed': {
      const n = nodeAt(d, s, diag.code === 'math.unclosed' ? 'math' : 'containerDirective');
      if (!n) break;
      const closer = diag.code === 'math.unclosed' ? '$$' : `:::/${n.name}`;
      const end = n.position.end.offset;
      act(`Close it with ${closer}`, [edit(end, end, `\n${closer}`)], true);
      break;
    }
    case 'name.unknown': {
      const o = d.occ.find((x) => x.kind === 'name' && x.s === s);
      if (!o) break;
      const level = LEVEL[o.node.type];
      const known = [...new Set([...Object.keys(d.schema[level] || {}), ...(level === 'block' ? ['meta', 'macros'] : []), ...ALLOW[level]])];
      for (const k of near(d.src.slice(s, e), known)) act(`Change to ${k}`, [edit(s, e, k)], out.length === 0);
      break;
    }
    case 'block.opener-junk': {
      const junk = d.src.slice(s, e).trim();
      if (!/^(?:[#.][\p{L}_]|[\p{L}_][\p{L}\p{M}\p{N}_-]*=)/u.test(junk)) break;
      let from = s;
      while (from > 0 && /[ \t]/.test(d.src[from - 1])) from--;
      act(`Write the attributes in braces: {${junk}}`, [edit(from, e, `{${junk}}`)], true);
      break;
    }
  }
  return out;
}

// The node of a type starting at an offset.
function nodeAt(d, off, type) {
  let found = null;
  luccet.visit(d.ast, (n) => {
    if (found || !n.position || n.position.end.offset < off) return found ? false : undefined;
    if (n.type === type && n.position.start.offset === off) found = n;
  });
  return found;
}

// The names near a misspelt one: an edit distance of one, or two for a name
// of five characters or more, two adjacent characters swapped counting one,
// case ignored; the nearest first, at most five.
function near(name, names) {
  const want = name.toLowerCase();
  const limit = want.length >= 5 ? 2 : 1;
  const scored = [];
  for (const k of names) {
    if (k === name) continue;
    const dist = distance(want, k.toLowerCase(), limit);
    if (dist <= limit) scored.push([dist, k]);
  }
  return scored
    .sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .slice(0, 5)
    .map((x) => x[1]);
}

// The edit distance of two strings (a swap of two adjacent characters
// counting one), or limit + 1 when it is past the limit.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let older = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (older && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], older[j - 2] + 1);
      if (row[j] < best) best = row[j];
    }
    if (best > limit) return limit + 1;
    older = prev;
    prev = row;
  }
  return prev[b.length];
}

// symbols(d) -> [{name, detail, kind, range, selectionRange, children}]:
// headings nest by depth, each spanning its section; named containers and
// leaves sit where they are written, a container holding what it contains.
// Kinds: 'heading', 'container', 'leaf'.
function symbols(d) {
  return d ? tree(d, d.ast.children, []) : [];
}

function tree(d, list, out) {
  const open = []; // [depth, symbol] for each heading whose section is open
  let last = 0;
  const close = (depth) => {
    while (open.length && open[open.length - 1][0] >= depth) open.pop()[1].range.end = point(d, last);
  };
  for (const n of list) {
    if (!n.position) continue;
    if (n.type === 'heading') close(n.depth);
    const into = open.length ? open[open.length - 1][1].children : out;
    const s = n.position.start.offset;
    const e = n.position.end.offset;
    const id = n.attributes && n.attributes.id !== undefined ? ` #${n.attributes.id}` : '';
    const symbol = (name, detail, kind) => {
      const r = range(d, s, e);
      const sym = { name: name || '(untitled)', detail, kind, range: r, selectionRange: { ...r }, children: [] };
      return into.push(sym), sym;
    };
    if (n.type === 'heading') open.push([n.depth, symbol(clip(plain(n.children)), `${'#'.repeat(n.depth)}${id}`, 'heading')]);
    else if (n.type === 'containerDirective' || n.type === 'leafDirective') {
      const container = n.type === 'containerDirective';
      const sym = symbol(describe(n) || n.name, `${':'.repeat(tn(n).colons || (container ? 3 : 2))}${n.name}${id}`, container ? 'container' : 'leaf');
      if (container && Array.isArray(n.children)) tree(d, n.children, sym.children);
    } else if (NESTS.has(n.type) && n.children) tree(d, n.children, into);
    last = e;
  }
  close(0);
  return out;
}

// folds(d) -> [{startLine, endLine}], 0-based file lines: containers,
// fences, raw HTML blocks, display math, tables, lists, footnote
// definitions, and heading sections; only what spans two lines or more.
function folds(d) {
  if (!d) return [];
  const out = [];
  const fold = (r) => r.end.line > r.start.line && out.push({ startLine: r.start.line, endLine: r.end.line });
  luccet.visit(d.ast, (n) => {
    if (!n.position) return false;
    if (FOLDS.has(n.type) || (n.type === 'html' && tn(n).kind !== 'inline')) fold(range(d, n.position.start.offset, n.position.end.offset));
  });
  const sections = (list) => {
    for (const s of list) {
      if (s.kind === 'heading') fold(s.range);
      sections(s.children);
    }
  };
  sections(symbols(d));
  return out;
}

// outline(a) -> luccet.outline(a.ast) with every `line` and `endLine` a file
// line, 1-based like the outline's own: the `luccet/outline` notification.
// It takes the analysis, not the index; null gives the empty outline.
function outline(a) {
  const o = luccet.outline(a ? a.ast : { type: 'root', children: [] });
  const line = a ? Number(a.line) || 0 : 0;
  for (const k in o) for (const e of o[k]) (e.line += line), e.endLine && (e.endLine += line);
  return o;
}

module.exports = { index, idAt, declaration, definition, references, highlights, hover, prepareRename, rename, completion, actions, symbols, folds, outline, LanguageError };
