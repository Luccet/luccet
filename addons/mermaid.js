// SPDX-License-Identifier: MIT
// mermaid.js, Tern's diagram add-on (docs/addons.html#mermaid). It draws
// each ```mermaid fence, titled ones (listings) too, as a diagram with
// Mermaid, in the page theme's colours and sans-serif font.
//
//   <script src="tern.js" data-use="addons/mermaid.js"></script>
//
// Mermaid comes from jsDelivr, pinned with SRI (the table below), and only
// to a page that has a mermaid fence. `?base=URL` names a copy instead (the
// folder of mermaid.min.js), loaded without SRI; a window.mermaid already on
// the page is used as it is. The add-on's other options go to
// mermaid.initialize: `?look=classic&layout=dagre`, or window.TERN = {use:
// {mermaid: {...}}} for nested ones.
//
// Mermaid writes the colours into each SVG, so a diagram is drawn for the
// palette in effect where it stands, and again when that changes (the
// reader's light or dark preference). A dark palette's diagram is drawn a
// second time in tern.css's print palette, the copy shown in print. The
// fence stays, hidden, inside the diagram's element; one that Mermaid
// cannot read stays as it is, with the error after it.
//
// A strict CSP blocks inline styles, which Mermaid writes while it draws
// and measures, and puts in its SVG. On a page with a nonce (data-nonce),
// they go through the CSSOM instead, which a CSP allows, and its <style>
// elements carry the nonce (guarded, below).
//
// Under node (tern check, tern build, the language server) it only adds its
// styles: drawing needs the page.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  // <mermaid> written by tools/mermaid.js; do not edit by hand
  const MERMAID = {
    version: '12.1.0',
    sri: 'sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4',
  };
  // </mermaid>

  T.style(
    [
      '.t-mermaid { font-family: var(--t-sans); font-size: 16px; line-height: 1.5; }',
      '.tern .t-mermaid { margin-block: 0 1rem; }',
      '.t-mermaid > svg { display: block; margin-inline: auto; max-inline-size: 100%; height: auto; }',
      '.t-mermaid > .t-mermaid-print { display: none; }',
      '.t-mermaid-box { position: absolute; inset-inline-start: -10000px; inset-block-start: 0; inline-size: var(--t-width); visibility: hidden; }',
      '@media print { .t-mermaid > .t-mermaid-print { display: block; } .t-mermaid:has(> .t-mermaid-print) > .t-mermaid-screen { display: none; } }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  const opts = Object.assign({}, T.config && T.config.use && T.config.use.mermaid);
  const own = typeof opts.base === 'string' && opts.base.trim() !== '';
  const base = own ? opts.base.trim().replace(/\/+$/, '') : `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID.version}/dist`;
  delete opts.base;
  for (const k of Object.keys(opts)) if (opts[k] === 'true' || opts[k] === 'false') opts[k] = opts[k] === 'true';

  // tern.css's print palette (src/css.js, @media print).
  const PRINT = {
    bg: '#ffffff', fg: '#000000', muted: '#555555', line: '#d9dde3', soft: '#f3f4f1',
    link: '#0b62c4', mark: '#fff2a8', error: '#b3261e', 'error-bg': '#fdecea', warn: '#8a5300',
    'code-comment': '#59636e', 'code-keyword': '#cf222e', 'code-string': '#0a3069', 'code-number': '#0550ae', 'code-function': '#6639ba',
    'code-type': '#953800', 'code-variable': '#0550ae', 'code-meta': '#116329', 'code-inserted': '#116329', 'code-deleted': '#82071e',
  };
  const KEYS = Object.keys(PRINT);

  // Mermaid, asked for at the first mermaid fence. window.mermaid can be an
  // element with id="mermaid", which the browser names on window.
  const found = () => (window.mermaid && typeof window.mermaid.render === 'function' ? window.mermaid : null);
  let mermaidP = null;
  function mermaid() {
    if (mermaidP) return mermaidP;
    if (found()) return (mermaidP = Promise.resolve(found()));
    mermaidP = new Promise((resolve) => {
      const s = document.createElement('script');
      if (T.config && T.config.nonce) s.nonce = T.config.nonce;
      if (!own) (s.integrity = MERMAID.sri), (s.crossOrigin = 'anonymous');
      s.async = true;
      s.src = `${base}/mermaid.min.js`;
      s.onload = () => resolve(found());
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
    mermaidP.then((M) => M || console.warn(`Tern mermaid.js: Mermaid did not load from ${base}, so diagrams stay as their source`));
    return mermaidP;
  }

  // A colour as #rrggbb, which Mermaid's colour maths reads: the canvas
  // normalises any CSS colour, reading the pixel back for those it does not
  // write as hex (oklch(), color-mix() …).
  let pen = null;
  function hex(value) {
    pen = pen || document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    pen.fillStyle = '#000';
    pen.fillStyle = value || '#000';
    if (/^#[0-9a-f]{6}$/i.test(pen.fillStyle)) return pen.fillStyle.toLowerCase();
    pen.clearRect(0, 0, 1, 1);
    pen.fillRect(0, 0, 1, 1);
    const d = pen.getImageData(0, 0, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const luminance = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };

  // The palette in effect at el, and its sans-serif font.
  function palette(el) {
    const cs = getComputedStyle(el);
    const p = { font: cs.getPropertyValue('--t-sans').trim() || 'sans-serif' };
    for (const k of KEYS) p[k] = hex(cs.getPropertyValue(`--t-${k}`).trim() || PRINT[k]);
    return p;
  }
  const keyOf = (p) => KEYS.map((k) => p[k]).join() + p.font;

  // #rrggbb as [hue, saturation, lightness], in degrees and percents, and
  // [h, s, l] as hsl().
  function toHsl(h) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l * 100];
    const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hue * 60, (d / (1 - Math.abs(2 * l - 1))) * 100, l * 100];
  }
  const hslText = ([h, s, l]) => `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${Math.max(0, Math.min(100, l)).toFixed(1)}%)`;

  // The theme's accents: the link colour, then the code colours, which
  // every theme fits to its background, less any too close to one taken
  // already (a theme may give two roles one colour).
  const ACCENTS = ['link', 'code-keyword', 'code-meta', 'code-type', 'code-function', 'code-string', 'code-deleted', 'code-number', 'code-variable', 'code-inserted', 'code-comment'];
  function accents(p) {
    const out = [];
    for (const c of ACCENTS.map((k) => p[k])) {
      const [h, s, l] = toHsl(c);
      const near = out.some((d) => {
        const [h2, s2, l2] = toHsl(d);
        const apart = Math.min(Math.abs(h - h2), 360 - Math.abs(h - h2));
        return (s < 15 || s2 < 15 ? Math.abs(s - s2) < 15 : apart < 20) && Math.abs(l - l2) < 20;
      });
      if (!near) out.push(c);
    }
    return out;
  }

  // Mermaid's base theme, from the palette; its own derivations fill the
  // rest. Categories (pie slices, git branches, mind map and timeline
  // sections …) take the accents in turn.
  function settings(p) {
    const dark = luminance(p.bg) < luminance(p.fg);
    const list = accents(p);
    const v = {
      darkMode: dark,
      fontFamily: p.font,
      fontSize: '16px',
      background: p.bg,
      primaryColor: p.soft,
      primaryTextColor: p.fg,
      primaryBorderColor: p.muted,
      secondaryColor: p.mark,
      secondaryTextColor: p.fg,
      secondaryBorderColor: p.muted,
      tertiaryColor: p.bg,
      tertiaryTextColor: p.fg,
      tertiaryBorderColor: p.line,
      lineColor: p.muted,
      textColor: p.fg,
      titleColor: p.fg,
      nodeBorder: p.muted,
      clusterBkg: p.bg,
      clusterBorder: p.line,
      edgeLabelBackground: p.bg,
      noteBkgColor: p.mark,
      noteTextColor: p.fg,
      noteBorderColor: p.warn,
      errorBkgColor: p['error-bg'],
      errorTextColor: p.error,
      useGradient: false,
      dropShadow: 'none',
      // Gantt charts
      sectionBkgColor: p.soft,
      altSectionBkgColor: p.bg,
      sectionBkgColor2: p.soft,
      excludeBkgColor: p.soft,
      taskBkgColor: p.soft,
      taskBorderColor: p.muted,
      taskTextColor: p.fg,
      taskTextLightColor: p.fg,
      taskTextDarkColor: p.fg,
      taskTextOutsideColor: p.fg,
      taskTextClickableColor: p.link,
      activeTaskBkgColor: p.mark,
      activeTaskBorderColor: p.warn,
      doneTaskBkgColor: p.line,
      doneTaskBorderColor: p.muted,
      critBkgColor: p['error-bg'],
      critBorderColor: p.error,
      gridColor: p.line,
      todayLineColor: p.error,
      vertLineColor: p.link,
      // architecture, radar, Wardley maps
      archEdgeColor: p.muted,
      archEdgeArrowColor: p.muted,
      archGroupBorderColor: p.muted,
      radar: { graticuleColor: p.line },
      wardleyEvolutionColor: p.error,
      // pie and xy charts: the accents, labels in the background colour
      pieSectionTextColor: p.bg,
      pieTitleTextColor: p.fg,
      pieLegendTextColor: p.fg,
      pieStrokeColor: p.bg,
      pieOuterStrokeColor: p.muted,
      pieOpacity: '1',
      xyChart: { plotColorPalette: list.join(',') },
    };
    for (let i = 0; i < 12; i++) {
      const c = list[i % list.length];
      const [h, sat] = toHsl(c);
      const tint = hslText(dark ? [h, Math.min(sat, 45), 22] : [h, Math.min(sat, 70), 86]);
      v[`pie${i + 1}`] = v[`cScaleInv${i}`] = v[`cScalePeer${i}`] = c;
      v[`cScale${i}`] = tint;
      v[`cScaleLabel${i}`] = p.fg;
      if (i < 8) (v[`git${i}`] = c), (v[`gitBranchLabel${i}`] = v[`gitInv${i}`] = p.bg), (v[`venn${i + 1}`] = v[`fillType${i}`] = tint);
    }
    // An author's own Mermaid theme (?theme=forest) has its own colours.
    const mine = typeof opts.theme === 'string' && opts.theme !== 'base';
    const user = opts.themeVariables && typeof opts.themeVariables === 'object' ? opts.themeVariables : null;
    // The author's options under the add-on's own: Mermaid draws when asked,
    // not on load, and securityLevel stays strict whatever the tag says
    // (docs/addons.html#mermaid-options).
    return Object.assign({ suppressErrorRendering: true, theme: 'base', fontFamily: p.font }, opts, {
      startOnLoad: false,
      securityLevel: 'strict',
      themeVariables: Object.assign(mine ? { fontFamily: p.font } : v, user),
    });
  }

  // Off-screen, in the diagrams' font, for Mermaid to measure text in.
  let box = null;
  function measuring() {
    if (!box || !box.isConnected) {
      box = document.createElement('div');
      box.className = 't-mermaid t-mermaid-box';
      box.setAttribute('aria-hidden', 'true');
      document.body.append(box);
    }
    return box;
  }

  // Style attributes renamed in markup, so that parsing it applies none,
  // and set again through the CSSOM, which a CSP allows; with a nonce, each
  // <style> given it. TAG is a start tag, its quoted values whole; ATTR one
  // of its attributes.
  const TAG = /<[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g;
  const ATTR = /(\s+)([^\s=/>]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  function unstyle(html, nonce) {
    return html.replace(TAG, (tag) => {
      const out = tag.replace(ATTR, (all, space, name, value) => (name.toLowerCase() === 'style' ? `${space}data-t-style${value || ''}` : all));
      return nonce && /^<style[\s>]/i.test(out) ? out.replace(/^<style/i, `<style nonce="${nonce.replace(/"/g, '&quot;')}"`) : out;
    });
  }
  function restyle(root) {
    const els = root.querySelectorAll('[data-t-style]');
    for (const el of root.nodeType === 1 && root.hasAttribute('data-t-style') ? [root, ...els] : els) {
      el.style.cssText = el.getAttribute('data-t-style');
      el.removeAttribute('data-t-style');
    }
  }

  // While Mermaid draws on a page with a nonce, so under a strict CSP, the
  // styles it writes go through the CSSOM and its <style> elements carry the
  // nonce: it measures its labels in the page, and blocked styles would put
  // them out of place. Only for the drawing, then the DOM is as it was.
  function guarded(run) {
    const nonce = T.config && T.config.nonce;
    if (!nonce) return run();
    const E = Element.prototype;
    const D = Document.prototype;
    const P = window.DOMParser && DOMParser.prototype;
    const was = { setAttribute: E.setAttribute, setAttributeNS: E.setAttributeNS, innerHTML: Object.getOwnPropertyDescriptor(E, 'innerHTML'), createElement: D.createElement, createElementNS: D.createElementNS, parse: P && P.parseFromString };
    const styleOf = (el, name) => String(name).toLowerCase() === 'style' && el.style;
    const nonced = (el) => (el.localName === 'style' && (el.nonce = nonce), el);
    E.setAttribute = function (name, value) {
      if (styleOf(this, name)) this.style.cssText = value;
      else was.setAttribute.call(this, name, value);
    };
    E.setAttributeNS = function (ns, name, value) {
      if (!ns && styleOf(this, name)) this.style.cssText = value;
      else was.setAttributeNS.call(this, ns, name, value);
    };
    Object.defineProperty(E, 'innerHTML', {
      configurable: true,
      enumerable: was.innerHTML.enumerable,
      get: was.innerHTML.get,
      set(html) {
        was.innerHTML.set.call(this, unstyle(String(html), nonce));
        restyle(this);
      },
    });
    D.createElement = function (...a) {
      return nonced(was.createElement.apply(this, a));
    };
    D.createElementNS = function (...a) {
      return nonced(was.createElementNS.apply(this, a));
    };
    if (P)
      P.parseFromString = function (text, type) {
        const doc = was.parse.call(this, unstyle(String(text), nonce), type);
        restyle(doc);
        return doc;
      };
    const undo = () => {
      Object.assign(E, { setAttribute: was.setAttribute, setAttributeNS: was.setAttributeNS });
      Object.defineProperty(E, 'innerHTML', was.innerHTML);
      Object.assign(D, { createElement: was.createElement, createElementNS: was.createElementNS });
      if (P) P.parseFromString = was.parse;
    };
    return Promise.resolve().then(run).finally(undo);
  }

  // One drawing at a time: mermaid.initialize is global. The last drawings
  // are kept by source and palette, so a note rendered again (the editor's
  // preview) shows its unchanged diagrams at once.
  const KEEP = 64;
  const drawn = new Map();
  let queue = Promise.resolve();
  let n = 0;
  function draw(src, p) {
    const key = `${keyOf(p)}\n${src}`;
    if (drawn.has(key)) {
      const r = drawn.get(key);
      drawn.delete(key);
      return drawn.set(key, r).get(key);
    }
    const r = (queue = queue.then(async () => {
      const M = await mermaid();
      if (!M) return null;
      if (document.fonts) await document.fonts.ready;
      try {
        M.initialize(settings(p));
        const { svg } = await guarded(() => M.render(`t-mermaid-${++n}`, src, measuring()));
        return { svg };
      } catch (e) {
        return { error: String((e && (e.message || e.str)) || e).trim() };
      }
    }));
    drawn.set(key, r);
    if (drawn.size > KEEP) drawn.delete(drawn.keys().next().value);
    return r;
  }

  // Mermaid's markup as nodes: its style attributes set through the CSSOM
  // once they are in the page, its <style> made anew with the page's nonce
  // (a template's content is inert, so neither applies there).
  function nodes(svg) {
    const t = document.createElement('template');
    t.innerHTML = unstyle(svg); // Mermaid sanitises labels (securityLevel strict)
    for (const old of t.content.querySelectorAll('style')) {
      const s = document.createElementNS(old.namespaceURI, 'style');
      if (T.config && T.config.nonce) s.nonce = T.config.nonce;
      s.textContent = old.textContent;
      old.replaceWith(s);
    }
    return t.content.firstElementChild;
  }

  function place(wrap, svg, cls) {
    const el = nodes(svg);
    if (!el) return;
    el.classList.add(cls);
    const old = wrap.querySelector(`:scope > .${cls}`);
    if (old) old.replaceWith(el);
    else wrap.insertBefore(el, wrap.querySelector(':scope > pre'));
    restyle(el);
  }

  // The fence's element, the diagram's from now on, holding the fence; the
  // palette it was last drawn for. A later drawing of it supersedes one
  // still under way.
  const sources = new WeakMap();
  const drawnFor = new WeakMap();
  async function show(wrap) {
    const screen = palette(wrap);
    const key = keyOf(screen);
    drawnFor.set(wrap, key);
    const current = () => wrap.isConnected && drawnFor.get(wrap) === key;
    const r = await draw(sources.get(wrap), screen);
    if (!r || !current()) return;
    if (r.error) return fail(wrap, r.error);
    place(wrap, r.svg, 't-mermaid-screen');
    wrap.querySelector(':scope > pre').hidden = true;
    const old = wrap.querySelector(':scope > .t-mermaid-print');
    if (luminance(screen.bg) >= luminance(screen.fg)) return void (old && old.remove());
    const pr = await draw(sources.get(wrap), Object.assign({}, PRINT, { font: screen.font }));
    if (pr && pr.svg && current()) place(wrap, pr.svg, 't-mermaid-print');
  }

  function fail(wrap, message) {
    const pre = wrap.querySelector(':scope > pre');
    const err = document.createElement('div');
    err.className = 't-error t-mermaid-error';
    err.textContent = `Mermaid cannot draw this diagram: ${message}`;
    wrap.replaceWith(pre, err);
    pre.hidden = false;
    console.warn(`Tern mermaid.js: ${message}`);
  }

  // Redraw when the reader's light or dark preference changes the palette.
  if (window.matchMedia)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      for (const wrap of document.querySelectorAll('.t-mermaid:not(.t-mermaid-box)')) if (sources.has(wrap) && keyOf(palette(wrap)) !== drawnFor.get(wrap)) show(wrap);
    });

  // Fences are pre[data-t=code], listings figure[data-t=code] holding one.
  T.define('code', (el) => {
    const pre = el.matches('pre') ? el : el.querySelector(':scope > pre');
    const code = pre && pre.querySelector(':scope > code');
    if (!code || !/(?:^|\s)language-mermaid(?:\s|$)/i.test(code.className)) return;
    const wrap = document.createElement('div');
    wrap.className = 't-mermaid';
    if (pre.id) (wrap.id = pre.id), pre.removeAttribute('id');
    if (pre.hasAttribute('data-pos')) wrap.setAttribute('data-pos', pre.getAttribute('data-pos'));
    sources.set(wrap, code.textContent);
    pre.replaceWith(wrap);
    wrap.append(pre);
    show(wrap);
  });
})();
