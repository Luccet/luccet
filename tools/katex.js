#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Writes the KaTeX table in addons/katex.js: the pinned version of the npm
// package katex and the SRI hashes of its dist/katex.min.js and
// dist/katex.min.css. Run it to move to another version; it needs the network
// once per version.
//
// The package comes from the npm registry, through tools/npm.js, which keeps
// its dist in node_modules/.cache/tern-smoke/ (test/smoke.js serves the same
// copy). jsDelivr's /npm/ files are the package's bytes, so the hashes hold.
//
//   node tools/katex.js [VERSION]   rewrite the table (default: the version in it)
//   node tools/katex.js --check     exit 1 if the table is not what the version gives
'use strict';

const fs = require('fs');
const path = require('path');
const npm = require('./npm');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'addons', 'katex.js');
const START = '  // <katex> written by tools/katex.js; do not edit by hand';
const END = '  // </katex>';

// node_modules/.cache/tern-smoke/katex-VERSION/dist/: the whole dist, so the
// same copy serves the add-on (katex.min.js, katex.min.css and its fonts) and
// pre-renders in node (katex.js), as test/smoke.js uses it.
const packageDir = (version) => npm.packageDir('katex', version, { folder: `katex-${version}`, keep: ['dist/'], has: 'dist/katex.min.js' });

async function table(version) {
  const dir = await packageDir(version);
  return [
    START,
    '  const KATEX = {',
    `    version: '${version}',`,
    `    js: '${npm.sri(path.join(dir, 'dist', 'katex.min.js'))}',`,
    `    css: '${npm.sri(path.join(dir, 'dist', 'katex.min.css'))}',`,
    '  };',
    END,
  ].join('\n');
}

async function main() {
  const src = fs.readFileSync(ADDON, 'utf8');
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`addons/katex.js has no table between "${START.trim()}" and "${END.trim()}"`);
  const current = /version: '([^']+)'/.exec(src.slice(a, b));
  const arg = process.argv.slice(2).find((x) => !x.startsWith('--'));
  const version = arg || (current && current[1]);
  if (!version) throw new Error('no version: give one, as node tools/katex.js 0.19.0');
  const out = src.slice(0, a) + (await table(version)) + src.slice(b + END.length);
  if (process.argv.includes('--check')) {
    if (out !== src) {
      console.log(`✗ the KaTeX table in addons/katex.js is not katex@${version}'s: run node tools/katex.js`);
      process.exit(1);
    }
    console.log(`✓ addons/katex.js has katex@${version}'s table`);
    return;
  }
  fs.writeFileSync(ADDON, out);
  console.log(`wrote katex@${version}'s table into addons/katex.js`);
}

module.exports = { packageDir };

if (require.main === module)
  main().catch((e) => {
    console.error(`tools/katex.js: ${e.message}`);
    process.exit(1);
  });
