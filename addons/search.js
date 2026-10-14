// SPDX-License-Identifier: MIT
// search.js, Tern's search add-on (docs/addons.html#search). A `::search` leaf
// becomes a search box over a set of notes, indexed in the browser: the notes
// are fetched, parsed by the engine with the page's own vocabulary, and split
// into entries — every heading's section and every named block with an id
// (an exercise, a theorem …) — so a hit links straight to its place. The
// pipeline is the engine's `tern.search` (docs/api.html#search), which
// `tern search` runs on files; this file fetches and draws.
//
//   <script src="tern.js" data-use="addons/search.js"></script>
//
//   ::search                        the notes this page links to
//   ::search{from=index.html}       the notes that page links to
//   ::search{notes="a.html b.html"} these notes
//
// `limit` caps the results (20), `placeholder` sets the box's. The same
// options go on the add-on (`?from=index.html`) or in window.TERN = {use:
// {search: {…}}}; an attribute on the leaf wins. `?q=` in the page's URL
// fills the box, and typing keeps it up to date.
//
// Matching is lexical: words are stemmed lightly and a query word matches
// the words it begins (`pythag` finds Pythagoras and Pythagorean), scored
// BM25-style with a boost for a hit in an entry's title. TeX is searched as
// written (`sqrt` finds \sqrt). Load the vocabulary the notes use on the
// search page too, so their blocks parse as they do on their own pages.
//
// Only the notes listed or linked are fetched — nothing else is read — and
// nothing leaves the browser. Under node (tern check, tern build, the
// language server) the add-on only declares `search` and adds its styles.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  T.leaf('search', { tag: 'search', attrs: { role: 'search' } });
  T.style(
    [
      '.tern .t-search { margin-block: 0 1rem; font-family: var(--t-sans); }',
      '.t-search-box { font: inherit; inline-size: 100%; box-sizing: border-box; padding: .5rem .75rem; color: var(--t-fg); background: var(--t-bg); border: 1px solid var(--t-line); border-radius: 6px; }',
      '.t-search-box:focus-visible { outline: 2px solid var(--t-link); outline-offset: 2px; }',
      '.t-search-status { color: var(--t-muted); font-size: .85em; margin-block: .4rem 0; }',
      '.tern .t-search-results { list-style: none; margin: .75rem 0 0; padding: 0; }',
      '.t-search-results > li { padding: .55rem 0; border-block-start: 1px solid var(--t-line); }',
      '.t-search-results a { text-decoration: none; }',
      '.t-search-results a:hover .t-search-title { text-decoration: underline; }',
      '.t-search-label { font-weight: 600; color: var(--t-link); }',
      '.t-search-page { color: var(--t-muted); font-size: .85em; margin-inline-start: .5em; }',
      '.tern .t-search-snippet { margin: .2rem 0 0; font-family: var(--t-font); font-size: .9em; color: var(--t-fg); }',
      '.t-search-snippet mark { background: var(--t-mark); color: inherit; padding: 0 .1em; border-radius: 2px; }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM || !T.search) return;

  const S = T.search;
  const defaults = Object.assign({}, T.config && T.config.use && T.config.use.search);

  // ---------------------------------------------------------------- the notes

  const isNote = (url) => /\.html?$/i.test(url.pathname);
  const page = () => location.href.replace(/[?#].*$/, '');

  // The note URLs an element asks for: its `notes`, else the links of `from`
  // (a page parsed as a note), else the links of this page.
  async function noteList(el, o) {
    const seen = new Set();
    const add = (href, base) => {
      let u;
      try {
        u = new URL(href, base);
      } catch {
        return;
      }
      if (u.origin !== location.origin || !isNote(u)) return;
      const key = u.href.replace(/[?#].*$/, '');
      if (key === page() || seen.has(key)) return;
      seen.add(key);
    };
    if (o.notes) {
      for (const n of String(o.notes).split(/[\s,]+/).filter(Boolean)) add(n, location.href);
    } else if (o.from) {
      const base = new URL(o.from, location.href).href;
      const got = await load(base);
      if (got) for (const url of got.links) add(url, base);
    } else {
      const main = el.closest('.tern') || document;
      for (const a of main.querySelectorAll('a[href]')) if (!el.contains(a)) add(a.getAttribute('href'), location.href);
    }
    return [...seen];
  }

  // A note fetched and parsed: {url, title, links, records} or null.
  const TAG = /<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*tern\.js(?:[?#][^"]*)?"|'[^']*tern\.js(?:[?#][^']*)?'|[^\s"'>]*tern\.js[^\s"'>]*)[^>]*>/i;
  async function load(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status}`);
      text = await res.text();
    } catch (e) {
      console.warn(`Tern search.js: ${url} could not be fetched: ${(e && e.message) || e}`);
      return null;
    }
    const m = TAG.exec(text);
    if (!m) {
      console.warn(`Tern search.js: ${url} is not a note (no tern.js tag)`);
      return null;
    }
    const nl = text.indexOf('\n', m.index + m[0].length);
    const head = text.slice(0, m.index);
    const note = nl < 0 ? '' : text.slice(nl + 1).replace(/\r\n?/g, '\n');
    let ast;
    try {
      ast = T.parse(note, { head }).ast;
      T.transform(ast, { head });
    } catch (e) {
      console.warn(`Tern search.js: ${url} could not be parsed: ${(e && e.message) || e}`);
      return null;
    }
    const title = S.title(head, ast) || url.replace(/^.*\//, '');
    const links = [];
    T.visit(ast, (n) => {
      if (n.type === 'link' && typeof n.url === 'string') links.push(n.url);
    });
    return { url, title, links, records: S.records(ast, { url, title }) };
  }

  // ---------------------------------------------------------------- the widget

  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };

  // The snippet as a paragraph, the matching words marked.
  function snippet(text, matched) {
    const s = S.snippet(text, matched);
    const p = el('p', { class: 't-search-snippet' });
    let last = 0;
    for (const [a, b] of s.marks) {
      if (a > last) p.append(s.text.slice(last, a));
      p.append(el('mark', null, s.text.slice(a, b)));
      last = b;
    }
    if (last < s.text.length) p.append(s.text.slice(last));
    return p;
  }

  async function build(host) {
    const attr = (k) => (host.hasAttribute(k) ? host.getAttribute(k) : defaults[k]);
    const o = { notes: attr('notes'), from: attr('from'), limit: Math.max(1, parseInt(attr('limit'), 10) || 20), placeholder: attr('placeholder') || 'Search the notes' };
    host.classList.add('t-search');
    const box = el('input', { type: 'search', class: 't-search-box', placeholder: o.placeholder, 'aria-label': o.placeholder, autocomplete: 'off' });
    const status = el('p', { class: 't-search-status', role: 'status', text: 'Indexing…' });
    const results = el('ol', { class: 't-search-results', 'aria-live': 'polite' });
    host.replaceChildren(box, status, results);

    const urls = await noteList(host, o);
    const notes = (await Promise.all(urls.map(load))).filter(Boolean);
    const entries = notes.flatMap((n) => n.records);
    const idx = S.index(entries);
    const skipped = urls.length - notes.length;
    const ready = `${notes.length} note${notes.length === 1 ? '' : 's'}, ${entries.length} entries${skipped ? `; ${skipped} could not be read` : ''}`;
    status.textContent = ready;

    const titleOf = new Map(notes.map((n) => [n.url, n.title]));
    const show = (q) => {
      results.replaceChildren();
      if (!q.trim()) return void (status.textContent = ready);
      const hits = S.query(idx, q, { limit: o.limit });
      status.textContent = hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'No results';
      for (const { entry, matched } of hits) {
        const href = entry.id ? `${entry.url}#${entry.id}` : entry.url;
        const title = [entry.label, entry.title].filter(Boolean).join(' ');
        const link = el('a', { href }, el('span', { class: 't-search-label t-search-title', text: title }), el('span', { class: 't-search-page', text: titleOf.get(entry.url) || '' }));
        results.append(el('li', null, link, snippet(entry.text || entry.title || entry.label, matched)));
      }
    };
    let timer = 0;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        show(box.value);
        const u = new URL(location.href);
        if (box.value) u.searchParams.set('q', box.value);
        else u.searchParams.delete('q');
        history.replaceState(null, '', u);
      }, 80);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = results.querySelector('a');
      if (first) (e.preventDefault(), (location.href = first.href));
    });
    const q = new URL(location.href).searchParams.get('q');
    if (q) (box.value = q), show(q);
  }

  T.define('search', (host) => {
    if (host.closest('.docs-live-out')) return; // an example's result on the docs stays inert
    build(host);
  });
})();
