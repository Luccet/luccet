// SPDX-License-Identifier: MIT
// luccet build: a note as a static page. The same pipeline as the browser's,
// under node with the note's add-on schema; the page is
//
//   the preserved head (plus a doctype and charset if it lacks them)
//   :::meta written into it: <title>, html[lang|dir], <meta name>
//   viewport and color-scheme metas, if absent
//   luccet's sheets, before the head's first author stylesheet: luccet.css
//     inlined (or the head's link to it, or data-css), then the CSS add-ons
//     of data-use
//   <script src="…luccet.js" data-built>, then the script add-ons as static
//     tags, so that both run before the note's own scripts
//   <main class="luccet"> holding the emitted HTML: luccet.toHTML's output,
//     its formulas MathML
//   <script type="text/luccet" id="luccet-source" data-line="N"> holding the note
//   <script type="application/json" id="luccet-diagnostics"> when it has any
//
// luccet.js still runs on the page (src/runtime.js `startBuilt`): behaviours,
// copy, print, fragments, diagnostics and the events.
'use strict';

const fs = require('fs');
const path = require('path');
const { analyse, attributes, luccet } = require('./note');

const escAttr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
const escText = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

// The note in a <script type="text/luccet">: script data must not hold
// `</script` or `<!--`, so one backslash goes after the `<` of each, and of
// each such run already escaped. Reversible: decodeSource removes it again.
const encodeSource = (s) => s.replace(/<(\\*)(\/script|!--)/gi, '<\\$1$2');
const decodeSource = (s) => s.replace(/<\\(\\*)(\/script|!--)/gi, '<$1$2');

// JSON inside a <script>: `<` as its JSON escape, so no `</script` or `<!--`.
const LT_ESCAPE = '\\' + 'u003c';
const scriptJson = (v) => JSON.stringify(v).replace(/</g, LT_ESCAPE);

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

// build(text, file, {noScripts}) -> null when the file is not a note, else
// {html, diagnostics, warnings, math: {total}, use, nonce, toFile}. The
// formulas are MathML, as the engine writes them.
function build(text, file, opts = {}) {
  const a = analyse(text, file, { noScripts: opts.noScripts });
  if (!a) return null;
  const attrs = attributes(a.tag);
  const warnings = [];
  // Loading vocabulary under node (addon.failed, addon.remote, head.script)
  // is the build's problem, not the page's: those have no note position. A
  // remote add-on is only an info to luccet check, but the page is emitted
  // without its schema, so the build warns.
  for (const d of a.diagnostics) {
    if (d.position) continue;
    if (d.code === 'addon.remote') warnings.push(`${d.message.replace(/; names it declares are unknown to luccet check$/, '')}, so the page uses its names without its schema`);
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

  // The formulas are the engine's MathML, like the rest of the body.
  // data-katex on the tag, read before 2.0, is named so it can be removed.
  if (attrs['data-katex'] !== undefined) warnings.push('data-katex on the luccet.js tag is not read since 2.0, when math became built in: remove it');
  const body = luccet.emit(a.ast, a.opts);
  // The emitter's own diagnostic (output.limit), found only now: on the page and the console like the others.
  for (const d of (a.ast.data && a.ast.data.luccet && a.ast.data.luccet.diagnostics) || []) if (d.code === 'output.limit') notes.push(Object.assign({ filePosition: a.toFile(d.position) }, d));
  const total = (body.match(/\bclass="(?:[^"]*\s)?t-math[\s"]/g) || []).length;

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
  const meta = (a.ast.data && a.ast.data.luccet && a.ast.data.luccet.meta) || {};
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

  // Luccet's sheets, in cascade order: the base, then the CSS add-ons, before
  // the head's first author stylesheet so the author's rules win; a head link
  // to luccet.css (or to data-css) is the base itself, and the group forms
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
  const base = sheets.find((s) => s.href != null && (s.href === css || /(?:^|\/)luccet(?:\.min)?\.css$/i.test(s.href.replace(/[?#].*$/, ''))));
  const after = use.filter(isCss).map((u) => link(u));
  if (base) {
    head = [head.slice(0, base.start), head.slice(base.start, base.end), ...after.map((x) => `\n${x}`), head.slice(base.end)].join('');
  } else {
    const own = css ? link(css) : `<style id="luccet-style"${n}>\n${luccet.css}</style>`;
    const group = [own, ...after];
    const at = sheets.length ? sheets[0].start : head.length;
    head = at < head.length ? `${head.slice(0, at)}${group.join('\n')}\n${head.slice(at)}` : `${head}\n${group.join('\n')}`;
  }

  // luccet.js, marked as a built page. The tag keeps its data-use, with the `:::use` block's
  // entries merged in: the block emits nothing, and luccet.js on the built page
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
    `<main class="luccet">${body}</main>`,
    `<script type="text/luccet" id="luccet-source" data-line="${a.line}">${encodeSource(a.note)}</script>`,
    ...(notes.length ? [`<script type="application/json" id="luccet-diagnostics">${scriptJson(notes.map(({ filePosition, ...d }) => d))}</script>`] : []),
    '',
  ].join('\n');
  return { html: page, diagnostics: notes, warnings, math: { total }, use, nonce: attrs['data-nonce'] || null, toFile: a.toFile };
}

module.exports = { build, decodeSource, escAttr };
