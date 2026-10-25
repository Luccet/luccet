// SPDX-License-Identifier: MIT
// The browser runtime. Run from a plain <script src> in a loading document,
// luccet.js captures the rest of the file as the note and renders it in place,
// in this order (docs/api.html#lifecycle):
//
//   config → capture (one document.write) → add-ons and base CSS
//   requested → wait for DOMContentLoaded and every add-on →
//   window.LUCCET.schema → parse → transform → emit → mount → note scripts in
//   order → line numbers, behaviours → 'render' → 'math' → fragment scroll →
//   console group → 'ready'
//
// The engine writes each formula as MathML (src/tex.js). An add-on that
// typesets math itself (KaTeX's) sets config.math = 'tex', gets the TeX, and
// renders it in a 'render' listener, which the runtime awaits before it fires
// 'math'. Code that needs the rendered math listens for 'math'.
//
// A page written by `luccet build` (its luccet.js tag has data-built) starts at
// the behaviours instead: its main.luccet is in the HTML, and its scripts and
// add-ons are real scripts the browser runs.
//
// The API sits on the engine's object:
//   luccet.define(name, fn) -> undo   fn(el) once per [data-t=name] element
//   luccet.undefine(name)
//   luccet.on('render'|'math'|'ready'|'diagnostic', fn) -> undo
//   luccet.render(root = main.luccet, source?) -> Promise of source's diagnostics
//   luccet.ready        a Promise, settled after 'ready'
//   luccet.diagnostics  parse, transform and runtime diagnostics (a live array)
//   luccet.config       window.LUCCET merged with the tag's data-* (data-* wins)
//   luccet.style(css)   a stylesheet, at its add-on's place in the cascade
// Under node nothing touches a DOM: the API is present and inert.
'use strict';

const { css: BASE_CSS } = require('./css');
const { sortDiagnostics } = require('./diag');
const { scanUse } = require('./use');

// The runtime's own diagnostic codes, all errors: each loses or changes what
// the reader sees. (A formula's problems are the engine's tex.* codes.)
const SEVERITY = {
  'addon.failed': 'error',
  'script.document-write': 'error',
  'script.domcontentloaded': 'error',
  'doc.quirks': 'error',
};
// A problem with the luccet.js line or the head, not with a note line: line 0,
// the line before the note's first; the panel shows its file line.
const HEAD = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };
// Note scripts that run: JavaScript MIME types, modules, import maps,
// speculation rules. Other types are data blocks and stay inert.
const RUNS = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript|javascript1\.[0-5])|module|importmap|speculationrules)?$/i;
const EVENTS = ['render', 'math', 'ready', 'diagnostic'];
const BROWSER = typeof window === 'object' && !!window && typeof document === 'object' && !!document && window.document === document;

let T = null; // the API object
const diagnostics = [];
const config = { use: Object.create(null) };
const listeners = { render: [], math: [], ready: [], diagnostic: [] };
const defined = new Map(); // name -> [{fn, done}]
let settle = null;
const ready = new Promise((resolve) => (settle = resolve));

let page = null; // what capture found: {head, lines, source, quirks}
let main = null;
let built = false; // a page written by `luccet build`
let addonList = []; // the data-use entries
let mounted = false;
let logged = false;
const roots = new Set();
let behavioursRan = false;

const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const now = () => performance.now();
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (s) => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The runtime's own words, and the add-ons' (luccet.string): each a key with
// an English fallback, overridden by window.LUCCET.strings[key]. A string
// holds `{name}` fields; one with a `|` is `singular|plural`, picked by
// params.n. The emitter's words (Footnotes …) take the same keys.
const STRINGS = { problems: '{n} problem|{n} problems', errors: '{n} error|{n} errors', warnings: '{n} warning|{n} warnings', infos: '{n} info|{n} infos' };
function string(key, params, fallback) {
  const given = config.strings && typeof config.strings === 'object' && typeof config.strings[key] === 'string' ? config.strings[key] : null;
  let s = given !== null ? given : fallback !== undefined ? String(fallback) : STRINGS[key] || key;
  const p = params && typeof params === 'object' ? params : {};
  if (s.includes('|')) s = s.split('|')[p.n === 1 ? 0 : 1];
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));
}
const append = (to, list) => {
  for (const x of list) to.push(x);
};

// ---------------------------------------------------------------- the API

function attach(api) {
  T = api;
  api.diagnostics = diagnostics;
  api.config = config;
  api.ready = ready;
  api.define = define;
  api.undefine = undefine;
  api.on = on;
  api.render = render;
  api.style = style;
  api.string = string;
  // A schema entry's `css` is queued like luccet.style.
  for (const level of ['block', 'leaf', 'inline']) {
    const add = api[level];
    api[level] = (name, spec) => {
      const entry = add(name, spec);
      if (entry && typeof entry.css === 'string' && entry.css) style(entry.css);
      return entry;
    };
  }
  if (!BROWSER) return api;
  // A second luccet.js (from a note script, say) leaves the first in charge.
  const first = window.luccet;
  if (first && first.version) {
    console.warn('luccet: luccet.js is already loaded; this second copy does nothing');
    return api;
  }
  document.addEventListener('copy', onCopy);
  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);
  start();
  return api;
}

function on(event, fn) {
  if (!EVENTS.includes(event)) throw new TypeError(`luccet.on: "${event}" is not one of ${EVENTS.join(', ')}`);
  if (typeof fn !== 'function') throw new TypeError(`luccet.on("${event}", fn): fn must be a function`);
  listeners[event].push(fn);
  const off = () => {
    const i = listeners[event].indexOf(fn);
    if (i >= 0) listeners[event].splice(i, 1);
  };
  registered(off);
  return off;
}

// `info` is the event's second argument: {safe} for 'render' and 'math'.
function fire(event, arg, info) {
  for (const fn of listeners[event].slice()) {
    try {
      fn(arg, info);
    } catch (e) {
      console.error(`luccet: a "${event}" listener failed`, e);
    }
  }
}

// Like fire, but awaits the listeners' return values. They run concurrently,
// so a synchronous listener (one logging the event, say) is not held up by an
// async one. The lifecycle awaits 'render' this way: an add-on that typesets
// math itself (KaTeX's) does it there, so 'math' fires once that is done.
async function fireAsync(event, arg, info) {
  await Promise.all(
    listeners[event].slice().map(async (fn) => {
      try {
        await fn(arg, info);
      } catch (e) {
        console.error(`luccet: a "${event}" listener failed`, e);
      }
    }),
  );
}

