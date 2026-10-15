// SPDX-License-Identifier: MIT
// Search over notes (docs/api.html#search): the pipeline behind the search
// add-on (addons/search.js), `tern search` and `tern index`. records()
// splits a transformed AST into entries — one per heading's section and one
// per named block with an id — index() builds a lexical index over the
// entries of any number of notes, query() ranks them BM25-style, snippet()
// cuts a passage around the first hit; describe() is what a catalogue of
// notes holds for one. Pure functions over the tree and plain data: the
// add-ons fetch and draw, the command line reads and writes files.
//
// An index is written out by `tern index` and read back by the add-on and
// `tern search --index`, so its stems must be the reader's: the stemmer
// changes only in a minor release, and an index records the version that
// wrote it (its `tern`); a reader of the same major and minor can use it.
'use strict';

const { decode } = require('./entities');

// The plain text of a node's content: words, code and TeX as written; raw
// HTML and footnote marks left out; an image by its alt; a hard break a
// space.
function plain(node) {
  if (!node) return '';
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'inlineMath':
    case 'code':
    case 'math':
      return node.value || '';
    case 'image':
      return node.alt || '';
    case 'break':
      return ' ';
    case 'html':
    case 'footnoteReference':
      return '';
    default:
      return (node.children || []).map(plain).join(node.type === 'paragraph' || node.type === 'heading' ? '' : ' ');
  }
}

const entities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, body) => decode(body) ?? m);

// title(head, ast) -> the note's title: the head's <title>, else the
// `:::meta` title, else the first heading's text, else ''.
function title(head, ast) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(head || '');
  if (m && m[1].trim()) return entities(m[1].trim());
  const meta = (ast && ast.data && ast.data.tern && ast.data.tern.meta) || {};
  if (meta.title) return String(meta.title);
  const h = ((ast && ast.children) || []).find((n) => n.type === 'heading');
  return h ? plain(h) : '';
}

// headMeta(head) -> the head's <meta name="…" content="…"> pairs, the names
// in lower case, the first of a name winning, entities decoded.
function headMeta(head) {
  const out = Object.create(null);
  for (const tag of String(head || '').match(/<meta\b[^>]*>/gi) || []) {
    const attr = (name) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return m ? [m[1], m[2], m[3]].find((x) => x !== undefined) : undefined;
    };
    const n = attr('name');
    const c = attr('content');
    if (n !== undefined && c !== undefined && !(n.toLowerCase() in out)) out[n.toLowerCase()] = entities(c);
  }
  return out;
}

// describe(head, ast) -> {title, description, meta, headings, links}: what a
// catalogue of notes holds for one (`tern index`, docs/tools.html#index).
// `title` is title()'s; `description` the head's <meta name="description">,
// else `:::meta`'s, else ''; `meta` the `:::meta` keys with the head's
// <meta> names over them (the head wins, as the engine resolves a conflict),
// a plain object; `headings` every heading, [{depth, id, text}], in order;
// `links` the URLs the note's links name, as written, each once, in order,
// a link to a fragment of the note itself left out.
function describe(head, ast) {
  const block = (ast && ast.data && ast.data.tern && ast.data.tern.meta) || {};
  const meta = Object.assign({}, block, headMeta(head));
  const headings = [];
  const links = [];
  const seen = new Set();
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type === 'heading') headings.push({ depth: c.depth, id: (c.attributes && c.attributes.id) || '', text: plain(c) });
      else if (c.type === 'link' && typeof c.url === 'string' && c.url && !c.url.startsWith('#') && !seen.has(c.url)) (seen.add(c.url), links.push(c.url));
      if (c.children) walk(c);
    }
  };
  walk(ast || {});
  return { title: title(head, ast), description: String(meta.description || '').trim(), meta, headings, links };
}

const lineOf = (n) => (n.position && n.position.start ? n.position.start.line : undefined);
const endLineOf = (n) => (n.position && n.position.end ? n.position.end.line : undefined);

// records(ast, {url, title}) -> entries [{url, id, line, endLine, kind,
// label, title, text}]: one per heading's section and one per named block
// with an id; a block's text is its own, not its section's, and a block
// without an id gives its text to the entry it is in. `kind` is 'page'
// (the text before the first heading), 'heading', or the block's name;
// `label` is the heading's text or the block's label ("Exercise 3"), and
// `title` a block's bracket title. Lines are note lines, 1-based. An entry
// with nothing to search is left out.
function records(ast, { url = '', title: pageTitle = '' } = {}) {
  const out = [];
  const entry = (id, line, endLine, kind, label, blockTitle) => {
    const r = { url, id, line, endLine, kind, label, title: blockTitle, text: [] };
    out.push(r);
    return r;
  };
  let current = entry('', 1, endLineOf(ast), 'page', pageTitle, '');
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type === 'heading') {
        current = entry((c.attributes && c.attributes.id) || '', lineOf(c), undefined, 'heading', plain(c), '');
        continue;
      }
      if (c.type === 'containerDirective' && c.attributes && c.attributes.id) {
        const tern = (c.data && c.data.tern) || {};
        const titleNode = (c.children || []).find((k) => k.type === 'paragraph' && k.data && k.data.directiveLabel);
        const r = entry(c.attributes.id, lineOf(c), endLineOf(c), c.name, tern.text || c.name, titleNode ? plain(titleNode) : '');
        const outer = current;
        current = r;
        walk({ children: (c.children || []).filter((k) => k !== titleNode) });
        current = outer;
        continue;
      }
      if (c.type === 'paragraph' && c.data && c.data.directiveLabel) continue;
      if (c.type === 'footnoteDefinition' || c.type === 'html') continue;
      if (c.children && !['paragraph', 'heading', 'tableCell'].includes(c.type)) {
        walk(c);
        continue;
      }
      const s = plain(c).trim();
      if (s) current.text.push(s);
    }
  };
  walk(ast);
  // A heading's section ends where the next entry at the top level starts.
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind === 'heading' && out[i].endLine === undefined) {
      const next = out.slice(i + 1).find((r) => r.kind === 'heading' && r.line !== undefined);
      out[i].endLine = next ? next.line - 1 : endLineOf(ast);
    }
  }
  for (const r of out) {
    r.text = r.text.join('\n');
    if (r.endLine === undefined) delete r.endLine;
    if (r.line === undefined) delete r.line;
  }
  return out.filter((r) => r.text || r.title || r.kind !== 'page');
}

