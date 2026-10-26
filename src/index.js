// SPDX-License-Identifier: MIT
// The engine's public API (docs/api.html). Everything returned is
// JSON-serialisable.
'use strict';

const { normalise } = require('./scan');
const { createContext, visit } = require('./ast');
const { sortDiagnostics } = require('./diag');
const { parseBlocks } = require('./block');
const { outline } = require('./outline');
const search = require('./search');
const glossary = require('./glossary');
const registry = require('./schema');
const pipeline = require('./transform');
const { emit } = require('./emit');
const { css } = require('./css');
const T = require('./tex');
const { symbols: TEX_SYMBOLS } = require('./tex-symbols');
const runtime = require('./runtime');

const version = '2.0.0';
// The add-on contract's number (docs/addon-api.html): it changes only when
// the contract breaks, which only a major release may do, and not at every
// major. What a minor release adds, an add-on finds by feature detection.
const api = 2;

// The schema a call uses: opts.schema when given (the corpus passes one),
// else the registry that luccet.block/leaf/inline write.
const withSchema = (opts) => (opts && opts.schema ? opts : { ...opts, schema: registry.schema });

// parse(source, {schema, head, maxDepth}) -> {ast, diagnostics}
// `source` is the note (everything after the luccet.js line); `head` is the
// preserved head as a string, for `:::meta` conflicts; `schema` is the
// registry {block, leaf, inline}, with `strict: true` for name.unknown.
function parse(source, opts) {
  const ctx = createContext(normalise(source), withSchema(opts));
  const ast = parseBlocks(ctx);
  return { ast, diagnostics: sortDiagnostics(ctx.diagnostics) };
}

// transform(ast, opts) -> ast: runs the transforms in place and appends
// their diagnostics to ast.data.luccet.diagnostics.
// transform(name, fn, {before | after}) registers a transform.
function transform(ast, opts, order) {
  if (typeof ast === 'string') return pipeline.register(ast, opts, order);
  return pipeline.run(ast, withSchema(opts));
}

// Every diagnostic for a note: the parser's and the transforms', in order.
function check(source, opts) {
  const o = withSchema(opts);
  const { ast, diagnostics } = parse(source, o);
  pipeline.run(ast, o);
  return sortDiagnostics(diagnostics.concat(ast.data.luccet.diagnostics));
}

// toHTML(source, {schema, head, positions, safe}) -> the body HTML, synchronously.
function toHTML(source, opts) {
  const o = withSchema(opts);
  const { ast } = parse(source, o);
  return emit(pipeline.run(ast, o), o);
}

// tex(source, {display, macros}) -> {mathml} | {error: {code, message,
// hint, at, end}}: one formula as the math transform makes it, macros
// being the page's ({'\\RR': '\\mathbb{R}'}). tex.symbols: the symbol
// commands, [name, char, class], for editors and the docs.
function tex(source, opts) {
  const o = opts || {};
  const r = T.render(String(source), { display: !!o.display, macros: T.table(o.macros) });
  return r.mathml ? { mathml: r.mathml } : { error: r.error };
}
tex.symbols = Object.freeze([...TEX_SYMBOLS].map(([name, [k, c]]) => Object.freeze([name, c, k])));

module.exports = {
  version,
  api,
  parse,
  transform,
  emit: (ast, opts) => emit(ast, withSchema(opts)),
  toHTML,
  check,
  visit,
  outline,
  search,
  glossary,
  tex,
  schema: registry.schema,
  block: registry.block,
  leaf: registry.leaf,
  inline: registry.inline,
  get transforms() {
    return pipeline.names();
  },
  css,
};

// The runtime's API (define, undefine, on, render, ready, diagnostics,
// config, style) on the same object; in a browser it also starts the
// runtime. Under node it is inert.
runtime.attach(module.exports);
