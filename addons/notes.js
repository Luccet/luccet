// SPDX-License-Identifier: MIT
// notes.js, Luccet's notes add-on (docs/addons.html#notes). A `::notes` leaf
// becomes a list of notes, read from the catalogue `luccet index` writes
// (notes.json, docs/tools.html#index): each note's title, linked, its date
// and its description. Nothing is fetched but that one file.
//
//   <script src="luccet.js" data-use="addons/notes.js"></script>
//
//   ::notes                              the notes.json next to this page
//   ::notes{from=../notes.json}          that catalogue
//   ::notes{in=BookOfProof/ sort=title limit=10}
//
// `sort` is date (the newest first; undated notes last, in path order),
// title, or path (the catalogue's own order); `in` keeps the notes under a
// folder, a prefix of their path in the catalogue; `limit` caps the list (0
// lists none). A date that is not a date (YYYY-MM-DD, with a time allowed)
// is shown as written, sorts last and gets no <time datetime>.
// The page itself is left out. The same options go on the add-on
// (`?from=…`) or in window.LUCCET = {use: {notes: {…}}}; an attribute on the
// leaf wins. Under node (luccet check, luccet build, the language server) the
// add-on only declares `notes` and adds its styles.
(function () {
  'use strict';
  const T = window.luccet;
  if (!T) return;

  // The list's words: window.LUCCET.strings[key] over these (luccet.string; the
  // command line's shim has the fallback alone).
  const str = (key, params, fallback) => (T.string ? T.string(key, params, fallback) : fallback);
  T.leaf('notes', { tag: 'nav', attrs: { 'aria-label': str('notes', {}, 'Notes') } });
  T.style(
    [
      '.luccet .t-notes { margin-block: 0 1rem; }',
      '.luccet .t-notes-list { list-style: none; margin: 0; padding: 0; }',
      '.t-notes-list > li { padding: .55rem 0; border-block-start: 1px solid var(--t-line); }',
      '.t-notes-title { font-weight: 600; text-decoration: none; }',
      '.t-notes-title:hover { text-decoration: underline; }',
      '.t-notes-date { color: var(--t-muted); font-size: .85em; margin-inline-start: .5em; font-family: var(--t-sans); }',
      '.luccet .t-notes-desc { margin: .2rem 0 0; font-size: .9em; }',
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

  // A date as the catalogue is meant to carry it: YYYY-MM-DD, a time after it allowed.
  const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  const dated = (n) => (typeof n.date === 'string' && ISO.test(n.date.trim()) ? n.date.trim() : '');
  const ORDER = {
    date: (a, b) => (dated(b) < dated(a) ? -1 : dated(b) > dated(a) ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    title: (a, b) => String(a.title).localeCompare(String(b.title)) || (a.url < b.url ? -1 : 1),
    path: () => 0,
  };

  // The catalogue is fetched from http(s), or the page's own scheme when it
  // is opened from a file. An entry resolves against the catalogue and must
  // stay on its origin: luccet index writes paths, so a crafted file cannot
  // send a reader to javascript:, data: or another site.
  const SCHEMES = new Set(['http:', 'https:', location.protocol]);
  const fetchable = (u) => SCHEMES.has(u.protocol);
  function linkTo(url, base) {
    let u = null;
    try {
      u = new URL(url, base);
    } catch {}
    if (u && fetchable(u) && u.origin === new URL(base).origin) return u.href;
    console.warn(`Luccet notes.js: ${url} in the catalogue is not a page of this site; left out`);
    return null;
  }

  async function build(host) {
    const attr = (k) => (host.hasAttribute(k) ? host.getAttribute(k) : defaults[k]);
    const given = parseInt(attr('limit'), 10);
    const o = { from: attr('from') || 'notes.json', in: attr('in') || '', sort: attr('sort') || 'date', limit: Number.isFinite(given) && given >= 0 ? given : Infinity };
    host.classList.add('t-notes');
    let url = null;
    try {
      url = new URL(o.from, location.href);
    } catch {}
    let data = null;
    if (!url || !fetchable(url)) console.warn(`Luccet notes.js: from=${o.from} is not an http(s) file`);
    else {
      try {
        const res = await fetch(url.href, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${res.status}`);
        data = await res.json();
      } catch (e) {
        console.warn(`Luccet notes.js: the catalogue ${url.href} could not be loaded: ${(e && e.message) || e}`);
      }
    }
    if (!data || !Array.isArray(data.notes)) {
      host.replaceChildren(el('p', { class: 't-notes-status', text: str('notesFailed', { from: o.from }, 'The list of notes could not be loaded ({from}).') }));
      return;
    }
    // The page itself is left out: a folder's address (blog/) is its
    // index.html, and a page without its extension (blog/post) is the page.
    const same = (h) => h.replace(/[?#].*$/, '').replace(/\/$/, '/index.html').replace(/\.html?$/i, '');
    const page = same(location.href);
    let list = data.notes
      .filter((n) => n && typeof n.url === 'string')
      .map((n) => ({ ...n, href: linkTo(n.url, url.href) }))
      .filter((n) => n.href && same(n.href) !== page);
    if (o.in) list = list.filter((n) => n.url.startsWith(o.in));
    if (ORDER[o.sort] && o.sort !== 'path') list.sort(ORDER[o.sort]);
    list = list.slice(0, o.limit === Infinity ? undefined : o.limit);
    if (!list.length) return void host.replaceChildren(el('p', { class: 't-notes-status', text: str('noNotes', {}, 'No notes.') }));
    const ul = el('ul', { class: 't-notes-list', role: 'list' }); // no bullets, so it says it is a list
    for (const n of list) {
      const li = el('li', null, el('a', { class: 't-notes-title', href: n.href, text: n.title || n.url }));
      if (n.date) li.append(' ', dated(n) ? el('time', { class: 't-notes-date', datetime: dated(n), text: n.date }) : el('span', { class: 't-notes-date', text: String(n.date) }));
      if (n.description) li.append(el('p', { class: 't-notes-desc', text: n.description }));
      ul.append(li);
    }
    host.replaceChildren(ul);
  }

  // A list that cannot be built says so in place and in the console, instead
  // of staying empty with an unhandled rejection.
  T.define('notes', (host) => {
    if (host.closest('.docs-live-out')) return; // an example's result on the docs stays inert
    build(host).catch((e) => {
      const why = (e && e.message) || String(e);
      console.warn(`Luccet notes.js: the list could not be built: ${why}`);
      host.replaceChildren(el('p', { class: 't-notes-status', text: str('notesFailed', { from: why }, 'The list of notes could not be built ({from}).') }));
    });
  });
})();
