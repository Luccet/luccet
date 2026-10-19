// SPDX-License-Identifier: MIT
// tern build: a note as a static page. The same pipeline as the browser's,
// under node with the note's add-on schema; the page is
//
//   the preserved head (plus a doctype and charset if it lacks them)
//   :::meta written into it: <title>, html[lang|dir], <meta name>
//   viewport and color-scheme metas, if absent
//   tern's sheets, before the head's first author stylesheet: KaTeX's CSS
//     (when math is pre-rendered), tern.css inlined (or the head's link to it,
//     or data-css), then the CSS add-ons of data-use
//   <script src="…tern.js" data-built>, then the script add-ons as static
//     tags, so that both run before the note's own scripts
//   <main class="tern"> holding the emitted HTML: tern.toHTML's output
//   <script type="text/tern" id="tern-source" data-line="N"> holding the note
//   <script type="application/json" id="tern-diagnostics"> when it has any
//
// tern.js still runs on the page (src/runtime.js `startBuilt`): behaviours,
// math the build left, copy, print, fragments, diagnostics and the events.
// With `katex`, formulas are pre-rendered to HTML+MathML by the katex npm
// package, if it can be required (it is not a dependency).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyse, attributes, tern } = require('./note');
const { styleTag } = require('./diagrams');

const escAttr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
const escText = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

// The note in a <script type="text/tern">: script data must not hold
// `</script` or `<!--`, so one backslash goes after the `<` of each, and of
// each such run already escaped. Reversible: decodeSource removes it again.
const encodeSource = (s) => s.replace(/<(\\*)(\/script|!--)/gi, '<\\$1$2');
const decodeSource = (s) => s.replace(/<\\(\\*)(\/script|!--)/gi, '<$1$2');

// JSON inside a <script>: `<` as its JSON escape, so no `</script` or `<!--`.
const LT_ESCAPE = '\\' + 'u003c';
const scriptJson = (v) => JSON.stringify(v).replace(/</g, LT_ESCAPE);

// ---------------------------------------------------------------- KaTeX

// The katex npm package, from the CLI's own resolution (and NODE_PATH), then
// from the note's directory and the working directory: {katex, main} or null.
function requireKatex(dir) {
  const tries = [() => require.resolve('katex'), () => require.resolve('katex', { paths: [dir, process.cwd()] })];
  for (const resolve of tries) {
    try {
      const main = resolve();
      const katex = require(main);
      if (katex && typeof katex.renderToString === 'function') return { katex, main };
    } catch {}
  }
  return null;
}

// Where the page loads KaTeX's CSS from: the tag's data-katex base, else the
// CDN at the installed version, with SRI computed from the package's own
// copy (jsDelivr serves the npm tarball's bytes).
function katexSheet(k, base) {
  if (base) return { href: `${base.replace(/\/+$/, '')}/katex.min.css`, integrity: null };
  const file = path.join(path.dirname(k.main), 'katex.min.css');
  let integrity = null;
  try {
    integrity = `sha384-${crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64')}`;
  } catch {}
  return { href: `https://cdn.jsdelivr.net/npm/katex@${k.katex.version}/dist/katex.min.css`, integrity };
}

// ---------------------------------------------------------------- Temml

// The temml npm package (--math=mathml), resolved like katex: {temml, main}
// or null. It renders TeX to native MathML.
function requireTemml(dir) {
  const tries = [() => require.resolve('temml'), () => require.resolve('temml', { paths: [dir, process.cwd()] })];
  for (const resolve of tries) {
    try {
      const main = resolve();
      const temml = require(main);
      if (temml && typeof temml.renderToString === 'function') return { temml, main };
    } catch {}
  }
  return null;
}

