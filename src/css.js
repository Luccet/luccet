// SPDX-License-Identifier: MIT
// The base stylesheet, injected by the runtime as <style id="luccet-style"> and
// published as luccet.css. It styles the emitter's output: blocks have no look
// of their own; add-ons and the note's own CSS style them by class and data-t.
// It uses logical properties throughout and isolates math and code as LTR, so
// RTL notes work.
'use strict';

const css = `:root {
  color-scheme: light dark;
  --t-bg: #fdfdfb; --t-fg: #1f2328; --t-muted: #636c76; --t-line: #d9dde3; --t-line-strong: #767676; --t-soft: #f3f4f1;
  --t-link: #0b62c4; --t-mark: #fff2a8; --t-error: #b3261e; --t-error-bg: #fdecea; --t-warn: #8a5300;
  --t-code-comment: #59636e; --t-code-keyword: #cf222e; --t-code-string: #0a3069; --t-code-number: #0550ae; --t-code-function: #6639ba;
  --t-code-type: #953800; --t-code-variable: #0550ae; --t-code-meta: #116329; --t-code-inserted: #116329; --t-code-deleted: #82071e;
  --t-font: Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif;
  --t-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --t-mono: ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --t-width: 40rem; --t-size: 1.125rem; --t-leading: 1.6; /* 18px at the browser's default size, so a reader's own size setting holds */
}
@media (prefers-color-scheme: dark) {
  :root {
    --t-bg: #16181c; --t-fg: #dcdfe4; --t-muted: #8b949e; --t-line: #30363d; --t-line-strong: #8b949e; --t-soft: #1f2329;
    --t-link: #6cb0ff; --t-mark: #5c4d00; --t-error: #ffb4ab; --t-error-bg: #3b1714; --t-warn: #e3b341;
    --t-code-comment: #949da6; --t-code-keyword: #ff7b72; --t-code-string: #a5d6ff; --t-code-number: #79c0ff; --t-code-function: #d2a8ff;
    --t-code-type: #ffa657; --t-code-variable: #79c0ff; --t-code-meta: #7ee787; --t-code-inserted: #7ee787; --t-code-deleted: #ffa198;
  }
}
html { background: var(--t-bg); color: var(--t-fg); font: var(--t-size)/var(--t-leading) var(--t-font); -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 2.5rem 1rem 6rem; }
.luccet { max-width: var(--t-width); margin-inline: auto; overflow-wrap: break-word; hanging-punctuation: first last; }
.luccet > :first-child { margin-block-start: 0; }
.luccet :is(h1, h2, h3, h4, h5, h6) { font-family: var(--t-sans); line-height: 1.25; margin-block: 2em .6em; text-wrap: balance; }
/* Body text wraps for an even rag and no stranded last word; headings balance. */
.luccet :is(p, li, dd, blockquote, figcaption, caption, .t-title) { text-wrap: pretty; }
.luccet h1 { font-size: 1.9rem; }
.luccet h2 { font-size: 1.4rem; padding-block-end: .25em; border-block-end: 1px solid var(--t-line); }
.luccet h3 { font-size: 1.15rem; }
.luccet :is(h4, h5, h6) { font-size: 1rem; }
.luccet :is(p, ul, ol, dl, pre, table, blockquote, figure, details), .t-block, .t-eq { margin-block: 0 1rem; margin-inline: 0; }
.luccet a { color: var(--t-link); text-decoration-thickness: .06em; text-underline-offset: .15em; }
.luccet :is(ul, ol) { padding-inline-start: 1.6rem; }
.luccet li > :is(ul, ol) { margin-block-end: 0; }
.luccet li > p { margin-block-end: .5rem; }
.luccet hr { border: 0; border-block-start: 1px solid var(--t-line); margin-block: 2rem; }
.luccet blockquote { padding-inline-start: 1rem; border-inline-start: 3px solid var(--t-line); color: var(--t-muted); }
/* Text in a highlight is the text colour, whatever it was (muted, a link, which keeps its underline): the pair that is checked is fg on mark. */
.luccet mark, .luccet mark a { color: var(--t-fg); }
.luccet mark { background: var(--t-mark); padding-inline: .15em; border-radius: 2px; }

/* Media keep their aspect ratio when max-width shrinks them. */
.luccet :is(img, video, canvas, picture) { max-inline-size: 100%; height: auto; }
.luccet :is(iframe, embed, object) { max-inline-size: 100%; }

/* Code. Math and code read left to right in a right-to-left note. */
.luccet :is(code, kbd, samp, pre) { font-family: var(--t-mono); font-size: .85em; }
.luccet pre code { font-size: 1em; }
.luccet :not(pre) > code { background: var(--t-soft); padding: .12em .35em; border-radius: 4px; }
.luccet kbd { border: 1px solid var(--t-line-strong); border-block-end-width: 2px; border-radius: 4px; padding: .05em .4em; }
.t-math, .luccet :is(pre, code, kbd, samp) { direction: ltr; unicode-bidi: isolate; }
.luccet pre { text-align: start; background: var(--t-soft); padding: .8rem 1rem; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
.luccet pre[data-lines] code { counter-reset: t-line; }
.luccet pre[data-lines][data-start] code { counter-reset: t-line calc(var(--t-start, 1) - 1); } /* --t-start: the emitter's, or the runtime's (CSSOM) */
.luccet pre[data-lines] .t-line::before {
  counter-increment: t-line; content: counter(t-line); display: inline-block; min-inline-size: 2.5ch;
  margin-inline-end: 1.5ch; text-align: end; color: var(--t-muted); user-select: none;
}
.luccet .t-hl { display: inline-block; min-inline-size: 100%; background: var(--t-mark); }

/* Tables scroll when wider than the column. */
.luccet table { border-collapse: collapse; display: block; inline-size: max-content; max-inline-size: 100%; overflow-x: auto; font-size: .95em; }
.luccet :is(th, td) { border: 1px solid var(--t-line); padding: .35em .7em; }
.luccet th { background: var(--t-soft); font-family: var(--t-sans); font-size: .9em; }
.luccet caption { caption-side: top; text-align: start; padding-block-end: .4em; }

/* Named blocks, titles, labels and end marks. */
.t-title { font-weight: 600; margin-block-end: .4rem; }
.luccet :is(figcaption, caption).t-title { font-weight: normal; color: var(--t-muted); font-size: .95em; }
.luccet figcaption.t-title { margin-block: .4rem 0; }
.t-label { font-weight: 700; }
.t-end { display: block; text-align: end; }
.t-block > :last-child, .t-cell > :last-child, .luccet blockquote > :last-child { margin-block-end: 0; }
.luccet figure > img { display: block; margin-inline: auto; }

/* Grids: --t-cols from cols= or the cell count; one column on narrow screens. */
.t-cols { display: grid; grid-template-columns: var(--t-cols, repeat(auto-fit, minmax(12rem, 1fr))); gap: 1rem 1.5rem; }
.t-cols > * { margin: 0; min-inline-size: 0; }
.t-cols > .t-title { grid-column: 1 / -1; }
.t-cell { min-inline-size: 0; }
@media (max-width: 36rem) { .t-cols { grid-template-columns: minmax(0, 1fr); } }

/* Math: display equations scroll rather than overflow; the number sits at the end. */
.t-eq { display: flex; align-items: center; gap: 1rem; overflow-x: auto; overflow-y: hidden; }
.t-eq > .t-math { flex: 1; text-align: center; min-inline-size: 0; }
.t-eqno { color: var(--t-muted); font-family: var(--t-font); white-space: nowrap; }
.t-math[data-display] { display: block; }
.t-macros[hidden] { display: none !important; }

/* Footnotes and task lists. */
.t-fnref { line-height: 0; font-size: .75em; }
.t-fnref a, .t-fnback { text-decoration: none; }
.t-footnotes { border-block-start: 1px solid var(--t-line); margin-block-start: 3rem; padding-block-start: 1rem; font-size: .9em; }
.luccet li.t-task { list-style: none; }
.luccet li.t-task > input, .luccet li.t-task > p:first-child > input { margin-inline: -1.4rem .3rem; vertical-align: middle; }

/* Problems stay visible where they are. */
.luccet .t-error { color: var(--t-error); background: var(--t-error-bg); border-inline-start: 3px solid var(--t-error); padding: .3em .6em; white-space: pre-wrap; font-family: var(--t-mono); font-size: .85em; }
.luccet .t-eq.t-error { display: block; }

/* The diagnostics panel: fixed at the end corner, outside main, never printed. */
.t-diagnostics {
  position: fixed; inset-block-end: .75rem; inset-inline-end: .75rem; z-index: 2147483647;
  max-inline-size: min(40rem, calc(100vw - 1.5rem)); max-block-size: 60vh; overflow: auto;
  background: var(--t-bg); color: var(--t-fg); border: 1px solid var(--t-line-strong); border-inline-start: 4px solid var(--t-error);
  border-radius: 6px; box-shadow: 0 4px 18px rgb(0 0 0 / .18); font: 13px/1.45 var(--t-sans);
}
.t-diagnostics summary { cursor: pointer; padding: .45rem .75rem; font-weight: 600; }
.t-diagnostics ol { margin: 0; padding-block: 0 .6rem; padding-inline: 2.2rem .75rem; }
.t-diagnostics li { margin-block: .35rem; }
.t-diag-sev { font-weight: 700; text-transform: uppercase; font-size: .78em; letter-spacing: .03em; }
.t-diag-error .t-diag-sev { color: var(--t-error); }
.t-diag-warning .t-diag-sev { color: var(--t-warn); }
.t-diag-info .t-diag-sev, .t-diag-at, .t-diag-hint { color: var(--t-muted); }
.t-diag-code { font-family: var(--t-mono); font-size: .95em; }
.t-diag-hint { display: block; }

/* A reader asking for more contrast: muted text in the text colour, rules and borders in the strong line. */
@media (prefers-contrast: more) {
  :root { --t-muted: #1f2328; --t-line: #767676; }
  @media (prefers-color-scheme: dark) { :root { --t-muted: #dcdfe4; --t-line: #8b949e; } }
}
/* Forced colours (Windows high-contrast themes): the system's palette throughout; a highlight keeps its pair. */
@media (forced-colors: active) {
  :root {
    --t-bg: Canvas; --t-fg: CanvasText; --t-muted: GrayText; --t-line: CanvasText; --t-line-strong: CanvasText; --t-soft: Canvas;
    --t-link: LinkText; --t-mark: Highlight; --t-error: CanvasText; --t-error-bg: Canvas; --t-warn: CanvasText;
  }
  .luccet mark, .luccet .t-hl { color: HighlightText; forced-color-adjust: none; }
  .luccet .t-error, .t-diagnostics { forced-color-adjust: none; border-color: CanvasText; }
}

@media print {
  .t-diagnostics { display: none; }
  .luccet > * { content-visibility: visible !important; } /* the runtime's held blocks (src/runtime.js) */
  /* Every colour: black on white, the rest the light palette's, even for a reader in dark mode. */
  :root {
    color-scheme: light; --t-size: 11pt;
    --t-bg: #fff; --t-fg: #000; --t-muted: #555; --t-line: #d9dde3; --t-line-strong: #767676; --t-soft: #f3f4f1;
    --t-link: #0b62c4; --t-mark: #fff2a8; --t-error: #b3261e; --t-error-bg: #fdecea; --t-warn: #8a5300;
    --t-code-comment: #59636e; --t-code-keyword: #cf222e; --t-code-string: #0a3069; --t-code-number: #0550ae; --t-code-function: #6639ba;
    --t-code-type: #953800; --t-code-variable: #0550ae; --t-code-meta: #116329; --t-code-inserted: #116329; --t-code-deleted: #82071e;
  }
  body { padding: 0; }
  .luccet { max-width: none; }
  /* Paged typesetting: no stranded lines across a page break, no heading left
     at a page's foot, and figures, equations, quotes and table rows kept whole. */
  .luccet :is(p, li, blockquote) { orphans: 3; widows: 3; }
  .luccet :is(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
  .luccet :is(figure, figcaption, .t-eq, blockquote, tr) { break-inside: avoid; }
  .luccet pre { white-space: pre-wrap; }
  .luccet pre, .luccet table, .t-eq { overflow: visible; }
  .luccet table { display: table; inline-size: auto; }
}
`;

module.exports = { css };
