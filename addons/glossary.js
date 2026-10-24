// SPDX-License-Identifier: MIT
// glossary.js, Luccet's glossary add-on (docs/addons.html#glossary). A
// `::glossary` leaf lists the terms the notes of a folder define, read from
// glossary.json, which `luccet index` writes beside notes.json: each term,
// linked to where it is defined, with its definition rendered as on its own
// page (its links lead back there; its formulas are typeset by the page's
// math add-on). `:term[…]` marks a use of a term and links it to the
// glossary page's entry. A term is defined by `:dfn[…]`, HTML's element for
// the defining instance of a word, whose paragraph is the definition, or by
// a titled `:::definition` block (luccet.glossary, docs/api.html#glossary).
//
//   <script src="luccet.js" data-use="addons/glossary.js"></script>
//
//   A :dfn[truism] is a claim so obviously true that it goes without saying.
//
//   :::definition[Kernel]
//   The set of vectors $v$ with $T(v) = 0$.
//   :::
//
//   ::glossary                              glossary.json next to this page
//   ::glossary{from=../wiki/glossary.json in=algebra/}
//
//   Every :term[truism] …                   → a link to glossary.html#glossary-truism
//   :term[kernels]{title=kernel}            the canonical form, as on dfn
//
// Options: `from=` names the file, `in=FOLDER` keeps the terms of the notes
// under a folder, a prefix of their path in the file; `page=` is the
// glossary page a `:term` links to, as a link in the note would be written
// (`glossary.html` by default; give a root-relative path for notes in
// several folders). Options go on the leaf, on the add-on (`?page=…`) or in
// window.LUCCET = {use: {glossary: {…}}}; the leaf's win. The link is in the
// page `luccet check` and `luccet build` see, so a missing glossary page is
// link.missing at the use; the entry's `#` is added when the page shows, since the
// entries exist only once the list is built. Under node the add-on declares
// `glossary` and `term`, links the uses and adds its styles; the list is
// built when luccet.js runs.
(function () {
  'use strict';
  const T = window.luccet;
  if (!T) return;

  const str = (key, params, fallback) => (T.string ? T.string(key, params, fallback) : fallback);
  const options = () => Object.assign({}, T.config && T.config.use && T.config.use.glossary);

  T.leaf('glossary', { tag: 'div', attrs: { role: 'region', 'aria-label': str('glossary', {}, 'Glossary') } });
  T.inline('term', { tag: 'span' });
  T.style(
    [
      '.luccet .t-glossary { margin-block: 0 1rem; }',
      '.luccet .t-glossary-list { margin: 0; }',
      '.luccet .t-glossary-list > dt { font-weight: 600; margin-block-start: .8rem; }',
      '.luccet .t-glossary-list > dd { margin: .2rem 0 0 1.2rem; }',
      '.luccet .t-glossary-list > dd > :last-child { margin-block-end: 0; }',
      '.luccet .t-glossary-source { color: var(--t-muted); font-size: .85em; font-family: var(--t-sans); margin-block-start: .2rem; }',
      '.luccet .term > a { text-decoration-style: dotted; }',
      '.t-glossary-status { color: var(--t-muted); font-size: .85em; }',
    ].join('\n'),
  );

  // A use links to the glossary page: the link node is in the tree, so
  // `luccet check` sees the page and `luccet build` writes the link.
  T.transform('glossary-term', (ast) => {
    const page = String(options().page || 'glossary.html');
    T.visit(ast, 'textDirective', (n) => {
      if (n.name !== 'term' || !n.children || !n.children.length || (n.children.length === 1 && n.children[0].type === 'link')) return;
      // The use's position, so the link checker places a missing page at it.
      n.children = [{ type: 'link', url: page, title: null, children: n.children, ...(n.position ? { position: n.position } : {}) }];
    });
  });

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  // The entry's anchor, once the page shows: the slug of the canonical term.
  T.define('term', (host) => {
    const a = host.querySelector(':scope > a');
    if (!a || a.hash) return;
    const term = host.getAttribute('title') || host.textContent;
    a.hash = `#${T.glossary.slug(term)}`;
  });

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

  // The file is fetched from http(s), or the page's own scheme when it is
  // opened from a file. A note's URL resolves against the file and must
  // stay on its origin: luccet index writes paths, so a crafted file cannot
  // send a reader to javascript:, data: or another site.
  const SCHEMES = new Set(['http:', 'https:', location.protocol]);
  const fetchable = (u) => SCHEMES.has(u.protocol);
  function noteURL(url, base) {
    let u = null;
    try {
      u = new URL(url, base);
    } catch {}
    if (u && fetchable(u) && u.origin === new URL(base).origin) return u.href;
    console.warn(`Luccet glossary.js: ${url} in the glossary is not a page of this site; its terms are left out`);
    return null;
  }

  // A definition's links lead back to its note: a fragment to the note's
  // element, a relative path to the file beside the note.
  const RELATIVE = /^(?![a-z][a-z0-9+.-]*:|\/)/i;
  function rebase(nodes, note) {
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.url === 'string' && (n.type === 'link' || n.type === 'image' || n.type === 'definition')) {
        if (n.url.startsWith('#')) n.url = note + n.url;
        else if (RELATIVE.test(n.url)) {
          try {
            n.url = new URL(n.url, note).href;
          } catch {}
        }
      }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return nodes;
  }

  async function build(host) {
    const defaults = options();
    const attr = (k) => (host.hasAttribute(k) ? host.getAttribute(k) : defaults[k]);
    const o = { from: attr('from') || 'glossary.json', in: attr('in') || '' };
    host.classList.add('t-glossary');
    const status = (text) => host.replaceChildren(el('p', { class: 't-glossary-status', text }));
    let url = null;
    try {
      url = new URL(o.from, location.href);
    } catch {}
    let data = null;
    if (!url || !fetchable(url)) console.warn(`Luccet glossary.js: from=${o.from} is not an http(s) file`);
    else {
      try {
        const res = await fetch(url.href, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${res.status}`);
        data = await res.json();
      } catch (e) {
        console.warn(`Luccet glossary.js: the glossary ${url.href} could not be loaded: ${(e && e.message) || e}`);
      }
    }
    if (!data || !Array.isArray(data.terms)) return status(str('glossaryFailed', { from: o.from }, 'The glossary could not be loaded ({from}).'));
    // The file's format decides, not the version that wrote it: the terms'
    // fields and the definitions' trees change only with the number, in a
    // major release; a file with no format is from before 1.0.
    if (data.format !== T.glossary.format) {
      console.warn(`Luccet glossary.js: ${url.href} was written by luccet ${data.luccet} in a format this luccet (${T.version}) does not read: run luccet index again`);
      return status(str('glossaryStale', { version: String(data.luccet) }, 'The glossary was written by luccet {version}; run luccet index again.'));
    }
    const titles = new Map((Array.isArray(data.notes) ? data.notes : []).filter((n) => n && typeof n.url === 'string').map((n) => [n.url, n.title]));
    let list = data.terms.filter((t) => t && typeof t.term === 'string' && typeof t.url === 'string' && typeof t.key === 'string');
    if (o.in) list = list.filter((t) => t.url.startsWith(o.in));
    list = list.map((t) => ({ ...t, href: noteURL(t.url, url.href) })).filter((t) => t.href);
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : (a.line || 0) - (b.line || 0)));
    if (!list.length) return status(str('noTerms', {}, 'No terms.'));
    const dl = el('dl', { class: 't-glossary-list' });
    const ids = new Map(); // a slug -> how many entries carry it, for a term defined twice
    list.forEach((t, i) => {
      const base = T.glossary.slug(t.term);
      const n = (ids.get(base) || 0) + 1;
      ids.set(base, n);
      const where = t.id ? `${t.href}#${t.id}` : t.href;
      dl.append(el('dt', { id: n === 1 ? base : `${base}-${n}` }, el('a', { href: where, text: t.term })));
      const dd = el('dd');
      const nodes = Array.isArray(t.definition) ? rebase(JSON.parse(JSON.stringify(t.definition)), t.href) : [];
      if (nodes.length) {
        const tpl = document.createElement('template');
        tpl.innerHTML = T.emit({ type: 'root', children: nodes }, { safe: true, cssom: true, positions: false, idPrefix: `glossary-${i + 1}-` });
        dd.append(tpl.content);
      }
      const title = titles.get(t.url) || t.title || t.url;
      dd.append(el('p', { class: 't-glossary-source' }, el('a', { href: where, text: str('glossaryFrom', { title }, 'From {title}') })));
      dl.append(dd);
    });
    host.replaceChildren(dl);
    // Behaviours and the math add-on's typesetting, on what was just added.
    await T.render(host);
  }

  T.define('glossary', (host) => {
    if (host.closest('.docs-live-out')) return; // an example's result on the docs stays inert
    build(host).catch((e) => {
      const why = (e && e.message) || String(e);
      console.warn(`Luccet glossary.js: the glossary could not be built: ${why}`);
      host.replaceChildren(el('p', { class: 't-glossary-status', text: str('glossaryFailed', { from: why }, 'The glossary could not be loaded ({from}).') }));
    });
  });
})();