// The roots rendered with `safe`: untrusted content, which no behaviour may
// touch, then or later. Each carries data-t-safe too, so an add-on can tell
// from any element (el.closest('[data-t-safe]')) and a root that holds one
// can skip it.
const safeRoots = new WeakSet();
let anySafe = false; // a safe root was made: elements must be checked
const inSafe = (el) => anySafe && !!el.closest('[data-t-safe]');

// luccet.define(name, fn): additive, in registration order. Defined after the
// behaviours ran, it runs at once on the elements already there, the safe
// roots' left out.
function define(name, fn) {
  if (typeof name !== 'string' || !name) throw new TypeError('luccet.define(name, fn): name must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError(`luccet.define("${name}", fn): fn must be a function`);
  const rec = { fn, done: new WeakSet() };
  if (!defined.has(name)) defined.set(name, []);
  defined.get(name).push(rec);
  if (behavioursRan) {
    for (const root of roots) {
      if (!root.isConnected || safeRoots.has(root)) continue;
      for (const el of root.querySelectorAll(`[data-t="${CSS.escape(name)}"]`)) if (!inSafe(el)) apply(rec, el, name);
    }
  }
  const off = () => {
    const list = defined.get(name);
    const i = list ? list.indexOf(rec) : -1;
    if (i >= 0) list.splice(i, 1);
  };
  registered(off);
  return off;
}

function undefine(name) {
  defined.delete(name);
}

// luccet.render(root, source, {safe, idPrefix}): with a source, root's content
// is replaced by the note's HTML and its scripts run. Then behaviours run on
// elements that have not had them and formulas not yet typeset are typeset,
// so a second call with no source changes nothing. Resolves to the source's
// diagnostics, which replace luccet.diagnostics when root is the page's main.
function render(root, source, opts) {
  if (!BROWSER) return Promise.resolve([]);
  return renderRoot(root, source, !!(opts && opts.safe), opts && typeof opts.idPrefix === 'string' ? opts.idPrefix : '', !(opts && opts.scripts === false));
}

// What a root's note scripts registered (luccet.define, luccet.on, luccet.style),
// as undo functions: rendered again from a source, the root first retires
// them, so a live preview does not stack a registration per edit.
const registrations = new WeakMap(); // root -> [undo]
let scriptRoot = null; // the root whose note scripts are running
function registered(undo) {
  if (!scriptRoot) return;
  let list = registrations.get(scriptRoot);
  if (!list) registrations.set(scriptRoot, (list = []));
  list.push(undo);
}
function retire(root) {
  const list = registrations.get(root);
  if (!list) return;
  for (const undo of list.splice(0)) {
    try {
      undo();
    } catch (e) {
      console.error('luccet: retiring a registration failed', e);
    }
  }
}

async function renderRoot(root, source, safe, idPrefix, scripts) {
  root = root || main || document.querySelector('main.luccet');
  if (!root || root.nodeType !== 1) throw new TypeError('luccet.render(root, source): root must be an element');
  let list = [];
  if (source !== undefined) {
    retire(root);
    const r = compile(String(source), safe, idPrefix);
    list = r.list;
    const tpl = document.createElement('template');
    tpl.innerHTML = r.html;
    root.replaceChildren(tpl.content);
    presentation(root);
    if (root === main) {
      const kept = diagnostics.filter((d) => d.position === HEAD);
      diagnostics.length = 0;
      append(diagnostics, kept);
      append(diagnostics, list);
      rebuildPanel();
    }
    // Under `safe` the note is untrusted: its scripts do not run, and
    // behaviours (schema `dom`, luccet.define — host code acting on untrusted
    // content) are skipped, now and later: the root is remembered and marked.
    // Its raw HTML is escaped and risky attributes dropped by emit; math
    // still typesets, with trust off (the add-ons read the mark). A trusted
    // source rendered into the same root makes it trusted again.
    if (safe) {
      safeRoots.add(root);
      root.setAttribute('data-t-safe', '');
      anySafe = true;
    } else {
      safeRoots.delete(root);
      root.removeAttribute('data-t-safe');
      if (scripts) await runScripts(root, r.ast); // {scripts: false}: the note's scripts stay inert
    }
  }
  await process(root, safe || safeRoots.has(root));
  return list;
}

// luccet.style(css): a stylesheet in the head. One added while an add-on runs
// sits at that add-on's place in data-use, so the cascade follows the
// listing; any other comes after all add-ons.
function style(text) {
  const css = text == null ? '' : String(text);
  if (!BROWSER || !document.head) return;
  const el = document.createElement('style');
  el.textContent = css;
  registered(() => {
    el.remove();
    for (const slot of slots) {
      const i = slot.els.indexOf(el); // out of its slot too, or the next sheet would anchor on a detached element
      if (i >= 0) slot.els.splice(i, 1);
    }
  });
  return insert(nonce(el), currentSlot());
}

// ---------------------------------------------------------------- diagnostics

// `el` is the element concerned, if any. luccet.diagnostics, the panel and
// the console speak of the page's note: a problem in another root given to
// luccet.render, or on a page where the runtime did not start, only fires
// the event.
function report(code, position, message, hint, el) {
  const d = { code, severity: SEVERITY[code], message, position: position || HEAD };
  if (hint) d.hint = hint;
  const own = !!page && (!el || (!!main && main.contains(el)));
  if (own) diagnostics.push(d);
  fire('diagnostic', d);
  if (own && mounted) panelAdd(d);
  if (own && logged) console.warn(`luccet: ${describe(d)}`);
  return d;
}

// "line 12:3 (file line 13)": positions are note lines; the file line is
// what the author edits, the note starting after the luccet.js line.
function where(d) {
  const p = d.position && d.position.start;
  const before = page ? page.lines : 0;
  if (!p || !p.line) return before ? `the luccet.js line (file line ${before})` : 'the luccet.js line';
  return `line ${p.line}:${p.column}${before ? ` (file line ${p.line + before})` : ''}`;
}
const describe = (d) => `${d.severity} ${d.code} at ${where(d)}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`;

// The source each root was rendered from: the page's note for main, then
// each luccet.render(root, source). data-pos holds line and column only; the
// offset is counted in the source of the root the element belongs to.

// The console group, always printed once; later problems get a line each.
function logGroup(times) {
  logged = true;
  console.groupCollapsed(`luccet: ${string('problems', { n: diagnostics.length })}`);
  if (times) console.log(`luccet ${T.version}: ${times}`);
  for (const d of diagnostics) (d.severity === 'info' ? console.info : console.warn)(describe(d));
  console.groupEnd();
}

// The panel, <aside class="t-diagnostics" role="status"> after main, on
// file:, localhost and with data-diagnostics; data-quiet silences it.
let panel = null;
function panelOn() {
  if (config.quiet) return false;
  if (config.diagnostics) return true;
  return location.protocol === 'file:' || /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}
function panelAdd(d) {
  if (!panelOn() || !document.body) return;
  if (!panel) {
    const aside = document.createElement('aside');
    aside.className = 't-diagnostics';
    aside.setAttribute('role', 'status');
    const box = document.createElement('details');
    const sum = document.createElement('summary');
    const list = document.createElement('ol');
    box.append(sum, list);
    aside.append(box);
    document.body.append(aside);
    panel = { aside, box, sum, list, n: { error: 0, warning: 0, info: 0 } };
  }
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const li = document.createElement('li');
  li.className = `t-diag t-diag-${d.severity}`;
  li.append(span('t-diag-sev', d.severity), ' ', span('t-diag-code', d.code), ' ', span('t-diag-at', where(d)), ' ', span('t-diag-msg', d.message));
  if (d.hint) li.append(span('t-diag-hint', d.hint));
  panel.list.append(li);
  const n = panel.n;
  n[d.severity] = (n[d.severity] || 0) + 1;
  const parts = [n.error && string('errors', { n: n.error }), n.warning && string('warnings', { n: n.warning }), n.info && string('infos', { n: n.info })].filter(Boolean);
  panel.sum.textContent = `luccet: ${string('problems', { n: n.error + n.warning + n.info })} (${parts.join(', ')})`;
  if (n.error) panel.box.open = true;
}
function rebuildPanel() {
  if (panel) panel.aside.remove();
  panel = null;
  for (const d of diagnostics) panelAdd(d);
}

// ---------------------------------------------------------------- capture

// What the runtime needs of the browser: replaceChildren, CSS.escape and
// `:is()` (Chrome 86, Firefox 78, Safari 14), nonce as a property,
// MutationObserver, and MathML layout, which MathMLElement stands for
// (Chrome 109; Firefox 71, Safari 13.1): formulas are MathML.
function supported() {
  try {
    return (
      typeof Element.prototype.replaceChildren === 'function' &&
      typeof MutationObserver === 'function' &&
      !!window.CSS &&
      typeof CSS.escape === 'function' &&
      typeof CSS.supports === 'function' &&
      !!document.querySelector(':is(html)') && // throws where :is() is unknown; CSS.supports('selector()') came later than :is() itself

      'nonce' in HTMLScriptElement.prototype &&
      typeof MathMLElement === 'function'
    );
  } catch {
    return false;
  }
}

function start() {
  const script = document.currentScript;
  if (script && script.hasAttribute('data-built')) return startBuilt(script);
  if (!script || document.readyState !== 'loading' || script.async || script.defer || script.type === 'module') {
    if (script && (script.hasAttribute('async') || script.hasAttribute('defer'))) console.warn('luccet: load luccet.js with a plain <script src>, without async or defer; the note was not rendered');
    return; // loaded by a page or an app: luccet.render works, nothing starts
  }
  if (document.querySelector('main.luccet')) return void console.warn('luccet: the page already has a main.luccet; luccet.js does nothing');
  // The support floor (docs/publishing.html#browsers): without these the
  // runtime would fail half-way, so the note is shown as its source instead.
  if (!supported()) {
    console.warn('luccet: this browser lacks what luccet.js needs (Chrome 109, Firefox 78, Safari 14 or newer); the note is shown as its source');
    try {
      document.write('<p>This browser is too old for luccet.js (it needs Chrome 109, Firefox 78, Safari 14 or newer); the note follows as its source.</p><plaintext>');
    } catch {}
    return;
  }

  const addons = readConfig(script);
  page = { head: headString(), lines: linesBefore(), source: null, quirks: document.compatMode === 'BackCompat' };
  locateSheets();
  if (page.quirks) {
    const use = script.getAttribute('data-use');
    const tag = `<script src="${script.getAttribute('src')}"${use ? ` data-use="${use}"` : ''}></script>`;
    report('doc.quirks', HEAD, 'the file has no <!doctype html>, so the browser renders it in quirks mode, where the layout and some add-ons misbehave', `make the first line <!doctype html><meta charset="utf-8">${tag}`);
  }

  // One document.write: the colour scheme (no white flash), preloads that
  // start with the HTML download, and the holder. <plaintext> makes the HTML
  // parser read the rest of the file into it as text, so the note arrives
  // untouched by HTML parsing; `hidden`, not a style attribute, for CSP.
  // Firefox warns of "an unbalanced tree" for this; that is harmless. By now
  // Chromium's preload scanner has read ahead in the raw file, so a `src=`
  // in the note's text (a code example) may be fetched: at worst a 404.
  const n = config.nonce ? ` nonce="${escAttr(config.nonce)}"` : '';
  let w = '';
  if (!document.querySelector('meta[name="color-scheme" i]')) w += '<meta name="color-scheme" content="light dark" id="luccet-color-scheme">';
  for (const a of addons) if (!a.css) w += `<link rel="preload" as="script" href="${escAttr(a.url)}"${n}>`;
  try {
    document.write(`${w}<plaintext id="luccet-source" hidden>`);
  } catch (e) {
    console.warn('luccet: the capture write was refused (a Trusted Types policy, perhaps); the note is shown as it is', e);
    return;
  }
  const holder = document.getElementById('luccet-source');
  if (!holder) return; // the write was ignored: not a parser-inserted script
  document.documentElement.setAttribute('aria-busy', 'true'); // until the mount

  // The tag's add-ons (data-use) load now; mount waits for each.
  const waits = [];
  let unwatch = watchAddons(addons); // one that loads but throws while it runs
  loadAddons(addons, waits);
  if (config.css && !BASE_SLOT.els.length)
    waits.push(loaded(insert(sheet(config.css), BASE_SLOT)).then((ok) => ok || report('addon.failed', HEAD, `the stylesheet ${config.css} (data-css) did not load; the note renders without its base stylesheet`, 'check the path in data-css')));
  baseStyle();

  // `:::use`: the add-ons the note's leading block lists are found in the
  // text as it streams into the holder (src/use.js), so they start loading
  // almost as early as the tag's, before the body has finished arriving. The
  // scan decides once the leading blocks end, or at DOMContentLoaded with the
  // whole note. Mount waits for these too.
  const noteText = () => {
    const t = holder.textContent;
    const nl = t.indexOf('\n');
    return nl < 0 ? null : t.slice(nl + 1);
  };
  let useDone = false;
  const useP = new Promise((resolve) => {
    const decide = (eof) => {
      if (useDone) return;
      const text = noteText();
      if (text === null && !eof) return;
      const r = scanUse(text || '', { eof });
      if (!r.decided) return;
      useDone = true;
      observer.disconnect();
      const extra = [];
      for (const e of r.entries) {
        const a = addonEntry(e.url);
        if (a && !addonList.some((x) => x.abs === a.abs) && !extra.some((x) => x.abs === a.abs)) extra.push(a); // once, however often it is listed
      }
      if (!extra.length) return resolve();
      slots.splice(slots.length - 1, 0, ...extra.map((a) => a.slot));
      addonList.push(...extra);
      const prev = unwatch;
      const next = watchAddons(extra);
      unwatch = () => (prev(), next());
      const more = [];
      loadAddons(extra, more);
      resolve(Promise.all(more));
    };
    const observer = new MutationObserver(() => decide(false));
    observer.observe(holder, { childList: true, characterData: true, subtree: true });
    decide(false);
    document.addEventListener('DOMContentLoaded', () => decide(true), { once: true });
  });

  const parsed = new Promise((resolve) =>
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        // The note is everything after the line holding the luccet.js tag.
        const text = holder.textContent;
        const nl = text.indexOf('\n');
        page.source = nl < 0 ? '' : text.slice(nl + 1);
        resolve();
      },
      { once: true },
    ),
  );
  // The mount waits for the note and every add-on, but not forever: once the
  // note has arrived, an add-on still loading after the deadline (12 s, or
  // luccet.config.addonTimeout in ms) is addon.failed and the note mounts
  // without it; a console line after 2 s says what is still awaited.
  const deadline = parsed.then(() => new Promise((resolve) => setTimeout(() => resolve('late'), addonTimeout())));
  setTimeout(() => {
    if (!mounted && pending.size) console.warn(`luccet: still waiting for ${plural(pending.size, 'add-on')} to load: ${[...pending].map((a) => a.url).join(', ')}`);
  }, NAG_MS);
  Promise.race([Promise.all([parsed, useP, ...waits]), deadline]).then((r) => {
    if (r === 'late')
      for (const a of pending) {
        timedOut.add(a);
        report('addon.failed', HEAD, `the add-on ${a.url} did not load in ${Math.round(addonTimeout() / 1000)} s; the note renders without it`, 'check the network, or host the add-on where it loads fast');
      }
    unwatch();
    return mount();
  });
}

