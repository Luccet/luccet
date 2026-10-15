// SPDX-License-Identifier: MIT
// search.js, Tern's search add-on (docs/addons.html#search). A `::search` leaf
// becomes a search box over a set of notes. Indexed in the browser, the
// notes are fetched, parsed by the engine with the page's own vocabulary,
// and split into entries — every heading's section and every named block
// with an id (an exercise, a theorem …) — so a hit links straight to its
// place. With `index=`, the same index is read from the search.json that
// `tern index` wrote (docs/tools.html#index): one file, no note fetched.
// The pipeline is the engine's `tern.search` (docs/api.html#search), which
// `tern search` runs on files; this file fetches and draws.
//
//   <script src="tern.js" data-use="addons/search.js"></script>
//
//   ::search                        the notes this page links to
//   ::search{from=index.html}       the notes that page links to
//   ::search{notes="a.html b.html"} these notes
//   ::search{index=search.json}     the notes that index holds
//
// `limit` caps the results (20), `placeholder` sets the box's. The same
// options go on the add-on (`?from=index.html`) or in window.TERN = {use:
// {search: {…}}}; an attribute on the leaf wins. `?q=` in the page's URL
// fills the box, and typing keeps it up to date. An index that cannot be
// loaded, or was written by another version series of tern.js (its stems
// are the stemmer's), is reported in the console and the notes are indexed
// here instead, from `notes`, `from` or the page's links.
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
  // This page's URL, as a link to it reads: a folder's address (blog/) is its index.html.
  const same = (h) => h.replace(/[?#].*$/, '').replace(/\/$/, '/index.html');
  const page = () => same(location.href);

  // A URL the add-on fetches or links to is http(s), or the page's own
  // scheme when it is opened from a file. An entry of an index resolves
  // against the index file and must stay on its origin: tern index writes
  // paths, so a crafted file cannot send a reader to javascript:, data: or
  // another site. Each URL refused is said once in the console.
  const SCHEMES = new Set(['http:', 'https:', location.protocol]);
  const fetchable = (u) => SCHEMES.has(u.protocol);
  const refused = new Set();
  function linkTo(url, base) {
    let u = null;
    try {
      u = new URL(url, base);
    } catch {}
    if (u && fetchable(u) && u.origin === new URL(base).origin) return u.href;
    if (!refused.has(url)) refused.add(url), console.warn(`Tern search.js: ${url} in the index is not a page of this site; left out`);
    return null;
  }

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
      if (same(key) === page() || seen.has(key)) return;
      seen.add(key);
    };
    if (o.notes) {
      for (const n of String(o.notes).split(/[\s,]+/).filter(Boolean)) add(n, location.href);
    } else if (o.from) {
      const base = new URL(o.from, location.href);
      if (!fetchable(base)) {
        console.warn(`Tern search.js: from=${o.from} is not an http(s) page; no note indexed`);
        return [];
      }
      const got = await load(base.href);
      if (got) for (const url of got.links) add(url, base.href);
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
    const d = S.describe(head, ast);
    const title = d.title || url.replace(/^.*\//, '');
    return { url, title, links: d.links, records: S.records(ast, { url, title }) };
  }

  // A search.json `tern index` wrote, read: {notes, entries, terms, lengths,
  // avg}, or null when it cannot be used, with the reason in the console.
  const series = (v) => String(v).split('.').slice(0, 2).join('.');
  async function loadIndex(url) {
    let data;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status}`);
      data = await res.json();
    } catch (e) {
      console.warn(`Tern search.js: the index ${url} could not be loaded (${(e && e.message) || e}); indexing the notes here`);
      return null;
    }
    if (!data || !Array.isArray(data.entries) || !data.terms || typeof data.terms !== 'object' || !Array.isArray(data.lengths)) {
      console.warn(`Tern search.js: ${url} is not a search index written by tern index; indexing the notes here`);
      return null;
    }
    if (series(data.tern) !== series(T.version)) {
      console.warn(`Tern search.js: ${url} was written by tern ${data.tern} and this page runs ${T.version}: run tern index again; indexing the notes here`);
      return null;
    }
    return data;
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
    const o = { notes: attr('notes'), from: attr('from'), index: attr('index'), limit: Math.max(1, parseInt(attr('limit'), 10) || 20), placeholder: attr('placeholder') || 'Search the notes' };
    host.classList.add('t-search');
    const box = el('input', { type: 'search', class: 't-search-box', placeholder: o.placeholder, 'aria-label': o.placeholder, autocomplete: 'off' });
    const status = el('p', { class: 't-search-status', role: 'status', text: 'Indexing…' });
    const results = el('ol', { class: 't-search-results', 'aria-live': 'polite' });
    host.replaceChildren(box, status, results);

    // The index: the file `index=` names, else built here from the notes.
    let idx = null;
    let base = location.href; // what the entries' URLs are relative to
    let ready;
    const indexURL = o.index ? new URL(o.index, location.href) : null;
    let data = null;
    if (indexURL && !fetchable(indexURL)) console.warn(`Tern search.js: index=${o.index} is not an http(s) file; indexing the notes here`);
    else if (indexURL) data = await loadIndex(indexURL.href);
    let titleOf;
    if (data) {
      idx = data;
      base = indexURL.href;
      titleOf = new Map((data.notes || []).map((n) => [n.url, n.title]));
      const n = (data.notes || []).length;
      ready = `${n} note${n === 1 ? '' : 's'}, ${idx.entries.length} entries`;
    } else {
      const urls = await noteList(host, o);
      const notes = (await Promise.all(urls.map(load))).filter(Boolean);
      const entries = notes.flatMap((n) => n.records);
      idx = S.index(entries);
      const skipped = urls.length - notes.length;
      ready = `${notes.length} note${notes.length === 1 ? '' : 's'}, ${entries.length} entries${skipped ? `; ${skipped} could not be read` : ''}`;
      titleOf = new Map(notes.map((n) => [n.url, n.title]));
    }
    status.textContent = ready;

    const show = (q) => {
      results.replaceChildren();
      if (!q.trim()) return void (status.textContent = ready);
      const hits = S.query(idx, q, { limit: o.limit })
        .map((h) => ({ ...h, href: linkTo(h.entry.url, base) }))
        .filter((h) => h.href);
      status.textContent = hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'No results';
      for (const { entry, matched, href } of hits) {
        const title = [entry.label, entry.title].filter(Boolean).join(' ');
        const link = el('a', { href: `${href}${entry.id ? `#${entry.id}` : ''}` }, el('span', { class: 't-search-label t-search-title', text: title }), el('span', { class: 't-search-page', text: titleOf.get(entry.url) || '' }));
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

  // A box that cannot be built (a malformed index= or from=, an index that
  // throws while it is read) says so in place and in the console, instead
  // of staying at "Indexing…" with an unhandled rejection.
  T.define('search', (host) => {
    if (host.closest('.docs-live-out')) return; // an example's result on the docs stays inert
    build(host).catch((e) => {
      const why = (e && e.message) || String(e);
      console.warn(`Tern search.js: the search box could not be set up: ${why}`);
      const status = host.querySelector('.t-search-status') || host.appendChild(el('p', { class: 't-search-status', role: 'status' }));
      status.textContent = `The search could not be set up (${why}).`;
    });
  });
})();
