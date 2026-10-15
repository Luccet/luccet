// SPDX-License-Identifier: MIT
// notes.js, Tern's notes add-on (docs/addons.html#notes). A `::notes` leaf
// becomes a list of notes, read from the catalogue `tern index` writes
// (notes.json, docs/tools.html#index): each note's title, linked, its date
// and its description. Nothing is fetched but that one file.
//
//   <script src="tern.js" data-use="addons/notes.js"></script>
//
//   ::notes                              the notes.json next to this page
//   ::notes{from=../notes.json}          that catalogue
//   ::notes{in=BookOfProof/ sort=title limit=10}
//
// `sort` is date (the newest first; undated notes last, in path order),
// title, or path (the catalogue's own order); `in` keeps the notes under a
// folder, a prefix of their path in the catalogue; `limit` caps the list.
// The page itself is left out. The same options go on the add-on
// (`?from=…`) or in window.TERN = {use: {notes: {…}}}; an attribute on the
// leaf wins. Under node (tern check, tern build, the language server) the
// add-on only declares `notes` and adds its styles.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  T.leaf('notes', { tag: 'nav', attrs: { 'aria-label': 'Notes' } });
  T.style(
    [
      '.tern .t-notes { margin-block: 0 1rem; }',
      '.tern .t-notes-list { list-style: none; margin: 0; padding: 0; }',
      '.t-notes-list > li { padding: .55rem 0; border-block-start: 1px solid var(--t-line); }',
      '.t-notes-title { font-weight: 600; text-decoration: none; }',
      '.t-notes-title:hover { text-decoration: underline; }',
      '.t-notes-date { color: var(--t-muted); font-size: .85em; margin-inline-start: .5em; font-family: var(--t-sans); }',
      '.tern .t-notes-desc { margin: .2rem 0 0; font-size: .9em; }',
      '.t-notes-status { color: var(--t-muted); font-size: .85em; }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  const defaults = Object.assign({}, T.config && T.config.use && T.config.use.notes);

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

  const ORDER = {
    date: (a, b) => (b.date || '') < (a.date || '') ? -1 : (b.date || '') > (a.date || '') ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
    title: (a, b) => String(a.title).localeCompare(String(b.title)) || (a.url < b.url ? -1 : 1),
    path: () => 0,
  };

  async function build(host) {
    const attr = (k) => (host.hasAttribute(k) ? host.getAttribute(k) : defaults[k]);
    const o = { from: attr('from') || 'notes.json', in: attr('in') || '', sort: attr('sort') || 'date', limit: Math.max(1, parseInt(attr('limit'), 10) || Infinity) };
    host.classList.add('t-notes');
    const url = new URL(o.from, location.href).href;
    let data;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status}`);
      data = await res.json();
    } catch (e) {
      console.warn(`Tern notes.js: the catalogue ${url} could not be loaded: ${(e && e.message) || e}`);
      data = null;
    }
    if (!data || !Array.isArray(data.notes)) {
      host.replaceChildren(el('p', { class: 't-notes-status', text: `The list of notes could not be loaded (${o.from}).` }));
      return;
    }
    // The page itself is left out: a folder's address (blog/) is its index.html.
    const same = (h) => h.replace(/[?#].*$/, '').replace(/\/$/, '/index.html');
    const page = same(location.href);
    let list = data.notes
      .filter((n) => n && typeof n.url === 'string')
      .map((n) => ({ ...n, href: new URL(n.url, url).href }))
      .filter((n) => same(n.href) !== page);
    if (o.in) list = list.filter((n) => n.url.startsWith(o.in));
    if (ORDER[o.sort] && o.sort !== 'path') list.sort(ORDER[o.sort]);
    list = list.slice(0, o.limit === Infinity ? undefined : o.limit);
    if (!list.length) return void host.replaceChildren(el('p', { class: 't-notes-status', text: 'No notes.' }));
    const ul = el('ul', { class: 't-notes-list' });
    for (const n of list) {
      const li = el('li', null, el('a', { class: 't-notes-title', href: n.href, text: n.title || n.url }));
      if (n.date) li.append(' ', el('time', { class: 't-notes-date', datetime: n.date, text: n.date }));
      if (n.description) li.append(el('p', { class: 't-notes-desc', text: n.description }));
      ul.append(li);
    }
    host.replaceChildren(ul);
  }

  T.define('notes', (host) => {
    if (host.closest('.docs-live-out')) return; // an example's result on the docs stays inert
    build(host);
  });
})();
