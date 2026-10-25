#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The browser floor (docs/publishing.html#browsers): Chrome 109, Firefox 78,
// Safari 14. A browser below it is shown the note's source with a message,
// which needs luccet.js to *parse* there: syntax newer than the floor fails the
// whole file before supported() can run, and an API the floor lacks fails
// the first note that reaches it. This lint looks for both in the built
// luccet.js; the
// regex flags `d` and `v` are not looked for, as a regex over source cannot
// tell a flag from a division.
//
//   node test/floor.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['luccet.js'];

// [pattern, what, the first version of a floor browser that has it]
const RULES = [
  [/\(\?<[=!]/, 'a regex lookbehind', 'Safari 16.4'],
  [/\?\?=|\|\|=|&&=/, 'logical assignment', 'Firefox 79'],
  [/\bstatic\s*\{/, 'a class static block', 'Chrome 94, Firefox 93, Safari 16.4'],
  [/^\s*#[A-Za-z_$][\w$]*\s*[=;(]|\.#[A-Za-z_$]/m, 'a private class member', 'Firefox 90, Safari 14.1'],
  [/\.at\(/, 'Array.prototype.at', 'Chrome 92, Firefox 90, Safari 15.4'],
  [/\bObject\.hasOwn\(/, 'Object.hasOwn', 'Chrome 93, Firefox 92, Safari 15.4'],
  [/\bstructuredClone\(/, 'structuredClone', 'Chrome 98, Firefox 94, Safari 15.4'],
  [/\.findLast(?:Index)?\(/, 'Array.prototype.findLast', 'Chrome 97, Firefox 104, Safari 15.4'],
  [/\bWeakRef\b|\bFinalizationRegistry\b/, 'WeakRef', 'Firefox 79, Safari 14.1'],
  [/\bAggregateError\b|\bPromise\.any\(/, 'Promise.any', 'Firefox 79'],
  [/\bIntl\.Segmenter\b/, 'Intl.Segmenter', 'Firefox 125'],
  [/\bAbortSignal\.timeout\(/, 'AbortSignal.timeout', 'Chrome 103, Firefox 100, Safari 16'],
  [/\.(?:toSorted|toReversed|toSpliced)\(|\bObject\.groupBy\(|\bArray\.fromAsync\(/, 'an ES2023 array method', 'Chrome 110, Firefox 115, Safari 16'],
];

const problems = [];
for (const f of FILES) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [re, what, since] of RULES) if (re.test(line)) problems.push(`${f}:${i + 1}: ${what} (${since}): ${line.trim().slice(0, 80)}`);
  });
}
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n✗ floor: ${problems.length} use(s) of syntax or an API above Chrome 88, Firefox 78, Safari 14`);
  process.exit(1);
}
console.log('✓ floor: luccet.js uses nothing above Chrome 88, Firefox 78, Safari 14 (the floor is Chrome 109, for MathML: the checks stay stricter)');
