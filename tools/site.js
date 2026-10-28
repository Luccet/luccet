#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The site luccet.dev serves, built into a folder for GitHub Pages: the
// pages (index.html, docs/, examples/), LICENSE, and the working tree's
// luccet.css and minified luccet.js, which the workflows check out from a
// release; and each release from 2.0 on in a folder of its own, rebuilt
// from its tag:
//
//   vX.Y.Z/luccet.js, luccet.css   a release, the same bytes at every deploy
//   vX.Y/                          the newest release of the series
//   vX/                            the newest release of the major
//
// cdn.luccet.dev, a bunny.net pull zone with luccet.dev as its origin, serves
// these folders under the cache a file that never changes can have: its edge
// rules give a release's folder a year and a series' or a major's an
// hour, where Pages gives every file ten minutes. Pages replaces the whole
// site at each deploy, so each deploy builds every release again;
// a release's bytes stay the same because its tag does, and so does the
// terser its own tree names (TERSER below, or release.yml's in a tree that
// predates this file). A new pin changes the next releases, not the served.
//
//   node tools/site.js [--out DIR]       build the site into DIR (default _site), emptied first
//   node tools/site.js --minify IN OUT   minify one luccet.js as a release's is (the release's asset)
//
// Either checks each minified file: V8's compile hint still on its first
// line (tools/concat.js), the version it should be, and a note it renders.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TERSER = 'terser@5.51.2';
const FIRST = 2; // the first major served: 1.x was tern.js
const PAGES = ['index.html', 'docs', 'examples', 'luccet.css', 'LICENSE'];

function fail(message) {
  console.log(`✗ ${message}`);
  process.exit(1);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}

function check(file, version) {
  if (!fs.readFileSync(file, 'utf8').startsWith('//# allFunctionsCalledOnLoad\n')) fail(`${file}: V8's compile hint is not its first line`);
  const engine = require(path.resolve(file));
  if (engine.version !== version) fail(`${file}: luccet.version is ${engine.version}, not ${version}`);
  const html = engine.toHTML('# Hi {#top}\n\nSee @top.\n');
  if (!/<h1 id="top">Hi<\/h1>/.test(html) || !/t-ref/.test(html)) fail(`${file}: the minified build does not render`);
}

function minify(source, out, version, terser = TERSER) {
  const r = spawnSync('npx', ['--yes', terser, '--compress', '--mangle', '--comments', '/allFunctionsCalledOnLoad/', '--output', out], { input: source, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${terser} failed on ${version}: ${(r.stderr || '').trim().split('\n')[0]}`);
  check(out, version);
}

// The releases served, oldest first: every vX.Y.Z tag from the major FIRST on.
function releases() {
  return (git(['tag', '--list', 'v*']) || '')
    .split('\n')
    .map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim()))
    .filter((m) => m && Number(m[1]) >= FIRST)
    .map((m) => ({ tag: m[0], version: m[0].slice(1), parts: m.slice(1).map(Number) }))
    .sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2]);
}

// The terser a release is minified with, as its own tree names it.
function terserOf(tag) {
  const site = git(['cat-file', 'blob', `${tag}:tools/site.js`]);
  const m = site ? /^const TERSER = '(terser@[\d.]+)';/m.exec(site) : /npx --yes (terser@[\d.]+) luccet\.js/.exec(git(['cat-file', 'blob', `${tag}:.github/workflows/release.yml`]) || '');
  if (!m) fail(`${tag}: its tree names no terser`);
  return m[1];
}

function build(out) {
  const inside = path.relative(out, ROOT);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) fail(`${out} holds the repository; name a folder of its own`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of PAGES) fs.cpSync(path.join(ROOT, f), path.join(out, f), { recursive: true });
  fs.rmSync(path.join(out, 'docs', 'README.md'), { force: true }); // the folder's page on GitHub, not the site's
  const current = require(path.join(ROOT, 'luccet.js')).version;
  minify(fs.readFileSync(path.join(ROOT, 'luccet.js'), 'utf8'), path.join(out, 'luccet.js'), current);

  const list = releases();
  for (const r of list) {
    const js = git(['cat-file', 'blob', `${r.tag}:luccet.js`]);
    const css = git(['cat-file', 'blob', `${r.tag}:luccet.css`]);
    if (js === null || css === null) fail(`${r.tag}: no luccet.js or luccet.css in its tree`);
    fs.mkdirSync(path.join(out, r.tag));
    fs.writeFileSync(path.join(out, r.tag, 'luccet.css'), css);
    minify(js, path.join(out, r.tag, 'luccet.js'), r.version, terserOf(r.tag));
  }
  // Copies, since Pages has no redirects; oldest first, so the newest is the last set.
  const newest = new Map();
  for (const r of list) newest.set(`v${r.parts[0]}.${r.parts[1]}`, r).set(`v${r.parts[0]}`, r);
  for (const [name, r] of newest) fs.cpSync(path.join(out, r.tag), path.join(out, name), { recursive: true });

  console.log(`✓ ${path.relative(process.cwd(), out) || out}: the pages, luccet.js ${current}, ${list.length ? list.map((r) => r.tag).join(' ') : 'no release yet'}`);
  for (const [name, r] of newest) console.log(`  ${name}/ is ${r.tag}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--minify') {
    if (args.length !== 3) fail('usage: node tools/site.js --minify IN OUT');
    const [, input, output] = args;
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    minify(fs.readFileSync(input, 'utf8'), output, require(path.resolve(input)).version);
    return console.log(`✓ ${output}: ${input} minified with ${TERSER}`);
  }
  const at = args.indexOf('--out');
  if (args.length !== (at === -1 ? 0 : 2) || (at !== -1 && !args[at + 1])) fail('usage: node tools/site.js [--out DIR]');
  build(path.resolve(at === -1 ? path.join(ROOT, '_site') : args[at + 1]));
}

main();
