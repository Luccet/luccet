// SPDX-License-Identifier: MIT
// switcher.js, Tern's theme switcher (docs/addons.html#switcher). A `::themes`
// leaf becomes a labelled <select> of Tern's themes, "Solarized (dark)". Choosing one applies it
// at once, the choice is kept in localStorage, and every page of the site
// that loads the add-on applies it again before it first paints. A
// `tern:theme` event on window says when the theme changed, so an add-on
// that paints colours itself (mermaid.js) draws again.
//
//   <script src="tern.js" data-use="addons/switcher.js"></script>
//
//   ::themes                                   every theme Tern ships
//   ::themes{themes="nord solarized sepia"}     these, in this order
//   ::themes{label=Colours}
//
// Options go on the leaf, on the add-on (`addons/switcher.js?themes=…`) or
// in window.TERN = {use: {switcher: {…}}}; the leaf's win:
//   themes  the names to offer, separated by spaces or commas: a family
//           (`solarized`: its system, light and dark files) or one file
//           (`solarized-dark`); a name Tern does not know is offered as
//           written, for your own NAME.css in the folder
//   base    the folder of the theme files; else the folder of the theme the
//           page loads itself, else `themes/` next to the add-on
//   at      a CSS selector: after each render the control is put inside the
//           first element that matches, for a page without `::themes`
//   key     the localStorage key, `tern.theme`: one choice per key and origin
//   label   the control's label, else the string `theme` (Theme)
// The words come from window.TERN.strings (theme, themeDefault, themeSystem,
// themeLight, themeDark; docs/api.html#strings). The control is not printed.
// Under node (tern check, tern build) the add-on declares the leaf and its
// styles and does nothing else.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;
  const str = (key, params, fallback) => (T.string ? T.string(key, params, fallback) : fallback);

  T.leaf('themes', { tag: 'div' });
  T.style(
    [
      '.t-themes { display: flex; align-items: center; flex-wrap: wrap; gap: .5em; font: .9rem/1.4 var(--t-sans); }',
      '.tern > .t-themes { margin-block: 0 1rem; }',
      '.t-themes select { font: inherit; color: var(--t-fg); background: var(--t-bg); border: 1px solid var(--t-line-strong); border-radius: 4px; padding: .3em .5em; max-inline-size: 100%; }',
      '.t-themes select:focus-visible { outline: 2px solid var(--t-link); outline-offset: 1px; }',
      '@media print { .t-themes { display: none; } }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  // The families themes/ holds, as tools/themes.js builds them: name, title,
  // and whether a light and a dark palette exist (three files) or one does.
  // test/addons.js checks this list against tools/themes.js.
  const FAMILIES = [
    ['catppuccin', 'Catppuccin', 'both'],
    ['dracula', 'Dracula', 'dark'],
    ['everforest', 'Everforest', 'both'],
    ['github', 'GitHub', 'both'],
    ['gruvbox', 'Gruvbox', 'both'],
    ['high-contrast', 'High contrast', 'both'],
    ['kanagawa', 'Kanagawa', 'dark'],
    ['monokai', 'Monokai', 'dark'],
    ['nord', 'Nord', 'dark'],
    ['one', 'One', 'both'],
    ['rose-pine', 'Rosé Pine', 'both'],
    ['sepia', 'Sepia', 'light'],
    ['solarized', 'Solarized', 'both'],
    ['tokyo-night', 'Tokyo Night', 'both'],
  ];
  const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i; // a file name without its .css

  const options = Object.assign({}, T.config && T.config.use && T.config.use.switcher);
  const KEY = String(options.key || 'tern.theme');
  const script = document.currentScript;

  // The folder of the theme files, with its slash.
  const folder = (url) => url.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  const stylesheets = () => [...document.head.querySelectorAll('link[rel~="stylesheet" i]')];
  // Whether a stylesheet's file is one of the families' (nord.css, solarized-dark.css).
  const known = (href) => {
    const m = /(?:^|\/)([a-z0-9-]+?)(?:-(?:light|dark))?\.css$/i.exec(href.replace(/[?#].*$/, ''));
    return !!m && FAMILIES.some((f) => f[0] === m[1].toLowerCase());
  };
  let base = null;
  try {
    if (options.base) base = new URL(String(options.base).replace(/\/?$/, '/'), document.baseURI).href;
  } catch {}
  if (!base) {
    const own = stylesheets().find((l) => known(l.href));
    if (own) base = folder(own.href);
    else {
      try {
        base = new URL('../themes/', script && script.src ? script.src : document.baseURI).href;
      } catch {}
    }
  }
  if (!base) return;
  const hrefOf = (name) => base + encodeURIComponent(name) + '.css';

  // The theme in effect: the stylesheet in the folder, whoever listed it.
  let current = null; // {name, link} or null for tern.css alone
  function detect() {
    for (const l of stylesheets()) {
      const href = l.href.replace(/[?#].*$/, '');
      if (href.startsWith(base) && /\.css$/i.test(href)) {
        let name = href.slice(base.length, -4);
        try {
          name = decodeURIComponent(name);
        } catch {}
        if (NAME.test(name)) return (current = { name, link: l });
      }
    }
    return (current = null);
  }
  detect();

  // What is offered: [{name, title, files: [{name, mode}]}], from `themes=` or
  // every family. A family's files are system (NAME.css), light and dark;
  // a one-palette family has NAME.css in that palette; a file given by name
  // is listed alone; an unknown name is offered as written.
  function offered(given) {
    const names = String(given || '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const groups = [];
    const add = (name, title, files) => {
      if (!groups.some((g) => g.name === name)) groups.push({ name, title, files });
    };
    if (!names.length) {
      for (const [name, title, modes] of FAMILIES) add(name, title, modes === 'both' ? [{ name, mode: 'system' }, { name: `${name}-light`, mode: 'light' }, { name: `${name}-dark`, mode: 'dark' }] : [{ name, mode: modes }]);
      return groups;
    }
    for (const n of names) {
      if (!NAME.test(n)) continue;
      const lower = n.toLowerCase();
      if (groups.some((g) => g.files.some((f) => f.name === lower))) continue; // listed already, by its family
      const fam = FAMILIES.find((f) => f[0] === lower);
      if (fam) {
        add(fam[0], fam[1], fam[2] === 'both' ? [{ name: fam[0], mode: 'system' }, { name: `${fam[0]}-light`, mode: 'light' }, { name: `${fam[0]}-dark`, mode: 'dark' }] : [{ name: fam[0], mode: fam[2] }]);
        continue;
      }
      const m = /^(.+)-(light|dark)$/.exec(lower);
      const parent = m && FAMILIES.find((f) => f[0] === m[1] && f[2] === 'both');
      if (parent) add(`${parent[0]}:${m[2]}`, parent[1], [{ name: lower, mode: m[2] }]);
      else add(n, n, [{ name: n, mode: null }]);
    }
    return groups;
  }

  // Where a theme goes when the page has none: after the base stylesheet
  // (tern.css, as a link or inlined), so the author's own CSS still wins.
  function anchor() {
    const inline = document.getElementById('tern-style');
    if (inline) return inline;
    let named = null;
    try {
      if (T.config && T.config.css) named = new URL(T.config.css, document.baseURI).href;
    } catch {}
    return stylesheets().find((l) => l.href === named || /(?:^|\/)tern(?:\.min)?\.css$/.test(l.href.replace(/[?#].*$/, ''))) || null;
  }

  const selects = new Set();
  // A select shows the theme in effect; one it does not offer (remembered
  // from another page) is added to it, by name, while it lasts.
  function show(s) {
    const value = current ? current.name : '';
    for (const o of s.querySelectorAll('option.t-themes-other')) if (o.value !== value) o.remove();
    if (![...s.options].some((o) => o.value === value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value;
      o.className = 't-themes-other';
      s.append(o);
    }
    if (s.value !== value) s.value = value;
  }
  const sync = () => {
    for (const s of selects) s.isConnected ? show(s) : selects.delete(s);
  };
  function remember(name) {
    try {
      localStorage.setItem(KEY, name);
    } catch {}
  }
  function announce(name) {
    try {
      window.dispatchEvent(new CustomEvent('tern:theme', { detail: { theme: name, href: name ? hrefOf(name) : null } }));
    } catch {}
  }

  // Applies a theme by name ('' for none): the new stylesheet is added beside
  // the old one and the old one removed once the new has loaded, so the page
  // never stands unthemed; a sheet that fails to load is removed and the old
  // one kept. Resolves to whether the theme is in effect.
  let pendingLink = null;
  function apply(name) {
    name = String(name || '');
    if (name && !NAME.test(name)) return Promise.resolve(false);
    if (pendingLink) {
      pendingLink.remove();
      pendingLink = null;
    }
    if (name === (current ? current.name : '')) return (sync(), Promise.resolve(true));
    if (!name) {
      if (current) current.link.remove();
      current = null;
      sync();
      announce('');
      return Promise.resolve(true);
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    if (T.config && T.config.nonce) link.nonce = T.config.nonce;
    link.href = hrefOf(name);
    const after = current ? current.link : anchor();
    if (after) after.after(link);
    else {
      const first = document.head.querySelector('link[rel~="stylesheet" i], style');
      if (first) first.before(link);
      else document.head.append(link);
    }
    pendingLink = link;
    return new Promise((resolve) => {
      link.addEventListener('load', () => {
        if (pendingLink !== link) return resolve(false); // superseded
        pendingLink = null;
        if (current) current.link.remove();
        current = { name, link };
        sync();
        announce(name);
        resolve(true);
      });
      link.addEventListener('error', () => {
        if (pendingLink === link) pendingLink = null;
        link.remove();
        console.warn(`Tern switcher.js: the theme ${name} did not load (${link.href}); ${current ? `${current.name} stays` : 'the page keeps tern.css alone'}`);
        sync();
        resolve(false);
      });
    });
  }

  // The remembered choice, requested now, before the note renders, so the
  // page opens in it.
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {}
  if (stored !== null && stored !== (current ? current.name : '')) apply(stored);

  // The control: a label and a select.
  let n = 0;
  function control(opts) {
    const id = `t-themes-${++n}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = opts.label || str('theme', {}, 'Theme');
    const select = document.createElement('select');
    select.id = id;
    const option = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    };
    // One flat list, each option naming its family and palette ("Solarized
    // (dark)"), so the closed control says which theme is on.
    const MODE = { system: () => str('themeSystem', {}, 'system'), light: () => str('themeLight', {}, 'light'), dark: () => str('themeDark', {}, 'dark') };
    select.append(option('', str('themeDefault', {}, 'Default')));
    for (const g of offered(opts.themes)) for (const f of g.files) select.append(option(f.name, f.mode ? `${g.title} (${MODE[f.mode]()})` : g.title));
    selects.add(select);
    show(select);
    select.addEventListener('change', () => {
      const name = select.value;
      remember(name);
      apply(name).then((ok) => ok || sync());
    });
    return [label, select];
  }
  const settings = (el) => {
    const o = Object.assign({}, options);
    for (const k of ['themes', 'label']) if (el && el.hasAttribute(k)) o[k] = el.getAttribute(k);
    return o;
  };

  T.define('themes', (el) => {
    el.classList.add('t-themes');
    el.replaceChildren(...control(settings(el)));
  });

  // `at=SELECTOR`: the control inside that element, once, after a render.
  if (options.at) {
    T.on('render', (_root, info) => {
      if (info && info.safe) return;
      let host = null;
      try {
        host = document.querySelector(String(options.at));
      } catch {}
      if (!host || host.querySelector('.t-themes')) return;
      const box = document.createElement('div');
      box.className = 't-themes';
      box.append(...control(options));
      host.append(box);
    });
  }
})();
