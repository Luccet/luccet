// SPDX-License-Identifier: MIT
// luccet build --diagrams: the note's mermaid fences drawn ahead, into the page
// cli/build.js writes, as the browser would draw them. The note itself is
// opened in a headless Chromium through Playwright, if it can be required
// (it is not a dependency), with Mermaid handed to the page: from the
// add-on's `?base=` folder, from a `mermaid` package, or from the copy
// tools/mermaid.js keeps; failing those the page fetches it from jsDelivr,
// as it would for a reader. The add-on draws, so the palettes, the print
// copies and the ids are its own. The page is read in the light scheme and
// in the dark one, and each fence gets a copy per palette that differs, with
// the print copy, in the add-on's wrapper, the fence hidden inside. On the
// built page the add-on adopts the drawings and asks for Mermaid only for a
// palette that has no copy. A fence Mermaid cannot draw stays a fence, with
// a diagram.error warning.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const escAttr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

const MERMAID_STYLE_ID = 'luccet-mermaid-style';
// What the add-on's styles do, for a page read with scripts off, and the
// rules that pick a copy before the add-on does: the light copy in a light
// scheme, the dark in a dark one, the print copy in print.
const MERMAID_STYLE = [
  '.t-mermaid { font-family: var(--t-sans); font-size: 16px; line-height: 1.5; }',
  '.luccet .t-mermaid { margin-block: 0 1rem; }',
  '.t-mermaid > svg { display: block; margin-inline: auto; max-inline-size: 100%; height: auto; }',
  '.t-mermaid > .t-mermaid-print, .t-mermaid > .t-mermaid-alt { display: none; }',
  '@media (prefers-color-scheme: dark) { .t-mermaid > .t-mermaid-light { display: none; } }',
  '@media (prefers-color-scheme: light) { .t-mermaid > .t-mermaid-dark { display: none; } }',
  '@media print { .t-mermaid > .t-mermaid-print { display: block; } .t-mermaid:has(> .t-mermaid-print) > .t-mermaid-screen { display: none; } }',
].join('\n');
const styleTag = (nonce) => `<style id="${MERMAID_STYLE_ID}"${nonce ? ` nonce="${escAttr(nonce)}"` : ''}>\n${MERMAID_STYLE}</style>`;

// A mermaid fence as the emitter writes it: the pre's attributes, the code.
const FENCE = /<pre\b([^>]*)><code class="language-mermaid(?:\s[^"]*)?">([\s\S]*?)<\/code><\/pre>/gi;
const fences = (html) => [...html.matchAll(FENCE)];

// ---------------------------------------------------------------- what is needed

// Playwright, from the CLI's own resolution (and NODE_PATH), then from the
// note's folder and the working folder: {pw, name} or null.
function requirePlaywright(dir) {
  for (const name of ['playwright', 'playwright-core']) {
    for (const resolve of [() => require.resolve(name), () => require.resolve(name, { paths: [dir, process.cwd()] })]) {
      try {
        const pw = require(resolve());
        if (pw && pw.chromium && typeof pw.chromium.launch === 'function') return { pw, name };
      } catch {}
    }
  }
  return null;
}

// The add-on's entry in the note's add-ons, and its ?base=.
function addonEntry(use) {
  for (const u of use) {
    const clean = u.replace(/#.*$/, '');
    if (!/(?:^|\/)mermaid(?:\.min)?\.js(?:\?|$)/i.test(clean)) continue;
    const q = clean.indexOf('?');
    const params = new URLSearchParams(q < 0 ? '' : clean.slice(q + 1));
    return { url: u, base: (params.get('base') || '').trim() };
  }
  return null;
}

// The version the add-on pins.
function pinned() {
  const m = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'addons', 'mermaid.js'), 'utf8'));
  return m ? m[1] : null;
}

// Where Mermaid comes from: {file, from} to hand to the page, {url, from}
// for the page to fetch, or a warning when a named folder has none.
function findMermaid(dir, entry) {
  const version = pinned();
  if (entry.base) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(entry.base) || entry.base.startsWith('//')) return { url: `${entry.base.replace(/\/+$/, '')}/mermaid.min.js`, from: `the add-on's base, ${entry.base}` };
    const file = path.resolve(dir, entry.base, 'mermaid.min.js');
    if (fs.existsSync(file)) return { file, from: `the add-on's base folder, ${entry.base}` };
    return { warning: `the add-on's base folder ${entry.base} has no mermaid.min.js (resolved from the note's folder); Mermaid is looked for elsewhere` };
  }
  for (const resolve of [() => require.resolve('mermaid/dist/mermaid.min.js'), () => require.resolve('mermaid/dist/mermaid.min.js', { paths: [dir, process.cwd()] })]) {
    try {
      const file = resolve();
      let v = '';
      try {
        v = ` ${require(path.join(path.dirname(file), '..', 'package.json')).version}`;
      } catch {}
      return { file, from: `the mermaid package${v}` };
    } catch {}
  }
  if (version) {
    const file = path.join(require('../tools/npm').CACHE, `mermaid-${version}`, 'dist', 'mermaid.min.js');
    if (fs.existsSync(file)) return { file, from: `the cached mermaid ${version}` };
  }
  return { url: null, from: `jsDelivr (mermaid ${version || ''}, as the page loads it)` };
}