// An add-on script that throws while it runs, at its top level or in what
// it parses badly, still fires `load`: the browser reports the error on
// window instead. Until mount (on a built page, until DOMContentLoaded),
// such an error is addon.failed, once per add-on, with its message. The
// add-on is the current script when the error is reported (so an error
// thrown inside luccet.js by the add-on's call counts), else the error's file.
// A cross-origin add-on served without CORS has its error muted: the message
// is then only "Script error.". Returns the function that stops watching.
function watchAddons(addons) {
  const scripts = addons.filter((a) => !a.css);
  if (!scripts.length) return () => {};
  const seen = new Set();
  const bare = (u) => String(u || '').replace(/#.*$/, '');
  const onError = (e) => {
    const cur = document.currentScript;
    const a = scripts.find((x) => (cur ? x.abs === cur.src : bare(x.abs) === bare(e.filename)));
    if (!a || seen.has(a)) return;
    seen.add(a);
    let msg = '';
    try {
      const err = e.error;
      msg = String((err && typeof err === 'object' && err.message) || e.message || err);
    } catch {}
    report('addon.failed', HEAD, `the add-on ${a.url} threw while it ran: ${msg}; the note renders with what it registered before the error`, 'fix the add-on; the browser console shows where it threw');
  };
  window.addEventListener('error', onError);
  return () => window.removeEventListener('error', onError);
}

// window.LUCCET merged with data-* on the tag. data-use's query strings go to
// config.use[name]: "my-addon.js?lang=de" gives use['my-addon'].lang.
function readConfig(script) {
  const given = window.LUCCET && typeof window.LUCCET === 'object' ? window.LUCCET : {};
  const attr = (k) => (script.hasAttribute(k) ? script.getAttribute(k).trim() : null);
  const flag = (k, v) => (attr(k) === null ? !!v : !/^(?:false|0|off|no)$/i.test(attr(k)));
  Object.assign(config, given);
  ownSchema = given.schema;
  config.use = Object.assign(Object.create(null), given.use && typeof given.use === 'object' ? given.use : null);
  if (attr('data-css') !== null) config.css = attr('data-css');
  // The nonce: data-nonce, taken off the tag once read, so a style-src that
  // allows attribute selectors cannot read it back; else the tag's own
  // nonce, which the browser hides from the DOM already.
  if (attr('data-nonce') !== null) {
    config.nonce = attr('data-nonce');
    script.removeAttribute('data-nonce');
  } else if (script.nonce) config.nonce = script.nonce;
  if (attr('data-lang') !== null) config.lang = attr('data-lang');
  if (attr('data-math') !== null) config.math = attr('data-math');
  config.diagnostics = flag('data-diagnostics', config.diagnostics);
  config.quiet = flag('data-quiet', config.quiet);
  const addons = [];
  for (const url of (attr('data-use') || '').split(/\s+/)) {
    const a = addonEntry(url);
    if (a && !addons.some((x) => x.abs === a.abs)) addons.push(a); // listed twice: loaded once
  }
  slots = [BASE_SLOT, ...addons.map((a) => a.slot), STYLE_SLOT];
  return (addonList = addons);
}

// One add-on from a URL, as data-use and `:::use` list them: its query string
// goes to config.use[name] ("my-addon.js?lang=de" gives use['my-addon'].lang).
// Null for a URL that does not parse.
function addonEntry(url) {
  let u;
  try {
    if (url) u = new URL(url, document.baseURI);
  } catch {}
  if (!u) return null;
  let file = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  try {
    file = decodeURIComponent(file);
  } catch {}
  const name = file.replace(/(?:\.min)?\.(?:m?js|css)$/i, '');
  const params = Object.create(null);
  u.searchParams.forEach((v, k) => (params[k] = v));
  config.use[name] = Object.assign(Object.create(null), config.use[name], params);
  return { url, abs: u.href, name, css: /\.css$/i.test(u.pathname), slot: { els: [] } };
}

// Loads add-ons: every script at once with async=false, so they are fetched
// in parallel but run in order (an inserted script is async by default); CSS
// as links, each in its slot. A failure is addon.failed; the promises pushed
// to `waits` settle when each has loaded or failed, with no timeout.
const ADDON_MS = 12000; // the deadline, after DOMContentLoaded, for an add-on still loading
const NAG_MS = 2000; // when the console says what is still awaited
const pending = new Set(); // add-ons not yet loaded or failed
const timedOut = new Set(); // reported at the deadline: not again when they fail
const addonTimeout = () => {
  const v = Number(config.addonTimeout);
  return Number.isFinite(v) && v >= 0 ? v : ADDON_MS;
};

function loadAddons(list, waits) {
  const failed = (a) => (ok) => {
    pending.delete(a);
    if (!ok && !timedOut.has(a)) report('addon.failed', HEAD, `the add-on ${a.url} did not load; the note renders without it`, 'check its path in data-use or `:::use`');
  };
  for (const a of list) {
    pending.add(a);
    if (a.css) {
      waits.push(loaded(insert(sheet(a.url), a.slot)).then(failed(a)));
      continue;
    }
    const s = nonce(document.createElement('script'));
    s.src = a.url;
    s.async = false;
    scriptSlot.set(s, a.slot);
    waits.push(loaded(s).then(failed(a)));
    document.head.append(s);
  }
}

// A single-file note declares its vocabulary in window.LUCCET.schema, in
// the registry's shape {block, leaf, inline}, from a head script. It is
// applied once the add-ons have registered theirs, so the note's own entry
// wins for a name both declare; function fields (label, dom) work as in an
// add-on. A bad entry is a console warning. Its `strict` sets the
// registry's (name.unknown), over an add-on's.
let ownSchema = null;
function applyOwnSchema() {
  const s = ownSchema;
  ownSchema = null;
  if (!s || typeof s !== 'object') return;
  if (s.strict !== undefined) T.schema.strict = !!s.strict;
  for (const level of ['block', 'leaf', 'inline']) {
    const entries = s[level];
    if (!entries || typeof entries !== 'object') continue;
    for (const name of Object.keys(entries)) {
      try {
        T[level](name, entries[name]);
      } catch (e) {
        console.warn(`luccet: window.LUCCET.schema.${level}: ${e.message}`);
      }
    }
  }
}

// The preserved head as a string, for `:::meta` conflicts.
function headString() {
  let s = '<html';
  for (const a of document.documentElement.attributes) s += ` ${a.name}="${escAttr(a.value)}"`;
  return `${s}>${document.head ? document.head.innerHTML : ''}`;
}

// The luccet.js line's number in the file: the line breaks in what the parser
// kept of the file so far, the tag being its last node. Exact for the
// canonical first line and for breaks between head elements; the parser
// drops breaks before <html> and <head>, which are then not counted.
function linesBefore() {
  let n = 0;
  const count = (s) => {
    for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  };
  for (const c of document.childNodes) {
    if (c.nodeType === 8) count(c.data);
    else if (c.nodeType === 1) count(c.outerHTML);
  }
  return n + 1;
}

// ---------------------------------------------------------------- the head

// Luccet's sheets go in the head in this order: the base, each add-on
// (its link, or the luccet.style sheets it adds) in data-use order, then other
// luccet.style sheets. The group sits before the head's first author
// stylesheet, so the author's head CSS wins; a head link to luccet.css is the
// base itself (the CSP route).
const BASE_SLOT = { els: [] };
const STYLE_SLOT = { els: [] };
let slots = [BASE_SLOT, STYLE_SLOT];
let anchor = null;
let located = false;
const scriptSlot = new Map(); // add-on script -> its slot

function locateSheets() {
  if (located || !document.head) return;
  located = true;
  const sheets = document.head.querySelectorAll('link[rel~="stylesheet" i], style');
  let named = null;
  try {
    if (config.css) named = new URL(config.css, document.baseURI).href;
  } catch {}
  for (const el of sheets) {
    // A built page inlines the base as <style id="luccet-style"> (cli/build.js).
    const base = el.localName === 'link' ? el.href === named || /(?:^|\/)luccet(?:\.min)?\.css$/.test(el.href.replace(/[?#].*$/, '')) : built && el.id === 'luccet-style';
    if (base) {
      BASE_SLOT.els.push(el);
      return;
    }
  }
  anchor = sheets[0] || null;
}

function insert(el, slot) {
  locateSheets();
  const i = Math.max(0, slots.indexOf(slot));
  let next = null;
  let prev = null;
  for (let j = i + 1; j < slots.length && !next; j++) next = slots[j].els[0] || null;
  for (let j = i; j >= 0 && !next && !prev; j--) prev = slots[j].els[slots[j].els.length - 1] || null;
  if (next) next.before(el);
  else if (prev) prev.after(el);
  else if (anchor && anchor.isConnected) anchor.before(el);
  else document.head.append(el);
  slot.els.push(el);
  return el;
}

// The slot of the add-on running now: the script capture appended, or on a
// built page the static tag with the add-on's URL.
function currentSlot() {
  const s = document.currentScript;
  if (!s) return STYLE_SLOT;
  const a = built && s.src ? addonList.find((x) => !x.css && x.abs === s.src) : null;
  return scriptSlot.get(s) || (a && a.slot) || STYLE_SLOT;
}

const nonce = (el) => {
  if (config.nonce) el.nonce = config.nonce;
  return el;
};
function sheet(href) {
  const l = nonce(document.createElement('link'));
  l.rel = 'stylesheet';
  l.href = href;
  return l;
}
function meta(name, content) {
  const m = document.createElement('meta');
  m.name = name;
  m.content = content;
  return m;
}
const loaded = (el) =>
  new Promise((resolve) => {
    el.addEventListener('load', () => resolve(true), { once: true });
    el.addEventListener('error', () => resolve(false), { once: true });
  });

// The base stylesheet (src/css.js), unless data-css names one or the head
// links luccet.css. Added at capture: the empty page already has its colours.
function baseStyle() {
  if (BASE_SLOT.els.length || !document.head) return;
  if (config.css) return void insert(sheet(config.css), BASE_SLOT);
  const s = nonce(document.createElement('style'));
  s.id = 'luccet-style';
  s.textContent = BASE_CSS;
  insert(s, BASE_SLOT);
}

// `:::meta` into the existing head, before mount. The head wins a conflict,
// so a key the head already sets is left alone.
function writeMeta(m) {
  if (!m || !document.head) return;
  const html = document.documentElement;
  for (const k of Object.keys(m)) {
    const v = String(m[k]);
    if (k === 'title') {
      if (!document.head.querySelector('title')) document.title = v;
    } else if (k === 'lang' || k === 'dir') {
      if (!html.hasAttribute(k)) html.setAttribute(k, v);
    } else {
      const el = document.head.querySelector(`meta[name="${CSS.escape(k)}" i]`);
      if (!el) document.head.append(meta(k, v));
      else if (el.id === 'luccet-color-scheme') el.content = v; // luccet's, not the head's
    }
  }
}

// ---------------------------------------------------------------- mount

// parse → transform → emit, with every diagnostic in document order.
function compile(source, safe, idPrefix) {
  const opts = { head: page ? page.head : '', lang: config.lang || undefined, math: config.math === 'tex' ? 'tex' : undefined, macros: config.macros };
  const { ast, diagnostics: parsed } = T.parse(source, opts);
  T.transform(ast, opts);
  return { ast, html: T.emit(ast, Object.assign({ cssom: true, safe: !!safe, idPrefix: idPrefix || '', strings: config.strings }, opts)), list: sortDiagnostics(parsed.concat(ast.data.luccet.diagnostics)) };
}

// Luccet's own presentational styles, a column's alignment and a grid's
// --t-cols, arrive as data-t-align and data-t-cols (emit's `cssom` option) and
// are set through the CSSOM: a strict CSP blocks style attributes, Chromium
// already while parsing (so stripping them after a <template> parse is too
// late), but not the CSSOM. The DOM then matches toHTML's. An author's own
// `style=` stays an attribute, under the page's CSP: raw HTML's could never be
// moved, and moving only `{style=…}` would make a declaration work or not
// depending on how it is written.
function presentation(root) {
  for (const el of root.querySelectorAll('[data-t-align]')) {
    el.style.textAlign = el.getAttribute('data-t-align');
    el.removeAttribute('data-t-align');
  }
  for (const el of root.querySelectorAll('[data-t-cols]')) {
    if (!el.style.getPropertyValue('--t-cols')) el.style.setProperty('--t-cols', el.getAttribute('data-t-cols'));
    el.removeAttribute('data-t-cols');
  }
  posters(root);
}

// A <video> parsed in a <template> and moved into the page keeps its poster
// unloaded in Chromium (Firefox loads it). Setting the attribute again, once
// per element, starts the load; where it is loaded already, the cache answers.
// presentation() runs after every insertion and in process(), so this
// covers a mount, luccet.render and a built page.
const posterDone = new WeakSet();
function posters(root) {
  for (const v of root.querySelectorAll('video[poster]')) {
    if (posterDone.has(v)) continue;
    posterDone.add(v);
    v.setAttribute('poster', v.getAttribute('poster'));
  }
}

// ---------------------------------------------------------------- held blocks

// A long note's top-level blocks out of view get content-visibility: auto, so
// the browser lays out and paints what is on screen and the first paint does
// not wait for the whole note. Each block is released, plain again for good,
// before it comes into view (those near the viewport at once, the rest when
// they come within one and a half screens), and all of them before printing
// and before a fragment jump. luccet.config.holdOver (characters, 30 000 by
// default; 0 never holds) is the note size from which a mount holds: from
// about 20 KB a held note paints sooner, in Chromium at normal speed and on a
// CPU four times slower, and from 30 KB by a margin over what the hold costs
// the mount.
const HOLD_OVER = 30000;
const held = new Map(); // block -> [content-visibility, contain-intrinsic-block-size] as they were
let watcher = null;
const holdOver = () => {
  const v = Number(config.holdOver);
  return Number.isFinite(v) && v >= 0 ? v : HOLD_OVER;
};
function hold(root) {
  const blocks = [];
  for (const b of root.children) {
    if (held.has(b) || /^(?:script|style|template)$/.test(b.localName)) continue;
    held.set(b, [b.style.contentVisibility, b.style.containIntrinsicBlockSize]);
    b.style.contentVisibility = 'auto';
    if (!b.style.containIntrinsicBlockSize) b.style.containIntrinsicBlockSize = 'auto 40rem';
    blocks.push(b);
  }
  // The blocks in and near the viewport now, so no frame shows a held block.
  const height = window.innerHeight || 800;
  const margin = height * 1.5;
  let again = true;
  while (again) {
    again = false;
    for (const b of blocks) {
      if (!held.has(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.bottom > -margin && r.top < height + margin) release(b), (again = true);
    }
  }
  if (!held.size) return;
  watcher = watcher || new IntersectionObserver((list) => list.forEach((e) => e.isIntersecting && release(e.target)), { rootMargin: '150% 0px' });
  for (const b of blocks) if (held.has(b)) watcher.observe(b);
}
function release(b) {
  const h = held.get(b);
  if (!h) return;
  held.delete(b);
  b.style.contentVisibility = h[0];
  b.style.containIntrinsicBlockSize = h[1];
  if (watcher) watcher.unobserve(b);
}
const releaseAll = () => {
  for (const b of [...held.keys()]) release(b);
};

let taskStart = 0; // when the task running the mount began (0: not mounting)

async function mount() {
  const t0 = (taskStart = now());
  let times = '';
  try {
    applyOwnSchema();
    let r;
    try {
      r = compile(page.source);
    } catch (e) {
      // An engine bug: the note stays readable.
      console.error('luccet: rendering failed; the note is shown as source', e);
      r = { ast: null, list: [], html: `<pre class="t-error">${escText(page.source)}</pre>` };
    }
    const t1 = now();
    append(diagnostics, r.list);
    sortDiagnostics(diagnostics);
    writeMeta(r.ast && r.ast.data && r.ast.data.luccet && r.ast.data.luccet.meta);
    if (!config.lang) config.lang = document.documentElement.lang || undefined;
    if (!document.querySelector('meta[name="viewport" i]')) document.head.append(meta('viewport', 'width=device-width, initial-scale=1'));
    baseStyle();
    // The one emitter's string, through <template>: never a second renderer.
    const tpl = document.createElement('template');
    tpl.innerHTML = `<main class="luccet">${r.html}</main>`;
    main = tpl.content.firstElementChild;
    document.body.replaceChildren(tpl.content);
    presentation(main);
    if (holdOver() && page.source.length >= holdOver()) hold(main);
    mounted = true;
    rebuildPanel();
    const t2 = now();
    await runScripts(main, r.ast);
    await process(main);
    const t3 = now();
    taskStart = 0;
    reveal();
    times = `${plural(page.source.split('\n').length, 'line')}; parse, transform and emit ${Math.round(t1 - t0)} ms, mount ${Math.round(t2 - t1)} ms, then scripts, behaviours and math ${Math.round(t3 - t2)} ms`;
  } catch (e) {
    console.error('luccet: the runtime failed', e);
  } finally {
    taskStart = 0;
    document.documentElement.removeAttribute('aria-busy');
    logGroup(times);
    fire('ready', main);
    settle();
  }
}

// After 'math': scroll to the URL's fragment, opening the <details> around it.
function reveal() {
  let id = location.hash.slice(1);
  if (!id) return;
  releaseAll(); // the target's place on the page needs every block laid out
  try {
    id = decodeURIComponent(id);
  } catch {}
  const target = document.getElementById(id);
  if (!target) return;
  for (let d = target.parentElement && target.parentElement.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
    if (!d.open) d.open = true;
  }
  target.scrollIntoView();
}

// ---------------------------------------------------------------- a built page

// `luccet build` writes main.luccet into the page, the note into
// <script type="text/luccet" id="luccet-source" data-line="N">, its diagnostics
// into <script type="application/json" id="luccet-diagnostics">, and the
// add-ons as static tags after luccet.js (cli/build.js). The browser has run
// the note's scripts by DOMContentLoaded, so there is no capture, mount or
// script re-creation: config now, then at DOMContentLoaded the diagnostics
// and the panel, behaviours, the 'render' listeners (where an add-on that
// typesets math itself works), the fragment and 'ready'. Its formulas are
// the engine's MathML, written by the build.
function startBuilt(script) {
  built = true;
  const addons = readConfig(script);
  page = { head: headString(), lines: 0, source: null, quirks: document.compatMode === 'BackCompat' };
  locateSheets();
  for (const l of document.head.querySelectorAll('link[rel~="stylesheet" i]')) {
    for (const a of addons) if (a.css && a.abs === l.href) a.slot.els.push(l);
  }
  // A static add-on script comes after this one; when it fails to load, its
  // error event reaches window in the capture phase.
  const failed = new Set();
  const onError = (e) => e.target && e.target.localName === 'script' && failed.add(e.target.src);
  window.addEventListener('error', onError, true);
  const unwatch = watchAddons(addons); // one that throws while it runs
  const go = () => {
    window.removeEventListener('error', onError, true);
    unwatch();
    startBuiltPage(addons, failed);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
}

async function startBuiltPage(addons, failed) {
  const t0 = (taskStart = now());
  let times = '';
  try {
    applyOwnSchema(); // for behaviours and luccet.render: the build applied it already
    main = document.querySelector('main.luccet');
    const src = document.getElementById('luccet-source');
    if (src && src.localName === 'script') {
      page.source = src.textContent.replace(/<\\(\\*)(\/script|!--)/gi, '<$1$2'); // cli/build.js decodeSource
      page.lines = Number(src.getAttribute('data-line')) || 0;
    }
    const data = document.getElementById('luccet-diagnostics');
    try {
      if (data) append(diagnostics, JSON.parse(data.textContent));
    } catch (e) {
      console.warn('luccet: the built page has unreadable diagnostics', e);
    }
    // A script add-on that failed. A CSS add-on's link comes before luccet.js,
    // so its error event is past, and a failed link still has a sheet: the
    // browser's own console reports it.
    for (const a of addons) if (!a.css && failed.has(a.abs)) report('addon.failed', HEAD, `the add-on ${a.url} did not load; the note renders without it`, 'check the path in data-use');
    sortDiagnostics(diagnostics);
    if (!config.lang) config.lang = document.documentElement.lang || undefined;
    if (!main) return void console.warn('luccet: this page has data-built but no main.luccet; luccet.js does nothing');
    mounted = true;
    rebuildPanel();
    await process(main);
    taskStart = 0;
    reveal();
    times = `a built page; behaviours and math ${Math.round(now() - t0)} ms`;
  } catch (e) {
    console.error('luccet: the runtime failed', e);
  } finally {
    taskStart = 0;
    logGroup(times);
    fire('ready', main);
    settle();
  }
}

// ---------------------------------------------------------------- note scripts

// Scripts parsed through <template> never run, so each is re-created, in
// document order: inline ones run on insertion, an external one without
// `async` is awaited before the next. Awaiting keeps the order; async=false
// is set too because without it Firefox could hang on a large script.
// Meanwhile document.write and DOMContentLoaded listeners are reported; no
// DOMContentLoaded is ever dispatched again.
const scriptAt = new WeakMap(); // a re-created script -> where it is written
async function runScripts(root, ast) {
  const all = [...root.querySelectorAll('script')].filter((s) => s instanceof HTMLScriptElement);
  if (!all.length) return;
  const at = scriptPositions(ast);
  const outer = scriptRoot;
  scriptRoot = root; // what they register is the root's, to retire on its next render
  intercept(true);
  try {
    for (let i = 0; i < all.length; i++) {
      const old = all[i];
      const type = (old.getAttribute('type') || '').trim();
      if (!RUNS.test(type) || !old.isConnected) continue;
      const s = document.createElement('script');
      for (const a of old.attributes) if (a.name !== 'nonce') s.setAttribute(a.name, a.value);
      const n = config.nonce || old.nonce;
      if (n) s.nonce = n;
      const external = old.hasAttribute('src');
      const ordered = external && !old.hasAttribute('async');
      if (ordered) s.async = false;
      if (!external) s.text = old.text;
      if (at.length === all.length) scriptAt.set(s, at[i]);
      const done = ordered || type.toLowerCase() === 'module' ? loaded(s) : null;
      old.replaceWith(s);
      if (done) {
        await done;
        if (taskStart) taskStart = now(); // a load event starts a new task
      }
    }
  } finally {
    scriptRoot = outer;
    intercept(false);
  }
}

// Where each <script> tag is written: only raw HTML blocks hold them. A
// `<script` inside a script's own text (a string in its code) is not a tag:
// the scan skips to the end tag.
function scriptPositions(ast) {
  const out = [];
  if (!ast) return out;
  T.visit(ast, 'html', (n) => {
    const v = n.value || '';
    const p = n.position && n.position.start;
    if (!p) return;
    const re = /<!--[\s\S]*?(?:-->|$)|<script\b/gi;
    for (let m = re.exec(v); m; m = re.exec(v)) {
      if (m[0][1] === '!') continue;
      const before = v.slice(0, m.index);
      const nl = before.lastIndexOf('\n');
      const pt = { line: p.line + (before.match(/\n/g) || []).length, column: nl < 0 ? p.column + m.index : m.index - nl, offset: p.offset + m.index };
      out.push({ start: pt, end: pt });
      const close = v.toLowerCase().indexOf('</script', m.index + 7);
      re.lastIndex = close < 0 ? v.length : close + 8;
    }
  });
  return out;
}

// The guard is installed for the outermost runScripts and removed when it
// ends: a note script that calls luccet.render(el, source) with a script in
// the source runs a nested runScripts, whose end must not disarm the guard
// for the scripts still to come (a later document.write would wipe the page).
let intercepting = 0;
function intercept(on) {
  if (!on) {
    if (--intercepting > 0) return;
    intercepting = 0;
    for (const k of ['write', 'writeln', 'addEventListener']) delete document[k];
    delete window.addEventListener;
    return;
  }
  if (intercepting++ > 0) return;
  const at = () => scriptAt.get(document.currentScript) || null;
  document.write = document.writeln = function (...args) {
    const text = args.join('').replace(/\s+/g, ' ').trim();
    report('script.document-write', at(), `a note script called document.write("${text.length > 60 ? `${text.slice(0, 60)}…` : text}"); the page is already parsed, so its output is dropped`, 'build elements with the DOM instead, for example document.currentScript.after(element)', document.currentScript);
  };
  const add = EventTarget.prototype.addEventListener;
  // A DOMContentLoaded listener is reported and not registered: the mount
  // may run inside the event's dispatch (luccet's own listener on document),
  // where one added to window would still run, so "never runs" holds only if
  // it is never added.
  const wrapped = function (type, fn, opts) {
    if (type !== 'DOMContentLoaded') return add.call(this, type, fn, opts);
    report('script.domcontentloaded', at(), 'a note script listens for DOMContentLoaded, which fired before note scripts run, so the listener never runs', "use luccet.on('ready', fn), or run the code directly", document.currentScript);
  };
  document.addEventListener = wrapped;
  window.addEventListener = wrapped;
}

// ---------------------------------------------------------------- behaviours

async function process(root, safe) {
  roots.add(root);
  presentation(root);
  lineNumbers(root);
  if (!safe) behaviours(root);
  // The formulas are MathML already; an add-on that typesets math itself does
  // it in a 'render' listener, which is awaited, so a listener on 'math' sees
  // the formulas done. Both get {safe}.
  const info = { safe: !!safe };
  await fireAsync('render', root, info);
  fire('math', root, info);
}

// schema `dom` and luccet.define, once per element and function, in document
// order, keyed on data-t. A `t-block` element is a container, so its block
// entry comes first; otherwise the leaf, then the inline one. An element
// inside a safe root (one rendered with `safe` inside this root) gets none.
const domRecs = new WeakMap(); // a schema dom function -> {fn, done}
function behaviours(root) {
  behavioursRan = true;
  const schema = T.schema;
  const list = root.querySelectorAll('[data-t]');
  for (let i = root.hasAttribute('data-t') ? -1 : 0; i < list.length; i++) {
    const el = i < 0 ? root : list[i];
    if (inSafe(el)) continue;
    const name = el.getAttribute('data-t');
    const levels = el.classList.contains('t-block') ? ['block', 'leaf', 'inline'] : ['leaf', 'inline', 'block'];
    for (const level of levels) {
      const spec = own(schema[level], name) ? schema[level][name] : null;
      if (!spec || typeof spec.dom !== 'function') continue;
      let rec = domRecs.get(spec.dom);
      if (!rec) domRecs.set(spec.dom, (rec = { fn: spec.dom, done: new WeakSet() }));
      apply(rec, el, name);
      break;
    }
    const recs = defined.get(name);
    if (recs) for (const rec of recs.slice()) apply(rec, el, name);
  }
}

function apply(rec, el, name) {
  if (rec.done.has(el)) return;
  rec.done.add(el);
  try {
    rec.fn.call(el, el);
  } catch (e) {
    console.error(`luccet: the "${name}" behaviour failed`, e);
  }
}

// Line numbers from data-start: the base CSS reads --t-start, which the
// emitter writes as a style attribute on a built page and the runtime sets
// here through the CSSOM, which a CSP allows.
function lineNumbers(root) {
  for (const pre of root.querySelectorAll('pre[data-start]')) {
    const n = parseInt(pre.getAttribute('data-start'), 10);
    if (Number.isFinite(n) && !pre.style.getPropertyValue('--t-start')) pre.style.setProperty('--t-start', String(n));
  }
}

// ---------------------------------------------------------------- page handlers

// Copy: a rendered formula (the engine's MathML, or an add-on's) is copied as
// its TeX, $tex$ or $$tex$$ (from data-tex), in text/plain and text/html. A
// formula left as its TeX copies as its text, which is the TeX, by itself.
function onCopy(e) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
  const tex = (m) => {
    const t = m.getAttribute('data-tex') || '';
    return m.hasAttribute('data-display') ? `$$${t}$$` : `$${t}$`;
  };
  const rendered = (m) => m.hasAttribute('data-tex') && m.firstElementChild;
  const anc = sel.getRangeAt(0).commonAncestorContainer;
  const inside = (anc.nodeType === 1 ? anc : anc.parentElement).closest('.t-math[data-tex]');
  if (inside) {
    if (!rendered(inside)) return;
    e.clipboardData.setData('text/plain', tex(inside));
    e.clipboardData.setData('text/html', escText(tex(inside)));
    return void e.preventDefault();
  }
  const host = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) host.append(sel.getRangeAt(i).cloneContents());
  if (![...host.querySelectorAll('.t-math[data-tex]')].some(rendered)) return;
  for (const m of host.querySelectorAll('.t-math[data-tex]')) if (rendered(m)) m.replaceChildren(tex(m));
  // innerText needs layout: measured off screen inside main, then taken out.
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:40rem';
  (main && main.isConnected ? main : document.body).append(host);
  const text = host.innerText;
  host.remove();
  host.removeAttribute('style');
  host.removeAttribute('aria-hidden');
  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', host.innerHTML);
  e.preventDefault();
}

// Print: every details.t-block opens (and closes again afterwards), so its
// content prints.
let printOpened = [];
function onBeforePrint() {
  releaseAll();
  for (const d of document.querySelectorAll('details.t-block:not([open])')) (d.open = true), printOpened.push(d);
}
function onAfterPrint() {
  for (const d of printOpened) d.open = false;
  printOpened = [];
}

module.exports = { attach };
