#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Writes the Mermaid table in addons/mermaid.js: the pinned version of the
// npm package mermaid and the SRI hash of its dist/mermaid.min.js. Run it to
// move to another version; it needs the network once per version.
//
// The package comes from the npm registry, through tools/npm.js, which
// keeps that one file in node_modules/.cache/tern-smoke/ (test/smoke.js
// serves the same copy). jsDelivr's /npm/ files are the package's bytes, so
// the hash holds.
//
//   node tools/mermaid.js [VERSION]   rewrite the table (default: the version in it)
//   node tools/mermaid.js --check     exit 1 if the table is not what the version gives
'use strict';

const fs = require('fs');
const path = require('path');
const npm = require('./npm');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'addons', 'mermaid.js');
const START = '  // <mermaid> written by tools/mermaid.js; do not edit by hand';
const END = '  // </mermaid>';

// node_modules/.cache/tern-smoke/mermaid-VERSION/dist/mermaid.min.js.
const packageDir = (version) => npm.packageDir('mermaid', version, { folder: `mermaid-${version}`, keep: ['dist/mermaid.min.js'], has: 'dist/mermaid.min.js' });

async function table(version) {
  const dir = await packageDir(version);
  return [START, '  const MERMAID = {', `    version: '${version}',`, `    sri: '${npm.sri(path.join(dir, 'dist', 'mermaid.min.js'))}',`, '  };', END].join('\n');
}

async function main() {
  const src = fs.readFileSync(ADDON, 'utf8');
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`addons/mermaid.js has no table between "${START.trim()}" and "${END.trim()}"`);
  const current = /version: '([^']+)'/.exec(src.slice(a, b));
  const arg = process.argv.slice(2).find((x) => !x.startsWith('--'));
  const version = arg || (current && current[1]);
  if (!version) throw new Error('no version: give one, as node tools/mermaid.js 12.1.0');
  const out = src.slice(0, a) + (await table(version)) + src.slice(b + END.length);
  if (process.argv.includes('--check')) {
    if (out !== src) {
      console.log(`✗ the Mermaid table in addons/mermaid.js is not mermaid@${version}'s: run node tools/mermaid.js`);
      process.exit(1);
    }
    console.log(`✓ addons/mermaid.js has mermaid@${version}'s table`);
    return;
  }
  fs.writeFileSync(ADDON, out);
  console.log(`wrote mermaid@${version}'s table into addons/mermaid.js`);
}

module.exports = { packageDir };

if (require.main === module)
  main().catch((e) => {
    console.error(`tools/mermaid.js: ${e.message}`);
    process.exit(1);
  });
