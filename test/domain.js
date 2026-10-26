#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One address. The documentation lives at luccet.dev and the repository at
// github.com/Luccet/luccet; the old ones (ozkr.ac/tern, OzkrAC/tern, a
// github.io copy of the site) redirect or are gone, so a link to them sends a
// reader astray. This lint looks for them in every tracked text file but
// CHANGELOG.md, whose past entries keep the addresses of their day and whose
// entry for the rename names the old ones on purpose, and checks
// package.json's homepage.
//
//   node test/domain.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://luccet.dev/';
const SKIP = new Set(['CHANGELOG.md', 'test/domain.js']);

// [pattern, what it is]
const RULES = [
  [/\bozkr\.ac\b/i, 'the old site, ozkr.ac'],
  [/\b[\w-]+\.github\.io\/(?:tern|luccet)(?![.\w-])/i, 'a github.io copy of the site'], // not a file such as USER.github.io/luccet.js
  [/\bluccet\.github\.io\b/i, 'the organization\'s github.io address'],
  [/\bOzkrAC\/(?:tern|luccet)\b/i, 'the old repository, OzkrAC/tern'],
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const problems = [];
let scanned = 0;
for (const f of files) {
  if (SKIP.has(f)) continue;
  const file = path.join(ROOT, f);
  let text;
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue; // binary
    text = buf.toString('utf8');
  } catch {
    continue; // listed but gone from the working tree
  }
  scanned++;
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of RULES) if (re.test(line)) problems.push(`${f}:${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
  });
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.homepage !== SITE) problems.push(`package.json: homepage is ${JSON.stringify(pkg.homepage)}, not ${SITE}`);

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n✗ domain: ${problems.length} link(s) to an old address; the site is ${SITE}, the repository github.com/Luccet/luccet`);
  process.exit(1);
}
console.log(`✓ domain: ${scanned} files name only ${SITE} and github.com/Luccet/luccet`);
