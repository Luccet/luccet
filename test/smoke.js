#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Browser smoke tests, in Chromium and Firefox through
// Playwright. Tests that need CDP (throttling, PDF) run in Chromium only;
// one that needs an API Firefox lacks skips there.
//
// A local server serves the repository, plus:
//   /nocharset/PATH      the file as text/html with no charset (charset test)
//   /csp/PATH            the file with a strict Content-Security-Policy
//   /csp-nonce/PATH      the same policy, plus the nonce csp-layout.html sets
//   /gen/big.js          a ≥ 250 KB script that records its execution
//   /gen/addon.js|.css   add-ons of a fixed size (waterfall test)
//   /gen/math4000.html   a long note with 4,000 formulas (mathNote)
//   /gen/long1mb.html    a 1 MB note of prose, lists, tables and code, no math (longNote)
//   /gen/long100kb.html  the same at 100 KB, over the default holdOver
//   /gen/a11y/luccet.html a note with every construct (a11yNote), for axe
//   /gen/fragment.html   two closed <details> below the fold (fragment tests)
//   /gen/use-long.html   a long note with a leading :::use (useLongNote)
//   /gen/built.html      test/smoke/built.html through `luccet build`;
//                        guarded.html and
//                        guarded-fr.html from `luccet new` (--lang=fr); built-own-schema.html,
//                        built-note-config.html, built-addon-throws.html and
//                        built-poster.html are
//                        test/smoke/own-schema.html, note-config.html,
//                        addon-throws.html and poster.html built;
//                        built-missing.html a note whose add-ons are missing, built
//   /gen/poster.png      a 1-pixel PNG, poster.html's poster
//   {{CDN}}              in test/smoke/*.html: a second, slow origin (a "CDN")
//   /test/samples/…      luccet.js and luccet.css resolve to the
//                        repository's; images, videos and component scripts
//                        the samples name but the repository lacks get
//                        stand-ins, so the console-error check sees Luccet's
//                        errors and not 404s
//   index.html, docs/,   the documentation: files a page's live
//   examples/            examples name but the repository lacks get the same
//                        stand-ins, listed in that page's report
//
// Math needs nothing from the network: the engine writes MathML itself. The
// add-ons are not the engine's (github.com/Luccet), and nor are their tests:
// a page that needs an add-on, any one, loads a fixture of test/smoke/
// (fence-addon.js, built-addon.js, …). axe-core, for the accessibility test,
// is fetched once from the npm registry into node_modules/.cache/luccet-smoke/
// (tools/npm.js, the tarball checked against its sha512).
//
// Each test has a timeout (30 s unless it says otherwise). A test can skip
// itself with a reason (a missing tool); skips are reported, not failed.
//
//   node test/smoke.js [--browsers=chromium,firefox] [--filter=TEXT] [--headed]
//
// LUCCET_JS=FILE serves FILE as /luccet.js (and for the samples' luccet.js), to
// try a build without writing the committed bundle.
//
// Needs the dev dependency: npm install && npx playwright install chromium firefox.
// The print test also needs mutool (MuPDF; Debian/Ubuntu: mupdf-tools).
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./lib/engine');

const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
const BROWSERS = (opt('browsers') || 'chromium,firefox').split(',');
const FILTER = opt('filter');
const DEFAULT_TIMEOUT = 30000;
const LUCCET_JS = process.env.LUCCET_JS ? path.resolve(process.env.LUCCET_JS) : path.join(ROOT, 'luccet.js');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:";
const NONCE = 'luccet-smoke-nonce';
const CSP_NONCE = CSP.replace(/(script-src|style-src) 'self'/g, `$1 'self' 'nonce-${NONCE}'`);

// ---- servers

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