// ---------------------------------------------------------------- in the page

// The colour properties the add-on's palette reads (its PRINT keys): their
// raw values tell whether the dark scheme changes the palette at all.
const KEYS = ['bg', 'fg', 'muted', 'line', 'line-strong', 'soft', 'link', 'mark', 'error', 'error-bg', 'warn', 'code-comment', 'code-keyword', 'code-string', 'code-number', 'code-function', 'code-type', 'code-variable', 'code-meta', 'code-inserted', 'code-deleted'];

// Every mermaid fence of the page in document order, as it stands: drawn
// (the screen copy and its palette key, the print copy), failed (the
// add-on's error after the fence), or pending.
const STATE = `(() => {
  const main = document.querySelector('main.luccet');
  const out = [];
  if (!main) return out;
  for (const el of main.querySelectorAll('.t-mermaid, pre')) {
    if (el.localName === 'pre') {
      const code = el.querySelector(':scope > code');
      if (!code || !/(?:^|\\s)language-mermaid(?:\\s|$)/i.test(code.className) || el.parentElement.classList.contains('t-mermaid')) continue;
      const next = el.nextElementSibling;
      out.push(next && next.classList.contains('t-mermaid-error') ? { error: next.textContent.replace(/^Mermaid cannot draw this diagram: /, '') } : { pending: true });
      continue;
    }
    if (el.classList.contains('t-mermaid-box')) continue;
    const screen = el.querySelector(':scope > svg.t-mermaid-screen');
    const print = el.querySelector(':scope > svg.t-mermaid-print');
    out.push(screen ? { screen: screen.outerHTML, key: screen.getAttribute('data-palette') || '', print: print ? print.outerHTML : null } : { pending: true });
  }
  return out;
})()`;
const SIGNATURE = `(() => {
  const cs = getComputedStyle(document.querySelector('main.luccet') || document.documentElement);
  return ${JSON.stringify(KEYS)}.map((k) => cs.getPropertyValue('--t-' + k).trim()).join('|') + '|' + cs.getPropertyValue('--t-sans').trim();
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until `done(state)` holds, then until the state has not changed for
// a moment (the print copies come after the screen ones). Returns the state.
async function settle(page, done, timeout) {
  const t0 = Date.now();
  let state = await page.evaluate(STATE);
  while (!done(state) && Date.now() - t0 < timeout) {
    await sleep(100);
    state = await page.evaluate(STATE);
  }
  let last = JSON.stringify(state);
  let quiet = 0;
  while (quiet < 600 && Date.now() - t0 < timeout + 10000) {
    await sleep(150);
    quiet += 150;
    state = await page.evaluate(STATE);
    const now = JSON.stringify(state);
    if (now !== last) (last = now), (quiet = 0);
  }
  return state;
}

// Opens the note and reads its diagrams in both schemes: per fence,
// {copies: [{html, key, scheme}], print} | {error} | {pending: true}.
async function read(pw, file, mermaid, { timeout }) {
  const browser = await pw.chromium.launch();
  try {
    const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    if (mermaid.file) await page.addInitScript({ path: mermaid.file });
    const console = [];
    page.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && console.push(m.text()));
    await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'load', timeout });
    try {
      await page.waitForFunction(() => window.luccet && window.luccet.ready, null, { timeout });
    } catch {
      throw new Error("luccet.js did not run in the browser: is the tag's src right from the note's folder?");
    }
    await page.evaluate(() => window.luccet.ready);
    const settled = (s) => s.every((x) => !x.pending);
    const light = await settle(page, settled, timeout);
    const sigLight = await page.evaluate(SIGNATURE);
    await page.emulateMedia({ colorScheme: 'dark' });
    let dark = light;
    if ((await page.evaluate(SIGNATURE)) !== sigLight) {
      // The add-on redraws what the palette change left stale.
      const keys = light.map((x) => x.key);
      dark = await settle(page, (s) => s.every((x, i) => !x.pending && (x.error || x.key !== keys[i] || !light[i].screen)), timeout);
    }
    const out = light.map((l, i) => {
      const d = dark[i] || l;
      if (l.pending && d.pending) return { pending: true };
      if (l.error && (d.error || d.pending)) return { error: l.error };
      if (!l.screen && !d.screen) return { error: l.error || d.error };
      const copies = [];
      if (l.screen) copies.push({ html: l.screen, key: l.key, scheme: 'light' });
      if (d.screen && d.key !== l.key) copies.push({ html: d.screen, key: d.key, scheme: 'dark' });
      if (copies.length === 1) copies[0].scheme = null;
      return { copies, print: l.print || d.print || null };
    });
    return { fences: out, console };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- into the page

// The wrapper the add-on makes, around the fence as emitted: the copies,
// the print copy, the fence hidden; the fence's id moves to the wrapper, so
// links land, and data-pos is copied.
function wrapper(attrs, code, result, nonce) {
  const id = /\sid="([^"]*)"/.exec(attrs);
  const pos = /\sdata-pos="([^"]*)"/.exec(attrs);
  const preAttrs = attrs.replace(/\sid="[^"]*"/, '');
  const inner = (html) => (nonce ? html.replace(/<style\b/g, `<style nonce="${escAttr(nonce)}"`) : html);
  const cls = (c) => `class="${c}"`;
  const svg = (html, c) => inner(html.replace(/^<svg\b[^>]*?\sclass="[^"]*"/, (m) => m.replace(/\sclass="[^"]*"/, ` ${cls(c)}`)));
  const copies = result.copies.map((c) => svg(c.html, c.scheme ? `t-mermaid-screen t-mermaid-${c.scheme}` : 't-mermaid-screen'));
  if (result.print) copies.push(svg(result.print, 't-mermaid-print'));
  return `<div class="t-mermaid"${id ? ` id="${id[1]}"` : ''}${pos ? ` data-pos="${pos[1]}"` : ''}>${copies.join('')}<pre${preAttrs} hidden><code class="language-mermaid">${code}</code></pre></div>`;
}

// Draws the diagrams of a built page in place: r is build()'s result (its
// html, use, nonce and toFile). Returns {total, drawn, from, warnings,
// failures}; failures are diagram.error diagnostics with file positions.
async function drawInto(r, file, { timeout = 60000 } = {}) {
  const warnings = [];
  const failures = [];
  const strip = () => (r.html = r.html.replace(new RegExp(`<style id="${MERMAID_STYLE_ID}"[^>]*>[\\s\\S]*?</style>\\n?`), ''));
  const found = fences(r.html);
  const result = { total: found.length, drawn: 0, from: null, warnings, failures };
  if (!found.length) return strip(), result;
  const dir = path.dirname(path.resolve(file));
  const entry = addonEntry(r.use || []);
  if (!entry) {
    warnings.push('the note does not load addons/mermaid.js, so its diagrams are not drawn');
    return strip(), result;
  }
  const playwright = requirePlaywright(dir);
  if (!playwright) {
    warnings.push('playwright cannot be required (npm install playwright && npx playwright install chromium); diagrams are left to the page');
    return strip(), result;
  }
  const mermaid = findMermaid(dir, entry);
  if (mermaid.warning) warnings.push(mermaid.warning);
  const source = mermaid.file || mermaid.url !== undefined ? mermaid : findMermaid(dir, { base: '' });
  result.from = source.from;
  let read_;
  try {
    read_ = await read(playwright.pw, file, source, { timeout });
  } catch (e) {
    warnings.push(`the diagrams could not be drawn: ${String((e && e.message) || e).split('\n')[0]}; they are left to the page`);
    return strip(), result;
  }
  const states = read_.fences;
  if (states.length !== found.length) {
    warnings.push(`the browser shows ${states.length} mermaid fence(s) where the page has ${found.length}; diagrams are left to the page`);
    return strip(), result;
  }
  const position = (attrs) => {
    const m = /\sdata-pos="(\d+):(\d+)"/.exec(attrs);
    const p = m ? { line: Number(m[1]), column: Number(m[2]) } : { line: 1, column: 1 };
    return r.toFile({ start: p, end: p });
  };
  let i = 0;
  r.html = r.html.replace(FENCE, (all, attrs, code) => {
    const s = states[i++];
    if (s.copies) {
      result.drawn++;
      return wrapper(attrs, code, s, r.nonce);
    }
    if (s.error) failures.push({ severity: 'warning', code: 'diagram.error', message: `Mermaid cannot draw this diagram, so the page keeps the fence: ${s.error}`, filePosition: position(attrs) });
    else failures.push({ severity: 'warning', code: 'diagram.error', message: 'this diagram was not drawn in time, so the page keeps the fence', filePosition: position(attrs) });
    return all;
  });
  if (!result.drawn) {
    const loaded = read_.console.find((t) => /Mermaid did not load/.test(t));
    if (loaded) warnings.push(`${loaded.replace(/^Luccet mermaid\.js: /, '')}; diagrams are left to the page`);
    strip();
  }
  return result;
}

module.exports = { drawInto, fences, styleTag, MERMAID_STYLE_ID, MERMAID_STYLE, requirePlaywright, findMermaid };
