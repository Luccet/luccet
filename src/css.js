// SPDX-License-Identifier: MIT
// The base stylesheet, injected by the runtime as <style id="luccet-style"> and
// published as luccet.css. It is functional only: a note looks like plain HTML,
// as the browser draws it (light or dark, by the reader's system), and this
// adds what Luccet's own constructs need to work: line numbers and highlighted
// lines, grids, math (a math font, and what Chromium's MathML leaves to CSS),
// an equation's number at its end, the end mark, task lists,
// scrolling where content would overflow, visible errors and the diagnostics
// panel, math and code isolated as LTR in an RTL note, and print without
// clipping. The look (a reading column, type, a palette) is a theme's
// (github.com/Luccet/themes). The --t-* properties are the contract between
// the two: here they default to the system's colours, or to colours of their
// own where the system has none (errors, a highlighted line). Code's colours,
// --t-code-*, are the code add-on's (github.com/Luccet/code).
'use strict';

const css = `:root {
  color-scheme: light dark;
  --t-bg: Canvas; --t-fg: CanvasText; --t-muted: CanvasText; --t-line: GrayText; --t-line-strong: GrayText; --t-soft: ButtonFace;
  --t-link: LinkText; --t-mark: #fff2a8; --t-error: #b3261e; --t-error-bg: #fdecea; --t-warn: #8a5300;
  --t-sans: system-ui, sans-serif; --t-mono: monospace;
  --t-math: "Latin Modern Math", "STIX Two Math", "Cambria Math", "Libertinus Math", "TeX Gyre Termes Math", "DejaVu Math TeX Gyre", "Noto Sans Math", math;
}
@media (prefers-color-scheme: dark) {
  :root {
    --t-mark: #5c4d00; --t-error: #ffb4ab; --t-error-bg: #3b1714; --t-warn: #e3b341;
  }
}
/* The page in the system's colours, as the browser draws it, said outright: a theme sets them, and
   a tool reading the page (a contrast check, an add-on) sees what the reader sees. GrayText is
   too faint for text in some browsers, so muted text is the text colour until a theme says otherwise. */
html { background: var(--t-bg); color: var(--t-fg); }
.luccet { overflow-wrap: break-word; }
/* A link in a highlight takes the highlight's text colour: a link colour on yellow is unreadable in dark. */
.luccet mark a { color: inherit; }

/* Media keep their aspect ratio when max-width shrinks them, and stay in the page. */
.luccet :is(img, video, canvas, picture) { max-inline-size: 100%; height: auto; }
.luccet :is(iframe, embed, object) { max-inline-size: 100%; }

/* Code: long lines scroll; math and code read left to right in a right-to-left note. */
.t-math, .luccet :is(pre, code, kbd, samp) { direction: ltr; unicode-bidi: isolate; }
.luccet pre { text-align: start; overflow-x: auto; }
.luccet pre[data-lines] code { counter-reset: t-line; }
.luccet pre[data-lines][data-start] code { counter-reset: t-line calc(var(--t-start, 1) - 1); } /* --t-start: the emitter's, or the runtime's (CSSOM) */
.luccet pre[data-lines] .t-line::before {
  counter-increment: t-line; content: counter(t-line); display: inline-block; min-inline-size: 2.5ch;
  margin-inline-end: 1.5ch; text-align: end; color: var(--t-muted); user-select: none;
}
.luccet .t-hl { display: inline-block; min-inline-size: 100%; background: var(--t-mark); }

/* Tables scroll when wider than the page. */
.luccet table { display: block; inline-size: max-content; max-inline-size: 100%; overflow-x: auto; }

/* A generated label reads as one; the end mark sits at the end. */
.t-label { font-weight: bold; }
.t-end { display: block; text-align: end; }

/* Grids: --t-cols from cols= or the cell count; one column on narrow screens. */
.t-cols { display: grid; grid-template-columns: var(--t-cols, repeat(auto-fit, minmax(12rem, 1fr))); gap: 1rem 1.5rem; }
.t-cols > * { margin: 0; min-inline-size: 0; }
.t-cols > .t-title { grid-column: 1 / -1; }
.t-cell { min-inline-size: 0; }
@media (max-width: 36rem) { .t-cols { grid-template-columns: minmax(0, 1fr); } }

/* Math (src/tex.js) is MathML, laid out by the browser in a math font, one with OpenType's math
   table, which stretches brackets and roots and sizes big operators: --t-math names the common ones
   before the browser's own, which on Linux is often not one. Chromium's MathML leaves table alignment,
   boxes and strikes to CSS; a negative space is a negative margin, in TeX's mu. */
.luccet math { font-family: var(--t-math); }
.luccet mtd { padding: .5ex .4em; }
.luccet mtable.t-align > mtr > mtd { padding-block: .25em; }
.luccet mtable.t-align > mtr > mtd:nth-child(odd) { text-align: right; text-align: -webkit-right; padding-inline-end: 0; }
.luccet mtable.t-align > mtr > mtd:nth-child(even) { text-align: left; text-align: -webkit-left; padding-inline-start: 0; }
.luccet mtable.t-align > mtr > mtd:nth-child(even):not(:last-child) { padding-inline-end: 2em; }
.luccet mtable.t-cases > mtr > mtd { text-align: left; text-align: -webkit-left; padding-inline: 0 1em; }
.luccet mtable.t-substack > mtr > mtd { padding: 0; }
.luccet mtd.t-left { text-align: left; text-align: -webkit-left; }
.luccet mtd.t-right { text-align: right; text-align: -webkit-right; }
.luccet mtd.t-vline { border-inline-start: .06em solid; }
.luccet mtd.t-vline-end { border-inline-end: .06em solid; }
.luccet mtr.t-hline > mtd { border-block-start: .06em solid; }
.luccet mtr.t-hline-end > mtd { border-block-end: .06em solid; }
.luccet mrow.t-boxed { border: .06em solid; padding: .2em .3em; }
.luccet mrow.t-overline { border-block-start: .06em solid; padding-block-start: .1em; }
.luccet mrow.t-underline { border-block-end: .06em solid; padding-block-end: .1em; }
.luccet mrow.t-colorbox { padding-inline: .3em; }
.luccet mrow:is(.t-cancel, .t-bcancel, .t-xcancel) { padding-inline: .1em; background-repeat: no-repeat; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
.luccet mrow.t-cancel { background-image: linear-gradient(to top right, transparent calc(50% - .04em), currentColor calc(50% - .04em) calc(50% + .04em), transparent calc(50% + .04em)); }
.luccet mrow.t-bcancel { background-image: linear-gradient(to bottom right, transparent calc(50% - .04em), currentColor calc(50% - .04em) calc(50% + .04em), transparent calc(50% + .04em)); }
.luccet mrow.t-xcancel { background-image: linear-gradient(to top right, transparent calc(50% - .04em), currentColor calc(50% - .04em) calc(50% + .04em), transparent calc(50% + .04em)), linear-gradient(to bottom right, transparent calc(50% - .04em), currentColor calc(50% - .04em) calc(50% + .04em), transparent calc(50% + .04em)); }
.luccet mtext.t-bold { font-weight: bold; }
.luccet mtext.t-italic { font-style: italic; }
.luccet mtext.t-mono { font-family: var(--t-mono); }
.luccet mtext.t-sans { font-family: var(--t-sans); }
.luccet mspace.t-n1 { margin-inline-start: -.0556em; }
.luccet mspace.t-n3 { margin-inline-start: -.1667em; }
.luccet mspace.t-n4 { margin-inline-start: -.2222em; }
.luccet mspace.t-n5 { margin-inline-start: -.2778em; }
.luccet mspace.t-n9 { margin-inline-start: -.5em; }
.luccet mspace.t-n18 { margin-inline-start: -1em; }

/* Display equations scroll rather than overflow; the number sits at the end. */
.t-eq { display: flex; align-items: center; gap: 1rem; overflow-x: auto; overflow-y: hidden; }
.t-eq > .t-math { flex: 1; text-align: center; min-inline-size: 0; }
.t-eqno { white-space: nowrap; }
.t-math[data-display] { display: block; }
.t-macros[hidden] { display: none !important; }

/* A task list's checkbox stands for its bullet. */
.luccet li.t-task { list-style: none; }
.luccet li.t-task > input, .luccet li.t-task > p:first-child > input { margin-inline: -1.4rem .3rem; vertical-align: middle; }

/* Problems stay visible where they are. */
.luccet .t-error { color: var(--t-error); background: var(--t-error-bg); border-inline-start: 3px solid var(--t-error); padding: .3em .6em; white-space: pre-wrap; font-family: var(--t-mono); }
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

/* Forced colours (Windows high-contrast themes): the system's palette throughout, a theme's
   colours notwithstanding (!important), so no theme has to repeat this; a highlight keeps its pair. */
@media (forced-colors: active) {
  :root {
    --t-bg: Canvas !important; --t-fg: CanvasText !important; --t-muted: GrayText !important; --t-line: CanvasText !important;
    --t-line-strong: CanvasText !important; --t-soft: Canvas !important; --t-link: LinkText !important; --t-mark: Highlight !important;
    --t-error: CanvasText !important; --t-error-bg: Canvas !important; --t-warn: CanvasText !important;
  }
  .luccet mark, .luccet .t-hl { color: HighlightText; forced-color-adjust: none; }
  .luccet .t-error, .t-diagnostics { forced-color-adjust: none; border-color: CanvasText; }
  .luccet mrow:is(.t-cancel, .t-bcancel, .t-xcancel) { forced-color-adjust: none; }
}

@media print {
  .t-diagnostics { display: none; }
  .luccet > * { content-visibility: visible !important; } /* the runtime's held blocks (src/runtime.js) */
  /* Dark on light paper, whatever the reader's scheme and the theme (!important, so no theme has to
     repeat this): the system's light colours, and these where the system has none. */
  :root {
    color-scheme: light !important;
    --t-bg: Canvas !important; --t-fg: CanvasText !important; --t-muted: GrayText !important; --t-line: GrayText !important;
    --t-line-strong: GrayText !important; --t-soft: ButtonFace !important; --t-link: LinkText !important; --t-mark: #fff2a8 !important;
    --t-error: #b3261e !important; --t-error-bg: #fdecea !important; --t-warn: #8a5300 !important;
  }
  /* What scrolls on screen is shown whole on paper. */
  .luccet pre { white-space: pre-wrap; }
  .luccet pre, .luccet table, .t-eq { overflow: visible; }
  .luccet table { display: table; inline-size: auto; }
}
`;

module.exports = { css };