// Temml's stylesheet, inlined so the page stays one self-contained file: its
// one font (Temml.woff2, for script letters) becomes a data: URL. Native
// MathML needs no font for the rest. Null when the package's files cannot be
// read, in which case the browser draws the MathML with no extra styles.
function temmlCss(main) {
  const dir = path.dirname(main);
  let css;
  try {
    css = fs.readFileSync(path.join(dir, 'Temml-Local.css'), 'utf8');
  } catch {
    return null;
  }
  try {
    const woff2 = fs.readFileSync(path.join(dir, 'Temml.woff2')).toString('base64');
    css = css.replace(/url\((['"]?)Temml\.woff2\1\)/g, `url(data:font/woff2;base64,${woff2})`);
  } catch {}
  return css;
}

// Pre-renders the formulas to native MathML with Temml, as prerender() does
// with KaTeX: the :::macros bodies make a preamble, then each formula with
// throwOnError and annotate (the TeX kept in an <annotation>, so it still
// copies as $tex$). A formula Temml rejects stays as its TeX source, since a
// MathML page turns tern.js's KaTeX off.
function prerenderMathml(ast, M) {
  const failures = [];
  const formulas = [];
  const macroNodes = [];
  walk(ast, (n) => {
    if (n.type === 'containerDirective' && n.name === 'macros') macroNodes.push(n);
    else if (n.type === 'inlineMath' || (n.type === 'math' && !(n.data && n.data.tern && n.data.tern.unclosed))) formulas.push(n);
  });
  let macros = {};
  const preamble = macroNodes.map((n) => n.value || '').join('\n');
  if (preamble.trim()) {
    try {
      macros = M.definePreamble(preamble);
    } catch (e) {
      failures.push({ node: macroNodes[0], message: `the :::macros block does not parse: ${e.message}` });
    }
  }
  const open = String.fromCharCode(0xe000) + crypto.randomBytes(4).toString('hex');
  const close = String.fromCharCode(0xe001);
  const done = [];
  for (const n of formulas) {
    try {
      const html = M.renderToString(n.value || '', { throwOnError: true, annotate: true, displayMode: n.type === 'math', macros });
      done.push({ n, value: n.value || '', html });
      n.value = `${open}${done.length - 1}${close}`;
    } catch (e) {
      failures.push({ node: n, message: `Temml cannot render this formula, so it stays as its TeX source: ${e.message}` });
    }
  }
  const at = new RegExp(`>${open}(\\d+)${close}</span>`, 'g');
  const left = new RegExp(`${open}(\\d+)${close}`, 'g');
  return {
    count: done.length,
    failures,
    fill: (html) => html.replace(at, (_, i) => ` data-tex="${escAttr(done[i].value)}">${done[i].html}</span>`).replace(left, (_, i) => escText(done[i].value)),
    restore: () => done.forEach((d) => (d.n.value = d.value)),
  };
}

// Every node of the tree, toc entries included (they hold copies of the
// headings' inline nodes), in document order.
function walk(root, fn) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    fn(n);
    const toc = n.data && n.data.tern && n.data.tern.toc;
    const kids = [...(n.children || []), ...(Array.isArray(toc) ? toc : [])];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

// Pre-renders the formulas as the runtime typesets them: every :::macros
// body first, into one shared table, then each formula with throwOnError. A
// formula KaTeX rejects is left for tern.js, which reports math.error on the
// page. The rendered HTML goes in through placeholders in the math nodes'
// values, which emit() writes as text.
function prerender(ast, K) {
  const macros = {};
  const failures = [];
  const formulas = [];
  walk(ast, (n) => {
    if (n.type === 'containerDirective' && n.name === 'macros') {
      try {
        K.renderToString(n.value || '', { throwOnError: true, displayMode: false, globalGroup: true, macros });
      } catch (e) {
        failures.push({ node: n, message: `the :::macros block does not parse: ${e.message}` });
      }
    } else if (n.type === 'inlineMath' || (n.type === 'math' && !(n.data && n.data.tern && n.data.tern.unclosed))) formulas.push(n);
  });
  const open = String.fromCharCode(0xe000) + crypto.randomBytes(4).toString('hex');
  const close = String.fromCharCode(0xe001);
  const done = [];
  for (const n of formulas) {
    try {
      const html = K.renderToString(n.value || '', { throwOnError: true, displayMode: n.type === 'math', macros });
      done.push({ n, value: n.value || '', html });
      n.value = `${open}${done.length - 1}${close}`;
    } catch (e) {
      failures.push({ node: n, message: `KaTeX cannot typeset this formula, so tern.js will: ${e.message}` });
    }
  }
  const at = new RegExp(`>${open}(\\d+)${close}</span>`, 'g');
  const left = new RegExp(`${open}(\\d+)${close}`, 'g');
  return {
    count: done.length,
    failures,
    // The emitted span is `<span class="t-math" …>PLACEHOLDER</span>`: its
    // TeX goes into data-tex, which the runtime reads instead of the text.
    fill: (html) => html.replace(at, (_, i) => ` data-tex="${escAttr(done[i].value)}">${done[i].html}</span>`).replace(left, (_, i) => escText(done[i].value)),
    restore: () => done.forEach((d) => (d.n.value = d.value)),
  };
}

// ---------------------------------------------------------------- the head

const SHEETS = /<link\b[^>]*>|<style\b[^>]*>/gi;

// The head with lang/dir on <html> (written into its tag, or a tag added
// after the doctype).
function htmlAttributes(head, add) {
  const extra = Object.keys(add)
    .map((k) => ` ${k}="${escAttr(add[k])}"`)
    .join('');
  if (!extra) return head;
  const m = /<html\b[^>]*>/i.exec(head);
  if (m) {
    const end = m.index + m[0].length;
    return head.slice(0, m.index) + m[0].slice(0, -1).replace(/\s*\/$/, '') + extra + '>' + head.slice(end);
  }
  const d = /<!doctype[^>]*>/i.exec(head);
  const at = d ? d.index + d[0].length : 0;
  return `${head.slice(0, at)}<html${extra}>${head.slice(at)}`;
}

// ---------------------------------------------------------------- build

// build(text, file, {math, noScripts, diagrams}) -> null when the file is not
// a note, else {html, diagnostics, failures, warnings, math:{total,
// prerendered, engine}, use, nonce, toFile}. math is 'katex' (pre-render with
// KaTeX), 'mathml' (native MathML with Temml) or absent (formulas left for
// tern.js at view time). With diagrams, the head carries the stylesheet the
// diagrams cli/diagrams.js draws into the page need (removed again if none
// is drawn).
function build(text, file, opts = {}) {
  const a = analyse(text, file, { noScripts: opts.noScripts });
  if (!a) return null;
  const dir = path.dirname(path.resolve(file));
  const attrs = attributes(a.tag);
  const warnings = [];
  // Loading vocabulary under node (addon.failed, addon.remote, head.script)
  // is the build's problem, not the page's: those have no note position. A
  // remote add-on is only an info to tern check, but the page is emitted
  // without its schema, so the build warns.
  for (const d of a.diagnostics) {
    if (d.position) continue;
    if (d.code === 'addon.remote') warnings.push(`${d.message.replace(/; names it declares are unknown to tern check$/, '')}, so the page uses its names without its schema`);
    else if (d.code === 'addon.failed') {
      // An add-on that threw keeps what it registered before the error, as in
      // a browser; one that never ran (missing, not a script) adds nothing.
      const why = /did not load: it threw: /.test(d.message)
        ? 'the page uses what it registered before the error'
        : /^the add-on .* did not load: /.test(d.message)
          ? 'the page uses its names without its schema'
          : 'the page is written without it';
      warnings.push(`${d.message}; ${why}`);
    }
    else if (d.severity !== 'info') warnings.push(d.message);
  }
  const notes = a.diagnostics.filter((d) => d.position);

  // Math, pre-rendered when asked for and the package is there. KaTeX
  // (--math=katex) makes HTML+MathML; Temml (--math=mathml) makes native
  // MathML and turns tern.js's KaTeX off for the page. data-katex="none"
  // skips KaTeX pre-rendering (nothing is rendered at all).
  const katexBase = (attrs['data-katex'] || '').trim();
  let pre = null;
  let sheet = null;
  let mathml = false;
  if (opts.math === 'katex' && katexBase === 'none') warnings.push('data-katex="none": math is not rendered, so it is not pre-rendered either');
  else if (opts.math === 'katex') {
    const k = requireKatex(dir);
    if (!k) warnings.push('the katex package cannot be required (npm install katex); formulas are left to tern.js');
    else {
      pre = prerender(a.ast, k.katex);
      sheet = katexSheet(k, katexBase);
    }
  } else if (opts.math === 'mathml') {
    const t = requireTemml(dir);
    if (!t) warnings.push('the temml package cannot be required (npm install temml); formulas are left to tern.js');
    else {
      pre = prerenderMathml(a.ast, t.temml);
      sheet = temmlCss(t.main) ? { inlineCss: temmlCss(t.main) } : null;
      mathml = true;
    }
  }
  let body;
  try {
    body = tern.emit(a.ast, a.opts);
  } finally {
    if (pre) pre.restore();
  }
  if (pre) body = pre.fill(body);
  // The emitter's own diagnostic (output.limit), found only now: on the page and the console like the others.
  for (const d of (a.ast.data && a.ast.data.tern && a.ast.data.tern.diagnostics) || []) if (d.code === 'output.limit') notes.push(Object.assign({ filePosition: a.toFile(d.position) }, d));
  const total = (body.match(/\bclass="(?:[^"]*\s)?t-math[\s"]/g) || []).length;
  const prerendered = pre ? pre.count : 0;
  if (pre && !pre.count) sheet = null;

  // The head: preserved, with the canonical first line's doctype and charset.
  let head = a.head;
  if (!/<!doctype\s+html\b/i.test(head)) {
    head = `<!doctype html>${head}`;
    warnings.push('the note has no <!doctype html>; the page adds it');
  }
  if (!/<meta\b[^>]*\scharset\s*=/i.test(head) && !/<meta\b[^>]*\shttp-equiv\s*=\s*["']?content-type/i.test(head)) {
    const d = /<!doctype[^>]*>/i.exec(head);
    head = `${head.slice(0, d.index + d[0].length)}<meta charset="utf-8">${head.slice(d.index + d[0].length)}`;
    warnings.push('the note has no <meta charset>; the page adds <meta charset="utf-8">');
  }

  // :::meta, statically: what the head does not set already.
  const meta = (a.ast.data && a.ast.data.tern && a.ast.data.tern.meta) || {};
  const htmlTag = (/<html\b[^>]*>/i.exec(head) || [''])[0];
  const has = attributes(htmlTag.replace(/^<html/i, ''));
  const add = {};
  for (const k of ['lang', 'dir']) if (meta[k] != null && has[k] === undefined) add[k] = meta[k];
  head = htmlAttributes(head, add);
  const named = new Set((head.match(/<meta\b[^>]*>/gi) || []).map((t) => (attributes(t).name || '').toLowerCase()).filter(Boolean));
  const lines = [];
  if (meta.title != null && !/<title\b/i.test(head)) lines.push(`<title>${escText(meta.title)}</title>`);
  for (const k of Object.keys(meta)) {
    if (k === 'title' || k === 'lang' || k === 'dir' || named.has(k.toLowerCase())) continue;
    lines.push(`<meta name="${escAttr(k)}" content="${escAttr(meta[k])}">`);
    named.add(k.toLowerCase());
  }
  if (!named.has('viewport')) lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (!named.has('color-scheme')) lines.push('<meta name="color-scheme" content="light dark">');

  // Tern's sheets, in cascade order: KaTeX, the base, the CSS add-ons, before
  // the head's first author stylesheet so the author's rules win; a head link
  // to tern.css (or to data-css) is the base itself, and the group forms
  // around it.
  const n = attrs['data-nonce'] ? ` nonce="${escAttr(attrs['data-nonce'])}"` : '';
  const link = (href, sri) => `<link rel="stylesheet" href="${escAttr(href)}"${sri ? ` integrity="${sri}" crossorigin="anonymous"` : ''}${n}>`;
  // The add-ons: the tag's data-use, then the leading `:::use` block's.
  const use = (attrs['data-use'] || '').split(/\s+/).filter(Boolean).concat((a.use || []).map((e) => e.url));
  const isCss = (u) => /\.css$/i.test(u.replace(/[?#].*$/, ''));
  const sheets = [];
  for (const m of head.matchAll(SHEETS)) {
    const at = attributes(m[0]);
    if (/^<link/i.test(m[0]) && !/(?:^|\s)stylesheet(?:\s|$)/i.test(at.rel || '')) continue;
    sheets.push({ start: m.index, end: m.index + m[0].length, href: /^<link/i.test(m[0]) ? at.href || '' : null });
  }
  const css = attrs['data-css'];
  const base = sheets.find((s) => s.href != null && (s.href === css || /(?:^|\/)tern(?:\.min)?\.css$/i.test(s.href.replace(/[?#].*$/, ''))));
  const before = sheet ? [sheet.inlineCss ? `<style id="tern-temml-style"${n}>\n${sheet.inlineCss}</style>` : link(sheet.href, sheet.integrity)] : [];
  const after = use.filter(isCss).map((u) => link(u));
  if (opts.diagrams) after.push(styleTag(attrs['data-nonce']));
  if (base) {
    head = [head.slice(0, base.start), ...before.map((x) => `${x}\n`), head.slice(base.start, base.end), ...after.map((x) => `\n${x}`), head.slice(base.end)].join('');
  } else {
    const own = css ? link(css) : `<style id="tern-style"${n}>\n${tern.css}</style>`;
    const group = [...before, own, ...after];
    const at = sheets.length ? sheets[0].start : head.length;
    head = at < head.length ? `${head.slice(0, at)}${group.join('\n')}\n${head.slice(at)}` : `${head}\n${group.join('\n')}`;
  }

  // tern.js, marked as a built page. The engine renders no math itself, so a
  // formula that was not pre-rendered shows only if the note loads a math
  // add-on; one pre-rendered here is already typeset (KaTeX HTML) or native
  // MathML (Temml). The tag keeps its data-use, with the `:::use` block's
  // entries merged in: the block emits nothing, and tern.js on the built page
  // reads the tag alone.
  let tag = a.tag.replace(/^<script/i, '<script data-built');
  if (a.use && a.use.length) {
    const value = ` data-use="${escAttr(use.join(' '))}"`;
    tag = /\sdata-use\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(tag) ? tag.replace(/\sdata-use\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, value) : tag.replace(/\s*\/?>$/, (m) => value + m);
  }
  const scripts = use.filter((u) => !isCss(u)).map((u) => `<script src="${escAttr(u)}"${n}></script>`);
  const page = [
    head,
    ...lines,
    `${tag}</script>${scripts.join('')}`,
    `<main class="tern">${body}</main>`,
    `<script type="text/tern" id="tern-source" data-line="${a.line}">${encodeSource(a.note)}</script>`,
    ...(notes.length ? [`<script type="application/json" id="tern-diagnostics">${scriptJson(notes.map(({ filePosition, ...d }) => d))}</script>`] : []),
    '',
  ].join('\n');
  return { html: page, diagnostics: notes, failures: pre ? pre.failures : [], warnings, math: { total, prerendered, engine: pre ? (mathml ? 'mathml' : 'katex') : null }, use, nonce: attrs['data-nonce'] || null, toFile: a.toFile };
}

module.exports = { build, decodeSource, escAttr };
