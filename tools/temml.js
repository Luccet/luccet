#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Writes the Temml table in addons/mathml.js: the pinned version of the npm
// package temml and the SRI hashes of its dist/temml.min.js and
// dist/Temml-Local.css. Run it to move to another version; it needs the
// network once per version.
//
// The package comes from the npm registry, through tools/npm.js, which keeps
// those files in node_modules/.cache/tern-smoke/ (test/smoke.js serves the
// same copy). jsDelivr's /npm/ files are the package's bytes, so the hashes
// hold.
//
//   node tools/temml.js [VERSION]   rewrite the table (default: the version in it)
//   node tools/temml.js --check     exit 1 if the table is not what the version gives
'use strict';

const fs = require('fs');
const path = require('path');
const npm = require('./npm');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'addons', 'mathml.js');
const START = '  // <temml> written by tools/temml.js; do not edit by hand';
const END = '  // </temml>';

// node_modules/.cache/tern-smoke/temml-VERSION/dist/: the whole dist, so the
// same copy serves the add-on (temml.min.js, Temml-Local.css, Temml.woff2) and
// pre-renders in node (temml.cjs), as test/smoke.js uses it.
const packageDir = (version) => npm.packageDir('temml', version, { folder: `temml-${version}`, keep: ['dist/'], has: 'dist/temml.min.js' });

async function table(version) {
  const dir = await packageDir(version);
  return [
    START,
    '  const TEMML = {',
    `    version: '${version}',`,
    `    js: '${npm.sri(path.join(dir, 'dist', 'temml.min.js'))}',`,
    `    css: '${npm.sri(path.join(dir, 'dist', 'Temml-Local.css'))}',`,
    '  };',
    END,
  ].join('\n');
}

async function main() {
  const src = fs.readFileSync(ADDON, 'utf8');
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`addons/mathml.js has no table between "${START.trim()}" and "${END.trim()}"`);
  const current = /version: '([^']+)'/.exec(src.slice(a, b));
  const arg = process.argv.slice(2).find((x) => !x.startsWith('--'));
  const version = arg || (current && current[1]);
  if (!version) throw new Error('no version: give one, as node tools/temml.js 0.14.0');
  const out = src.slice(0, a) + (await table(version)) + src.slice(b + END.length);
  if (process.argv.includes('--check')) {
    if (out !== src) {
      console.log(`✗ the Temml table in addons/mathml.js is not temml@${version}'s: run node tools/temml.js`);
      process.exit(1);
    }
    console.log(`✓ addons/mathml.js has temml@${version}'s table`);
    return;
  }
  fs.writeFileSync(ADDON, out);
  console.log(`wrote temml@${version}'s table into addons/mathml.js`);
}

module.exports = { packageDir };

if (require.main === module)
  main().catch((e) => {
    console.error(`tools/temml.js: ${e.message}`);
    process.exit(1);
  });