const SAMPLES = path.join(ROOT, 'test', 'samples');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// What a sample note names but the repository does not have.
function sampleStandIn(file) {
  const base = path.basename(file);
  if (['luccet.js', 'luccet.css'].includes(base) && fs.existsSync(path.join(ROOT, base))) return { file: path.join(ROOT, base) };
  const ext = path.extname(file);
  if (ext === '.svg') return { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#ccc"/></svg>' };
  if (/^\.(png|jpe?g|gif|webp)$/.test(ext)) return { type: 'image/png', body: PNG_1PX };
  if (ext === '.css') return { type: 'text/css', body: '/* a stand-in stylesheet */\n' }; // a theme or a preload a fence shows
  if (/^\.(mp4|webm|ogg|mp3)$/.test(ext)) return { status: 204 }; // silent in both browsers; an empty 200 stalls Firefox's load event
  if (ext === '.js') {
    // A component script: define the element its file is named after.
    const tag = path.basename(file, ext);
    return { type: 'text/javascript', body: /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(tag) ? `customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { connectedCallback() { this.textContent = '[stand-in ${tag}]'; } });\n` : '' };
  }
  return null;
}

// The documentation's examples name files that do not exist (cat.png,
// tide.mp4), and Chromium's preload scanner fetches what a fence shows
// (`<script src="luccet.js">`). Those requests get the samples' stand-ins,
// recorded per page so its test can list them; a page's own links and
// images are test/docs.js's to check.
const docStandIns = new Map(); // page path -> Set of stood-in paths
function docsReferer(req) {
  try {
    const p = new URL(req.headers.referer).pathname;
    return /^\/(?:index\.html)?$|^\/(?:docs|examples)\/[^/]+\.html$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

function staticHandler(cdnOrigin) {
  return (req, res) => {
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let charset = true;
    const headers = {};
    if (url.startsWith('/nocharset/')) {
      url = url.slice('/nocharset'.length);
      charset = false;
    }
    if (url.startsWith('/csp/')) {
      url = url.slice('/csp'.length);
      headers['Content-Security-Policy'] = CSP;
    }
    if (url.startsWith('/csp-nonce/')) {
      url = url.slice('/csp-nonce'.length);
      headers['Content-Security-Policy'] = CSP_NONCE;
    }
    if (url === '/gen/never.js') return; // the add-on that never loads (the deadline test): no answer, ever
    if (url.startsWith('/gen/a11y/') && url.endsWith('.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(a11yNote());
      return;
    }
    if (url.startsWith('/gen/') && GENERATED[url.slice(5)]) {
      const [type, body] = GENERATED[url.slice(5)]();
      res.writeHead(200, { 'Content-Type': /^text\/|javascript/.test(type) ? `${type}; charset=utf-8` : type });
      res.end(body);
      return;
    }
    let file = path.join(ROOT, path.normalize(url));
    // A folder's address is its index.html, as GitHub Pages and most servers serve it; a page without its extension is the page.
    if (url.endsWith('/') && fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    const missing = !file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory();
    const docs = missing && file.startsWith(ROOT + path.sep) && docsReferer(req);
    if (missing && (file.startsWith(SAMPLES + path.sep) || docs)) {
      const stand = sampleStandIn(file);
      if (docs && stand) {
        if (!docStandIns.has(docs)) docStandIns.set(docs, new Set());
        docStandIns.get(docs).add(url);
      }
      if (stand && stand.file) file = stand.file;
      else if (stand) {
        res.writeHead(stand.status || 200, stand.type ? { 'Content-Type': stand.type } : {});
        res.end(stand.body);
        return;
      }
    }
    if (file === path.join(ROOT, 'luccet.js')) file = LUCCET_JS;
    if ((file !== LUCCET_JS && !file.startsWith(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (file.startsWith(path.join(ROOT, 'test', 'smoke'))) body = Buffer.from(body.toString('utf8').replace(/\{\{CDN\}\}/g, cdnOrigin));
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { ...headers, 'Content-Type': charset && /^text|javascript|json|svg/.test(type) ? `${type}; charset=utf-8` : type });
    res.end(body);
  };
}

function cdnHandler(_req, res) {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end("window.order = (window.order || []).concat('cdn');\n");
  }, 300);
}

// ---- generated pages

const pad = (kb) => '/*' + 'x'.repeat(kb * 1024) + '*/\n';

// A 4,000-formula note in the core vocabulary: 80 sections, each a heading
// with one formula and seven blocks of seven formulas (a title, three inline,
// one display, two inline), two of the seven blocks being closed <details>
// (1,120 formulas, 28 %). 3,440 inline and 560 display. No add-on: the
// engine writes the MathML. The note script records when 'render' and
// 'math' fire.
function mathNote(sections = 80) {
  const kinds = ['theorem', 'definition', 'lemma', 'example', 'details', 'details', 'remark'];
  const out = [
    '<!doctype html><meta charset="utf-8"><script src="/luccet.js"></script>',
    '',
    '<script>',
    "  window.__t = { script: performance.now() };",
    "  luccet.on('render', () => { window.__t.render = performance.now(); });",
    "  luccet.on('math', () => { window.__t.math = performance.now(); });",
    '</script>',
    '',
    '# A long note: 4,000 formulas',
    '',
  ];
  for (let s = 1; s <= sections; s++) {
    out.push(`## Section ${s}: the space $L^{${(s % 5) + 1}}(\\Omega)$`, '');
    kinds.forEach((kind, i) => {
      const b = i + 1;
      const id = `${s}-${b}`;
      out.push(
        `:::${kind}[Result ${s}.${b} on $\\|x\\|_{${b}}$]{#r-${id}}`,
        `Let $x \\in \\mathbb{R}^n$ and $\\lambda_{${b}} > 0$. Then $\\sum_{i=1}^n x_i^2 \\le C \\lambda_{${b}}$ by @eq-${id}.`,
        '',
        `$$ \\int_\\Omega |\\nabla u|^2 \\, dx = \\lambda_{${b}} \\int_\\Omega u^2 \\, dx $$ {#eq-${id}}`,
        '',
        `Second paragraph with $\\alpha_{${b}}$ and $\\beta$; compare @eq-${id}.`,
        ':::',
        '',
      );
    });
  }
  return out.join('\n');
}

// Two closed <details> after enough prose to be below the fold: #box holds
// the fragment target #deep and a formula, #fold holds two formulas.
function fragmentNote() {
  const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}, to put what follows below the fold.`).join('\n\n');
  return [
    '<!doctype html><meta charset="utf-8"><script src="/luccet.js"></script>',
    '',
    '# Smoke: fragment targets',
    '',
    filler,
    '',
    ':::details[Closed, holding the target]{#box}',
    'Beside the target: $\\sqrt{2}$.',
    '',
    '{#deep}',
    'The target paragraph.',
    ':::',
    '',
    filler,
    '',
    ':::details[Closed, with math]{#fold}',
    'Inline $e^{i\\pi} + 1 = 0$ and display:',
    '',
    '$$ \\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6} $$',
    ':::',
    '',
  ].join('\n');
}

// A leading `:::use` block, then enough prose that the file arrives in many
// chunks on a slow network: the runtime must find the block in the first.
// luccet.js is a blocking script that downloads alongside the note, so the
// note is made 2.5 times its size: it is still arriving when luccet.js runs.
function useLongNote() {
  const filler = Array.from({ length: Math.ceil((2.5 * fs.statSync(LUCCET_JS).size) / 143) }, (_, i) =>`Paragraph ${i + 1}: enough prose to make the file arrive in many network chunks on Slow 3G, so that the leading block is read long before the end.`).join('\n\n');
  return ['<!doctype html><meta charset="utf-8"><script src="/luccet.js"></script>', '', ':::use', '/test/smoke/fence-addon.js', ':::', '', '# Smoke: a long note with a leading :::use', '', 'A formula $x^2$ near the top.', '', filler, ''].join('\n');
}

// A long note with no math, about a megabyte: the runtime's held blocks
// (src/runtime.js hold) are what keeps its first paint quick.
function longNote(bytes = 1000000) {
  const out = [
    '<!doctype html><meta charset="utf-8"><script src="/luccet.js"></script>',
    '',
    '<script>',
    "  window.__t = { script: performance.now() };",
    "  luccet.on('render', () => { window.__t.render = performance.now(); });",
    "  luccet.on('ready', () => { window.__t.ready = performance.now(); });",
    '</script>',
    '',
    '# A long note: about a megabyte of prose {#top}',
    '',
  ];
  const para = 'The kernel of a linear map is the set of vectors sent to zero; it is a subspace, and its dimension plus the rank is the dimension of the domain. '.repeat(4);
  let size = 0;
  for (let s = 1; size < bytes; s++) {
    const part = [
      `## Section ${s}: linear maps, part ${s} {#s-${s}}`,
      '',
      para,
      '',
      `- item one of section ${s}`,
      `- item two, with a [link](#top) and **emphasis**`,
      `- item three, with inline \`code()\``,
      '',
      '| Phase | Weeks | Note |',
      '|---|--:|---|',
      `| P${s} | ${s % 9} | a cell in section ${s} |`,
      '',
      '```js',
      `function section${s}() { return ${s}; }`,
      '```',
      '',
      `:::theorem[Result ${s}]{#r-${s}}`,
      para,
      ':::',
      '',
      `${para}See @r-${s} and the [top](#top).`,
      '',
    ].join('\n');
    out.push(part);
    size += part.length + 1;
  }
  return out.join('\n');
}

// A note with every construct the emitter writes, under luccet.css, with a
// language and a title, for an axe run; its formulas are the engine's
// MathML. (The themes are checked in github.com/Luccet/themes.)
function a11yNote() {
  return [
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Accessibility: luccet.css</title><script src="/luccet.js"></script>',
    '',
    '# Every construct {#top}',
    '',
    'A paragraph with a [link](#top), *emphasis*, **strong**, `code`, :kbd[Ctrl], a ==highlight with a [link](#eq) inside== and a footnote.[^n]',
    '',
    '> A quotation, in the muted colour, with ==a highlight==.',
    '',
    '## A list and a task list {#lists}',
    '',
    '- one\n- two with `code`\n\n1. first\n2. second\n\n- [x] done\n- [ ] not done',
    '',
    '## A table {#table}',
    '',
    '| Phase | Weeks | Note |\n|---|--:|---|\n| P2 | 2 | golden DOM |\n| P3 | 3 | smoke green |',
    '',
    '## Code {#code}',
    '',
    '```js {lines start=3 hl=4}\nfunction a() {}\nfunction b() {} // highlighted\nfunction c() {}\n```',
    '',
    '## Math and a figure {#math}',
    '',
    'Inline $x^2$ and display:',
    '',
    '$$\nE = mc^2\n$$ {#eq}',
    '',
    ':::figure[A one-pixel image]{#fig}\n![A grey square](/gen/poster.png)\n:::',
    '',
    ':::details[More]{#more}\nHidden until opened.\n:::',
    '',
    ':::aside{#aside}\nAn aside, with @eq and @fig.\n:::',
    '',
    '::toc',
    '',
    '[^n]: The footnote, with a back link.',
    '',
  ].join('\n');
}

const GENERATED = {
  'big.js': () => ['text/javascript', pad(260) + "window.order = (window.order || []).concat('external');\n"],
  'addon.js': () => ['text/javascript', pad(20) + 'window.__addon = (window.__addon || 0) + 1;\n'],
  'addon.css': () => ['text/css', pad(6) + '.luccet { outline-color: currentColor; }\n'],
  'math4000.html': () => ['text/html', mathNote()],
  'long1mb.html': () => ['text/html', longNote()],
  'long100kb.html': () => ['text/html', longNote(100000)],
  'fragment.html': () => ['text/html', fragmentNote()],
  'built.html': () => ['text/html', cliPage('built')],
  'use-long.html': () => ['text/html', useLongNote()],
  'built-missing.html': () => ['text/html', cliPage('built-missing')],
  'built-own-schema.html': () => ['text/html', cliPage('built-own-schema')],
  'built-note-config.html': () => ['text/html', cliPage('built-note-config')],
  'built-addon-throws.html': () => ['text/html', cliPage('built-addon-throws')],
  'built-poster.html': () => ['text/html', cliPage('built-poster')],
  'poster.png': () => ['image/png', PNG_1PX],
  'guarded.html': () => ['text/html', cliPage('guarded')],
  'guarded-fr.html': () => ['text/html', cliPage('guarded-fr')],
};

// ---- pages written by the command line

// `luccet build` and `luccet new` (its guard), run once per page; a test's setup
// calls cliPage first, so a failure fails that test.
const CLI = path.join(ROOT, 'luccet-cli.js');
const GUARDED_NOTE = '# Smoke: a guarded note\n\nRendered by luccet.js, or shown as its source when luccet.js does not load.\n';
const cliPages = new Map();

function cliPage(name) {
  if (cliPages.has(name)) return cliPages.get(name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luccet-smoke-cli-'));
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    if (r.status !== 0) throw new Error(`luccet ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  try {
    let html;
    if (name === 'built') html = cli(['build', 'test/smoke/built.html']);
    else if (/^built-(?:own-schema|note-config|addon-throws|poster)$/.test(name)) html = cli(['build', `test/smoke/${name.slice(6)}.html`]);
    else if (name === 'built-missing') {
      const file = path.join(tmp, 'missing.html');
      fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><script src="/luccet.js" data-use="/test/smoke/missing-addon.js /test/smoke/missing-addon.css"></script>\n# Smoke: a built page whose add-ons are missing\n');
      html = cli(['build', file]);
    } else {
      const file = path.join(tmp, `${name}.html`);
      cli(['new', file, '--luccet=/luccet.js', ...(name === 'guarded-fr' ? ['--lang=fr', '--title=Une note gardée'] : [])]);
      html = fs.readFileSync(file, 'utf8') + GUARDED_NOTE;
    }
    cliPages.set(name, html);
    return html;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- axe-core from a local copy

const npm = require('../tools/npm');
const AXE_VERSION = '4.14.0'; // axe-core, for the accessibility test

// A package's folder in node_modules/.cache/luccet-smoke/, filled once
// (tools/npm.js); null if it cannot be fetched (offline on the first run).
const dirs = new Map();
function cached(label, packageDir, version) {
  if (!dirs.has(`${label}@${version}`))
    dirs.set(
      `${label}@${version}`,
      packageDir(version).catch((e) => {
        console.log(`    (${label} ${version} not cached and not fetched: ${e.message})`);
        return null;
      }),
    );
  return dirs.get(`${label}@${version}`);
}
const axeDir = (v) => cached('axe-core', (version) => npm.packageDir('axe-core', version, { folder: `axe-core-${version}`, keep: ['axe.min.js'], has: 'axe.min.js' }), v);

// ---- measurement helpers

// Slow 3G: 400 kbit/s each way, 400 ms round trip.
const SLOW_3G = { latency: 400, bytesPerSecond: (400 * 1000) / 8 };
const STAGE_TOL = 25; // ms

// Serial stages: a page loads in three, HTML → luccet.js → add-ons (the
// add-ons are named by luccet.js, so they follow it; it preloads them) →
// mount. Math adds none. The document is stage 1.
// Every other request is one stage later than the latest-staged request that
// had already finished when it started, and at least stage 2, since
// everything is discovered from the document's bytes:
//
//   stage(r) = max(2, 1 + max{ stage(q) : q.end ≤ r.start + STAGE_TOL })
//
// start is CDP Network.requestWillBeSent, end is Network.loadingFinished (or
// loadingFailed). STAGE_TOL absorbs timestamp jitter between the renderer and
// the network service, in the strict direction: a request sent just before
// another finished still counts as waiting for it. Under Slow 3G a response
// takes at least one 400 ms round trip, so requests genuinely in flight
// together overlap by far more than 25 ms, while a request issued by a script
// starts after that script finished loading.
function assignStages(requests, doc) {
  const byStart = [...requests].sort((a, b) => a.start - b.start);
  for (const r of byStart) {
    if (r === doc) {
      r.stage = 1;
      continue;
    }
    r.stage = 2;
    for (const q of byStart) if (q !== r && q.stage && q.end != null && q.end <= r.start + STAGE_TOL / 1000) r.stage = Math.max(r.stage, q.stage + 1);
  }
  return byStart;
}

let mutoolChecked;
function hasMutool() {
  if (mutoolChecked === undefined) mutoolChecked = !spawnSync('mutool', ['-v'], { stdio: 'ignore' }).error;
  return mutoolChecked;
}

// The page printed by Chromium, as text extracted by mutool.
async function pdfText(page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luccet-smoke-'));
  try {
    const file = path.join(dir, 'page.pdf');
    await page.pdf({ path: file, format: 'A4' });
    const r = spawnSync('mutool', ['draw', '-q', '-F', 'txt', '-o', '-', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`mutool draw failed: ${(r.stderr || '').trim()}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every formula is the engine's MathML from the mount on, closed <details>
// included: a .t-math whose child is <math>, with its TeX in data-tex. One
// that does not translate is its TeX, with t-error (and a tex.* diagnostic).
const MATH_STATE = () => {
  const all = [...document.querySelectorAll('main.luccet .t-math')];
  const ok = (e) => e.hasAttribute('data-tex') && e.firstElementChild && e.firstElementChild.localName === 'math' && !e.classList.contains('t-error');
  const rendered = all.filter(ok);
  return { all: all.length, rendered: rendered.length, errors: all.filter((e) => e.classList.contains('t-error')).length, closed: all.filter((e) => e.closest('details:not([open])')).length, firstMissing: (all.find((e) => !ok(e)) || {}).outerHTML };
};

// Formulas under node, for the sample-notes test.
function mathCountUnderNode(file) {
  try {
    const luccet = require(LUCCET_JS);
    const src = fs.readFileSync(file, 'utf8').replace(/^[^\n]*\n/, '');
    return (luccet.toHTML(src).match(/class="t-math[ "]/g) || []).length;
  } catch {
    return null;
  }
}

class Skip extends Error {}

// ---- the documentation (docs/README.md)

// The documentation's pages: index.html, docs/*.html and examples/*.html
// that are notes, with what node knows of them (cli/examples.js): their
// live examples, and whether they load docs.js.
function docPages() {
  const note = require('../cli/note');
  const pages = [];
  const add = (rel) => {
    const file = path.join(ROOT, rel);
    const text = fs.readFileSync(file, 'utf8');
    const parts = note.split(text);
    if (!parts) return;
    const use = (note.attributes(parts.tag)['data-use'] || '').split(/\s+/);
    pages.push({ rel, file, text, docs: use.some((u) => /(?:^|\/)docs\.js(?:[?#]|$)/.test(u)) });
  };
  if (fs.existsSync(path.join(ROOT, 'index.html'))) add('index.html');
  for (const dir of ['docs', 'examples']) {
    const d = path.join(ROOT, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) if (/\.html$/.test(f)) add(`${dir}/${f}`);
  }
  return pages;
}

// What a page shows of docs.js: the site nav, the toc, the live examples
// and their results, and the math inside those results.
const DOCS_STATE = () => {
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
  const outs = [...document.querySelectorAll('.docs-live-out')];
  // An example's formulas are the engine's MathML, translated with its own macros.
  const math = outs.flatMap((o) => [...o.querySelectorAll('.t-math')]);
  const mathml = (m) => !!m.querySelector(':scope > math');
  const example = (e) => e.closest('.docs-live');
  const panel = document.querySelector('.t-diagnostics');
  const listed = (window.luccetDocs ? window.luccetDocs.pages.concat(window.luccetDocs.examples) : []).some(([p]) => location.pathname.endsWith(`/${p}`) || (p === 'index.html' && location.pathname.endsWith('/')));
  return {
    main: !!document.querySelector('main.luccet'),
    nav: document.querySelectorAll('main.luccet > nav.site-nav[aria-label] a[href]').length,
    current: document.querySelectorAll('nav.site-nav [aria-current="page"]').length,
    listed,
    toc: !!document.querySelector('main.luccet nav.toc:not(.docs-live-out *)'),
    widgets: document.querySelectorAll('.docs-live').length,
    results: outs.length,
    failed: [...document.querySelectorAll('.docs-live-failed .docs-live-problem')].map((p) => p.textContent),
    mismatched: [...document.querySelectorAll('.docs-live-mismatch .docs-live-problem')].map((p) => p.textContent),
    scripts: document.querySelectorAll('.docs-live-out script').length,
    math: math.length,
    // MathML, or a formula that does not translate: its TeX, with t-error
    // (an example may show one; its tex.* diagnostic is in the example)
    typeset: math.filter((m) => mathml(m) || m.classList.contains('t-error')).length,
    rejected: math.filter((m) => m.classList.contains('t-error')).length,
    untypeset: (math.find((m) => !mathml(m) && !m.classList.contains('t-error')) || {}).outerHTML,
    // a t-error formula whose example lists no tex.* diagnostic
    unexplained: (math.find((m) => m.classList.contains('t-error') && !example(m).querySelector('.docs-live-diagnostics .docs-diag[data-code^="tex."]')) || {}).outerHTML,
    duplicates: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
    diagnostics: (window.luccet.diagnostics || []).map((d) => `${d.code} at ${d.position && d.position.start ? `${d.position.start.line}:${d.position.start.column}` : 'the head'}: ${d.message}`),
    panel: !!panel && panel.getClientRects().length > 0,
  };
};

// Each example's :::macros are its own: a formula that uses a macro its
// example defines translates; one that uses a macro only another example
// defines does not; and none reaches the page's macros, probed through the
// runtime itself (luccet.render of formulas that use them, with the page's
// :::macros before them; run last, as the probe's failures are the page's
// diagnostics). A command the engine knows (luccet.tex) is not a macro.
const MACRO_STATE = async () => {
  const T = window.luccet;
  if (!T || typeof T.tex !== 'function') return { skipped: 'no luccet.tex' };
  const names = (tex) => [...tex.matchAll(/\\(?:(?:re|provide)?newcommand\*?\s*\{?\s*|[gex]?def\s*)(\\[A-Za-z]+)/g)].map((m) => m[1]);
  const builtin = (n) => {
    const r = T.tex(n);
    return !(r.error && r.error.code === 'tex.unknown');
  };
  const mathml = (f) => !!f.querySelector(':scope > math') && !f.classList.contains('t-error');
  const uses = (tex, n) => new RegExp(`${n.replace(/\\/g, '\\\\')}(?![A-Za-z])`).test(tex);
  const widgets = [...document.querySelectorAll('.docs-live')];
  const defs = widgets.map((w) => new Set([...w.querySelectorAll('.docs-live-out .t-macros')].flatMap((m) => names(m.textContent)).filter((n) => !builtin(n))));
  // an example that shows a tex.* diagnostic (a :::macros that does not
  // translate, a macro that never ends): its macros may fail on purpose
  const broken = widgets.map((w) => !!w.querySelector('.docs-live-diagnostics .docs-diag[data-code^="tex."]'));
  const problems = [];
  let used = 0;
  let foreign = 0;
  widgets.forEach((w, i) => {
    for (const f of w.querySelectorAll('.docs-live-out .t-math')) {
      const tex = f.getAttribute('data-tex') || '';
      for (const n of defs[i]) {
        if (!uses(tex, n)) continue;
        used++;
        if (!broken[i] && !mathml(f)) problems.push(`example ${i + 1}: ${n}, from its own :::macros, does not translate in ${tex}`);
      }
      widgets.forEach((_, j) => {
        if (j === i) return;
        for (const n of defs[j]) {
          if (defs[i].has(n) || !uses(tex, n)) continue;
          foreign++;
          if (mathml(f)) problems.push(`example ${i + 1} translates ${n}, which only example ${j + 1} defines`);
        }
      });
    }
  });
  const pageMacros = [...document.querySelectorAll('main.luccet .t-macros')].filter((m) => !m.closest('.docs-live'));
  const own = new Set(pageMacros.flatMap((m) => names(m.textContent)));
  const probe = [...new Set(defs.flatMap((d) => [...d]))].filter((n) => !own.has(n));
  if (probe.length) {
    const div = document.createElement('div');
    document.querySelector('main.luccet').append(div);
    const src = pageMacros.map((m) => `:::macros\n${m.textContent}\n:::\n\n`).join('') + probe.map((n) => `$${n}$`).join('\n\n') + '\n';
    await T.render(div, src);
    [...div.querySelectorAll('.t-math')].forEach((f, k) => mathml(f) && problems.push(`${probe[k]}, from an example's :::macros, reached the page's macros`));
    div.remove();
  }
  return { problems, defined: defs.reduce((a, d) => a + d.size, 0), used, foreign, probed: probe.length };
};

// The checks every documentation page must pass; `want` is the number of
// live examples node finds in it. Returns the state, for notes.
async function checkDocsPage(page, { docs, want }) {
  await expect(page, () => !!document.querySelector('main.luccet'), 'main.luccet');
  const done = `(${DOCS_STATE})().typeset === (${DOCS_STATE})().math`;
  try {
    await page.waitForFunction(done, null, { timeout: 8000 });
  } catch {}
  const s = await page.evaluate(DOCS_STATE);
  const problems = [];
  if (docs) {
    if (s.nav < 5) problems.push(`the site nav has ${s.nav} links`);
    if (s.listed && s.current !== 1) problems.push(`the site nav marks ${s.current} links as the current page, expected 1`);
    if (!s.toc) problems.push('no ::toc (nav.toc)');
  }
  if (s.widgets !== want || s.results !== want) problems.push(`${s.widgets} example widgets and ${s.results} rendered results for ${want} live fences`);
  if (s.failed.length) problems.push(`${s.failed.length} example(s) failed: ${s.failed[0]}`);
  if (s.mismatched.length) problems.push(`${s.mismatched.length} example(s) do not match their expect: ${s.mismatched[0]}`);
  if (s.scripts) problems.push(`${s.scripts} <script> element(s) left in example results`);
  if (s.typeset !== s.math) problems.push(`${s.math - s.typeset} of ${s.math} formulas in example results neither MathML nor marked t-error; first: ${String(s.untypeset).slice(0, 160)}`);
  if (s.unexplained) problems.push(`a formula in an example's result does not translate, and the example lists no tex.* diagnostic: ${String(s.unexplained).slice(0, 160)}`);
  if (s.duplicates.length) problems.push(`duplicate ids: ${s.duplicates.slice(0, 5).join(', ')}`);
  if (s.diagnostics.length) problems.push(`luccet.diagnostics has ${s.diagnostics.length}, expected none: ${s.diagnostics[0]}`);
  if (s.panel) problems.push('the diagnostics panel shows');
  const m = await page.evaluate(MACRO_STATE);
  if (m.problems) problems.push(...m.problems.slice(0, 3));
  s.macros = m;
  if (problems.length) throw new Error(problems.join(' | '));
  return s;
}

const DOC_TESTS = (() => {
  const examples = require('../cli/examples');
  const pages = docPages();
  const tests = pages.map((p) => ({
    name: `docs: ${p.rel} renders with zero console errors${p.docs ? ', a site nav and a toc' : ''}; every live example has a result; formulas in results are MathML`,
    url: `/${p.rel}`,
    offline: true,
    async check(page, ctx) {
      const x = examples.extract(p.text, p.file);
      const want = x ? x.examples.length : 0;
      const s = await checkDocsPage(page, { docs: p.docs, want });
      ctx.note(`${want} live example(s), ${s.math} formula(s) in their results${s.rejected ? ` (${s.rejected} that do not translate, with their tex.* diagnostics in the example)` : ''}${p.docs ? `, ${s.nav} site links` : ''}`);
      if (s.macros.defined) ctx.note(`${s.macros.defined} macro(s) defined in examples: ${s.macros.used} use(s) translated, ${s.macros.foreign} use(s) from other examples refused, ${s.macros.probed} kept from the page`);
      const stood = [...(docStandIns.get(`/${p.rel}`) || [])].map((u) => path.posix.relative(path.posix.dirname(`/${p.rel}`), u));
      if (stood.length) ctx.note(`stand-ins for ${stood.length} missing file(s) its examples name: ${stood.sort().join(', ')}`);
    },
  }));
  if (!pages.length) tests.push({ name: 'docs: the documentation pages render', todo: 'no pages yet in index.html, docs/ or examples/' });
  tests.push({
    name: 'docs: docs.js live examples: ids prefixed, scripts shown not run, styles scoped, math and macros isolated, diagnostics linked, Luccet highlighted; each parsed once, its HTML pane made on opening or once the page is idle; the mark painted',
    url: '/test/smoke/docs-live.html',
    // Counts the engine's runs by source: parse, toHTML and check each parse
    // the note they are given (the runtime's own calls are counted too, under
    // the page's source).
    init: () => {
      const runs = (window.__engineRuns = {});
      let luccet;
      Object.defineProperty(window, 'luccet', {
        configurable: true,
        get: () => luccet,
        set(v) {
          luccet = v;
          for (const k of ['parse', 'toHTML', 'check']) {
            const f = v[k];
            v[k] = (source, ...rest) => ((runs[source] = (runs[source] || 0) + 1), f(source, ...rest));
          }
        },
      });
    },
    async check(page) {
      await checkDocsPage(page, { docs: true, want: 8 });
      const parsed = await page.evaluate(() => {
        const want = {};
        for (const c of document.querySelectorAll('.docs-live-source code.language-luccet')) want[c.textContent + '\n'] = (want[c.textContent + '\n'] || 0) + 1;
        return Object.entries(want).map(([source, n]) => [n, window.__engineRuns[source] || 0, source.slice(0, 40)]);
      });
      const wrong = parsed.filter(([n, ran]) => ran !== n);
      if (parsed.length < 7 || wrong.length) throw new Error(`each example's source parsed once: ${JSON.stringify(wrong.length ? wrong : parsed)}`);
      // Every HTML pane is made once the page is idle, so find-in-page finds
      // its text in a closed panel; one that opens first is made then.
      await expect(page, () => [...document.querySelectorAll('.docs-live-markup')].every((d) => d.querySelector('.docs-live-html')), 'every HTML pane, once the page is idle');
      await page.evaluate(() => document.querySelector('.docs-live-out button').click());
      const r = await page.evaluate(() => {
        const out = [...document.querySelectorAll('.docs-live-out')];
        const styled = out[3].querySelector('p');
        const pagePara = [...document.querySelectorAll('main.luccet > p')].find((p) => /page paragraph/.test(p.textContent));
        return {
          ran: window.__ran,
          shown: (out[3].querySelector('.docs-live-script') || {}).textContent || '',
          onclick: out[3].querySelector('button').hasAttribute('onclick'),
          scope: 'CSSScopeRule' in window,
          styled: getComputedStyle(styled).color,
          page: getComputedStyle(pagePara).color,
          ids: [...out[0].querySelectorAll('[id]')].map((e) => e.id).sort(),
          hrefs: [...out[0].querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).sort(),
          bare: !!document.getElementById('k') || !!document.getElementById('fn-a'),
          math: out[0].querySelectorAll('.t-math[data-tex] > math').length + out[2].querySelectorAll('.t-math[data-tex] > math').length,
          ref: (out[2].querySelector('a.t-ref') || {}).textContent,
          refHref: (out[2].querySelector('a.t-ref') || {}).getAttribute?.('href'),
          diag: [...document.querySelectorAll('.docs-live')[1].querySelectorAll('.docs-diags a')].map((a) => a.getAttribute('href')),
          titled: !!document.querySelectorAll('.docs-live')[4].querySelector('.docs-live-source figure figcaption'),
          nav: (document.querySelector('nav.site-nav .docs-nav-list a') || {}).getAttribute?.('href'),
          luccet: document.querySelectorAll('code.docs-luccet .tk-mark, code.docs-luccet .tk-name, code.docs-luccet .tk-attr, code.docs-luccet .tk-math').length,
          html: (document.querySelector('.docs-live-html') || {}).textContent || '',
          // the math examples: 6 defines \RR and uses it, 7 uses it without, 8 has a bad :::macros and a bad formula
          own: [...out[5].querySelectorAll('.t-math')].map((f) => `${f.className}${f.querySelector(':scope > math') ? ' mathml' : ''} ${f.getAttribute('data-tex').trim()}`),
          display: !!out[5].querySelector('.t-math[data-display] > math[display="block"]'),
          macrosHidden: getComputedStyle(out[5].querySelector('.t-macros')).display,
          other: [...out[6].querySelectorAll('.t-math')].map((f) => `${f.className}${f.querySelector(':scope > math') ? ' mathml' : ''} ${f.textContent}`),
          codes: [5, 6, 7].map((i) => [...document.querySelectorAll('.docs-live')[i].querySelectorAll('.docs-diag')].map((d) => `${d.dataset.code} ${d.querySelector('.docs-pos').textContent}`)),
          errorLink: (document.querySelectorAll('.docs-live')[7].querySelector('.docs-diag[data-code="tex.unknown"] a') || {}).getAttribute?.('href'),
          label: (document.querySelectorAll('.docs-live')[7].querySelector('.docs-live-diagnostics .docs-live-label') || {}).textContent,
          logo: (document.querySelector('nav.site-nav .docs-nav-logo') || {}).getAttribute?.('src'),
        };
      });
      const problems = [];
      if (r.ran !== undefined) problems.push(`a script in an example ran (window.__ran = ${r.ran})`);
      if (!r.shown.includes('window.__ran')) problems.push(`the example's script is not shown: ${JSON.stringify(r.shown)}`);
      if (r.onclick) problems.push('an on* handler survived');
      if (r.page === 'rgb(200, 0, 0)') problems.push("the example's <style> reached the page");
      if (r.scope && r.styled !== 'rgb(200, 0, 0)') problems.push(`the example's <style> does not style its own result (${r.styled})`);
      const ids = ['ex1-eq', 'ex1-fn-a', 'ex1-fnref-a', 'ex1-k'];
      if (JSON.stringify(r.ids) !== JSON.stringify(ids)) problems.push(`result ids ${JSON.stringify(r.ids)}, expected ${JSON.stringify(ids)}`);
      if (JSON.stringify(r.hrefs) !== JSON.stringify(['#ex1-fn-a', '#ex1-fnref-a', '#ex1-k'])) problems.push(`result fragment links ${JSON.stringify(r.hrefs)}`);
      if (r.bare) problems.push('an unprefixed example id is in the page');
      if (r.math !== 3) problems.push(`${r.math} MathML formulas in results 1 and 3, expected 3`);
      if (r.ref !== 'Theorem 1' || r.refHref !== '#ex3-rn') problems.push(`the demo-schema reference reads ${JSON.stringify(r.ref)} → ${r.refHref}`);
      if (JSON.stringify(r.diag) !== JSON.stringify(['../../docs/diagnostics.html#block-unclosed', '../../docs/diagnostics.html#attr-malformed'])) problems.push(`diagnostic links ${JSON.stringify(r.diag)}`);
      if (!r.titled) problems.push('the titled example lost its figure and caption');
      if (r.nav !== '../../docs/guide.html') problems.push(`the site nav's first link is ${r.nav}, expected ../../docs/guide.html`);
      if (r.luccet < 10) problems.push(`only ${r.luccet} highlighted Luccet tokens`);
      if (!/^<p>A <em>short<\/em> example/.test(r.html) || !/\n<section class="t-footnotes" role="doc-endnotes" aria-label="Footnotes">\n {2}<ol>\n {4}<li id="fn-a">/.test(r.html)) problems.push(`the HTML pane: ${JSON.stringify(r.html.slice(0, 300))}`);
      const own = ['t-math mathml f\\colon \\RR \\to \\RR', 't-math mathml \\RR^2'];
      if (JSON.stringify(r.own) !== JSON.stringify(own) || !r.display) problems.push(`the example's own macro: ${JSON.stringify(r.own)}, display MathML ${r.display}; expected ${JSON.stringify(own)} (MathML in a .t-math with data-tex, for copy), the display one math[display=block]`);
      if (r.macrosHidden !== 'none') problems.push(`:::macros in a result: display ${r.macrosHidden}, expected hidden`);
      if (JSON.stringify(r.other) !== JSON.stringify(['t-math t-error \\RR'])) problems.push(`another example's macro: ${JSON.stringify(r.other)}, expected one formula that does not translate, shown as its TeX`);
      const codes = [[], ['tex.unknown 1:29'], ['tex.unbalanced 2:12', 'tex.unknown 5:37']];
      if (JSON.stringify(r.codes) !== JSON.stringify(codes)) problems.push(`the examples' diagnostics ${JSON.stringify(r.codes)}, expected ${JSON.stringify(codes)}`);
      if (r.errorLink !== '../../docs/diagnostics.html#tex-unknown' || r.label !== 'Diagnostics (2)') problems.push(`tex.unknown in the example: ${r.errorLink}, ${r.label}`);
      if (r.logo !== '../../docs/luccet.png') problems.push(`the site nav's mark is ${r.logo}, expected ../../docs/luccet.png`);
      if (problems.length) throw new Error(problems.join(' | '));
    },
  });
  return tests;
})();

// ---- tests

// Each test opens `url` and runs `check(page, ctx)`; ctx.diagnostics holds
// luccet.diagnostics after ready, ctx.console every console message, ctx.browser
// the browser's name, and ctx.note(line) adds a line to the report.
// `browsers` limits where it runs; `todo` lists what is still to build for it
// (reported, not run). Optional: `timeout` (whole test), `readyTimeout`,
// `waitUntil` for page.goto, `init` (an init script), `setup(context, page,
// ctx)` before navigation, `offline` (stub every request to another
// origin), `allowConsole` (a RegExp for the console errors the test
// provokes), `expectConsoleErrors` (allow any), `context` (browser context
// options), `noTern` (the page runs without luccet.js: no wait for luccet.ready).
const TESTS = [
  {
    name: "basic note mounts in place, its formulas are the engine's MathML, refs resolve",
    url: '/test/smoke/basic.html',
    async check(page) {
      await expect(page, () => document.compatMode === 'CSS1Compat', 'standards mode');
      await expect(page, () => !!document.querySelector('main.luccet h1#top'), 'main.luccet with the heading');
      await expect(page, () => document.querySelector('main.luccet p .t-math[data-tex="x^2 + 1"]:not([data-display]) > math:not([display])'), 'the inline formula as MathML, its TeX in data-tex');
      await expect(page, () => document.querySelector('main.luccet #eq-int .t-math[data-display][data-tex] > math[display="block"]'), 'the display formula as math[display=block]');
      await expect(page, () => document.querySelectorAll('main.luccet .t-math[data-tex] > math').length === 2 && !document.querySelector('main.luccet .t-error'), 'both formulas MathML, none t-error');
      await expect(page, () => document.querySelector('a.t-ref[href="#eq-int"]')?.textContent === '(1)', 'ref text "(1)"');
      await expect(page, () => document.characterSet === 'UTF-8', 'UTF-8');
    },
  },
  {
    // luccet.render(el, untrusted, {safe:true}): the note's scripts do not run,
    // raw HTML is escaped, dangerous elements are neutralised, risky
    // attributes and URLs are dropped — but math still translates.
    name: 'luccet.render with safe: untrusted source runs nothing and is scrubbed',
    url: '/test/smoke/basic.html',
    async check(page) {
      await page.evaluate(async () => {
        window.__ran = false;
        const src = [
          'A comment.',
          '',
          '<script>window.__ran = true;</scr' + 'ipt>',
          '',
          '::iframe{src=/secret srcdoc="<b>x</b>"}',
          '',
          '[go](javascript:alert(1)) and [click]{onclick="window.__ran = true"} and $x^2$.',
        ].join('\n');
        const box = document.createElement('div');
        box.className = 'luccet';
        box.id = 'untrusted';
        document.body.append(box);
        await luccet.render(box, src, { safe: true });
      });
      // Give any (wrongly) created script a chance to run.
      await expect(page, () => document.querySelector('#untrusted .t-math[data-tex="x^2"] > math'), 'math still MathML under safe');
      await expect(page, () => window.__ran === false, 'no script ran: raw <script> escaped, onclick dropped');
      await expect(page, () => !document.querySelector('#untrusted iframe') && !document.querySelector('#untrusted script'), 'no iframe and no script element');
      await expect(page, () => !!document.querySelector('#untrusted [data-t="iframe"]')?.matches('div'), 'the ::iframe became a div');
      await expect(page, () => !document.querySelector('#untrusted a[href^="javascript"]'), 'the javascript: link has no href');
    },
  },
  {
    name: 'note scripts run in order: inline, ≥ 250 KB external, slow CDN, inline; sentinel and load',
    url: '/test/smoke/scripts-order.html',
    async check(page) {
      await expect(page, () => JSON.stringify(window.order) === JSON.stringify(['inline1', 'external', 'cdn', 'inline2']), "order inline1, external, cdn, inline2");
      await expect(page, () => !!document.querySelector('#sentinel'), 'the sentinel after the scripts');
      await expect(page, () => document.readyState === 'complete', 'load fired');
    },
  },
  {
    name: 'UTF-8 without a charset header',
    url: '/nocharset/test/smoke/charset.html',
    async check(page) {
      await expect(page, () => document.querySelector('h1')?.textContent.includes('Überblick: naïve café, 日本語, ∀x ∃y'), 'decoded heading');
    },
  },
  {
    name: 'unclosed $$ keeps the heading after it, with math.unclosed',
    url: '/test/smoke/unclosed-math.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('.t-eq.t-error'), 'the visible error block');
      await expect(page, () => document.querySelector('h2')?.textContent === 'The heading survives', 'the heading');
      if (!ctx.diagnostics.some((d) => d.code === 'math.unclosed')) throw new Error('no math.unclosed diagnostic');
    },
  },
  {
    name: 'a formula that does not translate keeps its TeX, marked t-error, with its tex.* diagnostic in luccet.diagnostics and the panel',
    url: '/test/smoke/tex-error.html',
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        math: [...document.querySelectorAll('main.luccet .t-math')].map((e) => ({ tex: e.dataset.tex, text: e.textContent, error: e.classList.contains('t-error'), mathml: !!e.querySelector('math'), display: e.hasAttribute('data-display'), eq: !!e.closest('div.t-eq') })),
        panel: (document.querySelector('.t-diagnostics') || {}).textContent || '',
      }));
      const want = [
        { tex: '\\frac{1}{', text: '\\frac{1}{', error: true, mathml: false, display: false, eq: false },
        { tex: 'x', text: 'x', error: false, mathml: true, display: false, eq: false },
        { tex: '\\frac{a}{', text: '\\frac{a}{', error: true, mathml: false, display: true, eq: true },
        { tex: '\\notacommand + 1', text: '\\notacommand + 1', error: true, mathml: false, display: false, eq: false },
      ];
      if (JSON.stringify(r.math) !== JSON.stringify(want)) throw new Error(`formulas ${JSON.stringify(r.math)}, expected ${JSON.stringify(want)}`);
      // At the command at fault (note lines: line 1 follows the luccet.js line).
      const codes = ctx.diagnostics.map((d) => `${d.severity} ${d.code} ${d.position.start.line}:${d.position.start.column}`);
      const wantCodes = ['error tex.unbalanced 4:16', 'error tex.unbalanced 7:9', 'error tex.unknown 10:11'];
      if (JSON.stringify(codes) !== JSON.stringify(wantCodes)) throw new Error(`luccet.diagnostics ${JSON.stringify(codes)}, expected ${JSON.stringify(wantCodes)}`);
      for (const w of ['tex.unbalanced', 'tex.unknown', '\\notacommand']) if (!r.panel.includes(w)) throw new Error(`the panel lacks ${w}: ${JSON.stringify(r.panel.slice(0, 300))}`);
    },
  },
  {
    // Each construct as the browser lays out the engine's MathML, in the
    // math font luccet.css names (--t-math): boxes that are not empty, and
    // the geometry the construct is for. Brackets stretch only in a font with
    // OpenType's math table (docs/math.html#browsers): without one installed
    // the stretch is not checked, and the report says so.
    name: "math: the engine's MathML lays out",
    url: '/test/smoke/math.html',
    async check(page, ctx) {
      await page.evaluate(() => document.fonts.ready);
      const r = await page.evaluate(() => {
        const rect = (e) => {
          const b = e.getBoundingClientRect();
          return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height };
        };
        // An element's content: the union of its children's boxes, empty ones left out.
        const content = (e) => {
          const boxes = [...e.children].map(rect).filter((b) => b.w > 0 || b.h > 0);
          if (!boxes.length) return rect(e);
          const u = { l: Math.min(...boxes.map((b) => b.l)), r: Math.max(...boxes.map((b) => b.r)), t: Math.min(...boxes.map((b) => b.t)), b: Math.max(...boxes.map((b) => b.b)) };
          return { ...u, w: u.r - u.l, h: u.b - u.t };
        };
        // The first family of the math font stack that is installed: a
        // string set in it measures unlike the same string in the fallback.
        const font = (() => {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;font-size:72px;white-space:nowrap';
          probe.textContent = '∑∫(xyzWQ)⎛⎞';
          document.body.append(probe);
          const width = (family) => ((probe.style.fontFamily = family), probe.getBoundingClientRect().width);
          const families = getComputedStyle(document.querySelector('main.luccet math')).fontFamily.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter((f) => f && f !== 'math');
          const found = families.find((f) => ['monospace', 'serif'].some((g) => width(`"${f}", ${g}`) !== width(g)));
          probe.remove();
          return found || null;
        })();
        const inline = [...document.querySelectorAll('main.luccet p .t-math > math')];
        const eq = (id) => document.querySelector(`#${id} .t-math[data-display] > math[display="block"]`);
        const frac = inline[0].querySelector('mfrac');
        const sqrt = inline[1].querySelector('msqrt');
        const scripts = inline[2].querySelector('msubsup');
        const sum = eq('eq-sum').querySelector('munderover');
        const mos = [...eq('eq-fence').querySelectorAll('mo')].filter((m) => m.textContent === '(');
        const plain = mos.find((m) => m.getAttribute('stretchy') === 'false');
        const stretched = mos.find((m) => m.getAttribute('stretchy') === 'true');
        return {
          font,
          formulas: [...document.querySelectorAll('main.luccet .t-math')].map((e) => (e.firstElementChild && e.firstElementChild.localName === 'math' ? rect(e.firstElementChild) : null)),
          frac: { num: rect(frac.children[0]), den: rect(frac.children[1]) },
          sqrt: { all: rect(sqrt), base: content(sqrt) },
          scripts: { base: rect(scripts.children[0]), sub: rect(scripts.children[1]), sup: rect(scripts.children[2]) },
          sum: { op: rect(sum.children[0]), under: rect(sum.children[1]), over: rect(sum.children[2]) },
          paren: { plain: rect(plain), stretched: rect(stretched), inner: rect(stretched.nextElementSibling) },
          matrix: [...eq('eq-matrix').querySelectorAll('mtable > mtr > mtd')].map(rect),
          aligned: [...eq('eq-aligned').querySelectorAll('mtable.t-align > mtr')].map((tr) => [...tr.children].map(content)),
        };
      });
      const px = (x) => Math.round(x * 10) / 10;
      const problems = [];
      const empty = (b) => !b || !(b.w > 0 && b.h > 0);
      if (r.formulas.length !== 7 || r.formulas.some(empty)) problems.push(`formula boxes ${JSON.stringify(r.formulas.map((b) => b && `${px(b.w)}×${px(b.h)}`))}, expected 7 MathML formulas, none empty`);
      const { num, den } = r.frac;
      if (empty(num) || empty(den) || !(num.b <= den.t + 1)) problems.push(`the fraction: numerator ${JSON.stringify(num)}, denominator ${JSON.stringify(den)}, expected the numerator above`);
      const { all, base } = r.sqrt;
      if (empty(base) || !(all.w > base.w + 2) || !(all.h >= base.h)) problems.push(`the root: ${px(all.w)}×${px(all.h)} around ${px(base.w)}×${px(base.h)}, expected the radical sign to add to it`);
      const s = r.scripts;
      if (empty(s.sub) || empty(s.sup) || !(s.sup.t < s.sub.t - 1) || !(s.sub.l >= s.base.r - 1 && s.sup.l >= s.base.r - 1)) problems.push(`the scripts: base ${JSON.stringify(s.base)}, sub ${JSON.stringify(s.sub)}, sup ${JSON.stringify(s.sup)}, expected both right of the base, the superscript higher`);
      const { op, under, over } = r.sum;
      const centre = (b) => (b.l + b.r) / 2;
      if (empty(op) || empty(under) || empty(over) || !(under.t >= op.b - 1) || !(over.b <= op.t + 1) || !(centre(under) > op.l && centre(under) < op.r && centre(over) > op.l && centre(over) < op.r)) problems.push(`the big operator's limits: operator ${JSON.stringify(op)}, under ${JSON.stringify(under)}, over ${JSON.stringify(over)}, expected them below and above it`);
      const { plain, stretched, inner } = r.paren;
      if (empty(plain) || empty(stretched)) problems.push(`the parentheses: plain ${JSON.stringify(plain)}, stretched ${JSON.stringify(stretched)}`);
      else if (r.font) {
        if (!(stretched.h > plain.h * 1.5)) problems.push(`the \\left( is ${px(stretched.h)} px high around a fraction ${px(inner.h)} px high, a plain ( ${px(plain.h)} px: it did not stretch (in ${r.font})`);
      } else ctx.note(`no font of the math stack (--t-math) is installed: the stretch is not checked (\\left( ${px(stretched.h)} px, plain ${px(plain.h)} px)`);
      const m = r.matrix;
      const near = (a, b) => Math.abs(a - b) <= 1;
      if (m.length !== 4 || m.some(empty) || !near(m[0].t, m[1].t) || !near(m[2].t, m[3].t) || !(m[2].t >= m[0].b - 1) || !(m[1].l >= m[0].r - 1) || !(m[3].l >= m[2].r - 1)) problems.push(`the matrix cells ${JSON.stringify(m.map((b) => [px(b.l), px(b.t), px(b.w), px(b.h)]))}, expected two rows of two`);
      const a = r.aligned;
      if (a.length !== 2 || a.some((row) => row.length !== 2 || row.some(empty))) problems.push(`aligned: ${JSON.stringify(a)}, expected two rows of two cells`);
      else {
        if (!near(a[0][0].r, a[1][0].r)) problems.push(`aligned: the first column's right edges ${px(a[0][0].r)} and ${px(a[1][0].r)}, expected equal within a pixel (right-aligned)`);
        if (!(a[1][0].l > a[0][0].l + 5)) problems.push(`aligned: the first column's left edges ${px(a[0][0].l)} and ${px(a[1][0].l)}: "x + y + z" and "w" start together, so the column is not right-aligned`);
        if (!near(a[0][1].l, a[1][1].l)) problems.push(`aligned: the equals signs start at ${px(a[0][1].l)} and ${px(a[1][1].l)}, expected equal within a pixel`);
      }
      if (ctx.diagnostics.length) problems.push(`diagnostics ${JSON.stringify(ctx.diagnostics.map((d) => d.code))}`);
      ctx.note(`math font: ${r.font || 'none of --t-math'}; \\left( ${px(stretched.h)} px high, a plain ( ${px(plain.h)} px`);
      if (problems.length) throw new Error(problems.join(' | '));
    },
  },
  {
    name: 'RTL note: math and code stay left-to-right',
    url: '/test/smoke/rtl.html',
    async check(page) {
      await expect(page, () => document.documentElement.dir === 'rtl', 'dir kept from the head');
      await expect(page, () => getComputedStyle(document.querySelector('.t-math')).direction === 'ltr', 'math is LTR');
      await expect(page, () => getComputedStyle(document.querySelector('code')).direction === 'ltr', 'code is LTR');
    },
  },
  {
    name: 'strict CSP with an external luccet.css: renders, no violations',
    url: '/csp/test/smoke/csp.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'mounted');
      if (ctx.cspViolations.length) throw new Error(`CSP violations: ${ctx.cspViolations.join('; ')}`);
    },
  },
  {
    name: 'no doctype: mounts with doc.quirks, its formula MathML all the same',
    url: '/test/smoke/no-doctype.html',
    expectConsoleErrors: true,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'mounted');
      await expect(page, () => !!document.querySelector('main.luccet .t-math[data-tex="x"] > math'), 'the formula as MathML');
      if (!ctx.diagnostics.some((d) => d.code === 'doc.quirks')) throw new Error('no doc.quirks diagnostic');
    },
  },
  // ---- runtime behaviour (docs/api.html#lifecycle)
  {
    // The formulas are MathML from the mount on: the behaviours, 'render'
    // and 'math' all see the three of them, and the events keep their order.
    name: "lifecycle: behaviours once per element, then 'render', 'math', 'ready'; formulas are MathML when 'render' fires; luccet.render() again changes nothing",
    url: '/test/smoke/lifecycle.html',
    async check(page, ctx) {
      await expect(page, () => window.__log && window.__log.includes('ready-promise'), 'the lifecycle log to reach luccet.ready');
      const want = ['define p1 math=3', 'define p2 math=3', 'render math=3', 'math main math=3', 'ready', 'ready-promise'];
      const log = await page.evaluate(() => window.__log.slice());
      if (JSON.stringify(log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(log)}, expected ${JSON.stringify(want)}`);
      const html = await page.evaluate(() => document.querySelector('main.luccet').innerHTML);
      await page.evaluate(async () => {
        await luccet.render();
        await luccet.render();
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
      const after = await page.evaluate(() => ({
        html: document.querySelector('main.luccet').innerHTML,
        log: window.__log.slice(),
        math: [...document.querySelectorAll('main.luccet .t-math')].map((e) => e.querySelectorAll('math').length),
      }));
      const ran = after.log.filter((l) => l.startsWith('define'));
      if (ran.length !== 2) throw new Error(`behaviours ran ${ran.length} times after luccet.render() twice, expected 2: ${JSON.stringify(ran)}`);
      if (after.math.join() !== '1,1,1') throw new Error(`<math> per formula after luccet.render() twice: ${after.math.join(', ')}`);
      if (after.html !== html) throw new Error('luccet.render() with no source changed main.luccet');
      ctx.note(`events from the two extra luccet.render() calls: ${after.log.slice(want.length).join(', ') || 'none'}`);
    },
  },
  {
    name: 'note scripts: document.write gives script.document-write; a DOMContentLoaded listener gives script.domcontentloaded and never runs',
    url: '/test/smoke/interception.html',
    async check(page, ctx) {
      await expect(page, () => !!document.getElementById('after'), 'the paragraph after the script');
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        written: !!document.getElementById('written'),
        dcl: window.__dcl,
        restored: document.write === Document.prototype.write && document.addEventListener === EventTarget.prototype.addEventListener && window.addEventListener === EventTarget.prototype.addEventListener,
      }));
      const of = (code) => ctx.diagnostics.filter((d) => d.code === code);
      const write = of('script.document-write');
      const dcl = of('script.domcontentloaded');
      if (write.length !== 1) throw new Error(`${write.length} script.document-write diagnostics, expected 1`);
      if (dcl.length !== 2) throw new Error(`${dcl.length} script.domcontentloaded diagnostics, expected 2 (document and window)`);
      // The <script> tag is on note line 4 (line 1 follows the luccet.js line).
      const lines = [...write, ...dcl].map((d) => d.position && d.position.start && d.position.start.line);
      if (lines.some((l) => l !== 4)) throw new Error(`diagnostics at note lines ${lines.join(', ')}, expected the script's line 4`);
      if (r.written) throw new Error("document.write's output reached the page");
      if (r.dcl.document || r.dcl.window) throw new Error(`DOMContentLoaded listeners ran: on document ${r.dcl.document} time(s), on window ${r.dcl.window} time(s); expected never`);
      if (!r.restored) throw new Error('document.write or addEventListener is still intercepted after the note scripts');
    },
  },
  {
    name: 'a missing add-on gives addon.failed, and the note still mounts',
    url: '/test/smoke/addon-missing.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type/,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'mounted');
      await expect(page, () => !!document.querySelector('main.luccet .t-math > math'), 'math as MathML');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed');
      for (const file of ['missing-addon.js', 'missing-addon.css']) {
        if (!failed.some((d) => d.message.includes(file))) throw new Error(`no addon.failed naming ${file}; got ${JSON.stringify(failed.map((d) => d.message))}`);
      }
    },
  },
  {
    // The engine writes the MathML and the browser lays it out in a font it
    // has: math loads no script, stylesheet or font. Every request is
    // recorded, and any to another origin is refused, as offline.
    name: "math makes no network request: nothing beyond the page, luccet.js and the page's add-on, offline, and every formula MathML",
    url: '/test/smoke/math-requests.html',
    async setup(context, page, ctx) {
      ctx.requests = [];
      page.on('request', (r) => ctx.requests.push(r.url()));
      await context.route((url) => url.origin !== ctx.origin, (route) => route.abort());
    },
    async check(page, ctx) {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const m = await page.evaluate(MATH_STATE);
      if (m.all !== 6 || m.rendered !== 6) throw new Error(`${m.rendered} of ${m.all} formulas MathML, expected 6 of 6; first other: ${String(m.firstMissing).slice(0, 160)}`);
      const urls = [...new Set(ctx.requests.map((u) => (u.startsWith(ctx.origin) ? u.slice(ctx.origin.length) : u)))].filter((u) => u !== '/favicon.ico').sort();
      const want = ['/luccet.js', '/test/smoke/fence-addon.js', '/test/smoke/math-requests.html'];
      if (JSON.stringify(urls) !== JSON.stringify(want)) throw new Error(`requests ${JSON.stringify(urls)}, expected the page, luccet.js and its add-on alone`);
      if (ctx.diagnostics.length) throw new Error(`diagnostics ${JSON.stringify(ctx.diagnostics.map((d) => d.code))}`);
    },
  },
  {
    name: ':::meta writes <title>, html[lang] and <meta name>',
    url: '/test/smoke/meta.html',
    async check(page) {
      const r = await page.evaluate(() => ({ title: document.title, titles: document.querySelectorAll('title').length, lang: document.documentElement.lang, description: (document.querySelector('meta[name="description"]') || {}).content }));
      const want = { title: 'Meta from the note', titles: 1, lang: 'de', description: 'Written by the note' };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`head ${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
    },
  },
  {
    name: ':::meta against a head that sets title and lang: the head wins, with meta.conflict',
    url: '/test/smoke/meta-head.html',
    async check(page, ctx) {
      const r = await page.evaluate(() => ({ title: document.title, titles: document.querySelectorAll('title').length, lang: document.documentElement.lang }));
      const want = { title: 'Title from the head', titles: 1, lang: 'fr' };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`head ${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
      const n = ctx.diagnostics.filter((d) => d.code === 'meta.conflict').length;
      if (n !== 2) throw new Error(`${n} meta.conflict diagnostics, expected 2 (title, lang)`);
    },
  },
  {
    name: 'a fragment target in a closed <details>: loading #id opens it and scrolls to it',
    url: '/gen/fragment.html#deep',
    async check(page) {
      const r = await page.evaluate(() => {
        const rect = document.getElementById('deep').getBoundingClientRect();
        const f = document.querySelector('#box .t-math > math');
        const box = f && f.getBoundingClientRect();
        return { box: document.getElementById('box').open, fold: document.getElementById('fold').open, top: rect.top, bottom: rect.bottom, vh: innerHeight, y: scrollY, math: !!box && box.width > 0 && box.height > 0 };
      });
      if (!r.box) throw new Error('the <details> holding #deep is still closed');
      if (r.y <= 0) throw new Error('the page did not scroll');
      if (r.top < -20 || r.bottom > r.vh + 20) throw new Error(`#deep is out of view: top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, viewport ${r.vh}`);
      if (r.fold) throw new Error('the other <details> opened too');
      if (!r.math) throw new Error('the formula beside the target is not MathML laid out');
    },
  },
  {
    name: 'formulas in a closed <details> are MathML already, and lay out when it opens',
    url: '/gen/fragment.html',
    async check(page) {
      const before = await page.evaluate(() => ({ n: document.querySelectorAll('#fold .t-math').length, mathml: document.querySelectorAll('#fold .t-math[data-tex] > math, #box .t-math[data-tex] > math').length, open: document.getElementById('fold').open || document.getElementById('box').open }));
      if (before.n !== 2 || before.mathml !== 3 || before.open) throw new Error(`before the toggle: ${JSON.stringify(before)}, expected 2 formulas in #fold, all 3 in the closed <details> MathML, both closed`);
      await page.evaluate(() => (document.getElementById('fold').open = true));
      await expect(page, () => [...document.querySelectorAll('#fold .t-math > math')].every((m) => m.getBoundingClientRect().width > 0 && m.getBoundingClientRect().height > 0), 'both formulas in the opened <details> laid out');
    },
  },
  {
    name: 'a second luccet.js tag does not mount twice',
    url: '/test/smoke/reentry.html',
    async check(page, ctx) {
      await expect(page, () => document.querySelectorAll('main.luccet .t-math > math').length === 1, 'the formula as MathML, once');
      const r = await page.evaluate(() => ({ mains: document.querySelectorAll('main.luccet').length, h1: document.querySelectorAll('h1').length, once: document.querySelectorAll('#once').length, same: !!window.__first && window.luccet === window.__first }));
      if (r.mains !== 1 || r.h1 !== 1 || r.once !== 1) throw new Error(`${r.mains} main.luccet, ${r.h1} h1, ${r.once} #once; expected one of each`);
      if (!r.same) throw new Error('window.luccet is no longer the first copy');
      if (!ctx.console.some((m) => /already loaded/.test(m.text))) throw new Error('no console warning from the second copy (did it run?)');
    },
  },
  {
    // A counter's value cannot be read from the DOM, so: the first number is
    // the code element's computed counter-reset plus the first line's
    // ::before counter-increment, shown by content: counter(t-line). In
    // Chromium the rendered text is also read from a DOMSnapshot.
    name: 'code lines: data-start=10 numbers from 10, no start from 1',
    url: '/test/smoke/code-lines.html',
    async check(page, ctx) {
      const blocks = await page.evaluate(() =>
        [...document.querySelectorAll('main.luccet pre[data-lines] > code')].map((code) => {
          const line = code.querySelector('.t-line');
          const before = getComputedStyle(line, '::before');
          return { text: line.textContent, reset: getComputedStyle(code).counterReset, increment: before.counterIncrement, content: before.content };
        }),
      );
      const num = (s, re, dflt) => {
        const m = re.exec(s || '');
        return m ? (m[1] == null ? dflt : Number(m[1])) : null;
      };
      const first = blocks.map((b) => (b.content === 'counter(t-line)' ? num(b.reset, /\bt-line(?:\s+(-?\d+))?/, 0) + num(b.increment, /\bt-line(?:\s+(-?\d+))?/, 1) : NaN));
      if (first.join() !== '10,1') throw new Error(`first line numbers ${first.join(', ')}, expected 10, 1: ${JSON.stringify(blocks)}`);
      if (ctx.browser === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        const snap = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
        const texts = snap.documents[0].layout.text.map((i) => (i >= 0 ? snap.strings[i] : '')).filter((x) => x.trim());
        for (const [i, b] of blocks.entries()) {
          const at = texts.indexOf(b.text);
          const shown = at > 0 ? texts[at - 1].trim() : null;
          if (shown !== String(first[i])) throw new Error(`rendered number before "${b.text}" is ${JSON.stringify(shown)}, expected "${first[i]}"`);
        }
        ctx.note('rendered numbers checked through a DOMSnapshot');
      }
    },
  },
  {
    // luccet's presentational styles (column alignment, a grid's --t-cols)
    // must survive a policy with no 'unsafe-inline' for styles; data-nonce
    // covers luccet's <style> and the note's scripts.
    name: 'strict CSP with data-nonce: aligned table cells and a cols grid, no violations',
    url: '/csp-nonce/test/smoke/csp-layout.html',
    async check(page) {
      await expect(page, () => !!document.querySelector('main.luccet .t-math > math'), 'math as MathML under the CSP');
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => {
        const grid = document.querySelector('main.luccet .t-cols');
        const cs = grid && getComputedStyle(grid);
        return {
          csp: window.__csp,
          cells: [...document.querySelectorAll('main.luccet table tr')].map((tr) => [...tr.children].map((c) => getComputedStyle(c).textAlign)),
          display: cs && cs.display,
          columns: cs && cs.gridTemplateColumns,
          script: window.__noteScript === true,
          base: getComputedStyle(document.querySelector('main.luccet')).overflowWrap, // a rule of luccet.css's own
          nonceGone: !document.querySelector('script[data-nonce]'),
        };
      });
      const problems = [];
      if (r.csp.length) problems.push(`${r.csp.length} CSP violation(s): ${[...new Set(r.csp)].join('; ')}`);
      if (!r.nonceGone) problems.push('data-nonce is still readable on the tag after luccet.js read it');
      const bad = r.cells.flatMap((row, i) => row.map((a, j) => [i, j, a])).filter(([, j, a]) => a !== ['left', 'right'][j]);
      if (bad.length || r.cells.length !== 3) problems.push(`text-align by row: ${JSON.stringify(r.cells)}, expected left, right in each of 3 rows`);
      const tracks = String(r.columns || '').split(/\s+/).map(parseFloat);
      if (r.display !== 'grid' || tracks.length !== 2 || !(Math.abs(tracks[0] / tracks[1] - 2) < 0.02)) problems.push(`grid: display ${r.display}, grid-template-columns ${JSON.stringify(r.columns)}, expected two tracks at 2:1`);
      if (!r.script) problems.push('the note script did not run (nonce)');
      if (r.base !== 'break-word') problems.push("luccet's base stylesheet is not applied (nonce)");
      if (problems.length) throw new Error(problems.join(' | '));
    },
  },
  ...DOC_TESTS,

  // The five sample notes (test/samples/), as written:
  // luccet.js by a relative URL, no add-ons.
  ...['lecture', 'cheatsheet', 'media', 'code', 'layout'].map((name) => ({
    name: `sample ${name}.html: mounts, its formulas are MathML, no console errors`,
    url: `/test/samples/${name}.html`,
    offline: true,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'main.luccet with its h1');
      const expected = mathCountUnderNode(path.join(SAMPLES, `${name}.html`));
      const m = await page.evaluate(MATH_STATE);
      if (expected != null && m.all !== expected) throw new Error(`${m.all} formulas in main.luccet, ${expected} under node`);
      if (m.rendered !== m.all) throw new Error(`${m.all - m.rendered} of ${m.all} formulas not MathML (${m.errors} t-error); first: ${String(m.firstMissing).slice(0, 160)}`);
      ctx.note(m.all ? `${m.all} formula(s), all MathML, ${m.closed} of them in closed <details>` : 'no math');
    },
  })),

  {
    // A real key press (a synthetic ClipboardEvent has no clipboardData in
    // Firefox). A window listener records what the copy event carries after
    // luccet's handler, which listens on the document and so runs first.
    // Chromium also reads the system clipboard back (the permission exists
    // there); Firefox's clipboard read needs a user's paste prompt, so there
    // the event's data is the evidence. WebKit's shell on Linux binds no key
    // to copy, so there the key press's own (trusted) keydown runs
    // document.execCommand('copy'), which the browser answers with the same
    // trusted copy event; LUCCET_SMOKE_COPY_EXEC=1 takes that path everywhere.
    name: 'copy: a selection with formulas reaches the clipboard as $tex$ and $$tex$$',
    url: '/test/smoke/copy.html',
    init: () =>
      window.addEventListener('copy', (e) => {
        const d = e.clipboardData;
        window.__copy = { plain: d ? d.getData('text/plain') : null, html: d ? d.getData('text/html') : null, prevented: e.defaultPrevented, trusted: e.isTrusted };
      }),
    async setup(context, _page, ctx) {
      if (ctx.browser === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ctx.origin });
    },
    async check(page, ctx) {
      const INLINE = 'a^2 + b^2 = c^2';
      const DISPLAY = '\\int_0^1 x\\,dx = \\tfrac12';
      await expect(page, () => document.querySelectorAll('main.luccet .t-math[data-tex] > math').length === 2, 'both formulas as MathML');
      const tex = await page.evaluate(() => [...document.querySelectorAll('main.luccet .t-math')].map((e) => e.dataset.tex));
      if (tex[0] !== INLINE || tex[1] !== DISPLAY) throw new Error(`data-tex ${JSON.stringify(tex)}, expected ${JSON.stringify([INLINE, DISPLAY])}`);
      // Select from the paragraph before the inline formula to the one after
      // the equation, with the DOM Range API, and copy with the keyboard.
      if (ctx.browser === 'chromium') await page.evaluate(() => navigator.clipboard.writeText('(nothing was copied)'));
      await page.evaluate(() => {
        const range = document.createRange();
        range.setStartBefore(document.getElementById('copy-from'));
        range.setEndAfter(document.getElementById('copy-to'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      const exec = ctx.browser === 'webkit' || process.env.LUCCET_SMOKE_COPY_EXEC === '1';
      if (exec) {
        await page.evaluate(() => {
          window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && e.isTrusted) window.__exec = document.execCommand('copy');
          });
        });
      }
      await page.keyboard.press('ControlOrMeta+C');
      await expect(page, () => !!window.__copy, `a copy event from the key press${exec ? " (through execCommand('copy'))" : ''}`, 3000);
      if (exec && !(await page.evaluate(() => window.__exec))) throw new Error("execCommand('copy') from the key press returned false");
      const event = await page.evaluate(() => window.__copy);
      if (!event.trusted) throw new Error('the copy event was not trusted');
      if (!event.prevented) throw new Error("luccet's copy handler did not take the copy (the event was not cancelled)");
      const checks = [['the copy event', event.plain, event.html]];
      if (ctx.browser === 'chromium') {
        const clip = await page.evaluate(async () => {
          const out = {};
          for (const item of await navigator.clipboard.read()) for (const type of item.types) out[type] = await (await item.getType(type)).text();
          return out;
        });
        checks.push(['the clipboard', clip['text/plain'], clip['text/html']]);
      }
      for (const [where, plainRaw, html] of checks) {
        const plain = (plainRaw || '').replace(/\s+/g, ' ').trim();
        const show = JSON.stringify(plain.slice(0, 240));
        for (const want of [`Pythagoras: $${INLINE}$ for every right triangle.`, `$$${DISPLAY}$$`, 'The end of the selection.']) {
          if (!plain.includes(want)) throw new Error(`text/plain on ${where} lacks ${JSON.stringify(want)}: ${show}`);
        }
        // The MathML's own text (its tokens: "a2+b2=c2", "∫") must be
        // replaced, not kept beside the TeX.
        if (plain.split(INLINE).length !== 2) throw new Error(`text/plain on ${where} holds the inline TeX ${plain.split(INLINE).length - 1} times: ${show}`);
        if (/a2\+b2=c2|∫/.test(plain.replace(/\s/g, ''))) throw new Error(`text/plain on ${where} keeps the MathML's text: ${show}`);
        // The handler rewrites both flavours, text/plain and text/html.
        if (!html) throw new Error(`no text/html on ${where}`);
        const htmlText = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
        if (/<(?:math|mi|mn|mo|mrow|msup|msubsup|mfrac)\b/i.test(html)) throw new Error(`text/html on ${where} keeps MathML markup`);
        if (/a2\+b2=c2|∫/.test(htmlText.replace(/\s/g, ''))) throw new Error(`text/html on ${where} keeps the MathML's text: ${JSON.stringify(htmlText.slice(0, 240))}`);
        for (const want of [`$${INLINE}$`, `$$${DISPLAY}$$`]) {
          if (!htmlText.includes(want)) throw new Error(`text/html on ${where} lacks ${JSON.stringify(want)}: ${JSON.stringify(htmlText.slice(0, 240))}`);
        }
      }
      ctx.note(`checked ${checks.map(([w]) => w).join(' and ')}${exec ? ", copied through execCommand('copy') from the key press" : ''}`);
    },
  },
  {
    name: 'print: PDF text keeps a formula adjacent to its sentence',
    url: '/test/smoke/print.html',
    browsers: ['chromium'],
    async check(page, ctx) {
      if (!hasMutool()) ctx.skip('mutool not found; install MuPDF (mupdf-tools) to extract PDF text');
      await expect(page, () => !!document.querySelector('main.luccet .t-math > math'), 'the formula as MathML');
      await page.evaluate(() => document.fonts.ready);
      // `7 \times 6 = 42` has only upright glyphs on one baseline, so its
      // text reads "7×6=42" and has no sub/superscript parts, which a PDF's
      // text order may set apart. The MathML is laid out inline, in the
      // line, so its text must sit, once, between the words around it.
      const inPlace = (text) => /Theproduct7×6=42istheanswer/.test(text.replace(/[\s\u200b]+/g, ''));
      const text = await pdfText(page);
      if (!inPlace(text)) throw new Error(`the formula left its sentence in the PDF text: ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 200))}`);
      ctx.note(`PDF text: ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 90))}`);
    },
  },
  {
    // Throttling: CDP Network.emulateNetworkConditions for the local server.
    // Mount is when main.luccet enters the document. Stages are defined at
    // assignStages; the budget counts only requests started before mount. The
    // report lists them all. Also checked: luccet.js and the add-ons start
    // before mount; the math, MathML from the engine, asks for nothing, so
    // nothing is requested after mount; and nothing is fetched twice (a
    // preload the page did not reuse).
    name: 'Slow-3G waterfall: at most 3 serial stages before mount',
    url: '/test/smoke/waterfall.html',
    browsers: ['chromium'],
    timeout: 120000,
    readyTimeout: 90000,
    waitUntil: 'commit',
    init: () => {
      new MutationObserver((_, mo) => {
        if (document.querySelector('main.luccet')) {
          window.__mountedAt = performance.timeOrigin + performance.now();
          mo.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    },
    async setup(context, page, ctx) {
      const cdp = await context.newCDPSession(page);
      const requests = new Map();
      ctx.requests = requests;
      cdp.on('Network.requestWillBeSent', (e) => {
        if (!/^https?:/.test(e.request.url)) return;
        // A redirect keeps the id: keep the first start.
        if (!requests.has(e.requestId)) requests.set(e.requestId, { id: e.requestId, url: e.request.url, start: e.timestamp, wall: e.wallTime, type: e.type, initiator: e.initiator && e.initiator.type });
      });
      cdp.on('Network.loadingFinished', (e) => requests.has(e.requestId) && (requests.get(e.requestId).end = e.timestamp));
      cdp.on('Network.loadingFailed', (e) => requests.has(e.requestId) && Object.assign(requests.get(e.requestId), { end: e.timestamp, failed: e.errorText }));
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: SLOW_3G.latency, downloadThroughput: SLOW_3G.bytesPerSecond, uploadThroughput: SLOW_3G.bytesPerSecond });
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet .t-math[data-tex] > math'), 'the formula as MathML', 60000);
      if ((await page.evaluate(() => window.__addon)) !== 1) throw new Error('the JS add-on did not run exactly once');
      // Let late requests, were there any, finish, for the report.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const all = [...ctx.requests.values()].filter((r) => !/\/favicon\.ico$/.test(r.url));
      const doc = all.find((r) => r.type === 'Document');
      if (!doc) throw new Error('no document request recorded');
      const mountedAt = await page.evaluate(() => window.__mountedAt);
      if (!mountedAt) throw new Error('main.luccet never entered the document');
      // CDP timestamps are monotonic seconds; map the page's epoch time onto
      // them through the document request's wallTime.
      const mount = mountedAt / 1000 - (doc.wall - doc.start);
      const ordered = assignStages(all, doc);
      const at = (t) => (t - doc.start).toFixed(2).padStart(6);
      const short = (u) => u.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, 'cdn:');
      for (const r of ordered) {
        ctx.note(`${r.start < mount ? ' ' : '+'} stage ${r.stage}  ${at(r.start)} → ${r.end != null ? at(r.end) : '   (open)'} s  ${short(r.url)}${r.failed ? `  FAILED ${r.failed}` : ''}`);
      }
      ctx.note(`  mount at ${at(mount)} s; "+" = requested after mount (not counted); stage tolerance ${STAGE_TOL} ms`);
      const before = ordered.filter((r) => r.start < mount);
      // luccet.js and the add-ons are preloaded at capture.
      const want = [/\/luccet\.js$/, /\/gen\/addon\.js$/, /\/gen\/addon\.css$/];
      for (const re of want) {
        if (!before.some((r) => re.test(r.url))) throw new Error(`nothing matching ${re} was requested before mount (luccet.js and the add-ons are preloaded at capture)`);
      }
      const after = ordered.filter((r) => r.start >= mount);
      if (after.length) throw new Error(`requested after mount: ${after.map((r) => short(r.url)).join(', ')} (math needs nothing: no script, stylesheet or font)`);
      const seen = new Map();
      for (const r of all) seen.set(r.url, (seen.get(r.url) || 0) + 1);
      const twice = [...seen].filter(([, n]) => n > 1).map(([u]) => short(u));
      if (twice.length) throw new Error(`fetched more than once (a preload not reused?): ${twice.join(', ')}`);
      const failed = all.filter((r) => r.failed);
      if (failed.length) throw new Error(`failed requests: ${failed.map((r) => `${short(r.url)} (${r.failed})`).join(', ')}`);
      const stages = Math.max(...before.map((r) => r.stage));
      ctx.note(`  ${stages} serial stages before mount; none after it`);
      if (stages > 3) throw new Error(`${stages} serial stages before mount, budget 3 (see the waterfall below)`);
    },
  },
  {
    name: 'window.LUCCET.strings: the panel and the emitter\'s labels speak the page\'s words, and luccet.string reads them',
    url: '/test/smoke/strings.html',
    async check(page) {
      const r = await page.evaluate(() => ({
        panel: document.querySelector('.t-diagnostics summary').textContent,
        footnotes: document.querySelector('.t-footnotes').getAttribute('aria-label'),
        back: document.querySelector('.t-fnback').getAttribute('aria-label'),
        task: document.querySelector('.t-task input').getAttribute('aria-label'),
        api: window.luccet.string('problems', { n: 2 }) + ' / ' + window.luccet.string('nothing', { n: 2 }, '{n} thing|{n} things'),
      }));
      if (r.panel !== 'luccet: 1 Problem (1 Warnung)') throw new Error(`the panel: ${r.panel}`);
      if (r.footnotes !== 'Anmerkungen' || r.back !== 'Zurück' || r.task !== 'Fertig') throw new Error(`the emitter's labels: ${JSON.stringify([r.footnotes, r.back, r.task])}`);
      if (r.api !== '2 Probleme / 2 things') throw new Error(`luccet.string: ${r.api}`);
    },
  },
  {
    // axe-core over luccet.css, light and dark: WCAG 2.0/2.1 A and AA rules,
    // no violation. The page holds every construct the emitter writes.
    name: 'accessibility: axe finds no WCAG A or AA violation on a page of every construct, light and dark',
    url: '/gen/a11y/luccet.html',
    timeout: 240000,
    async setup(_context, _page, ctx) {
      ctx.axe = await axeDir(AXE_VERSION);
      if (!ctx.axe) ctx.skip(`no local copy of axe-core ${AXE_VERSION}`);
    },
    async check(page, ctx) {
      const origin = new URL(page.url()).origin;
      const pages = [['luccet', 'light'], ['luccet', 'dark']];
      const problems = [];
      let rules = 0;
      for (const [theme, mode] of pages) {
        await page.emulateMedia({ colorScheme: mode });
        await page.goto(`${origin}/gen/a11y/${theme}.html`, { waitUntil: 'load' });
        await expect(page, () => window.luccet && window.luccet.ready && document.querySelector('main.luccet .t-footnotes'), `${theme} ${mode} mounted`, 20000);
        await page.evaluate(() => window.luccet.ready);
        await page.addScriptTag({ path: path.join(ctx.axe, 'axe.min.js') });
        const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((res) => ({ violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })), passes: res.passes.length })));
        rules = Math.max(rules, r.passes + r.violations.length);
        for (const v of r.violations) problems.push(`${theme} (${mode}): ${v.id} [${v.impact}] at ${v.nodes.join('; ')}`);
      }
      ctx.note(`${pages.length} pages (${pages.map(([t, m]) => `${t}/${m[0]}`).join(', ')}); axe-core ${AXE_VERSION}, about ${rules} rules checked`);
      for (const p of problems) ctx.note(p);
      if (problems.length) throw new Error(`${problems.length} violation(s), listed below`);
    },
  },
  {
    // A 1 MB note of prose, no math: the runtime holds its top-level blocks out
    // of view at mount (content-visibility: auto), so the first paint costs a
    // screen's layout, not a megabyte's. The budget is the mount frame's
    // style, layout and paint (LoAF, Chromium) or, without LoAF, the time from
    // 'render' to the first contentful paint; both are reported. Held blocks
    // are released as they come into view, and all of them before printing.
    name: 'first paint of a 1 MB note: off-screen blocks held at mount, released on scroll and before print',
    url: '/gen/long1mb.html',
    timeout: 120000,
    readyTimeout: 60000,
    init: () => {
      window.__loaf = [];
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__loaf.push({ start: e.startTime, duration: e.duration, layout: e.duration - (e.styleAndLayoutStart ? e.styleAndLayoutStart - e.startTime : e.duration) }))).observe({ type: 'long-animation-frame', buffered: true });
      } catch {}
    },
    async check(page, ctx) {
      const BUDGET = 1500; // ms of style, layout and paint for the mount frame
      await expect(page, () => window.__t && window.__t.ready != null, "the 'ready' event", 60000);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const r = await page.evaluate(() => {
        const blocks = [...document.querySelector('main.luccet').children];
        const heldNow = blocks.filter((b) => b.style.contentVisibility === 'auto');
        const inView = heldNow.filter((b) => {
          const q = b.getBoundingClientRect();
          return q.bottom > 0 && q.top < innerHeight;
        });
        const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
        const t = window.__t;
        const end = (e) => e.start + e.duration;
        const frame = (window.__loaf || []).find((f) => f.start <= t.render + 1 && t.render <= end(f) + 1);
        return { bytes: document.documentElement.outerHTML.length, blocks: blocks.length, held: heldNow.length, inView: inView.length, fcp: paint ? paint.startTime : null, render: t.render, script: t.script, ready: t.ready, frame };
      });
      const ms = (x) => `${Math.round(x)} ms`;
      ctx.note(`${r.blocks} top-level blocks, ${r.held} held after the mount (${r.inView} of them in view); 'ready' at ${ms(r.ready)}`);
      if (r.frame) ctx.note(`mount frame (LoAF): ${ms(r.frame.duration)}, of which style, layout and paint ${ms(r.frame.layout)}`);
      if (r.fcp != null) ctx.note(`first contentful paint at ${ms(r.fcp)}, 'render' at ${ms(r.render)}`);
      if (r.held < 100) throw new Error(`${r.held} held blocks of ${r.blocks}: the runtime did not hold a 1 MB note`);
      if (r.inView) throw new Error(`${r.inView} held block(s) in view`);
      const cost = r.frame ? r.frame.layout : r.fcp != null ? r.fcp - r.render : null;
      if (cost == null) ctx.note('no LoAF and no first-contentful-paint entry: the layout cost is not measured here');
      else if (cost > BUDGET) throw new Error(`the first paint cost ${ms(cost)} of layout, budget ${BUDGET} ms`);
      // Scrolled to the end: the blocks there are released and laid out; before printing, all are.
      const scrolled = await page.evaluate(async () => {
        const last = document.querySelector('main.luccet').lastElementChild;
        last.scrollIntoView();
        await new Promise((r) => setTimeout(r, 400));
        return { lastHeld: last.style.contentVisibility === 'auto', lastHeight: last.getBoundingClientRect().height, stillHeld: [...document.querySelector('main.luccet').children].filter((b) => b.style.contentVisibility === 'auto').length };
      });
      if (scrolled.lastHeld || scrolled.lastHeight < 10) throw new Error(`the last block after a scroll to it: held ${scrolled.lastHeld}, ${Math.round(scrolled.lastHeight)} px high`);
      if (!scrolled.stillHeld) throw new Error('every block released by a scroll to the end: the middle should still be held');
      const printed = await page.evaluate(() => {
        window.dispatchEvent(new Event('beforeprint'));
        const n = [...document.querySelector('main.luccet').children].filter((b) => b.style.contentVisibility === 'auto').length;
        window.dispatchEvent(new Event('afterprint'));
        return n;
      });
      if (printed) throw new Error(`${printed} blocks still held before printing`);
    },
  },
  {
    // The default holdOver (30 000 characters) holds a note of 100 KB, which
    // the browser would otherwise lay out whole before its first paint.
    name: 'a 100 KB note under the default holdOver: off-screen blocks held at mount, none in view, released on scroll and before print',
    url: '/gen/long100kb.html',
    async check(page, ctx) {
      await expect(page, () => window.__t && window.__t.ready != null, "the 'ready' event");
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const r = await page.evaluate(() => {
        const blocks = [...document.querySelector('main.luccet').children];
        const held = blocks.filter((b) => b.style.contentVisibility === 'auto');
        const inView = held.filter((b) => {
          const q = b.getBoundingClientRect();
          return q.bottom > 0 && q.top < innerHeight;
        });
        return { blocks: blocks.length, held: held.length, inView: inView.length };
      });
      ctx.note(`${r.blocks} top-level blocks, ${r.held} held after the mount`);
      if (r.held < 50) throw new Error(`${r.held} held blocks of ${r.blocks}: the runtime did not hold a 100 KB note`);
      if (r.inView) throw new Error(`${r.inView} held block(s) in view`);
      const after = await page.evaluate(async () => {
        const main = document.querySelector('main.luccet');
        main.lastElementChild.scrollIntoView();
        await new Promise((r) => setTimeout(r, 400));
        const scrolled = { last: main.lastElementChild.style.contentVisibility === 'auto' };
        window.dispatchEvent(new Event('beforeprint'));
        scrolled.printed = [...main.children].filter((b) => b.style.contentVisibility === 'auto').length;
        window.dispatchEvent(new Event('afterprint'));
        return scrolled;
      });
      if (after.last) throw new Error('the last block is still held after a scroll to it');
      if (after.printed) throw new Error(`${after.printed} blocks still held before printing`);
    },
  },
  {
    // Parse+transform (the TeX translated to MathML there)+emit+mount is one
    // synchronous task by design, and the browser lays the whole note out,
    // MathML included, in the frame that follows it: the first paint shows
    // the math. No add-on. The mount frame is the long animation frame (LoAF)
    // holding 'render', or without LoAF the long task holding it. The budget
    // is for what comes after: no long task (> 50 ms, the Long Tasks API
    // threshold) from the end of the mount frame until 'math', plus a
    // settling window. Both are reported.
    name: 'the 4,000-formula note: every formula MathML at mount, and no long task over 50 ms after it',
    url: '/gen/math4000.html',
    timeout: 120000,
    readyTimeout: 60000,
    async setup(_context, page, ctx) {
      if (!(await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')))) ctx.skip(`${ctx.browser} exposes no longtask entries (PerformanceObserver.supportedEntryTypes)`);
    },
    init: () => {
      window.__lt = [];
      window.__loaf = [];
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push({ start: e.startTime, duration: e.duration }))).observe({ type: 'longtask', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((l) =>
          l.getEntries().forEach((e) =>
            window.__loaf.push({
              start: e.startTime,
              duration: e.duration,
              layout: e.duration - (e.styleAndLayoutStart ? e.styleAndLayoutStart - e.startTime : e.duration),
              scripts: (e.scripts || []).map((s) => `${s.invoker || s.invokerType}:${Math.round(s.duration)}`).join(' '),
            }),
          ),
        ).observe({ type: 'long-animation-frame', buffered: true });
      } catch {}
    },
    async check(page, ctx) {
      const SETTLE = 300;
      await expect(page, () => window.__t && window.__t.math != null, "the 'math' event", 30000);
      await page.evaluate((ms) => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), ms)), SETTLE);
      const m = await page.evaluate(MATH_STATE);
      if (m.all !== 4000) throw new Error(`${m.all} formulas in the note, expected 4,000`);
      if (m.rendered !== m.all) throw new Error(`${m.all - m.rendered} of ${m.all} formulas not MathML; first: ${String(m.firstMissing).slice(0, 160)}`);
      const { t, lt, loaf } = await page.evaluate(() => ({ t: window.__t, lt: window.__lt, loaf: window.__loaf }));
      if (t.render == null) throw new Error("'render' never fired");
      const end = (e) => e.start + e.duration;
      const ms = (x) => `${Math.round(x)} ms`;
      const mountTask = lt.find((e) => e.start <= t.render + 1 && t.render <= end(e) + 1);
      const frame = loaf.find((f) => f.start <= t.render + 1 && t.render <= end(f) + 1);
      const mountEnd = frame ? end(frame) : mountTask ? end(mountTask) : t.render;
      const inMount = lt.filter((e) => e.start < mountEnd && end(e) > t.render - 1);
      const after = lt.filter((e) => !inMount.includes(e) && end(e) > t.render && e.start <= t.math + SETTLE);
      ctx.note(`mount task (parse+transform+emit+mount, to 'render'): ${mountTask ? `${ms(mountTask.duration)} at ${ms(mountTask.start)}, ${ms(end(mountTask) - t.render)} of it after 'render'` : 'under 50 ms'}`);
      if (frame) ctx.note(`mount frame (LoAF): ${ms(frame.duration)} at ${ms(frame.start)}, of which style, layout and paint ${ms(frame.layout)}; its long tasks: ${inMount.map((e) => `${ms(e.start)}+${ms(e.duration)}`).join(', ') || 'none'}`);
      ctx.note(`'render' at ${ms(t.render)}, 'math' at ${ms(t.math)}; ${m.all} formulas, all MathML, ${m.closed} of them in closed <details>`);
      ctx.note(`long tasks after the mount: ${after.length ? after.map((e) => `${ms(e.start)}+${ms(e.duration)}`).join(', ') : 'none'}`);
      if (after.length) {
        const frames = loaf.filter((f) => f.start >= mountEnd - 1 && after.some((e) => f.start < end(e) && e.start < end(f)));
        if (frames.length) ctx.note(`their frames (LoAF): ${frames.map((f) => `${ms(f.start)}+${ms(f.duration)} = style, layout and paint ${ms(f.layout)} + ${f.scripts || 'no script'}`).join('; ')}`);
        throw new Error(`${after.length} long task(s) after the mount, longest ${ms(Math.max(...after.map((e) => e.duration)))} (budget: none over 50 ms)`);
      }
    },
  },

  // ---- a note's own vocabulary (window.LUCCET.schema), as a note and as a built page
  ...[
    ['a single-file note numbers with its window.LUCCET.schema, which wins over an add-on', '/test/smoke/own-schema.html', null],
    ['luccet build: the built page keeps the note\'s window.LUCCET.schema, behaviours included', '/gen/built-own-schema.html', 'built-own-schema'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup() {
      if (built) cliPage(built);
    },
    async check(page) {
      const r = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('main.luccet .t-label')].map((e) => e.textContent),
        refs: [...document.querySelectorAll('main.luccet a.t-ref')].map((e) => e.textContent),
        dom: document.getElementById('t1').dataset.dom,
        tags: [document.getElementById('t1').localName, document.getElementById('l2').localName],
      }));
      const want = { labels: ['Theorem 1', 'Lemma 2'], refs: ['Theorem 1', 'Lemma 2'], dom: 'own', tags: ['section', 'section'] };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
    },
  })),

  // ---- what the note sets, and what its add-ons do, as a note and as a built page
  ...[
    ['data-lang sets the label language over window.LUCCET.lang and :::meta; window.LUCCET.schema.strict gives name.unknown', '/test/smoke/note-config.html', null],
    ['luccet build: the built page has the same label language and name.unknown', '/gen/built-note-config.html', 'built-note-config'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup() {
      if (built) cliPage(built);
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('main.luccet .t-label')].map((e) => e.textContent),
        refs: [...document.querySelectorAll('main.luccet a.t-ref')].map((e) => e.textContent),
      }));
      if (JSON.stringify(r) !== JSON.stringify({ labels: ['Satz 1'], refs: ['Satz 1'] })) throw new Error(`${JSON.stringify(r)}, expected the label and the reference Satz 1`);
      const codes = ctx.diagnostics.map((d) => `${d.code} ${d.position.start.line}:${d.position.start.column}`);
      if (codes.join() !== 'name.unknown 14:4') throw new Error(`luccet.diagnostics ${JSON.stringify(codes)}, expected name.unknown at 14:4`);
    },
  })),
  ...[
    ['an add-on that throws while it runs gives addon.failed with its message; the note mounts with what it declared first', '/test/smoke/addon-throws.html', null],
    ['luccet build: an add-on that throws on the built page gives addon.failed with its message', '/gen/built-addon-throws.html', 'built-addon-throws'],
  ].map(([name, url, built]) => ({
    name,
    url,
    expectConsoleErrors: true, // the add-ons' uncaught errors
    async setup() {
      if (built) cliPage(built);
    },
    async check(page, ctx) {
      await expect(page, () => (document.getElementById('k') || {}).localName === 'aside', 'the kept block as an aside');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed').map((d) => d.message);
      const want = [
        ['addon-throws.js', 'addon-boom'],
        ['addon-throws-api.js', '"figures" is a built-in transform'],
      ];
      if (failed.length !== 2 || !want.every((w) => failed.some((m) => w.every((x) => m.includes(x))))) throw new Error(`addon.failed ${JSON.stringify(failed)}, expected one naming each add-on with its error`);
      if (!failed.every((m) => /^the add-on \S+ threw while it ran: /.test(m))) throw new Error(`messages ${JSON.stringify(failed)}`);
      const panel = await page.evaluate(() => (document.querySelector('.t-diagnostics') || {}).textContent || '');
      if (!panel.includes('addon-boom')) throw new Error(`the panel does not show it: ${JSON.stringify(panel)}`);
    },
  })),
  ...[
    ["a video's poster loads after the mount (Chromium skips one parsed in a <template>)", '/test/smoke/poster.html', null],
    ["luccet build: a video's poster loads on the built page", '/gen/built-poster.html', 'built-poster'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup(_context, page, ctx) {
      if (built) cliPage(built);
      ctx.posters = [];
      page.on('requestfinished', (q) => /\/gen\/poster\.png$/.test(q.url()) && ctx.posters.push(q.url()));
    },
    async check(page, ctx) {
      for (let i = 0; i < 30 && !ctx.posters.length; i++) await page.waitForTimeout(100);
      const v = await page.evaluate(() => {
        const el = document.querySelector('main.luccet video');
        return el && { poster: el.poster, mounted: !!el.closest('main.luccet') };
      });
      if (!v || !/\/gen\/poster\.png$/.test(v.poster)) throw new Error(`the video ${JSON.stringify(v)}`);
      if (!ctx.posters.length) throw new Error('the poster image was never requested');
      ctx.note(`poster requests: ${ctx.posters.length}`);
    },
  })),

  // ---- the command line's pages (docs/tools.html#built-page)
  {
    // The content is in the HTML: blocked, luccet.js leaves it as built (its
    // add-on and the note's script, which call luccet, throw).
    name: 'luccet build: the page shows its content, styled, with luccet.js blocked',
    url: '/gen/built.html',
    noTern: true,
    expectConsoleErrors: true,
    async setup(context) {
      cliPage('built');
      await context.route((url) => url.pathname === '/luccet.js', (route) => route.abort());
    },
    async check(page) {
      await expect(page, () => document.readyState === 'complete', 'the page to load');
      const r = await page.evaluate(() => {
        const box = document.querySelector('main.luccet aside.box');
        return {
          luccet: typeof window.luccet,
          h1: (document.querySelector('main.luccet h1') || {}).textContent,
          label: box && box.querySelector('.t-label').textContent,
          ref: (document.querySelector('main.luccet a.t-ref[href="#b1"]') || {}).textContent,
          math: document.querySelectorAll('main.luccet .t-math').length,
          mathml: [...document.querySelectorAll('main.luccet .t-math[data-tex] > math')].filter((m) => m.getBoundingClientRect().width > 0).length,
          source: !!document.querySelector('script[type="text/luccet"]#luccet-source'),
          title: document.title,
          lang: document.documentElement.lang,
          wrap: getComputedStyle(document.querySelector('main.luccet')).overflowWrap, // a rule of luccet.css's own
          border: box && getComputedStyle(box).borderTopStyle,
          panel: !!document.querySelector('.t-diagnostics'),
        };
      });
      const want = { luccet: 'undefined', h1: 'Smoke: a built page', label: 'Box 1', ref: 'Box 1', math: 2, mathml: 2, source: true, title: 'Smoke: a built page', lang: 'en', border: 'solid', panel: false };
      const got = { ...r };
      delete got.wrap;
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`page ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      if (r.wrap !== 'break-word') throw new Error('luccet.css is not applied (main.luccet does not wrap long words)');
    },
  },
  {
    name: "luccet build: luccet.js starts the built page: note scripts once, behaviours, math, the panel, 'ready'",
    url: '/gen/built.html',
    async setup() {
      cliPage('built');
    },
    async check(page, ctx) {
      await expect(page, () => document.querySelectorAll('main.luccet .t-math[data-tex] > math').length === 2, 'both formulas MathML');
      const r = await page.evaluate(() => ({
        log: window.__log,
        scripts: window.__script,
        mains: document.querySelectorAll('main.luccet').length,
        dom: document.getElementById('b1').dataset.dom,
        define: document.getElementById('b1').dataset.define,
        tex: [...document.querySelectorAll('main.luccet .t-math')].map((e) => e.dataset.tex),
        panel: (document.querySelector('.t-diagnostics') || {}).textContent || '',
        sheets: [...document.head.querySelectorAll('style, link[rel="stylesheet"]')].map((e) => (e.id === 'luccet-style' ? 'base' : e.href ? e.href.replace(/^.*\//, '') : /aside\.box/.test(e.textContent) ? 'luccet.style' : 'other')),
      }));
      const want = ['script luccet=object', 'define math=2', 'render', 'math main', 'ready'];
      if (JSON.stringify(r.log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(r.log)}, expected ${JSON.stringify(want)}`);
      if (r.scripts !== 1 || r.mains !== 1) throw new Error(`the note script ran ${r.scripts} time(s), ${r.mains} main.luccet; expected 1 and 1`);
      if (r.dom !== 'yes' || r.define !== 'yes') throw new Error(`behaviours: the add-on's dom ${r.dom}, luccet.define ${r.define}`);
      if (r.tex.join(' | ') !== 'a^2 + b^2 = c^2 | \\int_0^1 x\\,dx = \\tfrac12') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      const codes = ctx.diagnostics.map((d) => d.code);
      if (codes.join() !== 'ref.dangling') throw new Error(`luccet.diagnostics ${JSON.stringify(codes)}, expected the build's ref.dangling`);
      const d = ctx.diagnostics[0];
      if (!r.panel.includes('ref.dangling') || !r.panel.includes(`line ${d.position.start.line}:${d.position.start.column} (file line ${d.position.start.line + 1})`)) throw new Error(`the panel: ${JSON.stringify(r.panel)}`);
      const [base, own, css] = ['base', 'luccet.style', 'built-addon.css'].map((s) => r.sheets.indexOf(s));
      if (!(base >= 0 && base < own && own < css)) throw new Error(`head sheets ${JSON.stringify(r.sheets)}: expected the base, then the add-on's luccet.style, then the CSS add-on (data-use order)`);
    },
  },
  {
    // A missing CSS add-on is not reported on a built page: its link comes
    // before luccet.js.
    name: 'luccet build: a missing script add-on gives addon.failed on the built page',
    url: '/gen/built-missing.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type/,
    async setup() {
      cliPage('built-missing');
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'main.luccet');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed').map((d) => d.message);
      if (failed.length !== 1 || !failed[0].includes('missing-addon.js')) throw new Error(`addon.failed ${JSON.stringify(failed)}, expected one naming missing-addon.js`);
    },
  },
  {
    // The build writes the engine's MathML into the HTML, so the formulas are
    // there before any script runs, and nothing is fetched for them (no
    // --math or --katex any more: test/cli.js has the usage errors).
    name: 'luccet build: formulas are MathML in the HTML, and no math asset is requested',
    url: '/gen/built.html',
    async setup(_context, page, ctx) {
      cliPage('built');
      ctx.requests = [];
      page.on('request', (q) => ctx.requests.push(q.url()));
    },
    async check(page, ctx) {
      const raw = cliPage('built');
      const inHTML = [...raw.matchAll(/<span class="t-math"( data-display)? data-pos="[^"]*" data-tex="([^"]*)"><math( display="block")?>/g)].map((m) => `${m[1] ? 'display' : 'inline'} ${m[3] ? 'block' : 'inline'} ${m[2]}`);
      const wantHTML = ['inline inline a^2 + b^2 = c^2', 'display block \\int_0^1 x\\,dx = \\tfrac12'];
      if (JSON.stringify(inHTML) !== JSON.stringify(wantHTML)) throw new Error(`formulas in the built HTML ${JSON.stringify(inHTML)}, expected ${JSON.stringify(wantHTML)}`);
      if (/katex|temml/i.test(raw)) throw new Error('the built HTML names KaTeX or Temml');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => [...document.querySelectorAll('main.luccet .t-math[data-tex] > math')].map((m) => {
        const box = m.getBoundingClientRect();
        return `${m.getAttribute('display') || 'inline'} ${box.width > 0 && box.height > 0 ? 'laid out' : 'empty'}`;
      }));
      if (r.join() !== 'inline laid out,block laid out') throw new Error(`MathML in main.luccet: ${JSON.stringify(r)}`);
      const urls = [...new Set(ctx.requests.map((u) => (u.startsWith(ctx.origin) ? u.slice(ctx.origin.length) : u)))].filter((u) => u !== '/favicon.ico').sort();
      const want = ['/gen/built.html', '/luccet.js', '/test/smoke/built-addon.css', '/test/smoke/built-addon.js'];
      if (JSON.stringify(urls) !== JSON.stringify(want)) throw new Error(`requests ${JSON.stringify(urls)}, expected the page, luccet.js and its two add-ons alone`);
    },
  },
  {
    name: 'a leading :::use block loads its add-ons like data-use; a late one is ignored with use.late',
    url: '/test/smoke/use.html',
    async setup(_context, page, ctx) {
      ctx.reqs = [];
      page.on('request', (q) => /-addon\.js|\/themes\//.test(q.url()) && ctx.reqs.push(q.url().replace(/^https?:\/\/[^/]+/, '')));
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet pre[data-fence-addon="yes"]'), "the mark the block's add-on gives the fence");
      const r = await page.evaluate(() => ({
        useDivs: document.querySelectorAll('[data-t="use"]').length,
        nord: [...document.styleSheets].some((s) => /\/themes\/nord\.css/.test(s.href || '')),
        cfg: Object.keys(luccet.config.use).sort(),
      }));
      if (r.useDivs) throw new Error(`${r.useDivs} :::use elements in the page, expected none`);
      if (!r.nord) throw new Error('the theme the block lists did not load');
      if (JSON.stringify(r.cfg) !== JSON.stringify(['fence-addon', 'nord'])) throw new Error(`config.use ${JSON.stringify(r.cfg)}, expected fence-addon and nord only`);
      await page.waitForTimeout(200);
      if (ctx.reqs.some((u) => /built-addon\.js/.test(u))) throw new Error("the late block's add-on was requested");
      if (!ctx.diagnostics.some((d) => d.code === 'use.late')) throw new Error('no use.late for the late block');
    },
  },
  {
    name: ':::use is read as the file streams in: its add-on starts loading before the note has finished arriving (Slow 3G)',
    url: '/gen/use-long.html',
    browsers: ['chromium'],
    timeout: 120000,
    readyTimeout: 90000,
    async setup(context, page, ctx) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: SLOW_3G.latency, downloadThroughput: SLOW_3G.bytesPerSecond, uploadThroughput: SLOW_3G.bytesPerSecond });
      ctx.addonAt = null;
      page.on('request', (q) => /\/test\/smoke\/fence-addon\.js/.test(q.url()) && ctx.addonAt === null && (ctx.addonAt = Date.now()));
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'the note mounted', 60000);
      const { origin, dcl } = await page.evaluate(() => ({ origin: performance.timeOrigin, dcl: performance.timeOrigin + performance.getEntriesByType('navigation')[0].domContentLoadedEventStart }));
      if (ctx.addonAt === null) throw new Error('the add-on was never requested');
      ctx.note(`  fence-addon.js requested at ${Math.round(ctx.addonAt - origin)} ms, ${Math.round(dcl - ctx.addonAt)} ms before DOMContentLoaded (${Math.round(dcl - origin)} ms)`);
      if (ctx.addonAt >= dcl) throw new Error(`the add-on was requested only at DOMContentLoaded (${Math.round(ctx.addonAt - dcl)} ms after): the streaming scan did not fire early`);
    },
  },
  {
    name: 'luccet new: the note renders and the guard stays inert',
    url: '/gen/guarded.html',
    async setup() {
      cliPage('guarded');
    },
    async check(page) {
      await expect(page, () => (document.querySelector('main.luccet h1') || {}).textContent === 'Smoke: a guarded note', 'the heading in main.luccet');
      const r = await page.evaluate(() => ({ text: document.body.innerText, xmp: document.querySelectorAll('xmp, plaintext').length }));
      if (/did not load|JavaScript is off/.test(r.text) || r.xmp) throw new Error(`the guard acted: ${JSON.stringify(r)}`);
    },
  },
  ...[
    ['luccet.js does not load', { setup: (context) => context.route((url) => url.pathname === '/luccet.js', (route) => route.abort()) }, 'luccet.js did not load; the source follows.'],
    ['JavaScript is off', { context: { javaScriptEnabled: false } }, 'JavaScript is off; the source follows.'],
  ].map(([when, opts, message]) => ({
    name: `luccet new: when ${when}, the note shows as its source, wrapped`,
    url: '/gen/guarded.html',
    noTern: true,
    allowConsole: /Failed to load resource|Loading failed for the <script>/,
    ...opts,
    async setup(context, page, ctx) {
      cliPage('guarded');
      if (opts.setup) await opts.setup(context, page, ctx);
    },
    async check(page) {
      await expect(page, () => document.readyState === 'complete', 'the page to load');
      const r = await page.evaluate(() => ({
        p: [...document.querySelectorAll('body > p')].map((p) => p.textContent),
        source: (document.querySelector('body > plaintext') || {}).textContent,
        hidden: [...document.querySelectorAll('xmp')].every((x) => x.hidden),
        main: !!document.querySelector('main.luccet'),
        wrap: getComputedStyle(document.querySelector('body > plaintext')).whiteSpace,
      }));
      if (r.p.join() !== message) throw new Error(`the message ${JSON.stringify(r.p)}, expected ${JSON.stringify(message)}`);
      if (!r.source || !r.source.trimStart().startsWith(GUARDED_NOTE.trim().split('\n')[0]) || !r.source.includes(GUARDED_NOTE.trim())) throw new Error(`the source shown ${JSON.stringify(r.source)}, expected the note and nothing before it`);
      if (!r.hidden || r.main) throw new Error(`the guard shows itself (${!r.hidden}) or the note mounted (${r.main})`);
      if (r.wrap !== 'pre-wrap') throw new Error(`the source has white-space ${r.wrap}, expected pre-wrap`);
    },
  })),
  {
    name: 'luccet new --lang=fr: the guard speaks French when JavaScript is off, and the rendered note is lang=fr',
    url: '/gen/guarded-fr.html',
    noTern: true,
    context: { javaScriptEnabled: false },
    async setup() {
      cliPage('guarded-fr');
    },
    async check(page) {
      await expect(page, () => document.readyState === 'complete', 'the page to load');
      const r = await page.evaluate(() => ({
        p: [...document.querySelectorAll('body > p')].map((p) => `${p.lang}: ${p.textContent}`),
        lang: (document.querySelector('body > plaintext') || {}).lang,
        meta: ((document.querySelector('body > plaintext') || {}).textContent || '').includes('lang: fr'),
      }));
      if (r.p.join() !== 'fr: JavaScript est désactivé ; voici la source.') throw new Error(`the message ${JSON.stringify(r.p)}`);
      if (r.lang !== 'fr' || !r.meta) throw new Error(`the source is lang=${r.lang} and holds the :::meta lang line: ${r.meta}`);
    },
  },
  {
    name: 'luccet new --lang=fr: rendered, the note is lang=fr from its :::meta and the guard stays inert',
    url: '/gen/guarded-fr.html',
    async setup() {
      cliPage('guarded-fr');
    },
    async check(page) {
      await expect(page, () => (document.querySelector('main.luccet h1') || {}).textContent === 'Smoke: a guarded note', 'the heading in main.luccet');
      const r = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title, xmp: document.querySelectorAll('xmp, plaintext').length, text: document.body.innerText }));
      if (r.lang !== 'fr' || r.title !== 'Une note gardée') throw new Error(`lang ${JSON.stringify(r.lang)}, title ${JSON.stringify(r.title)}`);
      if (r.xmp || /voici la source/.test(r.text)) throw new Error(`the guard acted: ${JSON.stringify(r)}`);
    },
  },
  {
    // A root rendered with safe stays untrusted: a luccet.define registered
    // later, a later render of it without a source, and a render of the page
    // root that holds it run no behaviour on it; a trusted source rendered
    // into it makes it trusted again; listeners get {safe}.
    name: 'safe roots: a late luccet.define, a later render without a source and a render of the page root skip them; render and math listeners get {safe}',
    url: '/test/smoke/basic.html',
    async check(page) {
      const r = await page.evaluate(async () => {
        const calls = [];
        const events = [];
        luccet.on('render', (root, info) => events.push(`${root.id || root.localName}:${info && info.safe}`));
        luccet.on('math', (root, info) => events.push(`math ${root.id || root.localName}:${info && info.safe}`));
        const main = document.querySelector('main.luccet');
        const mk = (id, where) => {
          const d = document.createElement('div');
          d.id = id;
          where.append(d);
          return d;
        };
        const inside = mk('in', main);
        const outside = mk('out', document.body);
        const src = ':::widget{#w data-src=https://evil.example/x}\nx\n:::\n';
        await luccet.render(inside, src, { safe: true, idPrefix: 'u-' });
        await luccet.render(outside, src, { safe: true });
        luccet.define('widget', (el) => calls.push(el.parentElement.id)); // late: the safe roots are skipped
        await luccet.render(inside); // no source: still untrusted
        await luccet.render(main); // the page's root, holding the safe box
        const trusted = mk('ok', document.body);
        await luccet.render(trusted, src);
        await luccet.render(outside, src); // a trusted source makes the root trusted again
        return { calls, events, marked: [...document.querySelectorAll('[data-t-safe]')].map((e) => e.id), prefixed: !!document.getElementById('u-w') };
      });
      if (r.calls.join() !== 'ok,out') throw new Error(`behaviours ran on ${JSON.stringify(r.calls)}, expected the trusted root, then the box rendered again from a trusted source`);
      if (r.marked.join() !== 'in' || !r.prefixed) throw new Error(`marked ${JSON.stringify(r.marked)}, prefixed ${r.prefixed}: expected the box inside main alone, with its id prefixed`);
      const want = ['in:true', 'math in:true', 'out:true', 'math out:true', 'in:true', 'math in:true', 'main:false', 'math main:false', 'ok:false', 'math ok:false', 'out:false', 'math out:false'];
      if (r.events.join() !== want.join()) throw new Error(`events ${JSON.stringify(r.events)}`);
    },
  },
  {
    // Each luccet.render has its own macro table: a \gdef or a :::macros in
    // a root rendered with safe defines nothing for any formula outside it,
    // and a formula there still translates. \href is no command of the
    // engine's (tex.unsupported): no link is ever made from a formula.
    name: 'safe roots: formulas translate under safe, and a \\gdef or :::macros in a safe root reaches no formula outside it',
    url: '/test/smoke/basic.html',
    async check(page) {
      const r = await page.evaluate(async () => {
        const box = document.createElement('div');
        box.className = 'luccet';
        document.body.append(box);
        const boxDiags = await luccet.render(box, ':::macros\n\\gdef\\evil{E}\n:::\n\n$\\gdef\\worse{W}\\worse$, $\\evil$ and $\\href{javascript:alert(1)}{z}$.\n', { safe: true });
        const own = document.createElement('div');
        own.className = 'luccet';
        document.body.append(own);
        const ownDiags = await luccet.render(own, 'Trusted, after the box: $\\evil$ and $\\worse$.\n');
        const state = (root) => [...root.querySelectorAll('.t-math')].map((e) => (e.classList.contains('t-error') ? `error ${e.textContent}` : e.querySelector(':scope > math') ? `mathml ${e.querySelector('math').textContent}` : `other ${e.outerHTML}`));
        return { box: state(box), anchors: box.querySelectorAll('a').length, own: state(own), boxCodes: (boxDiags || []).map((d) => d.code), ownCodes: (ownDiags || []).map((d) => d.code) };
      });
      const box = ['mathml W', 'mathml E', 'error \\href{javascript:alert(1)}{z}'];
      if (JSON.stringify(r.box) !== JSON.stringify(box) || r.anchors) throw new Error(`the safe box ${JSON.stringify(r)}: expected ${JSON.stringify(box)} (its own macros at work, \\href refused), no link`);
      if (JSON.stringify(r.own) !== JSON.stringify(['error \\evil', 'error \\worse'])) throw new Error(`the formulas rendered after the box: ${JSON.stringify(r.own)}, expected both unknown (nothing leaked)`);
      if (r.boxCodes.join() !== 'tex.unsupported' || r.ownCodes.join() !== 'tex.unknown,tex.unknown') throw new Error(`the renders' diagnostics: box ${JSON.stringify(r.boxCodes)}, after it ${JSON.stringify(r.ownCodes)}`);
    },
  },
  // ---- runtime robustness (the remediation plan's Phase 3)
  {
    // A note script that renders a source holding a script runs a nested
    // runScripts; its end must leave the document.write guard in place for
    // the outer scripts still to come, or a later write wipes the page.
    name: 'note scripts: a nested luccet.render with a script keeps the document.write guard, so a later write is reported, not applied',
    url: '/test/smoke/reentry-write.html',
    async check(page, ctx) {
      await expect(page, () => !!document.getElementById('after'), 'the paragraph after the scripts');
      const r = await page.evaluate(() => ({ nested: window.__nested === true, wiped: !!document.getElementById('wiped'), main: !!document.querySelector('main.luccet h1') }));
      if (!r.nested) throw new Error('the nested render did not run its script');
      if (r.wiped || !r.main) throw new Error(`the later document.write reached the page (wiped ${r.wiped}, main ${r.main})`);
      const writes = ctx.diagnostics.filter((d) => d.code === 'script.document-write');
      if (writes.length !== 1) throw new Error(`${writes.length} script.document-write diagnostics, expected 1`);
    },
  },
  {
    // Rendering a root again from a source retires what its scripts
    // registered, so a live preview does not stack a registration per edit;
    // {scripts: false} runs none.
    name: 'luccet.render again: the previous render\'s define, on and style registrations are retired; {scripts: false} runs no script',
    url: '/test/smoke/rerender.html',
    async check(page) {
      const r = await page.evaluate(async () => {
        const main = document.querySelector('main.luccet');
        const src = (await (await fetch(location.href)).text()).replace(/^[^\n]*\n/, ''); // the note: the file after its first line
        const count = () => ({ runs: window.__runs, applied: window.__applied, renders: window.__renders, styles: [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('.probe')).length });
        const out = [count()];
        for (let i = 0; i < 3; i++) {
          await luccet.render(main, src);
          out.push(count());
        }
        await luccet.render(main, src, { scripts: false });
        out.push(count());
        return out;
      });
      const want = [[1, 1, 1, 1], [2, 2, 2, 1], [3, 3, 3, 1], [4, 4, 4, 1], [4, 4, 4, 0]];
      const got = r.map((c) => [c.runs, c.applied, c.renders, c.styles]);
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`[runs, applied, renders, styles] per render: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    },
  },
  {
    // An add-on that never answers no longer leaves a blank page: after the
    // deadline (luccet.config.addonTimeout, 12 s by default) the note mounts
    // with addon.failed, and the console says what is still awaited at 2 s.
    name: 'an add-on that never loads: the note mounts at the deadline with addon.failed, after a console line at 2 s; aria-busy until then',
    url: '/test/smoke/addon-slow.html',
    waitUntil: 'domcontentloaded', // the pending add-on holds the load event back
    readyTimeout: 15000,
    timeout: 40000,
    init: () => {
      // Sample aria-busy while the add-on is awaited.
      document.addEventListener('DOMContentLoaded', () => setTimeout(() => (window.__busy = document.documentElement.getAttribute('aria-busy')), 500));
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({ h1: !!document.querySelector('main.luccet h1'), busy: window.__busy, busyNow: document.documentElement.getAttribute('aria-busy') }));
      if (!r.h1) throw new Error('the note did not mount');
      if (r.busy !== 'true' || r.busyNow !== null) throw new Error(`aria-busy was ${JSON.stringify(r.busy)} while waiting and is ${JSON.stringify(r.busyNow)} after the mount`);
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed');
      if (failed.length !== 1 || !/never\.js did not load in 3 s/.test(failed[0].message)) throw new Error(`addon.failed: ${JSON.stringify(failed.map((d) => d.message))}`);
      if (!ctx.console.some((m) => m.type === 'warning' && /still waiting for 1 add-on to load: \/gen\/never\.js/.test(m.text))) throw new Error(`no "still waiting" line; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
    },
  },
  {
    name: 'an add-on listed in data-use twice and in :::use loads and runs once',
    url: '/test/smoke/addon-twice.html',
    async check(page, ctx) {
      const r = await page.evaluate(() => ({ ran: window.__addon, scripts: document.querySelectorAll('script[src$="/gen/addon.js"]').length }));
      if (r.ran !== 1 || r.scripts !== 1) throw new Error(`the add-on ran ${r.ran} time(s) from ${r.scripts} script element(s), expected once from one`);
      if (ctx.diagnostics.length) throw new Error(`diagnostics ${JSON.stringify(ctx.diagnostics)}`);
    },
  },
  {
    name: 'a data-css stylesheet that fails to load is addon.failed; the note still mounts',
    url: '/test/smoke/css-missing.html',
    allowConsole: /Failed to load resource|MIME type/,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.luccet h1'), 'mounted');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed');
      if (failed.length !== 1 || !/\/nope\/luccet\.css \(data-css\) did not load/.test(failed[0].message)) throw new Error(`addon.failed: ${JSON.stringify(failed.map((d) => d.message))}`);
    },
  },
  // The support floor: a browser without what the runtime needs gets the
  // source, readable, with a line that says why, instead of a half-rendered
  // page and an uncaught error. Simulated by taking one of its needs away:
  // replaceChildren (Chrome 86), or MathMLElement, which stands for MathML
  // layout (Chrome 109), as the formulas are MathML.
  ...[
    ['Element.prototype.replaceChildren', () => delete Element.prototype.replaceChildren],
    ['MathMLElement', () => delete window.MathMLElement],
  ].map(([what, init]) => ({
    name: `a browser below the support floor (no ${what}) is shown the source with a message, and no error`,
    url: '/test/smoke/basic.html',
    noTern: true,
    init,
    async check(page, ctx) {
      await page.waitForLoadState('load');
      const r = await page.evaluate(() => ({ gone: typeof window.MathMLElement !== 'function' || typeof Element.prototype.replaceChildren !== 'function', plaintext: !!document.querySelector('plaintext'), main: !!document.querySelector('main.luccet'), message: /too old for luccet\.js \(it needs Chrome 109, Firefox 78, Safari 14 or newer\)/.test(document.body.textContent), source: /Smoke: basic/.test(document.querySelector('plaintext') ? document.querySelector('plaintext').textContent : '') }));
      if (!r.gone) throw new Error(`${what} is still there: the simulation did not take`);
      if (!r.plaintext || r.main || !r.message || !r.source) throw new Error(JSON.stringify(r));
      if (!ctx.console.some((m) => m.type === 'warning' && /lacks what luccet\.js needs \(Chrome 109/.test(m.text))) throw new Error(`no warning; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
    },
  })),
];

async function expect(page, fn, what, timeout = 8000, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(`expected ${what}`);
  }
}

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch {}
  }
  return null;
}

async function runTest(browser, origin, t) {
  const context = await browser.newContext(t.context || {});
  const consoleErrors = [];
  const ctx = {
    browser: browser.browserType().name(),
    origin,
    diagnostics: [],
    cspViolations: [],
    console: [],
    notes: [],
    step: 'opening the page',
    note: (line) => ctx.notes.push(line),
    skip: (why) => {
      throw new Skip(why);
    },
  };
  const run = (async () => {
    if (t.offline) await context.route((url) => url.origin !== origin, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
    const page = await context.newPage();
    page.on('console', (m) => {
      ctx.console.push({ type: m.type(), text: m.text() });
      if (m.type() === 'error' && !(t.allowConsole && t.allowConsole.test(m.text()))) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    if (t.init) await page.addInitScript(t.init);
    if (t.setup) await t.setup(context, page, ctx);
    await page.goto(origin + t.url, { waitUntil: t.waitUntil || 'load', timeout: t.readyTimeout || 30000 });
    if (!t.noTern) await waitForReady(page, t, ctx);
    ctx.step = 'checking';
    await t.check(page, ctx);
    if (!t.expectConsoleErrors && consoleErrors.length) throw new Error(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
  })();
  run.catch(() => {}); // after a timeout, closing the context rejects what was pending
  const ms = t.timeout || DEFAULT_TIMEOUT;
  let timer;
  try {
    await Promise.race([run, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s while ${ctx.step}`)), ms)))]);
  } catch (e) {
    if (!(e instanceof Skip) && consoleErrors.length && !/^console errors/.test(e.message)) e.message += ` [console: ${consoleErrors.slice(0, 2).join(' | ').slice(0, 300)}]`;
    e.notes = ctx.notes;
    throw e;
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
  return ctx.notes;
}

