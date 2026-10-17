// SPDX-License-Identifier: MIT
// katex.js, Tern's math add-on (docs/addons.html#katex). It typesets every
// formula — $x$, $$…$$ and :::macros — with KaTeX, to styled HTML with KaTeX's
// own fonts, so the math looks the same in every browser.
//
//   <script src="tern.js" data-use="addons/katex.js"></script>
//
// Without a math add-on, the engine leaves each formula as its TeX source
// (like a code fence with no code.js). This add-on is the typeset default; for
// native MathML with no fonts to load, use addons/mathml.js instead.
//
// KaTeX comes from jsDelivr, pinned with SRI (the table below), with its
// stylesheet, loaded at the first formula. `?base=URL` names a copy instead
// (the folder of katex.min.js and katex.min.css), loaded without SRI; a
// window.katex already on the page is used as it is. Options go in
// window.TERN = {use: {katex: {macros: {…}, strict: false, …}}} — anything
// KaTeX takes but displayMode and throwOnError. The TeX is kept in each
// formula's data-tex, so it still copies as $tex$.
//
// A long note's off-screen blocks get content-visibility while the formulas
// are typeset in time slices, so no task runs long and no frame janks; a
// formula in a closed <details> is typeset when it opens, and everything
// pending is typeset before printing or a fragment scroll. A formula KaTeX
// rejects stays as its TeX source, marked t-error.
//
// Under node (tern check, tern build, the language server) it does nothing:
// typesetting needs the page.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  // <katex> written by tools/katex.js; do not edit by hand
  const KATEX = {
    version: '0.19.0',
    js: 'sha384-QFFtAGzvvj+bfgCGxXJlNZZR1nXEZgvG8tDLCCY1F19xl20WlfTYgguB4VcNdxYk',
    css: 'sha384-3rdsX6e5mueWyoweR9NIVmtEsUkokpBT/0ALqKKIBMr9j4qhHkaIkAcGgsE6uVlp',
  };
  // </katex>

  // KaTeX positions .katex and its bases relatively (0.19), so in print
  // Chromium paints a formula after the text around it and the PDF text layer
  // moves it out of its sentence. !important, as KaTeX's stylesheet loads after
  // this one.
  T.style('@media print { .katex, .katex :is(.base, .katex-base) { position: static !important; } }');

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  const opts = Object.assign({}, T.config && T.config.use && T.config.use.katex);
  const own = typeof opts.base === 'string' && opts.base.trim() !== '';
  const base = own ? opts.base.trim().replace(/\/+$/, '') : `https://cdn.jsdelivr.net/npm/katex@${KATEX.version}/dist`;
  delete opts.base;
  // Options from the add-on's query string arrive as strings, and KaTeX reads
  // its booleans with Boolean(), so 'false' would turn trust and strict on:
  // 'true' and 'false' are the booleans they spell, as mermaid.js reads them.
  for (const k of Object.keys(opts)) if (opts[k] === 'true' || opts[k] === 'false') opts[k] = opts[k] === 'true';

  const SLICE_MS = 10; // one typeset slice; a frame holds a few
  const HOLD_OVER = 100; // over this many visible formulas, hold off-screen blocks

  // ---------------------------------------------------------------- KaTeX

  // KaTeX, asked for at the first formula. window.katex can be an element with
  // id="katex", which the browser names on window; the check guards that.
  const found = () => (window.katex && typeof window.katex.render === 'function' ? window.katex : null);
  let katexP = null;
  function katex() {
    if (katexP) return katexP;
    if (found()) return (katexP = Promise.resolve(found()));
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${base}/katex.min.css`;
    if (T.config && T.config.nonce) link.nonce = T.config.nonce;
    if (!own) (link.integrity = KATEX.css), (link.crossOrigin = 'anonymous');
    link.fetchPriority = 'low';
    // The stylesheet's load is awaited as the script's is: typeset without
    // it, each formula would show three times over, unstyled.
    const css = new Promise((resolve) => {
      link.onload = () => resolve(true);
      link.onerror = () => resolve(false);
    });
    document.head.append(link);
    const js = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = `${base}/katex.min.js`;
      s.async = true;
      s.fetchPriority = 'low';
      if (T.config && T.config.nonce) s.nonce = T.config.nonce;
      if (!own) (s.integrity = KATEX.js), (s.crossOrigin = 'anonymous');
      s.onload = () => resolve(found());
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
    katexP = Promise.all([js, css]).then(([K, styled]) => {
      if (!K) warn(`KaTeX did not load from ${base}, so math stays as TeX source`);
      else if (!styled) warn(`KaTeX's stylesheet did not load from ${base}, so math stays as TeX source`);
      if (!K || !styled) {
        // Asked for again at the next render: the network may be back.
        katexP = null;
        link.remove();
      }
      return K && styled ? K : null;
    });
    return katexP;
  }

  // Options from window.TERN.use.katex: trust, strict, output, leqno, macros,
  // and any other KaTeX option but displayMode and throwOnError. One macro
  // table is shared by every formula, the :::macros bodies filling it first.
  let K = null;
  let inlineOpts, displayOpts, macroOpts;
  function useKatex(k) {
    K = k;
    const base = { throwOnError: true, macros: Object.assign({}, opts.macros) };
    for (const key of Object.keys(opts)) if (!['macros', 'displayMode', 'throwOnError'].includes(key)) base[key] = opts[key];
    inlineOpts = Object.assign({}, base, { displayMode: false });
    displayOpts = Object.assign({}, base, { displayMode: true });
    macroOpts = Object.assign({}, base, { displayMode: false, globalGroup: true });
    return k;
  }
  // A formula in a root rendered with `safe` (data-t-safe, src/runtime.js) is
  // untrusted: KaTeX's trust is off whatever the page sets, so \href and
  // \includegraphics stay errors, and it gets a copy of the macro table, so
  // a \gdef in it reaches no other formula.
  const safeOpts = (display) => Object.assign({}, display ? displayOpts : inlineOpts, { trust: false, macros: Object.assign({}, inlineOpts.macros) });
  const untrusted = (el) => !!el.closest('[data-t-safe]');

  // ---------------------------------------------------------------- the formulas

  const done = new WeakSet();
  const deferred = new Set(); // formulas in a closed <details>
  const macrosDone = new WeakSet();
  let queue = [];
  let qi = 0;
  let pumping = false;
  let waiters = [];

  // Typesets the formulas in a root; one in a closed <details> waits for it to
  // open. Returns when the visible ones are typeset (the 'render' event awaits
  // it, so 'math' fires after). The TeX is saved to data-tex first, so it
  // survives this and the copy handler.
  async function render(root) {
    const all = root.querySelectorAll('.t-math');
    for (const el of all) if (!el.hasAttribute('data-tex')) el.setAttribute('data-tex', el.textContent);
    const visible = [];
    for (const el of all) {
      if (done.has(el) || deferred.has(el)) continue;
      if (el.firstElementChild) done.add(el); // typeset already (tern build)
      else if (closedDetails(el)) deferred.add(el);
      else visible.push(el);
    }
    // Macros matter only to a formula typeset here; a page whose formulas are
    // all pre-rendered (tern build --katex) needs no KaTeX, not even for them.
    // A :::macros block in a safe root is untrusted and fills no table.
    const macros = !visible.length && !deferred.size ? [] : [...root.querySelectorAll('.t-macros')].filter((m) => !untrusted(m));
    if (!visible.length && !deferred.size && !macros.length) return;
    if (visible.length > HOLD_OVER) hold(root);
    if (!(K || (await katex()))) return; // left as TeX
    if (!inlineOpts) useKatex(K || found());
    for (const m of macros) {
      if (macrosDone.has(m)) continue;
      macrosDone.add(m);
      try {
        K.renderToString(m.textContent, macroOpts);
      } catch (e) {
        warn(`the :::macros block does not parse: ${e.message}`);
      }
    }
    if (!visible.length) return;
    for (const el of visible) queue.push(el);
    if (!pumping) {
      pumping = true;
      pump(SLICE_MS);
    }
    if (pumping) await new Promise((resolve) => waiters.push(resolve));
  }

  function pump(budget) {
    const end = now() + budget;
    do typesetOne(queue[qi++]);
    while (qi < queue.length && now() < end);
    if (qi < queue.length) return void later();
    queue = [];
    qi = 0;
    pumping = false;
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  }

  // Typeset into a detached box, moved in only on success: a failure keeps the
  // TeX visible. katex.render builds the DOM with CSSOM styles, which a CSP
  // allows; renderToString's style attributes would be blocked by one.
  let box = null;
  function typesetOne(el) {
    if (!el || done.has(el)) return;
    done.add(el);
    if (!el.isConnected) return;
    box = box || document.createElement('span');
    const display = el.hasAttribute('data-display');
    try {
      K.render(el.getAttribute('data-tex') || '', box, untrusted(el) ? safeOpts(display) : display ? displayOpts : inlineOpts);
    } catch (e) {
      box.textContent = '';
      el.classList.add('t-error');
      el.title = e.message;
      warn(`KaTeX cannot typeset this formula: ${e.message}`);
      return;
    }
    el.replaceChildren(...box.childNodes);
  }

  const now = () => performance.now();
  const warn = (message) => console.warn(`Tern katex.js: ${message}`);

  // The next slice: after the next frame while the page is visible (the frame
  // callback posts a MessageChannel task, so the slice runs after the paint,
  // not before it), at once while it is hidden, where frames stop.
  let port = null;
  let frame = 0;
  function later() {
    if (!port) {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => pump(SLICE_MS);
      port = ch.port2;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && frame) cancelAnimationFrame(frame), (frame = 0), port.postMessage(0);
      });
    }
    if (document.hidden) port.postMessage(0);
    else frame = requestAnimationFrame(() => ((frame = 0), port.postMessage(0)));
  }

  // Everything pending, now: before printing and before a fragment scroll.
  function typesetNow() {
    if (!K) return;
    for (const el of deferred) if (!closedDetails(el)) deferred.delete(el), typesetOne(el);
    while (qi < queue.length) typesetOne(queue[qi++]);
  }

  // The closed <details> that hides el, if any (its own <summary> shows).
  function closedDetails(el) {
    for (let d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) {
      const s = d.querySelector(':scope > summary');
      if (!(s && s.contains(el))) return d;
    }
    return null;
  }

  // ---------------------------------------------------------------- held blocks

  // A typeset formula costs the browser layout. When many wait, a root's
  // top-level blocks get content-visibility:auto, which skips that for the
  // ones out of view; an IntersectionObserver gives it back as they near the
  // viewport. (Printing opens everything, below.)
  const held = new Map(); // block -> [content-visibility, contain-intrinsic-block-size]
  let watcher = null;
  function hold(root) {
    const blocks = [];
    for (const b of root.children) {
      if (held.has(b) || /^(?:script|style|template)$/.test(b.localName)) continue;
      held.set(b, [b.style.contentVisibility, b.style.containIntrinsicBlockSize]);
      b.style.contentVisibility = 'auto';
      if (!b.style.containIntrinsicBlockSize) b.style.containIntrinsicBlockSize = 'auto 40rem';
      blocks.push(b);
    }
    // In-viewport blocks now, so no frame shows a held block.
    const margin = (window.innerHeight || 800) * 1.5;
    let again = true;
    while (again) {
      again = false;
      for (const b of blocks) {
        if (!held.has(b)) continue;
        const r = b.getBoundingClientRect();
        if (r.bottom > -margin && r.top < (window.innerHeight || 800) + margin) release(b), (again = true);
      }
    }
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

  // ---------------------------------------------------------------- page handlers

  // A formula in a <details> is typeset when it opens.
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!d.open || !deferred.size || !K) return;
      const list = [];
      for (const el of deferred) if (d.contains(el) && !closedDetails(el)) list.push(el);
      if (!list.length) return;
      for (const el of list) deferred.delete(el), queue.push(el);
      if (!pumping) (pumping = true), pump(SLICE_MS);
    },
    true,
  );

  // Before printing and before a fragment scroll: all held blocks shown, all
  // pending math typeset, as the layout is taken right after.
  window.addEventListener('beforeprint', () => {
    for (const b of [...held.keys()]) release(b);
    typesetNow();
  });
  window.addEventListener('hashchange', typesetNow);

  // The engine awaits this 'render' listener before it fires 'math', so a
  // listener on 'math' sees the typeset formulas.
  T.on('render', render);
})();
