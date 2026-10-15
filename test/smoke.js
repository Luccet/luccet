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
//   /gen/fragment.html   two closed <details> below the fold (fragment tests)
//   /gen/built.html      test/smoke/built.html through `tern build`;
//                        built-katex.html with --katex; guarded.html from
//                        `tern new --guarded`; built-own-schema.html,
//                        built-note-config.html, built-addon-throws.html
//                        and built-poster.html are test/smoke/own-schema.html,
//                        note-config.html, addon-throws.html and
//                        poster.html built
//   /gen/poster.png      a 1-pixel PNG, poster.html's poster
//   /gen/indexed/…       a copy of test/smoke/search/ after `tern index`
//                        ran in it: notes.json and search.json beside the
//                        notes, for the notes add-on and ::search{index=}
//   {{CDN}}              in test/smoke/*.html: a second, slow origin (a "CDN")
//   /test/samples/…      tern.js and tern.css resolve to the
//                        repository's; images, videos and component scripts
//                        the samples name but the repository lacks get
//                        stand-ins, so the console-error check sees Tern's
//                        errors and not 404s
//   index.html, docs/,   the documentation: files a page's live
//   examples/            examples name but the repository lacks get the same
//                        stand-ins, listed in that page's report
//
// KaTeX is served from a local copy: requests for cdn.jsdelivr.net/npm/
// katex@X.Y.Z/dist/… are answered from node_modules/.cache/tern-smoke/,
// filled once from the npm registry (tarball checked against its sha512) for
// the version the page asks for. The bytes are the ones jsDelivr serves, so
// SRI still applies, and runs are deterministic and work offline after the
// first. highlight.js, for addons/code.js, and Mermaid, for
// addons/mermaid.js, are served the same way from the copies tools/hljs.js
// and tools/mermaid.js keep there. --live-cdn uses the real CDN instead; so
// does any request the cache cannot answer.
//
// Each test has a timeout (30 s unless it says otherwise). A test can skip
// itself with a reason (a missing tool); skips are reported, not failed.
//
//   node test/smoke.js [--browsers=chromium,firefox] [--filter=TEXT] [--headed] [--live-cdn]
//
// TERN_JS=FILE serves FILE as /tern.js (and for the samples' tern.js), to
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
const LIVE_CDN = args.includes('--live-cdn');
const DEFAULT_TIMEOUT = 30000;
const TERN_JS = process.env.TERN_JS ? path.resolve(process.env.TERN_JS) : path.join(ROOT, 'tern.js');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:";
const NONCE = 'tern-smoke-nonce';
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
  if (['tern.js', 'tern.css'].includes(base) && fs.existsSync(path.join(ROOT, base))) return { file: path.join(ROOT, base) };
  const ext = path.extname(file);
  if (ext === '.svg') return { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#ccc"/></svg>' };
  if (/^\.(png|jpe?g|gif|webp)$/.test(ext)) return { type: 'image/png', body: PNG_1PX };
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
// (`<script src="tern.js">`). Those requests get the samples' stand-ins,
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
    if (url.startsWith('/gen/') && GENERATED[url.slice(5)]) {
      const [type, body] = GENERATED[url.slice(5)]();
      res.writeHead(200, { 'Content-Type': /^text\/|javascript/.test(type) ? `${type}; charset=utf-8` : type });
      res.end(body);
      return;
    }
    let file = path.join(ROOT, path.normalize(url));
    // Local copies of highlight.js and Mermaid, for the add-ons' ?base=.
    if (url.startsWith('/vendor/highlightjs/')) file = path.join(CACHE, `highlightjs-${HLJS_VERSION}`, path.normalize(url.slice('/vendor/highlightjs/'.length)));
    if (url.startsWith('/vendor/mermaid/')) file = path.join(CACHE, `mermaid-${MERMAID_VERSION}`, 'dist', path.normalize(url.slice('/vendor/mermaid/'.length)));
    if (url.startsWith('/vendor/temml/')) file = path.join(CACHE, `temml-${TEMML_VERSION}`, 'dist', path.normalize(url.slice('/vendor/temml/'.length)));
    // The search fixtures with the files `tern index` writes beside them.
    if (url.startsWith('/gen/indexed/')) file = path.join(indexedDir(), path.normalize(url.slice('/gen/indexed/'.length)));
    // A sample's add-ons (addons/katex.js …) resolve to the repository's, as tern.js does.
    if (url.startsWith('/test/samples/addons/')) file = path.join(ROOT, 'addons', path.normalize(url.slice('/test/samples/addons/'.length)));
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
    if (file === path.join(ROOT, 'tern.js')) file = TERN_JS;
    if ((file !== TERN_JS && !file.startsWith(ROOT) && !(INDEXED && file.startsWith(INDEXED))) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
// (1,120 formulas, 28 %). 3,440 inline and 560 display. The note script
// records when 'render' and 'math' fire.
function mathNote(sections = 80) {
  const kinds = ['theorem', 'definition', 'lemma', 'example', 'details', 'details', 'remark'];
  const out = [
    '<!doctype html><meta charset="utf-8"><script src="/tern.js" data-use="/addons/katex.js"></script>',
    '',
    '<script>',
    "  window.__t = { script: performance.now() };",
    "  tern.on('render', () => { window.__t.render = performance.now(); });",
    "  tern.on('math', () => { window.__t.math = performance.now(); });",
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
    '<!doctype html><meta charset="utf-8"><script src="/tern.js" data-use="/addons/katex.js"></script>',
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
    ':::details[Closed, with math to typeset on toggle]{#fold}',
    'Inline $e^{i\\pi} + 1 = 0$ and display:',
    '',
    '$$ \\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6} $$',
    ':::',
    '',
  ].join('\n');
}

// A leading `:::use` block, then enough prose that the file arrives in many
// chunks on a slow network: the runtime must find the block in the first.
function useLongNote() {
  const filler = Array.from({ length: 2500 }, (_, i) => `Paragraph ${i + 1}: enough prose to make the file arrive in many network chunks on Slow 3G, so that the leading block is read long before the end.`).join('\n\n');
  return ['<!doctype html><meta charset="utf-8"><script src="/tern.js"></script>', '', ':::use', '/addons/katex.js', ':::', '', '# Smoke: a long note with a leading :::use', '', 'A formula $x^2$ near the top.', '', filler, ''].join('\n');
}

const GENERATED = {
  'big.js': () => ['text/javascript', pad(260) + "window.order = (window.order || []).concat('external');\n"],
  'addon.js': () => ['text/javascript', pad(20) + 'window.__addon = (window.__addon || 0) + 1;\n'],
  'addon.css': () => ['text/css', pad(6) + '.tern { outline-color: currentColor; }\n'],
  'math4000.html': () => ['text/html', mathNote()],
  'fragment.html': () => ['text/html', fragmentNote()],
  'built.html': () => ['text/html', cliPage('built')],
  'built-katex.html': () => ['text/html', cliPage('built-katex')],
  'built-mathml.html': () => ['text/html', cliPage('built-mathml')],
  'use-long.html': () => ['text/html', useLongNote()],
  'built-missing.html': () => ['text/html', cliPage('built-missing')],
  'built-own-schema.html': () => ['text/html', cliPage('built-own-schema')],
  'built-note-config.html': () => ['text/html', cliPage('built-note-config')],
  'built-addon-throws.html': () => ['text/html', cliPage('built-addon-throws')],
  'built-poster.html': () => ['text/html', cliPage('built-poster')],
  'poster.png': () => ['image/png', PNG_1PX],
  'guarded.html': () => ['text/html', cliPage('guarded')],
};

// ---- pages written by the command line

// `tern build` and `tern new --guarded`, run once per page; a test's setup
// calls cliPage first, so a failure fails that test. built-katex.html
// pre-renders with the local KaTeX copy (below) as the `katex` package, on
// NODE_PATH: the setup awaits katexDist first.
const CLI = path.join(ROOT, 'tern-cli.js');
const KATEX_VERSION = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'addons', 'katex.js'), 'utf8'))[1];
const GUARDED_NOTE = '# Smoke: a guarded note\n\nRendered by tern.js, or shown as its source when tern.js does not load.\n';
const cliPages = new Map();

