// SPDX-License-Identifier: MIT
// mathml.js, Tern's MathML add-on (docs/addons.html#mathml). It renders every
// formula as native MathML with Temml, instead of tern.js's own KaTeX. The
// browser draws the MathML with its math fonts: no KaTeX, and once Temml has
// run nothing else is fetched.
//
//   <script src="tern.js" data-use="addons/mathml.js"></script>
//
// It is a math add-on like addons/katex.js: load one or the other. The engine
// renders no math itself, so the two never clash.
//
// Temml comes from jsDelivr, pinned with SRI (the table below), with its
// stylesheet, and only to a page that has a formula. `?base=URL` names a copy
// instead (the folder of temml.min.js and Temml-Local.css), loaded without
// SRI; a window.temml already on the page is used as it is. The TeX is kept in
// each formula's `<annotation>`, so it still copies as $tex$.
//
// A :::macros block defines macros for the formulas, as it does for KaTeX. A
// formula Temml cannot parse stays as its TeX source, marked t-error.
//
// A strict CSP that forbids inline styles (no 'unsafe-inline' in style-src)
// blocks the few style attributes Temml writes on a formula; its stylesheet
// (nonce'd with data-nonce) still applies, so the math renders, with at most
// some spacing off. For exact math under a strict policy, pre-render instead:
// `tern build --math=mathml`.
//
// Under node (tern check, tern build, the language server) it only adds its
// styles: rendering needs the page.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  // <temml> written by tools/temml.js; do not edit by hand
  const TEMML = {
    version: '0.14.0',
    js: 'sha384-qJQ7P+DRhXNyeli+ZThz25Ds5LRfplio0XuymYx3/9Nbv/tDev8QyVPrCYQONe+r',
    css: 'sha384-wrAonPpTrJ/7uzMC8LnKSeFSXi7NiAzdpkDAI+GD2Y5mFH9JFCJdHlscsQRFVr7x',
  };
  // </temml>

  // Display math as a block even before Temml's stylesheet arrives (Firefox
  // and Safari need it; Chromium reads the inline "display: block math").
  T.style(['.tern .t-math > math { font-size: inherit; }', '.tern .t-math > math.tml-display { display: block; width: 100%; }'].join('\n'));

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  const opts = Object.assign({}, T.config && T.config.use && T.config.use.mathml);
  const own = typeof opts.base === 'string' && opts.base.trim() !== '';
  const base = own ? opts.base.trim().replace(/\/+$/, '') : `https://cdn.jsdelivr.net/npm/temml@${TEMML.version}/dist`;

  // Temml's stylesheet, loaded with Temml at the first formula: the math
  // needs it across browsers (block display, script letters, stretchy
  // arrows), and a note without math fetches neither. The woff2 it names
  // resolves beside it.
  let styled = false;
  function stylesheet() {
    if (styled) return;
    styled = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${base}/Temml-Local.css`;
    if (T.config && T.config.nonce) link.nonce = T.config.nonce;
    if (!own) (link.integrity = TEMML.css), (link.crossOrigin = 'anonymous');
    document.head.append(link);
  }

  // Temml, asked for at the first formula. window.temml can be an element with
  // id="temml", which the browser names on window; the check guards that.
  const found = () => (window.temml && typeof window.temml.renderToString === 'function' ? window.temml : null);
  let temmlP = null;
  function temml() {
    stylesheet();
    if (temmlP) return temmlP;
    if (found()) return (temmlP = Promise.resolve(found()));
    temmlP = new Promise((resolve) => {
      const s = document.createElement('script');
      if (T.config && T.config.nonce) s.nonce = T.config.nonce;
      if (!own) (s.integrity = TEMML.js), (s.crossOrigin = 'anonymous');
      s.async = true;
      s.src = `${base}/temml.min.js`;
      s.onload = () => resolve(found());
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
    // A load that failed is asked for again at the next render.
    temmlP.then((M) => {
      if (M) return;
      console.warn(`Tern mathml.js: Temml did not load from ${base}, so math stays as TeX source`);
      temmlP = null;
    });
    return temmlP;
  }

  // One formula to MathML, into a detached template, then its nodes in. A
  // failure keeps the TeX (already the element's text), marked t-error.
  // A formula in a root rendered with `safe` (data-t-safe, src/runtime.js) is
  // untrusted: trust stays off and it gets a copy of the macro table, so a
  // \gdef in it reaches no other formula.
  const untrusted = (el) => !!el.closest('[data-t-safe]');
  function one(M, el, macros) {
    const tex = el.getAttribute('data-tex') || '';
    const safe = untrusted(el);
    let mml;
    try {
      mml = M.renderToString(tex, Object.assign({ displayMode: el.hasAttribute('data-display'), annotate: true, throwOnError: true, macros: safe ? Object.assign({}, macros) : macros }, safe ? { trust: false } : null));
    } catch (e) {
      el.classList.add('t-error');
      el.title = (e && e.message) || String(e);
      console.warn(`Tern mathml.js: ${el.title}`);
      return;
    }
    const t = document.createElement('template');
    t.innerHTML = mml;
    el.replaceChildren(...t.content.childNodes);
  }

  // Every formula under a root, once it is rendered. The TeX is saved to
  // data-tex synchronously, before tern.js's own math pass would read the
  // element's text, so it survives this replacement and the copy handler.
  const done = new WeakSet();
  function run(root) {
    const maths = [];
    for (const el of root.querySelectorAll('.t-math')) {
      if (done.has(el) || el.firstElementChild) continue;
      if (!el.hasAttribute('data-tex')) el.setAttribute('data-tex', el.textContent);
      done.add(el);
      maths.push(el);
    }
    if (!maths.length) return;
    return render(root, maths);
  }

  async function render(root, maths) {
    const M = await temml();
    if (!M) {
      for (const el of maths) done.delete(el); // left as TeX; a later root may still load it
      return;
    }
    // A :::macros block in a safe root is untrusted and defines nothing.
    const preamble = [...root.querySelectorAll('.t-macros')].filter((m) => !untrusted(m)).map((m) => m.textContent).join('\n');
    let macros = {};
    if (preamble.trim()) {
      try {
        macros = M.definePreamble(preamble);
      } catch (e) {
        console.warn(`Tern mathml.js: the :::macros block does not parse: ${(e && e.message) || e}`);
      }
    }
    for (const el of maths) one(M, el, macros);
  }

  T.on('render', run);
})();