// ---------------------------------------------------------------- words

const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1);

// A light stem, the same for a word and its forms: plurals, -ed and -ing
// lose their ending, and a final e goes, so "prove", "proves", "proved"
// and "triangle", "triangles" meet ("prov", "triangl"). A query is stemmed
// the same way and then stands for every indexed stem it begins.
function stem(w) {
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:[sxz]|[cs]h)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && /[^su]s$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
const tokens = (s) => words(s).map(stem);

// ---------------------------------------------------------------- the index

// index(entries) -> {entries, terms, lengths, avg}: plain data, so an index
// can be written out and read back. `terms` maps a stem to [[entry index,
// weight], …]; a word in an entry's label or title weighs 3. The maps have
// no prototype: a note's "constructor" or "toString" is a word like any.
function index(entries) {
  const terms = Object.create(null);
  const lengths = [];
  entries.forEach((e, i) => {
    const body = tokens(e.text);
    const head = tokens(`${e.label} ${e.title}`);
    lengths.push(body.length + head.length);
    const count = new Map();
    for (const t of body) count.set(t, (count.get(t) || 0) + 1);
    for (const t of head) count.set(t, (count.get(t) || 0) + 3);
    for (const [t, n] of count) (terms[t] || (terms[t] = [])).push([i, n]);
  });
  const avg = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  return { entries, terms, lengths, avg };
}

// query(index, text, {limit}) -> [{entry, score, matched}], best first:
// BM25, each query word standing for every indexed stem it begins, an exact
// stem weighing a little more. `matched` lists the stems the hit matched.
function query(idx, text, { limit = 20 } = {}) {
  const q = [...new Set(tokens(text))];
  if (!q.length) return [];
  const N = idx.entries.length;
  // Own keys only: an index read back from JSON has a prototype again.
  const keys = Object.keys(idx.terms);
  const own = (k) => Object.prototype.hasOwnProperty.call(idx.terms, k);
  const scores = new Map();
  const matched = new Set();
  for (const w of q) {
    const expand = keys.filter((k) => own(k) && k.startsWith(w));
    if (!expand.length) continue;
    const docs = new Set();
    for (const k of expand) for (const [i] of idx.terms[k]) docs.add(i);
    const idf = Math.log(1 + (N - docs.size + 0.5) / (docs.size + 0.5));
    for (const k of expand) {
      matched.add(k);
      const exact = k === w ? 1.25 : 1;
      for (const [i, tf] of idx.terms[k]) {
        const len = idx.lengths[i] / (idx.avg || 1);
        const s = idf * exact * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * len)));
        scores.set(i, (scores.get(i) || 0) + s);
      }
    }
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit === Infinity ? undefined : limit)
    .map(([i, score]) => ({ entry: idx.entries[i], score, matched: [...matched] }));
}

// snippet(text, matched, {width}) -> {text, marks}: a passage of about
// `width` characters around the first word that matched, with `…` where it
// is cut, and the [start, end) ranges in it of every matching word.
function snippet(text, matched, { width = 160 } = {}) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const list = [...matched];
  const re = list.length ? new RegExp(`[\\p{L}\\p{N}]*(?:${list.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\p{L}\\p{N}]*`, 'giu') : null;
  const hits = (s) => {
    const out = [];
    if (!re) return out;
    for (const m of s.matchAll(re)) {
      const w = m[0].toLowerCase();
      if (list.some((k) => stem(w) === k || w.startsWith(k))) out.push([m.index, m.index + m[0].length]);
    }
    return out;
  };
  const first = hits(flat)[0];
  let start = first ? Math.max(0, first[0] - Math.floor(width / 3)) : 0;
  let end = Math.min(flat.length, start + width);
  if (end - start < width) start = Math.max(0, end - width);
  // Cut on word boundaries where there is room.
  if (start > 0) {
    const sp = flat.indexOf(' ', start);
    if (sp > 0 && sp < (first ? first[0] : end)) start = sp + 1;
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(' ', end);
    if (sp > (first ? first[1] : start)) end = sp;
  }
  const pre = start > 0 ? '…' : '';
  const piece = flat.slice(start, end);
  const marks = hits(piece).map(([a, b]) => [a + pre.length, b + pre.length]);
  return { text: `${pre}${piece}${end < flat.length ? '…' : ''}`, marks };
}

module.exports = { plain, title, describe, records, stem, tokens, index, query, snippet };