// test/smoke/search/ copied to a temporary folder and indexed there with
// `tern index`, so notes.json and search.json sit beside the notes without
// being written into the repository; served as /gen/indexed/. Once.
let INDEXED = null;
function indexedDir() {
  if (INDEXED) return INDEXED;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tern-smoke-indexed-')), 'search');
  fs.cpSync(path.join(ROOT, 'test', 'smoke', 'search'), dir, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, 'index', dir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  if (r.status !== 0) throw new Error(`tern index exited ${r.status}: ${r.stderr.trim()}`);
  INDEXED = dir;
  return dir;
}

function cliPage(name) {
  if (cliPages.has(name)) return cliPages.get(name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-smoke-cli-'));
  const cli = (args, env) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', ...env } });
    if (r.status !== 0) throw new Error(`tern ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  try {
    let html;
    if (name === 'built') html = cli(['build', 'test/smoke/built.html']);
    else if (/^built-(?:own-schema|note-config|addon-throws|poster)$/.test(name)) html = cli(['build', `test/smoke/${name.slice(6)}.html`]);
    else if (name === 'built-missing') {
      const file = path.join(tmp, 'missing.html');
      fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><script src="/tern.js" data-use="/test/smoke/missing-addon.js /test/smoke/missing-addon.css"></script>\n# Smoke: a built page whose add-ons are missing\n');
      html = cli(['build', file]);
    } else if (name === 'built-katex') {
      const pkg = path.join(tmp, 'node_modules', 'katex');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'katex', version: KATEX_VERSION, main: 'dist/katex.js' }));
      fs.symlinkSync(path.join(CACHE, `katex-${KATEX_VERSION}`, 'dist'), path.join(pkg, 'dist'), 'dir');
      html = cli(['build', 'test/smoke/built.html', '--katex'], { NODE_PATH: path.join(tmp, 'node_modules') });
      if (!/<script data-built src=/.test(html)) throw new Error('tern build --katex left formulas to tern.js');
    } else if (name === 'built-mathml') {
      const pkg = path.join(tmp, 'node_modules', 'temml');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'temml', version: TEMML_VERSION, main: 'dist/temml.cjs' }));
      fs.symlinkSync(path.join(CACHE, `temml-${TEMML_VERSION}`, 'dist'), path.join(pkg, 'dist'), 'dir');
      html = cli(['build', 'test/smoke/built.html', '--math=mathml'], { NODE_PATH: path.join(tmp, 'node_modules') });
      if (!/<math\b/.test(html)) throw new Error('tern build --math=mathml did not pre-render MathML');
    } else {
      const file = path.join(tmp, 'guarded.html');
      cli(['new', file, '--guarded', '--tern=/tern.js']);
      html = fs.readFileSync(file, 'utf8') + GUARDED_NOTE;
    }
    cliPages.set(name, html);
    return html;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- KaTeX, highlight.js and Mermaid from local copies

const npm = require('../tools/npm');
const CACHE = npm.CACHE;
const KATEX_URL = /^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@(\d+\.\d+\.\d+)\/(dist\/[^?#]+)/;
const HLJS_URL = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@highlightjs\/cdn-assets@(\d+\.\d+\.\d+)\/([^?#]+)/;
const HLJS_VERSION = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'addons', 'code.js'), 'utf8'))[1];
const MERMAID_URL = /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@(\d+\.\d+\.\d+)\/([^?#]+)/;
const MERMAID_VERSION = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'addons', 'mermaid.js'), 'utf8'))[1];
const TEMML_VERSION = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'addons', 'mathml.js'), 'utf8'))[1];

// A package's folder in node_modules/.cache/tern-smoke/, filled once
// (tools/npm.js); null if it cannot be fetched (offline on the first run).
const dirs = new Map();
function cached(label, packageDir, version) {
  if (!dirs.has(`${label}@${version}`))
    dirs.set(
      `${label}@${version}`,
      packageDir(version).catch((e) => {
        console.log(`    (${label} ${version} not cached, using the live CDN: ${e.message})`);
        return null;
      }),
    );
  return dirs.get(`${label}@${version}`);
}
// katex-X.Y.Z/dist/; highlightjs-X.Y.Z/, the package (tools/hljs.js);
// mermaid-X.Y.Z/dist/mermaid.min.js (tools/mermaid.js).
const katexDist = (v) => cached('KaTeX', (version) => npm.packageDir('katex', version, { folder: `katex-${version}`, keep: ['dist/'], has: 'dist/katex.min.js' }), v);
const hljsDir = (v) => cached('highlight.js', require('../tools/hljs').packageDir, v);
const mermaidDir = (v) => cached('Mermaid', require('../tools/mermaid').packageDir, v);
const temmlDir = (v) => cached('Temml', require('../tools/temml').packageDir, v);

// Answers a package's CDN requests from its copy, as routeKatex below does KaTeX's.
async function routeCached(context, re, dirOf) {
  await context.route(
    (url) => re.test(url.href),
    async (route) => {
      const [, version, rel] = re.exec(route.request().url());
      const dir = await dirOf(version);
      const file = dir && path.join(dir, path.normalize(rel));
      if (!file || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) return route.continue();
      await route
        .fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } })
        .catch(() => {}); // the context closed
    },
  );
}

// Answers KaTeX requests from the cache. ctx.cdnDelay(bytes), when set,
// holds each response back as a throttled network would: CDP throttling
// does not apply to responses fulfilled by a route (measured: 12 ms instead
// of 1.4 s for 50 KB at 400 kbit/s), so the waterfall test sets it.
async function routeKatex(context, ctx) {
  await context.route(
    (url) => KATEX_URL.test(url.href),
    async (route) => {
      const [, version, rel] = KATEX_URL.exec(route.request().url());
      const dir = await katexDist(version);
      const file = dir && path.join(dir, path.normalize(rel));
      if (!file || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) return route.continue();
      const body = fs.readFileSync(file);
      if (ctx.cdnDelay) await new Promise((r) => setTimeout(r, ctx.cdnDelay(body.length)));
      await route
        .fulfill({
          status: 200,
          body,
          headers: {
            'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Timing-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
        .catch(() => {}); // the context closed while we waited
    },
  );
}

// ---- measurement helpers

// Slow 3G: 400 kbit/s each way, 400 ms round trip.
const SLOW_3G = { latency: 400, bytesPerSecond: (400 * 1000) / 8 };
const STAGE_TOL = 25; // ms

// Serial stages: a page loads in three, HTML → tern.js ∥ add-ons ∥ KaTeX
// preload → mount. The document is stage 1.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-smoke-'));
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

// Every formula outside a closed <details> rendered by KaTeX ('ready' comes
// after 'math'; closed details render on toggle).
const MATH_STATE = () => {
  const all = [...document.querySelectorAll('main.tern .t-math')];
  const shown = all.filter((e) => !e.closest('details:not([open])'));
  const rendered = shown.filter((e) => e.querySelector('.katex'));
  return { all: all.length, shown: shown.length, rendered: rendered.length, firstMissing: (shown.find((e) => !e.querySelector('.katex')) || {}).outerHTML };
};

// Formulas under node, for the sample-notes test.
function mathCountUnderNode(file) {
  try {
    const tern = require(TERN_JS);
    const src = fs.readFileSync(file, 'utf8').replace(/^[^\n]*\n/, '');
    return (tern.toHTML(src).match(/class="t-math[ "]/g) || []).length;
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
  // docs.js typesets an example's math itself: .docs-math until then, .t-math after
  const math = outs.flatMap((o) => [...o.querySelectorAll('.t-math, .docs-math')]);
  const panel = document.querySelector('.t-diagnostics');
  const listed = (window.ternDocs ? window.ternDocs.pages.concat(window.ternDocs.examples) : []).some(([p]) => location.pathname.endsWith(`/${p}`) || (p === 'index.html' && location.pathname.endsWith('/')));
  return {
    main: !!document.querySelector('main.tern'),
    nav: document.querySelectorAll('main.tern > nav.site-nav[aria-label] a[href]').length,
    current: document.querySelectorAll('nav.site-nav [aria-current="page"]').length,
    listed,
    toc: !!document.querySelector('main.tern nav.toc:not(.docs-live-out *)'),
    widgets: document.querySelectorAll('.docs-live').length,
    results: outs.length,
    failed: [...document.querySelectorAll('.docs-live-failed .docs-live-problem')].map((p) => p.textContent),
    mismatched: [...document.querySelectorAll('.docs-live-mismatch .docs-live-problem')].map((p) => p.textContent),
    scripts: document.querySelectorAll('.docs-live-out script').length,
    math: math.length,
    // typeset, or rejected by KaTeX: the TeX stays, with t-error (an example
    // may show a formula KaTeX refuses; it is listed in the example)
    typeset: math.filter((m) => m.querySelector('.katex') || m.classList.contains('t-error')).length,
    rejected: math.filter((m) => m.classList.contains('t-error')).length,
    untypeset: (math.find((m) => !m.querySelector('.katex') && !m.classList.contains('t-error')) || {}).outerHTML,
    duplicates: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
    diagnostics: (window.tern.diagnostics || []).map((d) => `${d.code} at ${d.position && d.position.start ? `${d.position.start.line}:${d.position.start.column}` : 'the head'}: ${d.message}`),
    panel: !!panel && panel.getClientRects().length > 0,
  };
};

// Each example's :::macros are its own: a formula that uses a macro its
// example defines typesets; one that uses a macro only another example
// defines does not; and none reaches the page's macro table, probed through
// the runtime itself (tern.render on formulas that use them; run last, as
// the probe's failures are the page's diagnostics).
const MACRO_STATE = async () => {
  const K = window.katex;
  if (!K) return { skipped: 'KaTeX did not load' };
  const names = (tex) => [...tex.matchAll(/\\(?:(?:re|provide)?newcommand\*?\s*\{?\s*|[gex]?def\s*)(\\[A-Za-z]+)/g)].map((m) => m[1]);
  const builtin = (n) => {
    try {
      K.renderToString(n, { throwOnError: true });
      return true;
    } catch {
      return false;
    }
  };
  const uses = (tex, n) => new RegExp(`${n.replace(/\\/g, '\\\\')}(?![A-Za-z])`).test(tex);
  const widgets = [...document.querySelectorAll('.docs-live')];
  const defs = widgets.map((w) => new Set([...w.querySelectorAll('.docs-live-out .docs-macros')].flatMap((m) => names(m.textContent)).filter((n) => !builtin(n))));
  const broken = widgets.map((w) => [...w.querySelectorAll('.docs-diag[data-code="math.error"] .docs-msg')].some((m) => /:::macros block does not parse/.test(m.textContent)));
  const problems = [];
  let used = 0;
  let foreign = 0;
  widgets.forEach((w, i) => {
    for (const f of w.querySelectorAll('.docs-live-out .t-math, .docs-live-out .docs-math')) {
      const tex = f.getAttribute('data-tex') || '';
      for (const n of defs[i]) {
        if (!uses(tex, n)) continue;
        used++;
        if (!broken[i] && !f.querySelector('.katex')) problems.push(`example ${i + 1}: ${n}, from its own :::macros, does not typeset in ${tex}`);
      }
      widgets.forEach((_, j) => {
        if (j === i) return;
        for (const n of defs[j]) {
          if (defs[i].has(n) || !uses(tex, n)) continue;
          foreign++;
          if (f.querySelector('.katex')) problems.push(`example ${i + 1} typesets ${n}, which only example ${j + 1} defines`);
        }
      });
    }
  });
  const own = new Set([...document.querySelectorAll('main.tern .t-macros')].flatMap((m) => names(m.textContent)));
  const probe = [...new Set(defs.flatMap((d) => [...d]))].filter((n) => !own.has(n));
  if (probe.length) {
    const div = document.createElement('div');
    for (const n of probe) div.append(Object.assign(document.createElement('span'), { className: 't-math', textContent: n }));
    document.querySelector('main.tern').append(div);
    await window.tern.render(div);
    [...div.children].forEach((f, k) => f.querySelector('.katex') && problems.push(`${probe[k]}, from an example's :::macros, reached the page's macros`));
    div.remove();
  }
  return { problems, defined: defs.reduce((a, d) => a + d.size, 0), used, foreign, probed: probe.length };
};

// The checks every documentation page must pass; `want` is the number of
// live examples node finds in it. Returns the state, for notes.
async function checkDocsPage(page, { docs, want }) {
  await expect(page, () => !!document.querySelector('main.tern'), 'main.tern');
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
  if (s.typeset !== s.math) problems.push(`${s.math - s.typeset} of ${s.math} formulas in example results not typeset; first: ${String(s.untypeset).slice(0, 160)}`);
  if (s.duplicates.length) problems.push(`duplicate ids: ${s.duplicates.slice(0, 5).join(', ')}`);
  if (s.diagnostics.length) problems.push(`tern.diagnostics has ${s.diagnostics.length}, expected none: ${s.diagnostics[0]}`);
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
    name: `docs: ${p.rel} renders with zero console errors${p.docs ? ', a site nav and a toc' : ''}; every live example has a result; math in results is typeset`,
    url: `/${p.rel}`,
    offline: true,
    async check(page, ctx) {
      const x = examples.extract(p.text, p.file);
      const want = x ? x.examples.length : 0;
      const s = await checkDocsPage(page, { docs: p.docs, want });
      ctx.note(`${want} live example(s), ${s.math} formula(s) in their results${s.rejected ? ` (${s.rejected} rejected by KaTeX)` : ''}${p.docs ? `, ${s.nav} site links` : ''}`);
      if (s.macros.defined) ctx.note(`${s.macros.defined} macro(s) defined in examples: ${s.macros.used} use(s) typeset, ${s.macros.foreign} use(s) from other examples refused, ${s.macros.probed} kept from the page`);
      const stood = [...(docStandIns.get(`/${p.rel}`) || [])].map((u) => path.posix.relative(path.posix.dirname(`/${p.rel}`), u));
      if (stood.length) ctx.note(`stand-ins for ${stood.length} missing file(s) its examples name: ${stood.sort().join(', ')}`);
    },
  }));
  if (!pages.length) tests.push({ name: 'docs: the documentation pages render', todo: 'no pages yet in index.html, docs/ or examples/' });
  tests.push({
    name: 'docs: docs.js live examples: ids prefixed, scripts shown not run, styles scoped, math and macros isolated, diagnostics linked, Tern highlighted',
    url: '/test/smoke/docs-live.html',
    async check(page) {
      await checkDocsPage(page, { docs: true, want: 8 });
      await page.evaluate(() => document.querySelector('.docs-live-out button').click());
      const r = await page.evaluate(() => {
        const out = [...document.querySelectorAll('.docs-live-out')];
        const styled = out[3].querySelector('p');
        const pagePara = [...document.querySelectorAll('main.tern > p')].find((p) => /page paragraph/.test(p.textContent));
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
          math: out[0].querySelectorAll('.t-math .katex').length + out[2].querySelectorAll('.t-math .katex').length,
          ref: (out[2].querySelector('a.t-ref') || {}).textContent,
          refHref: (out[2].querySelector('a.t-ref') || {}).getAttribute?.('href'),
          diag: [...document.querySelectorAll('.docs-live')[1].querySelectorAll('.docs-diags a')].map((a) => a.getAttribute('href')),
          titled: !!document.querySelectorAll('.docs-live')[4].querySelector('.docs-live-source figure figcaption'),
          nav: (document.querySelector('nav.site-nav .docs-nav-list a') || {}).getAttribute?.('href'),
          tern: document.querySelectorAll('code.docs-tern .tk-mark, code.docs-tern .tk-name, code.docs-tern .tk-attr, code.docs-tern .tk-math').length,
          html: (document.querySelector('.docs-live-html') || {}).textContent || '',
          // the math examples: 6 defines \RR and uses it, 7 uses it without, 8 has a bad :::macros and a bad formula
          own: [...out[5].querySelectorAll('.t-math, .docs-math')].map((f) => `${f.className}${f.querySelector('.katex') ? ' katex' : ''} ${f.getAttribute('data-tex').trim()}`),
          macrosHidden: getComputedStyle(out[5].querySelector('.docs-macros')).display,
          runtimeMacros: document.querySelectorAll('.docs-live-out .t-macros').length,
          other: [...out[6].querySelectorAll('.t-math, .docs-math')].map((f) => `${f.className}${f.querySelector('.katex') ? ' katex' : ''}`),
          codes: [5, 6, 7].map((i) => [...document.querySelectorAll('.docs-live')[i].querySelectorAll('.docs-diag')].map((d) => `${d.dataset.code} ${d.querySelector('.docs-pos').textContent}`)),
          errorLink: (document.querySelectorAll('.docs-live')[7].querySelector('.docs-diag[data-code="math.error"] a') || {}).getAttribute?.('href'),
          label: (document.querySelectorAll('.docs-live')[7].querySelector('.docs-live-diagnostics .docs-live-label') || {}).textContent,
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
      if (r.math !== 3) problems.push(`${r.math} typeset formulas in results 1 and 3, expected 3`);
      if (r.ref !== 'Theorem 1' || r.refHref !== '#ex3-rn') problems.push(`the demo-schema reference reads ${JSON.stringify(r.ref)} → ${r.refHref}`);
      if (JSON.stringify(r.diag) !== JSON.stringify(['../../docs/diagnostics.html#block-unclosed', '../../docs/diagnostics.html#attr-malformed'])) problems.push(`diagnostic links ${JSON.stringify(r.diag)}`);
      if (!r.titled) problems.push('the titled example lost its figure and caption');
      if (r.nav !== '../../docs/guide.html') problems.push(`the site nav's first link is ${r.nav}, expected ../../docs/guide.html`);
      if (r.tern < 10) problems.push(`only ${r.tern} highlighted Tern tokens`);
      if (!/^<p>A <em>short<\/em> example/.test(r.html) || !/\n<section class="t-footnotes">\n {2}<ol>\n {4}<li id="fn-a">/.test(r.html)) problems.push(`the HTML pane: ${JSON.stringify(r.html.slice(0, 300))}`);
      const own = ['t-math katex f\\colon \\RR \\to \\RR', 't-math katex \\RR^2'];
      if (JSON.stringify(r.own) !== JSON.stringify(own)) problems.push(`the example's own macro: ${JSON.stringify(r.own)}, expected ${JSON.stringify(own)} (typeset .t-math with data-tex, for copy)`);
      if (r.macrosHidden !== 'none' || r.runtimeMacros) problems.push(`:::macros in a result: display ${r.macrosHidden}, ${r.runtimeMacros} left as .t-macros for the runtime`);
      if (JSON.stringify(r.other) !== JSON.stringify(['docs-math t-error'])) problems.push(`another example's macro: ${JSON.stringify(r.other)}, expected one formula KaTeX rejects`);
      const codes = [[], ['math.error 1:28'], ['math.error 1:1', 'math.error 5:26']];
      if (JSON.stringify(r.codes) !== JSON.stringify(codes)) problems.push(`the examples' diagnostics ${JSON.stringify(r.codes)}, expected ${JSON.stringify(codes)}`);
      if (r.errorLink !== '../../docs/diagnostics.html#math-error' || r.label !== 'Diagnostics (2)') problems.push(`math.error in the example: ${r.errorLink}, ${r.label}`);
      if (problems.length) throw new Error(problems.join(' | '));
    },
  });
  return tests;
})();

