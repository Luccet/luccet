#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The npm package, luccet: what `npm pack` would ship (the engine, its
// declarations, the command line and what it requires, the add-ons, the
// themes, the skill; not the documentation, the examples or the tests), the
// exports map resolving what the documentation requires, the declarations'
// surface matching the engine's, and the manifest's fields.
//
//   node test/package.js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const luccet = require('../luccet.js');

let failed = 0;
const results = [];
function test(name, fn) {
  const problems = [];
  try {
    fn(problems);
  } catch (e) {
    problems.push((e && e.message) || String(e));
  }
  if (problems.length) failed++;
  results.push(problems.length ? `✗ ${name}\n  ${problems.join('\n  ')}` : `✓ ${name}`);
}

test('the manifest: a public scoped package with the engine, its types, the bin and the exports map', (p) => {
  if (pkg.name !== 'luccet') p.push(`name ${pkg.name}`);
  if (pkg.private) p.push('private: true would refuse npm publish');
  if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') p.push('publishConfig.access must be public for a scoped package');
  if (pkg.main !== 'luccet.js' || pkg.types !== 'luccet.d.ts') p.push(`main ${pkg.main}, types ${pkg.types}`);
  if (!pkg.bin || pkg.bin.luccet !== 'luccet-cli.js') p.push(`bin ${JSON.stringify(pkg.bin)}`);
  if (pkg.version !== luccet.version) p.push(`package.json ${pkg.version}, luccet.version ${luccet.version}`);
  const root = pkg.exports && pkg.exports['.'];
  if (!root || root.types !== './luccet.d.ts' || root.default !== './luccet.js') p.push(`exports["."] ${JSON.stringify(root)}`);
  for (const sub of ['./luccet.css', './cli/*', './src/*', './addons/*', './themes/*', './test/fixtures/detect.json', './package.json']) if (!pkg.exports || !pkg.exports[sub]) p.push(`no export for ${sub}`);
});

test('what npm pack ships: the engine and the command line, not the documentation or the tests', (p) => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return p.push(`npm pack --dry-run exited ${r.status}: ${r.stderr.trim().split('\n')[0]}`);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  const has = (f) => files.includes(f);
  for (const f of ['luccet.js', 'luccet.css', 'luccet.d.ts', 'luccet-cli.js', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'cli/commands.js', 'cli/language.js', 'cli/lsp.js', 'cli/sandbox.js', 'src/schema.js', 'src/use.js', 'addons/katex.js', 'themes/nord.css', 'skills/luccet-notes/SKILL.md', 'test/fixtures/detect.json', 'tools/npm.js', 'tools/katex.js']) {
    if (!has(f)) p.push(`${f} is not in the package`);
  }
  const stray = files.filter((f) => /^(docs|examples|test)\//.test(f) && f !== 'test/fixtures/detect.json');
  if (stray.length) p.push(`in the package but not meant to be: ${stray.slice(0, 5).join(', ')}${stray.length > 5 ? '…' : ''}`);
  if (has('index.html')) p.push('index.html (the site) is in the package');
  const size = JSON.parse(r.stdout)[0].unpackedSize;
  if (size > 2 * 1024 * 1024) p.push(`unpacked size ${(size / 1048576).toFixed(1)} MB, over 2 MB`);
});

test('the declarations name every export of the engine, and nothing else', (p) => {
  const dts = fs.readFileSync(path.join(ROOT, 'luccet.d.ts'), 'utf8');
  const iface = dts.slice(dts.indexOf('export interface Luccet {'), dts.indexOf('export type Visitor'));
  const declared = new Set([...iface.matchAll(/^\s+(?:readonly )?([a-zA-Z]+)[(:?]/gm)].map((m) => m[1]));
  for (const k of Object.keys(luccet)) if (!declared.has(k)) p.push(`luccet.${k} is not declared in luccet.d.ts`);
  for (const k of declared) if (!(k in luccet)) p.push(`luccet.d.ts declares luccet.${k}, which the engine lacks`);
  if (!/^export = luccet;$/m.test(dts)) p.push('luccet.d.ts does not `export = luccet`');
});

test('every exported subpath exists', (p) => {
  for (const [sub, target] of Object.entries(pkg.exports || {})) {
    const t = typeof target === 'string' ? target : target.default;
    if (!t) continue;
    const file = t.includes('*') ? path.dirname(t) : t;
    if (!fs.existsSync(path.join(ROOT, file))) p.push(`${sub} → ${t}: nothing there`);
  }
});

// V8's explicit compile hint (docs/publishing.html#performance, tools/concat.js):
// a comment line that must come before any code, or it does nothing.
test('the engine asks to be compiled as it arrives: //# allFunctionsCalledOnLoad before its code', (p) => {
  const lines = fs.readFileSync(path.join(ROOT, 'luccet.js'), 'utf8').split('\n');
  const head = lines.slice(0, lines.findIndex((l) => !l.startsWith('//')));
  if (!head.includes('//# allFunctionsCalledOnLoad')) p.push(`the comment lines before the code are ${JSON.stringify(head)}`);
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} package checks pass`);
process.exit(failed ? 1 : 0);
