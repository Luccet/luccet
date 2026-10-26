// SPDX-License-Identifier: MIT
// The diagnostic codes, each with its effect on what the author wrote, and
// report(), behind the parser's ctx.report. The severity follows from the
// effect (docs/diagnostics.html#severity):
//   lost     something the author wrote (text, a line or a block of the note,
//            a footnote's definition) does not reach the page: an error;
//   changed  it reaches the page with another structure or meaning (the rest
//            of the note inside a block, a construct cut short): an error;
//   kept     it reaches the page as written, as text or with an attribute or
//            an option not applied, which is probably not what was meant: a
//            warning;
//   hint     the page is what the author meant: an info.
'use strict';

const LOST = 'lost';
const CHANGED = 'changed';
const KEPT = 'kept';
const HINT = 'hint';
const SEVERITY_OF = { lost: 'error', changed: 'error', kept: 'warning', hint: 'info' };

// Every code the parser and the transforms report (transform.js reads the
// severities too). The runtime and the command line have codes of their own.
const EFFECT = {
  'block.unclosed': CHANGED,
  'block.closer-mismatch': CHANGED,
  'block.stray-closer': KEPT,
  'block.closer-count': HINT,
  'block.opener-junk': CHANGED,
  'block.bad-opener': KEPT,
  'block.spaced-name': KEPT,
  'block.unclosed-fence': CHANGED,
  'fence.info-junk': KEPT,
  'html.unclosed': CHANGED,
  'html.stray-closer': HINT,
  'html.wrapper': KEPT,
  // Verbatim, so kept; a formatting tag such as <b> also carries on into the
  // paragraphs after it in the browser, which an HTML hazard check would split
  // out as an error.
  'html.inline-unclosed': KEPT,
  'html.inline-escaped': HINT,
  'math.unclosed': CHANGED,
  'math.opener-tail': CHANGED,
  'math.closer-tail': KEPT,
  'math.inline-display': KEPT,
  'math.unclosed-inline': KEPT,
  'math.bracket': KEPT,
  'math.suspect-price': KEPT,
  // In a formula (src/tex.js): it is shown as its TeX.
  'tex.unknown': CHANGED,
  'tex.unsupported': CHANGED,
  'tex.unbalanced': CHANGED,
  'tex.argument': CHANGED,
  'tex.script': CHANGED,
  'tex.misplaced': CHANGED,
  'tex.macro': CHANGED,
  'tex.limit': CHANGED,
  'attr.overridden': KEPT,
  'html.self-closed': CHANGED,
  'attr.malformed': KEPT,
  'attributes.orphan': KEPT,
  'attributes.raw': KEPT,
  'table.stray-delimiter': KEPT,
  'table.row-unterminated': KEPT,
  'table.misplaced-separator': KEPT,
  'table.extra-cell': KEPT,
  'cell.orphan': KEPT,
  'leaf.demoted': KEPT,
  'leaf.void-content': KEPT,
  'inline.unclosed': KEPT,
  'inline.glued': KEPT,
  'footnote.undefined': KEPT,
  'footnote.duplicate': LOST,
  'footnote.nested': KEPT,
  'footnote.unused': HINT,
  'latex.delimiters': KEPT,
  'latex.linebreak': KEPT,
  'nesting.limit': CHANGED,
  'doc.frontmatter': KEPT,
  'meta.conflict': KEPT, // the head's value, which is the author's too
  'meta.duplicate': KEPT, // the first value, as an id.duplicate keeps the first id
  'meta.malformed': LOST,
  'meta.nested': LOST,
  'name.reserved': KEPT,
  'tag.not-allowed': KEPT,
  'table.body': KEPT,
  'id.invalid': KEPT,
  'id.duplicate': KEPT,
  'ref.dangling': KEPT,
  'ref.unreferenceable': KEPT,
  'use.late': LOST,
  'name.unknown': HINT,
};

const SEVERITY = {};
for (const code of Object.keys(EFFECT)) SEVERITY[code] = SEVERITY_OF[EFFECT[code]];

// Appends one diagnostic. `start` and `end` are offsets into the normalised
// source (end exclusive; defaults to start). An unknown code is a bug in the
// engine, so it throws rather than reporting something unlisted.
function report(ctx, code, start, end, message, hint) {
  const severity = SEVERITY[code];
  if (!severity) throw new Error(`luccet: unknown diagnostic code ${code}`);
  const d = { code, severity, message, position: ctx.position(start, end == null ? start : end) };
  if (hint) d.hint = hint;
  ctx.diagnostics.push(d);
  return d;
}

// Document order, then code, so output is stable whatever order phases report in.
function sortDiagnostics(list) {
  return list.sort(
    (a, b) =>
      a.position.start.offset - b.position.start.offset ||
      a.position.end.offset - b.position.end.offset ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

module.exports = { EFFECT, SEVERITY_OF, SEVERITY, report, sortDiagnostics };
