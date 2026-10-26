#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The live examples of documentation pages as conformance-corpus cases
// (cli/examples.js toCorpus; test/corpus/README.md "Cases from the
// documentation"), so every example in Luccet's documentation is also a
// test of the engine. A tool of this repository's, not a command: it reads
// the pages through docs.js, so it runs their code (in the sandbox, as
// `luccet check` does), and only Luccet's own pages have live examples.
//
//   node tools/corpus.js PATH… [--out=DIR]
//   npm run corpus            the site's pages, to stdout
//
// Paths are pages or folders, searched as `luccet check` searches them.
// Without --out the cases go to stdout, page after page; with it, each page
// with examples is DIR/docs-PAGE.txt (DIR is created). An example that does
// not match its expect, or names an unknown schema, is left out and
// reported as `file:line: message`: exit 1. A usage error exits 2.
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { notNote, htmlFiles, readText } = require('../cli/note');
const examples = require('../cli/examples');

const warn = (s) => process.stderr.write(`${s}\n`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shown = (f) => String(f).split(path.sep).join('/');
const USAGE = 'usage: node tools/corpus.js PATH… [--out=DIR]';

class UsageError extends Error {}

function main(args) {
  let o;
  let positionals;
  try {
    ({ values: o, positionals } = parseArgs({ args, options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (o.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!positionals.length) throw new UsageError('give at least one PATH');
  if (o.out !== undefined && !o.out) throw new UsageError('--out is empty');
  const files = [];
  const seen = new Set();
  for (const p of positionals) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`);
    }
    for (const f of st.isDirectory() ? [...htmlFiles(p)] : [p]) {
      const key = path.resolve(f);
      if (!seen.has(key)) seen.add(key), files.push({ shown: shown(f), named: !st.isDirectory() });
    }
  }
  if (o.out) {
    try {
      fs.mkdirSync(o.out, { recursive: true });
    } catch (e) {
      throw new UsageError(`cannot create ${o.out}: ${e.message}`);
    }
  }
  let cases = 0;
  let pages = 0;
  let failed = false;
  const written = new Map(); // output file -> the page that wrote it
  for (const f of files) {
    let r;
    try {
      r = readText(f.shown);
    } catch (e) {
      throw new UsageError(`cannot read ${f.shown}: ${e.code === 'EISDIR' ? 'it is a directory' : e.message}`);
    }
    if (r.warning) warn(`corpus: ${r.warning}`);
    const x = examples.extract(r.text, f.shown);
    if (!x) {
      if (f.named) warn(`corpus: ${f.shown} is not a note (${notNote(r.text)}); skipped`);
      continue;
    }
    const c = examples.toCorpus(x, f.shown);
    for (const p of c.problems) warn(`${f.shown}:${p.line}: ${p.message}`);
    failed = failed || c.problems.length > 0;
    if (!c.cases) continue;
    cases += c.cases;
    pages++;
    if (!o.out) {
      process.stdout.write(`${pages > 1 ? '\n' : ''}${c.text}`);
      continue;
    }
    const out = path.join(o.out, `docs-${examples.pageSlug(f.shown)}.txt`);
    if (written.has(out)) throw new UsageError(`${f.shown} and ${written.get(out)} would both write ${out}`);
    written.set(out, f.shown);
    fs.writeFileSync(out, c.text);
  }
  warn(`corpus: ${plural(cases, 'case')} from ${plural(pages, 'page')}${o.out ? `, written to ${o.out}` : ''}`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    warn(`corpus: ${e.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}

module.exports = { main };