// ---- tests

// Each test opens `url` and runs `check(page, ctx)`; ctx.diagnostics holds
// tern.diagnostics after ready, ctx.console every console message, ctx.browser
// the browser's name, and ctx.note(line) adds a line to the report.
// `browsers` limits where it runs; `todo` lists what is still to build for it
// (reported, not run). Optional: `timeout` (whole test), `readyTimeout`,
// `waitUntil` for page.goto, `init` (an init script), `setup(context, page,
// ctx)` before navigation, `offline` (stub every request to another origin
// except KaTeX), `allowConsole` (a RegExp for the console errors the test
// provokes), `expectConsoleErrors` (allow any), `context` (browser context
// options), `noTern` (the page runs without tern.js: no wait for tern.ready).
const TESTS = [
  {
    name: 'basic note mounts in place, math renders, refs resolve',
    url: '/test/smoke/basic.html',
    async check(page) {
      await expect(page, () => document.compatMode === 'CSS1Compat', 'standards mode');
      await expect(page, () => !!document.querySelector('main.tern h1#top'), 'main.tern with the heading');
      await expect(page, () => !!document.querySelector('.t-math .katex'), 'KaTeX output');
      await expect(page, () => document.querySelector('a.t-ref[href="#eq-int"]')?.textContent === '(1)', 'ref text "(1)"');
      await expect(page, () => document.characterSet === 'UTF-8', 'UTF-8');
    },
  },
  {
    // tern.render(el, untrusted, {safe:true}): the note's scripts do not run,
    // raw HTML is escaped, dangerous elements are neutralised, risky
    // attributes and URLs are dropped — but math still typesets.
    name: 'tern.render with safe: untrusted source runs nothing and is scrubbed',
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
        box.className = 'tern';
        box.id = 'untrusted';
        document.body.append(box);
        await tern.render(box, src, { safe: true });
      });
      // Give any (wrongly) created script a chance to run.
      await expect(page, () => document.querySelector('#untrusted .katex'), 'math still typeset under safe');
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
    name: 'a KaTeX error keeps the TeX, marked t-error, with a console warning',
    url: '/test/smoke/katex-error.html',
    allowConsole: /KaTeX cannot typeset|ParseError/i,
    async check(page, ctx) {
      await expect(
        page,
        () => [...document.querySelectorAll('.t-math')].some((e) => e.dataset.tex === '\\frac{1}{' && e.classList.contains('t-error') && e.textContent.trim() !== ''),
        'the failing formula keeps visible source, marked t-error',
      );
      if (!ctx.console.some((m) => m.type === 'warning' && /KaTeX cannot typeset/.test(m.text))) throw new Error(`no KaTeX error warning; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
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
    name: 'strict CSP with an external tern.css: renders, no violations',
    url: '/csp/test/smoke/csp.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'mounted');
      if (ctx.cspViolations.length) throw new Error(`CSP violations: ${ctx.cspViolations.join('; ')}`);
    },
  },
  {
    name: 'no doctype: mounts with doc.quirks, math as source',
    url: '/test/smoke/no-doctype.html',
    expectConsoleErrors: true,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'mounted');
      if (!ctx.diagnostics.some((d) => d.code === 'doc.quirks')) throw new Error('no doc.quirks diagnostic');
    },
  },
  // ---- runtime behaviour (docs/api.html#lifecycle)
  {
    // KaTeX is loaded by the page's head, so it is present before the
    // behaviours run: the order must hold even then.
    name: "lifecycle: behaviours once per element before math; 'render', 'math', 'ready'; tern.render() again changes nothing",
    url: '/test/smoke/lifecycle.html',
    async check(page, ctx) {
      await expect(page, () => window.__log && window.__log.includes('ready-promise'), 'the lifecycle log to reach tern.ready');
      const want = ['define p1 katex=0', 'define p2 katex=0', 'render katex=0', 'math main katex=3', 'ready', 'ready-promise'];
      const log = await page.evaluate(() => window.__log.slice());
      if (JSON.stringify(log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(log)}, expected ${JSON.stringify(want)}`);
      const html = await page.evaluate(() => document.querySelector('main.tern').innerHTML);
      await page.evaluate(async () => {
        await tern.render();
        await tern.render();
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
      const after = await page.evaluate(() => ({
        html: document.querySelector('main.tern').innerHTML,
        log: window.__log.slice(),
        katex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.querySelectorAll('.katex').length),
      }));
      const ran = after.log.filter((l) => l.startsWith('define'));
      if (ran.length !== 2) throw new Error(`behaviours ran ${ran.length} times after tern.render() twice, expected 2: ${JSON.stringify(ran)}`);
      if (after.katex.join() !== '1,1,1') throw new Error(`.katex per formula after tern.render() twice: ${after.katex.join(', ')}`);
      if (after.html !== html) throw new Error('tern.render() with no source changed main.tern');
      ctx.note(`events from the two extra tern.render() calls: ${after.log.slice(want.length).join(', ') || 'none'}`);
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
      // The <script> tag is on note line 4 (line 1 follows the tern.js line).
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
      await expect(page, () => !!document.querySelector('main.tern h1'), 'mounted');
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed');
      for (const file of ['missing-addon.js', 'missing-addon.css']) {
        if (!failed.some((d) => d.message.includes(file))) throw new Error(`no addon.failed naming ${file}; got ${JSON.stringify(failed.map((d) => d.message))}`);
      }
    },
  },
  {
    name: 'KaTeX that fails to load leaves math as its source, with a warning',
    url: '/test/smoke/katex-unavailable.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type|katex/i,
    async setup(context) {
      // Registered after the KaTeX cache route, so it wins.
      await context.route((url) => /^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@/.test(url.href), (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: 'not found' }));
    },
    async check(page, ctx) {
      const math = await page.evaluate(() => [...document.querySelectorAll('main.tern .t-math')].map((e) => ({ text: e.textContent, katex: !!e.querySelector('.katex') })));
      if (math.length !== 1 || math[0].katex || math[0].text !== 'x^2 + 1') throw new Error(`math ${JSON.stringify(math)}, expected its source "x^2 + 1"`);
      if (!ctx.console.some((m) => m.type === 'warning' && /KaTeX did not load/.test(m.text))) throw new Error(`no "KaTeX did not load" warning; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
    },
  },
  {
    name: 'no math add-on: no KaTeX is requested, and math stays as its source',
    url: '/test/smoke/katex-none.html',
    async setup(_context, page, ctx) {
      ctx.katexRequests = [];
      page.on('request', (r) => r.resourceType() !== 'document' && /katex/i.test(r.url()) && ctx.katexRequests.push(r.url()));
    },
    async check(page, ctx) {
      await page.waitForTimeout(500);
      if (ctx.katexRequests.length) throw new Error(`KaTeX requested: ${ctx.katexRequests.join(', ')}`);
      const r = await page.evaluate(() => ({
        tags: document.querySelectorAll('link[href*="katex" i], script[src*="katex" i]').length,
        math: [...document.querySelectorAll('main.tern .t-math')].map((e) => ({ text: e.textContent, katex: !!e.querySelector('.katex') })),
      }));
      if (r.tags) throw new Error(`${r.tags} KaTeX <link>/<script> in the page`);
      if (r.math.length !== 1 || r.math[0].katex || r.math[0].text !== 'x^2 + 1') throw new Error(`math ${JSON.stringify(r.math)}, expected its source "x^2 + 1"`);
      if (ctx.diagnostics.some((d) => d.code === 'katex.unavailable')) throw new Error('katex.unavailable reported, though KaTeX is off');
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
        return { box: document.getElementById('box').open, fold: document.getElementById('fold').open, top: rect.top, bottom: rect.bottom, vh: innerHeight, y: scrollY, math: !!document.querySelector('#box .t-math .katex') };
      });
      if (!r.box) throw new Error('the <details> holding #deep is still closed');
      if (r.y <= 0) throw new Error('the page did not scroll');
      if (r.top < -20 || r.bottom > r.vh + 20) throw new Error(`#deep is out of view: top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, viewport ${r.vh}`);
      if (r.fold) throw new Error('the other <details> opened too');
      if (!r.math) throw new Error('the formula beside the target was not typeset');
    },
  },
  {
    name: 'math in a closed <details> is typeset when it opens',
    url: '/gen/fragment.html',
    async check(page) {
      const before = await page.evaluate(() => ({ n: document.querySelectorAll('#fold .t-math').length, typeset: document.querySelectorAll('#fold .t-math .katex, #box .t-math .katex').length, open: document.getElementById('fold').open }));
      if (before.n !== 2 || before.typeset || before.open) throw new Error(`before the toggle: ${JSON.stringify(before)}, expected 2 formulas, none typeset, closed`);
      await page.evaluate(() => (document.getElementById('fold').open = true));
      await expect(page, () => document.querySelectorAll('#fold .t-math .katex').length === 2, 'both formulas in the opened <details> typeset');
      if (await page.evaluate(() => document.querySelectorAll('#box .t-math .katex').length)) throw new Error('math in the other, still closed <details> was typeset too');
    },
  },
  {
    name: 'a second tern.js tag does not mount twice',
    url: '/test/smoke/reentry.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered');
      const r = await page.evaluate(() => ({ mains: document.querySelectorAll('main.tern').length, h1: document.querySelectorAll('h1').length, once: document.querySelectorAll('#once').length, same: !!window.__first && window.tern === window.__first }));
      if (r.mains !== 1 || r.h1 !== 1 || r.once !== 1) throw new Error(`${r.mains} main.tern, ${r.h1} h1, ${r.once} #once; expected one of each`);
      if (!r.same) throw new Error('window.tern is no longer the first copy');
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
        [...document.querySelectorAll('main.tern pre[data-lines] > code')].map((code) => {
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
    name: 'code add-on: fences coloured by highlight.js with SRI, lines kept, a language loaded on first use, plain ones left',
    url: '/test/smoke/code-addon.html',
    async check(page) {
      await page.waitForFunction(() => document.querySelector('code.language-tex [class*="hljs-"]'), null, { timeout: 15000 });
      const r = await page.evaluate(() => {
        const out = {};
        for (const code of document.querySelectorAll('main.tern pre > code')) {
          out[code.className || 'none'] = {
            spans: code.querySelectorAll('[class*="hljs-"]').length,
            lines: [...code.querySelectorAll(':scope > .t-line')].map((l) => (l.classList.contains('t-hl') ? '*' : '') + l.textContent),
            text: code.textContent,
          };
        }
        const kw = document.querySelector('code.language-js .hljs-keyword');
        out.keyword = kw && getComputedStyle(kw).color;
        out.want = getComputedStyle(document.documentElement).getPropertyValue('--t-code-keyword').trim();
        out.comment = [...document.querySelectorAll('code.language-js .t-line')].map((l) => !!l.querySelector('.hljs-comment'));
        out.scripts = [...document.querySelectorAll('script[src*="@highlightjs/"]')].map((e) => ({ src: e.src.replace(/^.*@[\d.]+\//, ''), sri: e.integrity.startsWith('sha384-') }));
        return out;
      });
      const js = r['language-js'];
      const lines = ['// The nth Fibonacci number.', 'function fib(n) {', '*  return n < 2 ? n : fib(n - 1) + fib(n - 2); /* a long', '  comment */', '}'];
      if (JSON.stringify(js.lines) !== JSON.stringify(lines)) throw new Error(`js lines ${JSON.stringify(js.lines)}`);
      if (!js.spans) throw new Error('js has no highlight.js spans');
      if (r.comment.join() !== 'true,false,true,true,false') throw new Error(`the comment spans by line: ${r.comment.join()}, want a comment on lines 1, 3 and 4`);
      if (!r['language-python'].spans || !r['language-tex'].spans) throw new Error(`python ${r['language-python'].spans} spans, tex ${r['language-tex'].spans}`);
      for (const k of ['language-nosuchlang', 'language-text', 'none']) if (r[k].spans) throw new Error(`${k} was coloured`);
      const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      if (r.keyword !== rgb(r.want)) throw new Error(`a keyword is ${r.keyword}, --t-code-keyword is ${r.want}`);
      const want = ['highlight.min.js', 'languages/latex.min.js'];
      if (JSON.stringify(r.scripts.map((x) => x.src)) !== JSON.stringify(want) || !r.scripts.every((x) => x.sri)) throw new Error(`scripts ${JSON.stringify(r.scripts)}`);
    },
  },
  {
    name: 'code add-on: a theme colours code, and a strict CSP with data-nonce allows highlight.js',
    url: '/csp-nonce/test/smoke/code-addon-theme.html',
    async check(page) {
      await page.waitForFunction(() => document.querySelector('code.language-haskell [class*="hljs-"]'), null, { timeout: 15000 });
      const r = await page.evaluate(() => {
        const kw = document.querySelector('code.language-js .hljs-keyword');
        return { keyword: getComputedStyle(kw).color, want: getComputedStyle(document.documentElement).getPropertyValue('--t-code-keyword').trim(), csp: window.__csp, nonces: [...document.querySelectorAll('script[src*="@highlightjs/"]')].map((e) => e.nonce) };
      });
      if (r.want !== '#606e00') throw new Error(`--t-code-keyword is ${r.want}, solarized-light.css's is #606e00`);
      if (r.keyword !== 'rgb(96, 110, 0)') throw new Error(`a keyword is ${r.keyword}`);
      if (r.csp.length) throw new Error(`CSP violations: ${r.csp.join('; ')}`);
      if (r.nonces.length !== 2 || !r.nonces.every((n) => n === 'tern-smoke-nonce')) throw new Error(`highlight.js scripts' nonces ${JSON.stringify(r.nonces)}`);
    },
  },
  {
    name: 'code add-on: ?base= loads a local copy without SRI',
    url: '/test/smoke/code-addon-base.html',
    async setup(_context, _page, ctx) {
      if (!(await hljsDir(HLJS_VERSION))) ctx.skip(`no local copy of highlight.js ${HLJS_VERSION}`);
    },
    async check(page) {
      await page.waitForFunction(() => document.querySelector('code.language-tex [class*="hljs-"]'), null, { timeout: 15000 });
      const r = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((e) => ({ src: new URL(e.src).pathname, sri: !!e.integrity })).filter((x) => x.src.startsWith('/vendor/')));
      const want = ['/vendor/highlightjs/highlight.min.js', '/vendor/highlightjs/languages/latex.min.js'];
      if (JSON.stringify(r.map((x) => x.src)) !== JSON.stringify(want) || r.some((x) => x.sri)) throw new Error(`scripts ${JSON.stringify(r)}`);
      if (!(await page.evaluate(() => document.querySelector('code.language-js [class*="hljs-"]')))) throw new Error('js not coloured');
    },
  },
  {
    name: 'code add-on: highlight.js that fails to load leaves code plain, with a warning',
    url: '/test/smoke/code-addon.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|integrity|MIME type/i,
    async setup(context) {
      // Registered after the cache route, so it wins.
      await context.route((url) => HLJS_URL.test(url.href), (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: 'not found' }));
    },
    async check(page, ctx) {
      await page.waitForTimeout(500);
      const spans = await page.evaluate(() => document.querySelectorAll('main.tern [class*="hljs-"]').length);
      if (spans) throw new Error(`${spans} highlight.js spans, though it did not load`);
      if (!(await page.evaluate(() => document.querySelectorAll('main.tern code.language-js .t-line').length === 5))) throw new Error('the js lines changed');
      if (!ctx.console.some((m) => m.type === 'warning' && /highlight\.js did not load/.test(m.text))) throw new Error(`no warning; console: ${JSON.stringify(ctx.console)}`);
    },
  },
  {
    name: 'mermaid add-on: fences drawn as diagrams in the theme, listings and ids kept, a broken one left with its error, Mermaid pinned with SRI',
    url: '/test/smoke/mermaid-addon.html',
    timeout: 60000,
    async check(page, ctx) {
      await page.waitForFunction(() => document.querySelectorAll('main.tern .t-mermaid > svg.t-mermaid-screen').length === 11 && document.querySelector('.t-mermaid-error'), null, { timeout: 40000 });
      const r = await page.evaluate(() => {
        const flow = document.getElementById('flow');
        const rect = flow && flow.querySelector('svg .node rect, svg .node polygon');
        const listing = document.querySelector('figure[data-t=code]');
        const broken = document.querySelector('.t-mermaid-error');
        return {
          flow: flow && flow.matches('.t-mermaid') && !!flow.querySelector(':scope > svg') && flow.querySelector(':scope > pre').hidden,
          pos: flow && flow.hasAttribute('data-pos'),
          fill: rect && getComputedStyle(rect).fill,
          soft: getComputedStyle(document.documentElement).getPropertyValue('--t-soft').trim(),
          listing: listing && !!listing.querySelector(':scope > .t-mermaid > svg') && !!listing.querySelector(':scope > figcaption'),
          broken: broken && broken.previousElementSibling && broken.previousElementSibling.matches('pre:not([hidden])') && /Parse error/.test(broken.textContent),
          js: !!document.querySelector('main.tern > pre > code.language-js'),
          prints: document.querySelectorAll('.t-mermaid-print').length,
          scripts: [...document.querySelectorAll('script[src*="mermaid@"]')].map((e) => ({ src: e.src.replace(/^.*\/npm\//, ''), sri: e.integrity.startsWith('sha384-') })),
        };
      });
      const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      if (!r.flow || !r.pos) throw new Error(`#flow: drawn ${r.flow}, data-pos ${r.pos}`);
      if (r.fill !== rgb(r.soft)) throw new Error(`a flowchart node is filled ${r.fill}, --t-soft is ${r.soft}`);
      if (!r.listing) throw new Error('the listing lost its diagram or its caption');
      if (!r.broken) throw new Error('the broken diagram is not shown as source with its error');
      if (!r.js) throw new Error('the js fence was touched');
      if (r.prints) throw new Error(`${r.prints} print copies for a light palette`);
      if (JSON.stringify(r.scripts) !== JSON.stringify([{ src: `mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`, sri: true }])) throw new Error(`scripts ${JSON.stringify(r.scripts)}`);
      if (!ctx.console.some((m) => m.type === 'warning' && /Tern mermaid\.js: Parse error/.test(m.text))) throw new Error('no console warning for the broken diagram');
    },
  },
  {
    name: 'mermaid add-on: a dark theme under a strict CSP with data-nonce: drawn in its colours, styles kept, a light copy for print',
    url: '/csp-nonce/test/smoke/mermaid-addon-theme.html',
    timeout: 60000,
    async check(page, ctx) {
      await page.waitForFunction(() => document.querySelectorAll('.t-mermaid > svg.t-mermaid-print').length === 2, null, { timeout: 40000 });
      const look = () => {
        const rect = document.querySelector('.t-mermaid > svg:not([style*="display: none"]) .node rect');
        const shown = [...document.querySelectorAll('.t-mermaid > svg')].filter((s) => getComputedStyle(s).display !== 'none');
        const node = shown[0] && shown[0].querySelector('.node rect');
        return {
          fill: node && getComputedStyle(node).fill,
          maxWidth: shown[0] && shown[0].style.maxWidth,
          kinds: shown.map((s) => s.classList[s.classList.length - 1]),
          soft: getComputedStyle(document.documentElement).getPropertyValue('--t-soft').trim(),
          csp: window.__csp,
          nonces: [...document.querySelectorAll('script[src*="mermaid@"]')].map((e) => e.nonce),
        };
      };
      const screen = await page.evaluate(look);
      const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      if (screen.csp.length) throw new Error(`CSP violations: ${screen.csp.slice(0, 3).join('; ')}`);
      if (JSON.stringify(screen.nonces) !== JSON.stringify(['tern-smoke-nonce'])) throw new Error(`Mermaid's script nonces ${JSON.stringify(screen.nonces)}`);
      if (screen.kinds.join() !== 't-mermaid-screen,t-mermaid-screen') throw new Error(`on screen: ${screen.kinds.join()}`);
      if (screen.fill !== rgb(screen.soft)) throw new Error(`a node is filled ${screen.fill}, nord's --t-soft is ${screen.soft} (the SVG's <style> did not apply?)`);
      if (!/px$/.test(screen.maxWidth || '')) throw new Error(`the SVG's max-width is "${screen.maxWidth}" (its style attribute was not set again)`);
      await page.emulateMedia({ media: 'print' });
      const print = await page.evaluate(look);
      if (print.kinds.join() !== 't-mermaid-print,t-mermaid-print') throw new Error(`in print: ${print.kinds.join()}`);
      if (print.fill !== rgb('#f3f4f1')) throw new Error(`in print a node is filled ${print.fill}, tern.css's print --t-soft is #f3f4f1`);
    },
  },
  {
    name: 'mermaid add-on: a change of light or dark preference redraws; a note rendered again reuses its drawings',
    url: '/test/smoke/mermaid-addon.html',
    timeout: 60000,
    context: { colorScheme: 'light' },
    async check(page) {
      const fill = () => getComputedStyle(document.querySelector('#flow > svg.t-mermaid-screen .node rect')).fill;
      await page.waitForFunction(() => document.querySelector('#flow > svg.t-mermaid-screen'), null, { timeout: 40000 });
      const light = await page.evaluate(fill);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction((was) => getComputedStyle(document.querySelector('#flow > svg.t-mermaid-screen .node rect')).fill !== was && document.querySelector('#flow > svg.t-mermaid-print'), light, { timeout: 20000 });
      const dark = await page.evaluate(() => ({ fill: getComputedStyle(document.querySelector('#flow > svg.t-mermaid-screen .node rect')).fill, soft: getComputedStyle(document.documentElement).getPropertyValue('--t-soft').trim() }));
      if (dark.soft !== '#1f2329' || dark.fill !== 'rgb(31, 35, 41)') throw new Error(`after the switch a node is filled ${dark.fill}, --t-soft is ${dark.soft}`);
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction((was) => getComputedStyle(document.querySelector('#flow > svg.t-mermaid-screen .node rect')).fill === was && !document.querySelector('.t-mermaid-print'), light, { timeout: 20000 });
      // Once the redraws the switches queued are done, render the note again.
      const again = await page.evaluate(async () => {
        const main = document.querySelector('main.tern');
        const render = window.mermaid.render;
        let calls = 0;
        let last = performance.now();
        window.mermaid.render = (...a) => (calls++, (last = performance.now()), render.apply(window.mermaid, a));
        while (performance.now() - last < 1000) await new Promise((r) => setTimeout(r, 100));
        calls = 0;
        const html = await (await fetch(location.href)).text();
        await window.tern.render(main, html.slice(html.indexOf('</script>') + '</script>'.length));
        return { calls, svgs: main.querySelectorAll('.t-mermaid > svg.t-mermaid-screen').length };
      });
      if (again.calls || again.svgs !== 11) throw new Error(`rendered again: ${again.svgs} diagrams, ${again.calls} new drawings`);
    },
  },
  {
    name: 'mermaid add-on: ?base= loads a local copy without SRI; other options go to Mermaid',
    url: '/test/smoke/mermaid-addon-base.html',
    timeout: 60000,
    async setup(_context, _page, ctx) {
      if (!(await mermaidDir(MERMAID_VERSION))) ctx.skip(`no local copy of Mermaid ${MERMAID_VERSION}`);
    },
    async check(page) {
      await page.waitForFunction(() => document.querySelector('.t-mermaid > svg.t-mermaid-screen'), null, { timeout: 40000 });
      const r = await page.evaluate(() => ({
        scripts: [...document.querySelectorAll('script[src*="mermaid.min.js"]')].map((e) => ({ src: new URL(e.src).pathname, sri: !!e.integrity })),
        look: window.mermaid.mermaidAPI.getConfig().look,
      }));
      if (JSON.stringify(r.scripts) !== JSON.stringify([{ src: '/vendor/mermaid/mermaid.min.js', sri: false }])) throw new Error(`scripts ${JSON.stringify(r.scripts)}`);
      if (r.look !== 'classic') throw new Error(`look ${r.look}, want classic from ?look=classic`);
    },
  },
  {
    name: 'mermaid add-on: Mermaid is not requested for a note with no diagram',
    url: '/test/smoke/mermaid-addon-none.html',
    async check(page) {
      await page.waitForTimeout(300);
      const n = await page.evaluate(() => document.querySelectorAll('script[src*="mermaid@"]').length);
      if (n) throw new Error('Mermaid was requested for a note with no mermaid fence');
    },
  },
  {
    name: 'mermaid add-on: a Mermaid that fails to load leaves each fence as its source, with a warning',
    url: '/test/smoke/mermaid-addon.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|integrity|MIME type/i,
    async setup(context) {
      // Registered after the cache route, so it wins.
      await context.route((url) => MERMAID_URL.test(url.href), (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: 'not found' }));
    },
    async check(page, ctx) {
      await page.waitForFunction(() => [...document.querySelectorAll('script')].some((s) => /mermaid@/.test(s.src)), null, { timeout: 5000 });
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({ svgs: document.querySelectorAll('.t-mermaid svg').length, hidden: document.querySelectorAll('main.tern pre[hidden]').length, fences: document.querySelectorAll('main.tern code.language-mermaid').length }));
      if (r.svgs || r.hidden || r.fences !== 12) throw new Error(`${r.svgs} diagrams, ${r.hidden} hidden fences, ${r.fences} fences`);
      if (!ctx.console.some((m) => m.type === 'warning' && /Mermaid did not load/.test(m.text))) throw new Error(`no warning; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
    },
  },
  {
    // tern's presentational styles (column alignment, a grid's --t-cols)
    // must survive a policy with no 'unsafe-inline' for styles; data-nonce
    // covers tern's <style> and the note's scripts.
    name: 'strict CSP with data-nonce: aligned table cells and a cols grid, no violations',
    url: '/csp-nonce/test/smoke/csp-layout.html',
    async check(page) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered under the CSP');
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => {
        const grid = document.querySelector('main.tern .t-cols');
        const cs = grid && getComputedStyle(grid);
        return {
          csp: window.__csp,
          cells: [...document.querySelectorAll('main.tern table tr')].map((tr) => [...tr.children].map((c) => getComputedStyle(c).textAlign)),
          display: cs && cs.display,
          columns: cs && cs.gridTemplateColumns,
          script: window.__noteScript === true,
          base: getComputedStyle(document.querySelector('main.tern')).maxWidth,
        };
      });
      const problems = [];
      if (r.csp.length) problems.push(`${r.csp.length} CSP violation(s): ${[...new Set(r.csp)].join('; ')}`);
      const bad = r.cells.flatMap((row, i) => row.map((a, j) => [i, j, a])).filter(([, j, a]) => a !== ['left', 'right'][j]);
      if (bad.length || r.cells.length !== 3) problems.push(`text-align by row: ${JSON.stringify(r.cells)}, expected left, right in each of 3 rows`);
      const tracks = String(r.columns || '').split(/\s+/).map(parseFloat);
      if (r.display !== 'grid' || tracks.length !== 2 || !(Math.abs(tracks[0] / tracks[1] - 2) < 0.02)) problems.push(`grid: display ${r.display}, grid-template-columns ${JSON.stringify(r.columns)}, expected two tracks at 2:1`);
      if (!r.script) problems.push('the note script did not run (nonce)');
      if (r.base === 'none') problems.push("tern's base stylesheet is not applied (nonce)");
      if (problems.length) throw new Error(problems.join(' | '));
    },
  },
  ...DOC_TESTS,

  // The five sample notes (test/samples/), as written:
  // tern.js by a relative URL, no add-ons.
  ...['lecture', 'cheatsheet', 'media', 'code', 'layout'].map((name) => ({
    name: `sample ${name}.html: mounts, math renders, no console errors`,
    url: `/test/samples/${name}.html`,
    offline: true,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'main.tern with its h1');
      const expected = mathCountUnderNode(path.join(SAMPLES, `${name}.html`));
      await expect(page, (n) => document.querySelectorAll('main.tern .t-math').length >= Math.min(n || 0, 1), `the note's formulas in main.tern (${expected} under node)`, 8000, expected);
      try {
        await page.waitForFunction(`(${MATH_STATE})().rendered === (${MATH_STATE})().shown`, null, { timeout: 8000 });
      } catch {
        const m = await page.evaluate(MATH_STATE);
        throw new Error(`${m.shown - m.rendered} of ${m.shown} formulas outside closed <details> not rendered by KaTeX; first: ${String(m.firstMissing).slice(0, 160)}`);
      }
      const m = await page.evaluate(MATH_STATE);
      ctx.note(m.all ? `${m.all} formula(s) (${expected} under node), ${m.rendered} typeset, ${m.all - m.shown} in closed <details>` : `no math (${expected} formulas under node)`);
    },
  })),

  {
    // A real key press in both browsers (in Firefox a synthetic
    // ClipboardEvent has no clipboardData). A window listener records what
    // the copy event carries after tern's handler, which listens on the
    // document and so runs first. Chromium also reads the system clipboard
    // back (the permission exists there); Firefox's clipboard read needs a
    // user's paste prompt, so there the event's data is the evidence.
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
      await expect(page, () => document.querySelectorAll('main.tern .t-math .katex').length === 2, 'both formulas rendered by KaTeX');
      const tex = await page.evaluate(() => [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex));
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
      await page.keyboard.press('ControlOrMeta+C');
      await expect(page, () => !!window.__copy, 'a copy event from the key press', 3000);
      const event = await page.evaluate(() => window.__copy);
      if (!event.trusted) throw new Error('the copy event was not trusted');
      if (!event.prevented) throw new Error("tern's copy handler did not take the copy (the event was not cancelled)");
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
        // KaTeX's own text (HTML glyphs, MathML tokens, the annotation) must
        // be replaced, not kept beside the TeX.
        if (plain.split(INLINE).length !== 2) throw new Error(`text/plain on ${where} holds the inline TeX ${plain.split(INLINE).length - 1} times: ${show}`);
        if (/a2\+b2=c2|∫/.test(plain.replace(/\s/g, ''))) throw new Error(`text/plain on ${where} keeps KaTeX's rendered text: ${show}`);
        // The handler rewrites both flavours, text/plain and text/html.
        if (!html) throw new Error(`no text/html on ${where}`);
        const htmlText = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
        if (/class="[^"]*\bkatex\b/.test(html)) throw new Error(`text/html on ${where} keeps KaTeX markup`);
        for (const want of [`$${INLINE}$`, `$$${DISPLAY}$$`]) {
          if (!htmlText.includes(want)) throw new Error(`text/html on ${where} lacks ${JSON.stringify(want)}: ${JSON.stringify(htmlText.slice(0, 240))}`);
        }
      }
      ctx.note(`checked ${checks.map(([w]) => w).join(' and ')}`);
    },
  },
  {
    name: 'print: PDF text keeps a formula adjacent to its sentence',
    url: '/test/smoke/print.html',
    browsers: ['chromium'],
    async check(page, ctx) {
      if (!hasMutool()) ctx.skip('mutool not found; install MuPDF (mupdf-tools) to extract PDF text');
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'the formula rendered by KaTeX');
      await page.evaluate(() => document.fonts.ready);
      // `7 \times 6 = 42` has only upright glyphs on one baseline, so its
      // text is the same in KaTeX's HTML and MathML layers ("7×6=42") and
      // has no sub/superscript parts, which stay displaced even when fixed.
      // The MathML layer is clipped and absolutely positioned: if Chromium
      // ever prints its text it lands after the page's prose, as scattered
      // HTML glyphs do. So the check is that one copy sits between the words
      // around it, and a control proves the check can fail.
      const inPlace = (text) => /Theproduct(?:7×6=42){1,2}istheanswer/.test(text.replace(/[\s\u200b]+/g, ''));
      const text = await pdfText(page);
      if (!inPlace(text)) throw new Error(`the formula left its sentence in the PDF text: ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 200))}`);
      // KaTeX positions .katex (0.19) and its bases (.base; .katex-base in 0.19) relatively.
      await page.addStyleTag({ content: '@media print { .katex, .katex .base, .katex .katex-base { position: relative !important; } }' });
      const control = await pdfText(page);
      if (inPlace(control)) throw new Error("control: with KaTeX's relative positioning restored the formula still reads in place, so this test no longer detects scattering");
      ctx.note(`PDF text: ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 90))}; control scattered as expected`);
    },
  },
  {
    // Throttling: CDP Network.emulateNetworkConditions for the local server;
    // the KaTeX route holds its responses back by the same latency and rate
    // (see routeKatex). Mount is when main.tern enters the document. Stages
    // are defined at assignStages. KaTeX's fonts are a fourth wave, found
    // through katex.min.css once math is typeset, which is after mount; mount
    // does not wait for them, so the budget counts only requests started
    // before mount. The report lists them all. Also checked: tern.js and the
    // add-ons (the math add-on among them) start before mount, KaTeX after it,
    // and nothing is fetched twice (a preload the page did not reuse).
    name: 'Slow-3G waterfall: at most 3 serial stages before mount',
    url: '/test/smoke/waterfall.html',
    browsers: ['chromium'],
    timeout: 120000,
    readyTimeout: 90000,
    waitUntil: 'commit',
    init: () => {
      new MutationObserver((_, mo) => {
        if (document.querySelector('main.tern')) {
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
      ctx.cdnDelay = (bytes) => SLOW_3G.latency + (bytes / SLOW_3G.bytesPerSecond) * 1000;
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered', 60000);
      if ((await page.evaluate(() => window.__addon)) !== 1) throw new Error('the JS add-on did not run exactly once');
      // Let late requests (fonts) finish, for the report.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const all = [...ctx.requests.values()].filter((r) => !/\/favicon\.ico$/.test(r.url));
      const doc = all.find((r) => r.type === 'Document');
      if (!doc) throw new Error('no document request recorded');
      const mountedAt = await page.evaluate(() => window.__mountedAt);
      if (!mountedAt) throw new Error('main.tern never entered the document');
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
      // tern.js and the add-ons (the math add-on among them) are preloaded at
      // capture; KaTeX loads later, when the math add-on runs after mount.
      const want = [/\/tern\.js$/, /\/gen\/addon\.js$/, /\/gen\/addon\.css$/, /\/addons\/katex\.js$/];
      for (const re of want) {
        if (!before.some((r) => re.test(r.url))) throw new Error(`nothing matching ${re} was requested before mount (tern.js and the add-ons are preloaded at capture)`);
      }
      const after = ordered.filter((r) => r.start >= mount);
      if (!after.some((r) => /katex@[^/]+\/dist\/katex(\.min)?\.js$/.test(r.url))) throw new Error('KaTeX was not requested after mount (the math add-on loads it when it runs)');
      const seen = new Map();
      for (const r of all) seen.set(r.url, (seen.get(r.url) || 0) + 1);
      const twice = [...seen].filter(([, n]) => n > 1).map(([u]) => short(u));
      if (twice.length) throw new Error(`fetched more than once (a preload not reused?): ${twice.join(', ')}`);
      const failed = all.filter((r) => r.failed);
      if (failed.length) throw new Error(`failed requests: ${failed.map((r) => `${short(r.url)} (${r.failed})`).join(', ')}`);
      const stages = Math.max(...before.map((r) => r.stage));
      const late = ordered.filter((r) => r.start >= mount);
      const fonts = late.filter((r) => /katex@[^/]+\/dist\/fonts\//.test(r.url));
      ctx.note(`  ${stages} serial stages before mount; after mount ${late.length} request(s)${late.length ? ` up to stage ${Math.max(...late.map((r) => r.stage))}` : ''}, ${fonts.length} of them KaTeX fonts (not counted: mount does not wait for them)`);
      if (stages > 3) throw new Error(`${stages} serial stages before mount, budget 3 (see the waterfall below)`);
    },
  },
  {
    // Parse+transform+emit+mount is one synchronous task by design, and the
    // browser lays the whole note out in the frame that follows
    // it; the first math slice shares that task when KaTeX is ready (the
    // first paint is typeset). The mount frame is the long animation frame
    // (LoAF) holding 'render', or without LoAF the long task holding it.
    // The budget is for what comes after: no long task (> 50 ms, the Long
    // Tasks API threshold) from the end of the mount frame until 'math', plus
    // a settling window for the last slice's layout. Both are reported.
    name: 'no math task over 50 ms on the 4,000-formula note',
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
      if (m.rendered !== m.shown) throw new Error(`${m.shown - m.rendered} of ${m.shown} formulas outside closed <details> not rendered`);
      const { t, lt, loaf } = await page.evaluate(() => ({ t: window.__t, lt: window.__lt, loaf: window.__loaf }));
      if (t.render == null) throw new Error("'render' never fired");
      const end = (e) => e.start + e.duration;
      const ms = (x) => `${Math.round(x)} ms`;
      const mountTask = lt.find((e) => e.start <= t.render + 1 && t.render <= end(e) + 1);
      const frame = loaf.find((f) => f.start <= t.render + 1 && t.render <= end(f) + 1);
      const mountEnd = frame ? end(frame) : mountTask ? end(mountTask) : t.render;
      const inMount = lt.filter((e) => e.start < mountEnd && end(e) > t.render - 1);
      const math = lt.filter((e) => !inMount.includes(e) && end(e) > t.render && e.start <= t.math + SETTLE);
      ctx.note(`mount task (parse+transform+emit+mount, to 'render'): ${mountTask ? `${ms(mountTask.duration)} at ${ms(mountTask.start)}, ${ms(end(mountTask) - t.render)} of it after 'render'` : 'under 50 ms'}`);
      if (frame) ctx.note(`mount frame (LoAF): ${ms(frame.duration)} at ${ms(frame.start)}, of which style, layout and paint ${ms(frame.layout)}; its long tasks: ${inMount.map((e) => `${ms(e.start)}+${ms(e.duration)}`).join(', ') || 'none'}`);
      ctx.note(`'render' at ${ms(t.render)}, 'math' at ${ms(t.math)}: ${ms(t.math - t.render)} of math; ${m.all} formulas, ${m.rendered} typeset, ${m.all - m.shown} left for closed <details>`);
      ctx.note(`long tasks during math: ${math.length ? math.map((e) => `${ms(e.start)}+${ms(e.duration)}`).join(', ') : 'none'}`);
      if (math.length) {
        const frames = loaf.filter((f) => f.start >= mountEnd - 1 && math.some((e) => f.start < end(e) && e.start < end(f)));
        if (frames.length) ctx.note(`their frames (LoAF): ${frames.map((f) => `${ms(f.start)}+${ms(f.duration)} = style, layout and paint ${ms(f.layout)} + ${f.scripts || 'no script'}`).join('; ')}`);
        throw new Error(`${math.length} long task(s) during math rendering, longest ${ms(Math.max(...math.map((e) => e.duration)))} (budget: none over 50 ms)`);
      }
    },
  },

  // ---- a note's own vocabulary (window.TERN.schema), as a note and as a built page
  ...[
    ['a single-file note numbers with its window.TERN.schema, which wins over an add-on', '/test/smoke/own-schema.html', null],
    ['tern build: the built page keeps the note\'s window.TERN.schema, behaviours included', '/gen/built-own-schema.html', 'built-own-schema'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup() {
      if (built) cliPage(built);
    },
    async check(page) {
      const r = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('main.tern .t-label')].map((e) => e.textContent),
        refs: [...document.querySelectorAll('main.tern a.t-ref')].map((e) => e.textContent),
        dom: document.getElementById('t1').dataset.dom,
        tags: [document.getElementById('t1').localName, document.getElementById('l2').localName],
      }));
      const want = { labels: ['Theorem 1', 'Lemma 2'], refs: ['Theorem 1', 'Lemma 2'], dom: 'own', tags: ['section', 'section'] };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
    },
  })),

  // ---- what the note sets, and what its add-ons do, as a note and as a built page
  ...[
    ['data-lang sets the label language over window.TERN.lang and :::meta; window.TERN.schema.strict gives name.unknown', '/test/smoke/note-config.html', null],
    ['tern build: the built page has the same label language and name.unknown', '/gen/built-note-config.html', 'built-note-config'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup() {
      if (built) cliPage(built);
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('main.tern .t-label')].map((e) => e.textContent),
        refs: [...document.querySelectorAll('main.tern a.t-ref')].map((e) => e.textContent),
      }));
      if (JSON.stringify(r) !== JSON.stringify({ labels: ['Satz 1'], refs: ['Satz 1'] })) throw new Error(`${JSON.stringify(r)}, expected the label and the reference Satz 1`);
      const codes = ctx.diagnostics.map((d) => `${d.code} ${d.position.start.line}:${d.position.start.column}`);
      if (codes.join() !== 'name.unknown 14:4') throw new Error(`tern.diagnostics ${JSON.stringify(codes)}, expected name.unknown at 14:4`);
    },
  })),
  ...[
    ['an add-on that throws while it runs gives addon.failed with its message; the note mounts with what it declared first', '/test/smoke/addon-throws.html', null],
    ['tern build: an add-on that throws on the built page gives addon.failed with its message', '/gen/built-addon-throws.html', 'built-addon-throws'],
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
    ["tern build: a video's poster loads on the built page", '/gen/built-poster.html', 'built-poster'],
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
        const el = document.querySelector('main.tern video');
        return el && { poster: el.poster, mounted: !!el.closest('main.tern') };
      });
      if (!v || !/\/gen\/poster\.png$/.test(v.poster)) throw new Error(`the video ${JSON.stringify(v)}`);
      if (!ctx.posters.length) throw new Error('the poster image was never requested');
      ctx.note(`poster requests: ${ctx.posters.length}`);
    },
  })),

  // ---- the command line's pages (docs/tools.html#built-page)
  {
    // The content is in the HTML: blocked, tern.js leaves it as built (its
    // add-on and the note's script, which call tern, throw).
    name: 'tern build: the page shows its content, styled, with tern.js blocked',
    url: '/gen/built.html',
    noTern: true,
    expectConsoleErrors: true,
    async setup(context) {
      cliPage('built');
      await context.route((url) => url.pathname === '/tern.js', (route) => route.abort());
    },
    async check(page) {
      await expect(page, () => document.readyState === 'complete', 'the page to load');
      const r = await page.evaluate(() => {
        const box = document.querySelector('main.tern aside.box');
        return {
          tern: typeof window.tern,
          h1: (document.querySelector('main.tern h1') || {}).textContent,
          label: box && box.querySelector('.t-label').textContent,
          ref: (document.querySelector('main.tern a.t-ref[href="#b1"]') || {}).textContent,
          math: document.querySelectorAll('main.tern .t-math').length,
          source: !!document.querySelector('script[type="text/tern"]#tern-source'),
          title: document.title,
          lang: document.documentElement.lang,
          width: getComputedStyle(document.querySelector('main.tern')).maxWidth,
          border: box && getComputedStyle(box).borderTopStyle,
          panel: !!document.querySelector('.t-diagnostics'),
        };
      });
      const want = { tern: 'undefined', h1: 'Smoke: a built page', label: 'Box 1', ref: 'Box 1', math: 2, source: true, title: 'Smoke: a built page', lang: 'en', border: 'solid', panel: false };
      const got = { ...r };
      delete got.width;
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`page ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      if (r.width === 'none') throw new Error('tern.css is not applied (main.tern has no max-width)');
    },
  },
  {
    name: "tern build: tern.js starts the built page: note scripts once, behaviours, math, the panel, 'ready'",
    url: '/gen/built.html',
    async setup() {
      cliPage('built');
    },
    async check(page, ctx) {
      await expect(page, () => document.querySelectorAll('main.tern .t-math .katex').length === 2, 'both formulas typeset by tern.js');
      const r = await page.evaluate(() => ({
        log: window.__log,
        scripts: window.__script,
        mains: document.querySelectorAll('main.tern').length,
        dom: document.getElementById('b1').dataset.dom,
        define: document.getElementById('b1').dataset.define,
        tex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex),
        panel: (document.querySelector('.t-diagnostics') || {}).textContent || '',
        sheets: [...document.head.querySelectorAll('style, link[rel="stylesheet"]')].map((e) => (e.id === 'tern-style' ? 'base' : e.href ? e.href.replace(/^.*\//, '') : /aside\.box/.test(e.textContent) ? 'tern.style' : 'other')),
      }));
      const want = ['script tern=object', 'define katex=0', 'render', 'math main', 'ready'];
      if (JSON.stringify(r.log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(r.log)}, expected ${JSON.stringify(want)}`);
      if (r.scripts !== 1 || r.mains !== 1) throw new Error(`the note script ran ${r.scripts} time(s), ${r.mains} main.tern; expected 1 and 1`);
      if (r.dom !== 'yes' || r.define !== 'yes') throw new Error(`behaviours: the add-on's dom ${r.dom}, tern.define ${r.define}`);
      if (r.tex.join(' | ') !== 'a^2 + b^2 = c^2 | \\int_0^1 x\\,dx = \\tfrac12') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      const codes = ctx.diagnostics.map((d) => d.code);
      if (codes.join() !== 'ref.dangling') throw new Error(`tern.diagnostics ${JSON.stringify(codes)}, expected the build's ref.dangling`);
      const d = ctx.diagnostics[0];
      if (!r.panel.includes('ref.dangling') || !r.panel.includes(`line ${d.position.start.line}:${d.position.start.column} (file line ${d.position.start.line + 1})`)) throw new Error(`the panel: ${JSON.stringify(r.panel)}`);
      const [base, own, css] = ['base', 'tern.style', 'built-addon.css'].map((s) => r.sheets.indexOf(s));
      if (!(base >= 0 && base < own && own < css)) throw new Error(`head sheets ${JSON.stringify(r.sheets)}: expected the base, then the add-on's tern.style, then the CSS add-on (data-use order)`);
    },
  },
  {
    // A missing CSS add-on is not reported on a built page: its link comes
    // before tern.js.
    name: 'tern build: a missing script add-on gives addon.failed on the built page',
    url: '/gen/built-missing.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type/,
    async setup() {
      cliPage('built-missing');
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'main.tern');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed').map((d) => d.message);
      if (failed.length !== 1 || !failed[0].includes('missing-addon.js')) throw new Error(`addon.failed ${JSON.stringify(failed)}, expected one naming missing-addon.js`);
    },
  },
  {
    name: "tern build --katex: math pre-rendered, KaTeX's script never requested",
    url: '/gen/built-katex.html',
    async setup(_context, page, ctx) {
      if (!(await katexDist(KATEX_VERSION))) ctx.skip(`no local copy of KaTeX ${KATEX_VERSION} to pre-render with`);
      cliPage('built-katex');
      ctx.katexScripts = [];
      // KaTeX's library (katex.min.js), not the add-on script (addons/katex.js).
      page.on('request', (q) => /katex\.min\.js(?:[?#]|$)|\/katex@[^/]+\/dist\/katex\.js/.test(q.url()) && ctx.katexScripts.push(q.url()));
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        log: window.__log,
        katex: document.querySelectorAll('main.tern .t-math .katex').length,
        mathml: document.querySelectorAll('main.tern .t-math math').length,
        tex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex),
        css: [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => /katex/.test(l.href) && l.sheet).length,
      }));
      const want = ['script tern=object', 'define katex=2', 'render', 'math main', 'ready'];
      if (JSON.stringify(r.log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(r.log)}, expected ${JSON.stringify(want)}`);
      if (r.katex !== 2 || r.mathml !== 2) throw new Error(`${r.katex} .katex and ${r.mathml} <math> in main.tern, expected 2 of each`);
      if (r.tex.join(' | ') !== 'a^2 + b^2 = c^2 | \\int_0^1 x\\,dx = \\tfrac12') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      if (!r.css) throw new Error("KaTeX's stylesheet did not load");
      await page.waitForTimeout(300);
      if (ctx.katexScripts.length) throw new Error(`KaTeX's script was requested: ${ctx.katexScripts.join(', ')}`);
    },
  },
  {
    name: 'addons/mathml.js: formulas render as native MathML with Temml, KaTeX never requested',
    url: '/test/smoke/mathml.html',
    timeout: 60000,
    async setup(_context, page, ctx) {
      if (!(await temmlDir(TEMML_VERSION))) ctx.skip(`no local copy of Temml ${TEMML_VERSION}`);
      ctx.katexReqs = [];
      page.on('request', (q) => /katex/i.test(q.url()) && ctx.katexReqs.push(q.url()));
    },
    async check(page, ctx) {
      await page.waitForFunction(() => document.querySelectorAll('.t-math math').length >= 3, null, { timeout: 40000 });
      const r = await page.evaluate(() => ({
        maths: document.querySelectorAll('.t-math math').length,
        katex: document.querySelectorAll('.t-math .katex').length,
        annotations: document.querySelectorAll('.t-math annotation').length,
        tex: [...document.querySelectorAll('.t-math')].map((e) => e.dataset.tex),
        scripts: [...document.querySelectorAll('script[src*="temml.min.js"]')].map((e) => ({ src: new URL(e.src).pathname, sri: !!e.integrity })),
      }));
      if (r.maths !== 3 || r.katex !== 0) throw new Error(`${r.maths} <math>, ${r.katex} .katex (expected 3, 0)`);
      if (r.tex.join(' | ') !== 'x \\in \\RR | \\sum_{i=1}^{n} x_i^2 | \\frac{a}{b} = \\RR^n') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      if (r.annotations !== 3) throw new Error(`${r.annotations} annotations, expected 3 (the TeX kept for copy)`);
      if (JSON.stringify(r.scripts) !== JSON.stringify([{ src: '/vendor/temml/temml.min.js', sri: false }])) throw new Error(`scripts ${JSON.stringify(r.scripts)}`);
      await page.waitForTimeout(200);
      if (ctx.katexReqs.length) throw new Error(`KaTeX was requested: ${ctx.katexReqs.join(', ')}`);
    },
  },
  {
    name: 'tern build --math=mathml: native MathML, self-contained, no math asset fetched',
    url: '/gen/built-mathml.html',
    async setup(_context, page, ctx) {
      if (!(await temmlDir(TEMML_VERSION))) ctx.skip(`no local copy of Temml ${TEMML_VERSION} to pre-render with`);
      cliPage('built-mathml');
      ctx.ext = [];
      // A math library (katex.min.js / temml.min.js, or a CDN katex@/temml@
      // path) or any non-local asset. The add-on scripts (addons/*.js) are
      // local and harmless — a MathML page's formulas are already rendered.
      page.on('request', (q) => {
        const u = q.url();
        if (/katex\.min|temml\.min|\/(?:katex|temml)@/i.test(u) || !/^http:\/\/(?:localhost|127\.0\.0\.1)/.test(u)) ctx.ext.push(u.replace(/^https?:\/\/[^/]+/, ''));
      });
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        mathml: document.querySelectorAll('main.tern .t-math math').length,
        katex: document.querySelectorAll('main.tern .t-math .katex').length,
        tex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex),
      }));
      if (r.mathml !== 2 || r.katex !== 0) throw new Error(`${r.mathml} <math>, ${r.katex} .katex (expected 2, 0)`);
      if (r.tex.join(' | ') !== 'a^2 + b^2 = c^2 | \\int_0^1 x\\,dx = \\tfrac12') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      await page.waitForTimeout(200);
      if (ctx.ext.length) throw new Error(`fetched external or math assets: ${ctx.ext.join(', ')}`);
    },
  },
  {
    name: 'a leading :::use block loads its add-ons like data-use; a late one is ignored with use.late',
    url: '/test/smoke/use.html',
    async setup(_context, page, ctx) {
      ctx.reqs = [];
      page.on('request', (q) => /\/addons\/|\/themes\//.test(q.url()) && ctx.reqs.push(q.url().replace(/^https?:\/\/[^/]+/, '')));
    },
    async check(page, ctx) {
      await expect(page, () => document.querySelectorAll('main.tern .t-math .katex').length === 2, 'both formulas typeset by the KaTeX the block loads');
      const r = await page.evaluate(() => ({
        useDivs: document.querySelectorAll('[data-t="use"]').length,
        nord: [...document.styleSheets].some((s) => /\/themes\/nord\.css/.test(s.href || '')),
        cfg: Object.keys(tern.config.use).sort(),
      }));
      if (r.useDivs) throw new Error(`${r.useDivs} :::use elements in the page, expected none`);
      if (!r.nord) throw new Error('the theme the block lists did not load');
      if (JSON.stringify(r.cfg) !== JSON.stringify(['katex', 'nord'])) throw new Error(`config.use ${JSON.stringify(r.cfg)}, expected katex and nord only`);
      await page.waitForTimeout(200);
      if (ctx.reqs.some((u) => /code\.js/.test(u))) throw new Error("the late block's add-on was requested");
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
      ctx.katexAt = null;
      page.on('request', (q) => /\/addons\/katex\.js/.test(q.url()) && ctx.katexAt === null && (ctx.katexAt = Date.now()));
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math typeset', 60000);
      const dcl = await page.evaluate(() => performance.timeOrigin + performance.getEntriesByType('navigation')[0].domContentLoadedEventStart);
      if (ctx.katexAt === null) throw new Error('the add-on was never requested');
      ctx.note(`  addons/katex.js requested ${Math.round(dcl - ctx.katexAt)} ms before DOMContentLoaded`);
      if (ctx.katexAt >= dcl) throw new Error(`the add-on was requested only at DOMContentLoaded (${Math.round(ctx.katexAt - dcl)} ms after): the streaming scan did not fire early`);
    },
  },
  {
    name: 'tern new --guarded: the note renders and the guard stays inert',
    url: '/gen/guarded.html',
    async setup() {
      cliPage('guarded');
    },
    async check(page) {
      await expect(page, () => (document.querySelector('main.tern h1') || {}).textContent === 'Smoke: a guarded note', 'the heading in main.tern');
      const r = await page.evaluate(() => ({ text: document.body.innerText, xmp: document.querySelectorAll('xmp, plaintext').length }));
      if (/did not load|JavaScript is off/.test(r.text) || r.xmp) throw new Error(`the guard acted: ${JSON.stringify(r)}`);
    },
  },
  ...[
    ['tern.js does not load', { setup: (context) => context.route((url) => url.pathname === '/tern.js', (route) => route.abort()) }, 'tern.js did not load; the source follows.'],
    ['JavaScript is off', { context: { javaScriptEnabled: false } }, 'JavaScript is off; the source follows.'],
  ].map(([when, opts, message]) => ({
    name: `tern new --guarded: when ${when}, the note shows as its source`,
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
        main: !!document.querySelector('main.tern'),
      }));
      if (r.p.join() !== message) throw new Error(`the message ${JSON.stringify(r.p)}, expected ${JSON.stringify(message)}`);
      if (!r.source || !r.source.trimStart().startsWith(GUARDED_NOTE.trim().split('\n')[0]) || !r.source.includes(GUARDED_NOTE.trim())) throw new Error(`the source shown ${JSON.stringify(r.source)}, expected the note and nothing before it`);
      if (!r.hidden || r.main) throw new Error(`the guard shows itself (${!r.hidden}) or the note mounted (${r.main})`);
    },
  })),
  {
    name: 'search add-on: the linked notes are indexed, hits link to their block, a missing note is counted, nothing else is fetched',
    url: '/test/smoke/search/index.html',
    allowConsole: /Failed to load resource/,
    async setup(_context, page, ctx) {
      ctx.fetched = [];
      page.on('request', (r) => r.resourceType() !== 'document' && /\/test\/smoke\/search\//.test(r.url()) && ctx.fetched.push(r.url().replace(/^.*\/search\//, '')));
    },
    async check(page, ctx) {
      const status = () => page.evaluate(() => document.querySelector('.t-search-status').textContent);
      await expect(page, () => !/Indexing/.test(document.querySelector('.t-search-status').textContent), 'the index to build');
      if ((await status()) !== '2 notes, 5 entries; 1 could not be read') throw new Error(`status "${await status()}"`);
      const hits = async (q) => {
        await page.fill('.t-search-box', q);
        await page.waitForTimeout(250);
        return page.evaluate(() => [...document.querySelectorAll('.t-search-results > li')].map((li) => ({
          title: li.querySelector('.t-search-title').textContent,
          page: li.querySelector('.t-search-page').textContent,
          href: li.querySelector('a').getAttribute('href').replace(/^.*\/search\//, ''),
          snippet: li.querySelector('.t-search-snippet').textContent,
          marks: [...li.querySelectorAll('mark')].map((m) => m.textContent),
        })));
      };
      let r = await hits('pythag');
      if (r.length !== 1) throw new Error(`"pythag": ${JSON.stringify(r)}, expected the one exercise`);
      if (r[0].title !== 'Exercise 1 I.1' || r[0].page !== 'Alpha: triangles' || r[0].href !== 'alpha.html#ex-1') throw new Error(`"pythag" hit ${JSON.stringify(r[0])}`);
      if (r[0].marks.join() !== 'Pythagoras' || !/using squares/.test(r[0].snippet)) throw new Error(`"pythag" snippet ${JSON.stringify(r[0])}: expected Pythagoras marked and the hard break read as a space`);
      r = await hits('triangle');
      if (r[0].href !== 'alpha.html#tri' || r[0].title !== 'Triangles') throw new Error(`"triangle" first hit ${JSON.stringify(r[0])}, expected the heading (a title hit weighs more)`);
      if (!r.some((h) => h.href === 'beta.html#ex-3') || !r.some((h) => h.href === 'alpha.html#ex-2')) throw new Error(`"triangle" hits ${JSON.stringify(r.map((h) => h.href))}`);
      r = await hits('sqrt');
      if (r.length !== 1 || r[0].href !== 'alpha.html#tri' || r[0].marks.join() !== 'sqrt') throw new Error(`"sqrt" (TeX as written) ${JSON.stringify(r)}`);
      r = await hits('circumference');
      if (r.length !== 2 || r[0].href !== 'beta.html#circ') throw new Error(`"circumference" ${JSON.stringify(r.map((h) => h.href))}, expected beta's section first (shorter) then alpha's exercise`);
      r = await hits('nothingofthesort');
      if (r.length || (await status()) !== 'No results') throw new Error(`a miss: ${JSON.stringify(r)}, status "${await status()}"`);
      await page.fill('.t-search-box', 'circle');
      await page.waitForTimeout(250);
      const url = await page.evaluate(() => location.search);
      if (url !== '?q=circle') throw new Error(`the URL after typing: "${url}", expected ?q=circle`);
      const fetched = [...new Set(ctx.fetched)].sort();
      if (fetched.join() !== 'alpha.html,beta.html,missing.html,vocab.js') throw new Error(`fetched ${fetched.join(', ')}: expected the two notes and the missing one, not hidden.html or notes.txt`);
      if (!ctx.console.some((m) => m.type === 'warning' && /missing\.html could not be fetched/.test(m.text))) throw new Error(`no warning for missing.html; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
      if (ctx.diagnostics.length) throw new Error(`diagnostics ${JSON.stringify(ctx.diagnostics)}`);
    },
  },
  {
    name: 'search add-on: from= takes another page\'s links, ?q= fills the box, limit and placeholder apply, Enter opens the first hit',
    url: '/test/smoke/search-from.html?q=pi',
    allowConsole: /Failed to load resource/,
    async check(page) {
      await expect(page, () => /result/.test(document.querySelector('.t-search-status').textContent), 'the prefilled query to run');
      const r = await page.evaluate(() => ({
        status: document.querySelector('.t-search-status').textContent,
        value: document.querySelector('.t-search-box').value,
        placeholder: document.querySelector('.t-search-box').placeholder,
        hrefs: [...document.querySelectorAll('.t-search-results a')].map((a) => a.getAttribute('href').replace(/^.*\/search\//, '')),
        role: document.querySelector('search.t-search').getAttribute('role'),
      }));
      if (r.status !== '1 result' || r.value !== 'pi' || r.placeholder !== 'Find an exercise') throw new Error(JSON.stringify(r));
      if (r.hrefs.join() !== 'beta.html#circ') throw new Error(`hits ${r.hrefs.join()}, expected beta's section alone (limit=1)`);
      if (r.role !== 'search') throw new Error(`the element is ${r.role}`);
      await page.focus('.t-search-box');
      await page.keyboard.press('Enter');
      await page.waitForURL(/beta\.html#circ$/, { timeout: 5000 });
    },
  },
  {
    name: 'search add-on: index= reads the search.json tern index wrote, fetching no note, hits resolving from the file; an index that cannot be loaded falls back to indexing here',
    url: '/gen/indexed/indexed.html',
    allowConsole: /Failed to load resource/,
    async setup(_context, page, ctx) {
      ctx.fetched = [];
      page.on('request', (r) => r.resourceType() !== 'document' && /\/gen\/indexed\//.test(r.url()) && ctx.fetched.push(r.url().replace(/^.*\/indexed\//, '')));
    },
    async check(page, ctx) {
      const status = (sel) => page.evaluate((sel) => document.querySelector(`${sel} .t-search-status`).textContent, sel);
      await expect(page, () => ['#pre', '#live'].every((s) => document.querySelector(`${s} .t-search-status`) && !/Indexing/.test(document.querySelector(`${s} .t-search-status`).textContent)), 'both boxes to be ready');
      if ((await status('#pre')) !== '3 notes, 6 entries') throw new Error(`status "${await status('#pre')}", expected the index's three notes, the noindex pages left out`);
      if ((await status('#live')) !== '1 note, 3 entries') throw new Error(`the fallback's status "${await status('#live')}", expected alpha.html indexed here`);
      await page.fill('#pre .t-search-box', 'pythag');
      await page.waitForTimeout(250);
      const hits = await page.evaluate(() => [...document.querySelectorAll('#pre .t-search-results > li')].map((li) => ({
        title: li.querySelector('.t-search-title').textContent,
        page: li.querySelector('.t-search-page').textContent,
        href: li.querySelector('a').getAttribute('href').replace(/^.*\/indexed\//, ''),
        marks: [...li.querySelectorAll('mark')].map((m) => m.textContent),
      })));
      if (hits.length !== 2 || hits[0].href !== 'alpha.html#ex-1' || hits[1].href !== 'hidden.html#no') throw new Error(`"pythag": ${JSON.stringify(hits)}, expected the exercise then the hidden note's section`);
      if (hits[0].title !== 'Exercise 1 I.1' || hits[0].page !== 'Alpha: triangles' || hits[0].marks.join() !== 'Pythagoras') throw new Error(`the first hit ${JSON.stringify(hits[0])}`);
      const fetched = [...new Set(ctx.fetched)].sort();
      if (fetched.join() !== 'alpha.html,missing.json,search.json,vocab.js') throw new Error(`fetched ${fetched.join(', ')}: expected the index, the missing index, and alpha.html for the fallback box only`);
      if (!ctx.console.some((m) => m.type === 'warning' && /missing\.json could not be loaded/.test(m.text))) throw new Error(`no warning for missing.json; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
      if (ctx.diagnostics.length) throw new Error(`diagnostics ${JSON.stringify(ctx.diagnostics)}`);
      await page.focus('#pre .t-search-box');
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/gen\/indexed\/alpha\.html#ex-1$/, { timeout: 5000 });
    },
  },
  {
    name: 'notes add-on: lists the catalogue tern index wrote, newest first, with dates and descriptions; sort=title and limit; a catalogue that cannot be loaded says so',
    url: '/gen/indexed/notes.html',
    allowConsole: /Failed to load resource/,
    async check(page, ctx) {
      await expect(page, () => document.querySelectorAll('.t-notes').length === 3 && [...document.querySelectorAll('.t-notes')].every((n) => n.querySelector('.t-notes-list, .t-notes-status')), 'the three lists to settle');
      const r = await page.evaluate(() => [...document.querySelectorAll('.t-notes')].map((n) => ({
        label: n.getAttribute('aria-label'),
        tag: n.tagName,
        items: [...n.querySelectorAll('li')].map((li) => [li.querySelector('.t-notes-title').textContent, li.querySelector('.t-notes-title').getAttribute('href').replace(/^.*\/indexed\//, ''), (li.querySelector('.t-notes-date') || {}).textContent || '', (li.querySelector('.t-notes-desc') || {}).textContent || '']),
        status: (n.querySelector('.t-notes-status') || {}).textContent || '',
      })));
      const want = [
        ['Beta: circles', 'beta.html', '2026-03-01', 'Circles and what is inscribed in them.'],
        ['Alpha: triangles', 'alpha.html', '2026-02-01', 'Right triangles and their hypotenuse.'],
        ['Hidden', 'hidden.html', '2025-12-31', ''],
      ];
      if (JSON.stringify(r[0].items) !== JSON.stringify(want)) throw new Error(`the default list ${JSON.stringify(r[0].items)}, expected newest first, the noindex pages and this page left out`);
      if (JSON.stringify(r[1].items.map((i) => i[0])) !== JSON.stringify(['Alpha: triangles', 'Beta: circles'])) throw new Error(`sort=title limit=2: ${JSON.stringify(r[1].items)}`);
      if (r[2].items.length || !/could not be loaded \(missing\.json\)/.test(r[2].status)) throw new Error(`the missing catalogue: ${JSON.stringify(r[2])}`);
      if (r.some((n) => n.label !== 'Notes' || n.tag !== 'NAV')) throw new Error(`the element: ${JSON.stringify(r.map((n) => [n.tag, n.label]))}`);
      if (!ctx.console.some((m) => m.type === 'warning' && /missing\.json could not be loaded/.test(m.text))) throw new Error(`no warning for missing.json; console: ${JSON.stringify(ctx.console.slice(0, 5))}`);
      if (ctx.diagnostics.length) throw new Error(`diagnostics ${JSON.stringify(ctx.diagnostics)}`);
    },
  },
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
    if (!LIVE_CDN) await routeKatex(context, ctx), await routeCached(context, HLJS_URL, hljsDir), await routeCached(context, MERMAID_URL, mermaidDir);
    if (t.offline) await context.route((url) => url.origin !== origin && ![KATEX_URL, HLJS_URL, MERMAID_URL].some((re) => re.test(url.href)), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
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

// tern.ready settles; ctx gets tern.diagnostics and the CSP violations.
async function waitForReady(page, t, ctx) {
  ctx.step = 'waiting for tern.ready';
  try {
    await page.waitForFunction(() => window.tern && window.tern.ready, null, { timeout: t.readyTimeout || 10000 });
  } catch {
    const seen = await page.evaluate(() => (window.tern ? `window.tern has ${Object.keys(window.tern).slice(0, 8).join(', ')}…` : 'window.tern is undefined')).catch(() => '');
    throw new Error(`expected window.tern.ready (the runtime); ${seen}`);
  }
  await page.evaluate(() => window.tern.ready.then(() => (window.__ternReady = 'yes'), (e) => (window.__ternReady = `rejected: ${e}`)));
  await expect(page, () => window.__ternReady, 'tern.ready to settle', t.readyTimeout || 10000);
  const settled = await page.evaluate(() => window.__ternReady);
  if (settled !== 'yes') throw new Error(`tern.ready ${settled}`);
  ctx.diagnostics = await page.evaluate(() => JSON.parse(JSON.stringify(window.tern.diagnostics || [])));
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