// luccet.ready settles; ctx gets luccet.diagnostics and the CSP violations.
async function waitForReady(page, t, ctx) {
  ctx.step = 'waiting for luccet.ready';
  try {
    await page.waitForFunction(() => window.luccet && window.luccet.ready, null, { timeout: t.readyTimeout || 10000 });
  } catch {
    const seen = await page.evaluate(() => (window.luccet ? `window.luccet has ${Object.keys(window.luccet).slice(0, 8).join(', ')}…` : 'window.luccet is undefined')).catch(() => '');
    throw new Error(`expected window.luccet.ready (the runtime); ${seen}`);
  }
  await page.evaluate(() => window.luccet.ready.then(() => (window.__luccetReady = 'yes'), (e) => (window.__luccetReady = `rejected: ${e}`)));
  await expect(page, () => window.__luccetReady, 'luccet.ready to settle', t.readyTimeout || 10000);
  const settled = await page.evaluate(() => window.__luccetReady);
  if (settled !== 'yes') throw new Error(`luccet.ready ${settled}`);
  ctx.diagnostics = await page.evaluate(() => JSON.parse(JSON.stringify(window.luccet.diagnostics || [])));
  ctx.cspViolations = await page.evaluate(() => window.__csp);
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log('✗ playwright is not installed: npm install && npx playwright install chromium firefox');
    process.exit(2);
  }
  const cdn = await serve(cdnHandler);
  const site = await serve(staticHandler(cdn.origin));
  const count = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const notes = (lines) => (lines || []).forEach((l) => console.log(`      ${l}`));
  try {
    for (const name of BROWSERS) {
      let browser;
      try {
        browser = await pw[name].launch({ headless: !args.includes('--headed') });
      } catch (e) {
        count.failed++;
        console.log(`✗ ${name}: cannot launch (${e.message.split('\n')[0]}); npx playwright install ${name}`);
        continue;
      }
      console.log(`${name} ${browser.version()}`);
      for (const t of TESTS) {
        if (FILTER && !t.name.includes(FILTER)) continue;
        if (t.browsers && !t.browsers.includes(name)) continue;
        if (t.todo) {
          count.todo++;
          console.log(`  · ${t.name} (todo: ${t.todo})`);
          continue;
        }
        try {
          const lines = await runTest(browser, site.origin, t);
          count.passed++;
          console.log(`  ✓ ${t.name}`);
          notes(lines);
        } catch (e) {
          if (e instanceof Skip) {
            count.skipped++;
            console.log(`  - ${t.name} (skipped: ${e.message})`);
            continue;
          }
          count.failed++;
          console.log(`  ✗ ${t.name}: ${e.message.split('\n')[0]}`);
          notes(e.notes);
        }
      }
      await browser.close();
    }
  } finally {
    site.server.close();
    cdn.server.close();
  }
  const extra = [count.skipped && `${count.skipped} skipped`, count.todo && `${count.todo} todo`].filter(Boolean).join(', ');
  console.log(`\n${count.failed ? `${count.failed} failure(s), ` : ''}${count.passed} passed${extra ? `; ${extra}` : ''}`);
  process.exit(count.failed ? 1 : 0);
}

main();
