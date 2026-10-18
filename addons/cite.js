// SPDX-License-Identifier: MIT
// cite.js, Tern's citations add-on (docs/addons.html#cite). A
// `:::bibliography` container holds the sources, BibTeX or CSL-JSON, in the
// note; `@key` cites one and reads "[1]" (or "(Knuth, 1984)" with
// style=author-year); the block lists the cited sources, formatted in one
// plain style, numbered in the list's order. No new syntax: a citation is a
// reference, so the engine's rules for `@id`, `ref=` and dangling references
// apply, and `tern check` and `tern build` see the same list as the browser.
//
//   <script src="tern.js" data-use="addons/cite.js"></script>
//
//   :::bibliography
//   @article{knuth84,
//     author = {Knuth, Donald E.}, title = {Literate programming},
//     journal = {The Computer Journal}, volume = 27, number = 2,
//     pages = {97--111}, year = 1984, doi = {10.1093/comjnl/27.2.97}}
//   :::
//
//   As @knuth84 showed …          → As [1] showed …
//
//   :::bibliography[Sources]{style=author-year sort=cited all}
//   [{"id": "knuth84", "type": "article-journal", "title": "…",
//     "author": [{"family": "Knuth", "given": "Donald E."}],
//     "issued": {"date-parts": [[1984]]}}]
//   :::
//
// Options on the block: style=numeric (the default; "[1]") or author-year
// ("(Knuth, 1984)"; `@key{ref=label}` reads "Knuth (1984)"); sort=author
// (the default: by the first author's family name, then year, then title),
// cited (the order of first citation) or source (as written); `all` lists
// every source, not only the cited ones. The heading is the title written in
// the brackets, else "References" in the note's label language.
//
// A shared bibliography: a head script before tern.js sets window.TERN.bib to
// the same text (BibTeX or CSL-JSON) or to an array of CSL items; the note's
// first `:::bibliography` lists from it too (an empty body: from it alone).
// tern.js reads the head in the browser and the command line runs it under
// node, so both see it.
//
// Diagnostics, at the entry's line: cite.syntax (warning) for an entry that
// cannot be read, cite.duplicate (warning) for a key given twice, and
// cite.key (warning) for a key `@` cannot reach, and
// cite.empty (info) for a bibliography with no source at all. A `@key` that
// names no source is the engine's ref.dangling.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  // ---------------------------------------------------------------- vocabulary

  const WORDS = { en: 'References', de: 'Literatur', fr: 'Références', es: 'Referencias', it: 'Riferimenti', pt: 'Referências', nl: 'Referenties' };
  T.block('bibliography', { tag: 'section', body: 'raw', attrs: { role: 'doc-bibliography' } });
  T.block('bib-list', { tag: 'ul', attrs: { role: 'list' } });
  // An entry: counted, so `@key` reads its number; the label is "[n]" in the
  // numeric style and nothing in author-year, which the entry's class says.
  T.leaf('bib', {
    tag: 'li',
    counter: 'bib',
    label: (n, node) => (node && node.attributes && /(?:^|\s)author-year(?:\s|$)/.test(String(node.attributes.class || '')) ? '' : `[${n}]`),
    ref: '{label}',
  });
  T.style(
    [
      '.tern .bibliography > .bib-list { list-style: none; margin: 0; padding: 0; }',
      '.tern .bib { margin: .4rem 0; padding-inline-start: 2.4em; text-indent: -2.4em; }',
      '.tern .bib.author-year { padding-inline-start: 1.6em; text-indent: -1.6em; }',
      '.tern .bib > .t-label { font-weight: normal; }',
      '.tern a.cite { text-decoration: none; }',
      '.tern a.cite:hover { text-decoration: underline; }',
    ].join('\n'),
  );

  // ---------------------------------------------------------------- LaTeX text

  // A BibTeX value as plain text: braces removed, accents composed, the
  // common commands and ligatures resolved, `--` an en dash, `~` a no-break
  // space, other commands dropped with their backslash.
  const ACCENT = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', d: '̣', r: '̊' };
  const NAMED = { LaTeX: 'LaTeX', TeX: 'TeX', BibTeX: 'BibTeX', ss: 'ß', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', ldots: '…', dots: '…', textendash: '–', textemdash: '—' };
  function latex(s) {
    let t = String(s);
    t = t.replace(/\\([`'^"~=.uvHckdr])\s*\{\\?([ij])\}/g, (_, a, c) => c + ACCENT[a]); // \'{\i}
    t = t.replace(/\\([`'^"~=.uvHckdr])\s*\{?([A-Za-z])\}?/g, (_, a, c) => c + ACCENT[a]);
    t = t.replace(/\\([A-Za-z]+)/g, (_, w) => (w in NAMED ? NAMED[w] : '')); // \emph{x} keeps x; an unknown command goes
    t = t.replace(/\\([&%$#_{}])/g, '$1');
    t = t.replace(/[{}]/g, '').replace(/~/g, ' ').replace(/---/g, '—').replace(/--/g, '–').replace(/\s+/g, ' ').trim();
    return t.normalize('NFC');
  }

  // ---------------------------------------------------------------- BibTeX

  const MONTHS = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };

  // Parses BibTeX into [{key, type, fields, line}] and problems [{line,
  // message}]. @comment and @preamble are skipped, @string defines macros;
  // values are {braced}, "quoted", bare numbers or macro names, joined by #.
  function bibtex(text) {
    const entries = [];
    const problems = [];
    const macros = Object.assign(Object.create(null), MONTHS);
    const lineOf = (i) => {
      let n = 1;
      for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++;
      return n;
    };
    let i = 0;
    const n = text.length;
    const ws = () => {
      while (i < n && /\s/.test(text[i])) i++;
    };
    // A brace-balanced run from text[i] === '{', returned without its braces.
    const braced = () => {
      let depth = 0;
      const start = i;
      for (; i < n; i++) {
        const c = text[i];
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return text.slice(start + 1, i++);
      }
      throw new Error('a brace is not closed');
    };
    const quoted = () => {
      const start = ++i;
      let depth = 0;
      for (; i < n; i++) {
        const c = text[i];
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' && depth === 0) return text.slice(start, i++);
      }
      throw new Error('a quote is not closed');
    };
    // A value: pieces joined by #.
    const value = () => {
      let out = '';
      for (;;) {
        ws();
        const c = text[i];
        if (c === '{') out += braced();
        else if (c === '"') out += quoted();
        else {
          const m = /^[^\s,#}()]+/.exec(text.slice(i, i + 200));
          if (!m) throw new Error(i < n ? `unexpected "${text[i]}"` : 'the entry ends early');
          i += m[0].length;
          const w = m[0];
          out += /^\d+$/.test(w) ? w : w.toLowerCase() in macros ? macros[w.toLowerCase()] : w;
        }
        ws();
        if (text[i] !== '#') return out;
        i++;
      }
    };
    while (i < n) {
      const at = text.indexOf('@', i);
      if (at < 0) break;
      i = at + 1;
      const line = lineOf(at);
      const tm = /^[A-Za-z]+/.exec(text.slice(i, i + 60));
      if (!tm) {
        problems.push({ line, message: '"@" is not followed by an entry type' });
        continue;
      }
      const type = tm[0].toLowerCase();
      i += type.length;
      ws();
      const open = text[i];
      if (open !== '{' && open !== '(') {
        problems.push({ line, message: `@${type} is not followed by "{"` });
        continue;
      }
      const close = open === '{' ? '}' : ')';
      try {
        if (type === 'comment' || type === 'preamble') {
          if (open === '{') braced();
          else i = text.indexOf(close, i) + 1 || n;
          continue;
        }
        i++;
        ws();
        if (type === 'string') {
          const m = /^[^\s=]+/.exec(text.slice(i, i + 200));
          if (!m) throw new Error('@string has no name');
          i += m[0].length;
          ws();
          if (text[i] !== '=') throw new Error('@string has no "="');
          i++;
          macros[m[0].toLowerCase()] = value();
          ws();
          if (text[i] === close) i++;
          continue;
        }
        const km = /^[^\s,{}()]+/.exec(text.slice(i, i + 200));
        if (!km) throw new Error('the entry has no key');
        const key = km[0];
        i += key.length;
        ws();
        const fields = Object.create(null);
        while (i < n) {
          if (text[i] === close) {
            i++;
            break;
          }
          if (text[i] !== ',') throw new Error(`unexpected "${text[i]}" after ${Object.keys(fields).length ? 'a field' : 'the key'}`);
          i++;
          ws();
          if (text[i] === close) {
            i++;
            break;
          }
          const fm = /^[A-Za-z][\w-]*/.exec(text.slice(i, i + 200));
          if (!fm) throw new Error(`unexpected "${text[i] || 'end'}" where a field name should be`);
          i += fm[0].length;
          ws();
          if (text[i] !== '=') throw new Error(`the field ${fm[0]} has no "="`);
          i++;
          fields[fm[0].toLowerCase()] = value();
          ws();
        }
        entries.push({ key, type, fields, line });
      } catch (e) {
        problems.push({ line, message: (e && e.message) || String(e) });
        // Resume at the next entry after this one's start.
        const next = text.indexOf('\n@', at + 1);
        i = next < 0 ? n : next + 1;
      }
    }
    return { entries, problems };
  }

  // A BibTeX name list: "Last, First and First Last and others", split on
  // " and " outside braces.
  function names(s) {
    const t = String(s);
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (depth === 0 && /\s/.test(c)) {
        const m = /^\s+and\s+/i.exec(t.slice(i));
        if (m) {
          parts.push(cur);
          cur = '';
          i += m[0].length - 1;
          continue;
        }
      }
      cur += c;
    }
    parts.push(cur);
    const out = [];
    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      if (/^others$/i.test(p)) {
        out.push({ others: true });
        continue;
      }
      if (/^\{[^{}]*\}$/.test(p)) {
        out.push({ family: latex(p), given: '' }); // {Barnes and Noble}: one name
        continue;
      }
      const comma = p.indexOf(',');
      if (comma >= 0) {
        const segs = p.split(',').map((x) => latex(x));
        out.push({ family: segs[0], given: segs[segs.length - 1], suffix: segs.length > 2 ? segs[1] : '' });
      } else {
        const words = latex(p).split(' ').filter(Boolean);
        let k = words.length - 1;
        while (k > 0 && /^\p{Ll}/u.test(words[k - 1])) k--; // "van der Berg": the particles go with the family
        out.push({ family: words.slice(k).join(' '), given: words.slice(0, k).join(' ') });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- CSL-JSON

  const CSL_TYPE = { 'article-journal': 'article', 'article-magazine': 'article', 'article-newspaper': 'article', article: 'article', book: 'book', chapter: 'incollection', 'paper-conference': 'inproceedings', thesis: 'thesis', report: 'techreport', webpage: 'misc', post: 'misc', 'post-weblog': 'misc' };
  function csl(items) {
    const entries = [];
    const problems = [];
    items.forEach((it, k) => {
      if (!it || typeof it !== 'object') return void problems.push({ line: 1, message: `item ${k + 1} is not an object` });
      const id = it.id == null ? '' : String(it.id);
      if (!id) return void problems.push({ line: 1, message: `item ${k + 1} has no id` });
      const people = (list) => (Array.isArray(list) ? list.map((p) => (p && typeof p === 'object' ? (p.literal ? { family: String(p.literal), given: '' } : { family: String(p.family || ''), given: String(p.given || '') }) : { family: String(p), given: '' })) : []);
      const year = it.issued && Array.isArray(it.issued['date-parts']) && it.issued['date-parts'][0] ? String(it.issued['date-parts'][0][0] || '') : it.issued && (it.issued.raw || it.issued.literal) ? String(it.issued.raw || it.issued.literal) : '';
      const s = (k2) => (it[k2] == null ? '' : String(it[k2]));
      entries.push({
        key: id,
        type: CSL_TYPE[String(it.type || '').toLowerCase()] || 'misc',
        source: {
          authors: people(it.author),
          editors: people(it.editor),
          title: s('title'),
          container: s('container-title'),
          volume: s('volume'),
          number: s('issue') || s('number'),
          pages: s('page'),
          publisher: s('publisher'),
          year,
          doi: s('DOI'),
          url: s('URL'),
          note: s('note'),
          genre: s('genre'),
          edition: s('edition'),
          institution: s('publisher'),
        },
        line: 1,
      });
    });
    return { entries, problems };
  }

  // A BibTeX entry's fields as the same source shape.
  function fromBibtex(e) {
    const f = e.fields;
    const get = (k) => (k in f ? latex(f[k]) : '');
    const type = /^(?:phdthesis|mastersthesis|thesis)$/.test(e.type) ? 'thesis' : /^(?:inproceedings|conference)$/.test(e.type) ? 'inproceedings' : e.type;
    let year = get('year');
    if (!year && f.date) year = (/\d{4}/.exec(latex(f.date)) || [''])[0];
    return {
      key: e.key,
      type,
      line: e.line,
      source: {
        authors: f.author ? names(f.author) : [],
        editors: f.editor ? names(f.editor) : [],
        title: get('title'),
        container: get('journal') || get('booktitle') || get('journaltitle'),
        volume: get('volume'),
        number: get('number') || get('issue'),
        pages: get('pages'),
        publisher: get('publisher'),
        year,
        doi: get('doi'),
        url: get('url'),
        note: get('note') || get('howpublished'),
        genre: get('type') || (e.type === 'phdthesis' ? 'PhD thesis' : e.type === 'mastersthesis' ? "Master's thesis" : ''),
        edition: get('edition'),
        institution: get('institution') || get('school') || get('organization'),
      },
    };
  }

  // ---------------------------------------------------------------- the style

  const initials = (given) =>
    given
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.split('-').map((p) => (p ? `${p[0]}.` : '')).join('-'))
      .join(' ');
  const oneName = (p) => (p.given ? `${p.family}, ${initials(p.given)}${p.suffix ? `, ${p.suffix}` : ''}` : p.family);
  // "A", "A and B", "A, B, and C", "A, B, et al."
  function nameList(list) {
    const etal = list.some((p) => p.others);
    const ps = list.filter((p) => !p.others).map(oneName);
    if (etal) return ps.length ? `${ps.join(', ')}${ps.length > 1 ? ',' : ''} et al.` : 'et al.';
    if (ps.length <= 2) return ps.join(' and ');
    return `${ps.slice(0, -1).join(', ')}, and ${ps[ps.length - 1]}`;
  }
  // "Knuth", "Knuth and Lamport", "Knuth et al." for a citation.
  function shortNames(list) {
    const ps = list.filter((p) => !p.others).map((p) => p.family);
    const etal = list.some((p) => p.others) || ps.length > 2;
    if (!ps.length) return '';
    if (ps.length === 2 && !etal) return `${ps[0]} and ${ps[1]}`;
    return etal ? `${ps[0]} et al.` : ps[0];
  }

  const txt = (value) => ({ type: 'text', value });
  const em = (value) => ({ type: 'emphasis', children: [txt(value)] });
  const link = (url, value) => ({ type: 'link', url, children: [txt(value)] });
  const dash = (s) => s.replace(/\s*--?\s*/g, '–');
  const pp = (pages) => `${/[–,]/.test(pages) ? 'pp.' : 'p.'} ${pages}`;

  // The entry's inline content, one plain style:
  //   Authors (Year). Title. *Container*, Volume(Number), Pages. Publisher. DOI/URL
  function format(e) {
    const s = e.source;
    const out = [];
    let text = '';
    const push = (v) => {
      if (v) text += v;
    };
    const flush = () => {
      if (text) out.push(txt(text));
      text = '';
    };
    const who = nameList(s.authors.length ? s.authors : s.editors);
    const yr = s.year || 'n.d.';
    if (who) push(`${who}${s.authors.length ? '' : ' (Ed.)'} (${yr}). `);
    const title = s.title || e.key;
    const vol = s.volume ? `${s.volume}${s.number ? `(${s.number})` : ''}` : s.number ? `(${s.number})` : '';
    const pages = s.pages ? dash(s.pages) : '';
    switch (e.type) {
      case 'article':
        push(`${title}. `);
        if (s.container) {
          flush();
          out.push(em(s.container));
          push(vol ? `, ${vol}` : '');
          push(pages ? `, ${pages}` : '');
          push('. ');
        } else if (pages) push(`${pages}. `);
        break;
      case 'book':
        flush();
        out.push(em(title));
        push(s.edition ? ` (${s.edition} ed.)` : '');
        push('. ');
        push(s.publisher ? `${s.publisher}. ` : '');
        break;
      case 'incollection':
      case 'inproceedings':
        push(`${title}. `);
        if (s.container) {
          push('In ');
          flush();
          out.push(em(s.container));
          push(pages ? ` (${pp(pages)})` : '');
          push('. ');
        } else if (pages) push(`${pp(pages)}. `);
        push(s.publisher ? `${s.publisher}. ` : '');
        break;
      case 'thesis':
        flush();
        out.push(em(title));
        push(` [${[s.genre || 'Thesis', s.institution].filter(Boolean).join(', ')}]. `);
        break;
      case 'techreport':
        push(`${title}${s.number ? ` (${s.number})` : ''}. `);
        push(s.institution ? `${s.institution}. ` : '');
        break;
      default:
        push(`${title}. `);
        if (s.container) {
          flush();
          out.push(em(s.container));
          push(vol ? `, ${vol}` : '');
          push(pages ? `, ${pages}` : '');
          push('. ');
        }
        push(s.publisher ? `${s.publisher}. ` : '');
        push(s.note ? `${s.note}. ` : '');
    }
    if (!who) push(`(${yr}). `);
    flush();
    if (s.doi) {
      const doi = s.doi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, '');
      out.push(link(`https://doi.org/${doi}`, `https://doi.org/${doi}`));
    } else if (s.url) out.push(link(s.url, s.url));
    // A trailing space before nothing, and "..": tidied.
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.value = last.value.replace(/\s+$/, '').replace(/\.\.$/, '.');
    return out;
  }

  // ---------------------------------------------------------------- the transforms

  // The language of the heading: the exact tag, its primary subtag, then English.
  function word(lang) {
    const want = String(lang || '').toLowerCase();
    return WORDS[want] || WORDS[want.split('-')[0]] || WORDS.en;
  }

  const isBib = (n) => n && n.type === 'containerDirective' && n.name === 'bibliography';
  const IDENT = /^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u; // what `@` reaches (docs/syntax-inline.html#ref-extent)
  const isTitle = (n) => !!n && n.type === 'paragraph' && !!n.data && n.data.directiveLabel === true;

  // Walks the tree (tern.visit is absent under node).
  function walk(node, fn) {
    if (!node || typeof node !== 'object') return;
    fn(node);
    const kids = node.children;
    if (Array.isArray(kids)) for (const k of kids) walk(k, fn);
  }

  // Reads a bibliography's sources: the body, then window.TERN.bib. Returns
  // {entries, problems}, lines being the body's (1-based) or 0 for TERN.bib.
  function read(text, fromPage) {
    const out = { entries: [], problems: [] };
    const take = (src, offset) => {
      let r;
      if (Array.isArray(src)) r = csl(src);
      else {
        const t = String(src == null ? '' : src).trim();
        if (!t) return;
        if (t[0] === '[' || t[0] === '{') {
          let data;
          try {
            data = JSON.parse(t);
          } catch (e) {
            return void out.problems.push({ line: offset ? 1 : 0, message: `the CSL-JSON does not parse: ${(e && e.message) || e}` });
          }
          r = csl(Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : [data]);
        } else {
          r = bibtex(t);
          r.entries = r.entries.map(fromBibtex);
        }
      }
      for (const e of r.entries) out.entries.push(Object.assign(e, { line: offset ? e.line + offset - 1 : 0 }));
      for (const p of r.problems) out.problems.push({ line: offset ? p.line + offset - 1 : 0, message: p.message });
    };
    // The body's first non-blank line is where its text starts.
    const lead = /^\s*/.exec(text)[0];
    take(text, 1 + (lead.match(/\n/g) || []).length);
    if (fromPage !== undefined) take(fromPage, 0);
    return out;
  }

  const sortKey = (e) => {
    const s = e.source;
    const who = (s.authors.length ? s.authors : s.editors).filter((p) => !p.others)[0];
    return `${who ? who.family : s.title}\u0000${s.year}\u0000${s.title}`.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  };

  // Before `attributes`: each :::bibliography's raw body becomes its heading
  // and a list of entry leaves, which the engine then counts, ids and
  // references like any element.
  T.transform(
    'cite',
    (ast, ctx) => {
      const blocks = [];
      const cited = []; // ids in order of first citation
      const seen = new Set();
      walk(ast, (n) => {
        if (isBib(n) && typeof n.value === 'string') blocks.push(n);
        else if (n.type === 'ref' && typeof n.id === 'string' && !seen.has(n.id)) seen.add(n.id), cited.push(n.id);
      });
      if (!blocks.length) return;
      // The page's sources (window.TERN.bib) go with the first block alone,
      // so two blocks never list the same entry.
      let page = typeof window !== 'undefined' && window.TERN && typeof window.TERN === 'object' ? window.TERN.bib : undefined;
      for (const b of blocks) {
        const a = b.attributes || (b.attributes = {});
        const style = a.style === 'author-year' ? 'author-year' : 'numeric';
        const sort = a.sort === 'cited' || a.sort === 'source' ? a.sort : 'author';
        const all = 'all' in a;
        delete a.style, delete a.sort, delete a.all;
        const body = b.value;
        delete b.value;
        const startLine = b.position ? b.position.start.line : 0;
        const offset = b.position ? b.position.start.offset : 0;
        const { entries, problems } = read(body, page);
        page = undefined;
        const bodyLines = body.split('\n');
        // Where body line k starts: file line startLine + k, column 1. Its
        // offset counts the body's text from the opener's start, without the
        // opener's own length (unknown here): below the true offset, but in
        // order with every other position, which is what the sort needs.
        const starts = [offset + 1];
        for (const l of bodyLines) starts.push(starts[starts.length - 1] + l.length + 1);
        const span = (line) => {
          if (!(line > 0 && startLine)) return undefined;
          const l = startLine + line;
          const len = (bodyLines[line - 1] || '').length;
          const o = starts[line - 1] || offset;
          return { start: { line: l, column: 1, offset: o }, end: { line: l, column: len + 1, offset: o + len } };
        };
        const at = (line) => span(line) || b;
        for (const p of problems) ctx.report('cite.syntax', at(p.line), `the source${p.line ? '' : ' in window.TERN.bib'} cannot be read: ${p.message}; it is left out`, 'write the entry as BibTeX (@type{key, field = {value}, …}) or CSL-JSON', 'warning');
        if (!entries.length && !problems.length) ctx.report('cite.empty', b, 'the bibliography has no source', 'put BibTeX or CSL-JSON entries in the block, or set window.TERN.bib in a head script', 'info');
        const byKey = new Map();
        for (const e of entries) {
          if (byKey.has(e.key)) ctx.report('cite.duplicate', at(e.line), `the key "${e.key}" is given twice; the second entry is left out`, 'give each source its own key', 'warning');
          else byKey.set(e.key, e);
          if (!IDENT.test(e.key)) {
            ctx.report('cite.key', at(e.line), `the key "${e.key}" cannot be cited: @ reaches a key that starts with a letter or _ and holds only letters, digits, _ and -`, 'rename the key, in the entry and where it is cited', 'warning');
            e.unreachable = true;
          }
        }
        let list = [...byKey.values()];
        if (!all) list = list.filter((e) => seen.has(e.key));
        if (sort === 'author') list.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
        else if (sort === 'cited') {
          const rank = new Map(cited.map((id, i) => [id, i]));
          list.sort((x, y) => (rank.has(x.key) ? rank.get(x.key) : Infinity) - (rank.has(y.key) ? rank.get(y.key) : Infinity) || (sortKey(x) < sortKey(y) ? -1 : 1));
        }
        const title = b.children.find(isTitle);
        const kids = [];
        if (title) kids.push(title);
        else kids.push({ type: 'paragraph', data: { directiveLabel: true }, children: [txt(word(ctx.lang))] });
        if (list.length) {
          kids.push({
            type: 'containerDirective',
            name: 'bib-list',
            attributes: {},
            children: list.map((e) => ({
              type: 'leafDirective',
              name: 'bib',
              attributes: Object.assign(e.unreachable ? {} : { id: e.key }, { class: style === 'author-year' ? 'author-year' : 'numeric' }),
              children: format(e),
              data: { cite: { style, source: e.source } },
              position: span(e.line),
            })),
          });
        }
        b.children = kids;
        b.data = b.data || {};
        b.data.cite = { style, entries: list.length, all, sort };
      }
    },
    { before: 'attributes' },
  );

  // After `refs`: a reference to an entry reads as a citation. Numeric:
  // "[n]" (ref=number "n"); author-year: "(Knuth, 1984)" (ref=label "Knuth
  // (1984)", ref=number the year); ref=title the title; ref=full the
  // citation and the title. The link gets the class `cite`.
  T.transform(
    'cite-text',
    (ast) => {
      const entries = new Map();
      walk(ast, (n) => {
        if (n.type === 'leafDirective' && n.name === 'bib' && n.data && n.data.cite && n.attributes && n.attributes.id) entries.set(n.attributes.id, n);
      });
      if (!entries.size) return;
      walk(ast, (n) => {
        if (n.type !== 'ref' || !entries.has(n.id)) return;
        const e = entries.get(n.id);
        const t = e.data && e.data.tern;
        const number = t && t.number != null ? String(t.number) : '';
        const { style, source: s } = e.data.cite;
        const sel = n.data && n.data.tern ? n.data.tern.ref : undefined;
        const who = shortNames(s.authors.length ? s.authors : s.editors) || s.title || n.id;
        const yr = s.year || 'n.d.';
        let text;
        if (style === 'numeric') text = sel === 'number' ? number : sel === 'title' ? s.title || n.id : sel === 'full' ? `[${number}] ${s.title || n.id}` : `[${number}]`;
        else text = sel === 'label' ? `${who} (${yr})` : sel === 'number' ? yr : sel === 'title' ? s.title || n.id : sel === 'full' ? `${who} (${yr}). ${s.title || n.id}` : `(${who}, ${yr})`;
        n.children = [txt(text)];
        const a = n.attributes || (n.attributes = {});
        a.class = a.class ? `${a.class} cite` : 'cite';
      });
    },
    { after: 'refs' },
  );
})();
