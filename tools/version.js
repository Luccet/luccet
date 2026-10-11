#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Tern's version, everywhere it is written. package.json holds it; the
// PLACES below repeat it (tern.version in src/index.js, the README's
// jsDelivr tag and release series, the docs' examples of output), each
// found by the text around it. tern.js is rebuilt from src/, not edited.
//
//   node tools/version.js                    list the places and what each says
//   node tools/version.js X.Y.Z              set the version everywhere, rebuild tern.js
//   node tools/version.js patch|minor|major  the same, with the next version
//   node tools/version.js --check            exit 1 if a place disagrees with package.json (CI)
//
// The check also reads every file git tracks: one that names the version
// outside a place fails it, so a new mention is added to PLACES and the
// next bump cannot miss it.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// [file, text]: {v} is the version, {xy} its release series (X.Y for X.Y.Z).
// `built` places are tools/concat.js's to write.
const PLACES = [
  ['package.json', '"version": "{v}"'],
  ['src/index.js', "const version = '{v}';"],
  ['tern.js', '// tern.js {v}: built from src/', { built: true }],
  ['tern.js', "const version = '{v}';", { built: true }],
  ['README.md', 'cdn.jsdelivr.net/gh/OscarAC/tern@v{v}/tern.js'],
  ['README.md', 'use `@{xy}` (the newest {xy}.x)'],
  ['docs/api.html', "| engine | `'{v}'` |"],
  ['docs/api.html', "tern.version;                    // → '{v}'"],
  ['docs/api.html', "as a string: `'{v}'`"],
  ['docs/publishing.html', '```text\ntern {v}: '],
  ['docs/tools.html', '$ tern --version\n{v}\n'],
  ['docs/tools.html', '"serverInfo": { "name": "tern", "version": "{v}" }'],
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const series = (v) => v.split('.').slice(0, 2).join('.');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const lineOf = (text, at) => text.slice(0, at).split('\n').length;

// A place's text as a regex, a group for each {v} and {xy}, in order.
function compile(text) {
  const kinds = [];
  const source = text
    .split(/(\{v\}|\{xy\})/)
    .map((part) => {
      if (part === '{v}') return kinds.push('v'), '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';
      if (part === '{xy}') return kinds.push('xy'), '(\\d+\\.\\d+)';
      return esc(part);
    })
    .join('');
  return { re: new RegExp(source, 'dg'), kinds };
}

// Each place with what it says: [{file, text, built, found: [{line, values, spans}]}].
function places() {
  return PLACES.map(([file, text, o]) => {
    const { re, kinds } = compile(text);
    const body = fs.existsSync(path.join(ROOT, file)) ? read(file) : '';
    const found = [...body.matchAll(re)].map((m) => ({
      line: lineOf(body, kinds.length ? m.indices[1][0] : m.index),
      span: [m.index, m.index + m[0].length],
      values: kinds.map((kind, i) => ({ kind, value: m[i + 1], at: m.indices[i + 1] })),
    }));
    return { file, text, built: !!(o && o.built), found };
  });
}

// The files git tracks, or every file but node_modules/ and .git/ without git.
function tracked() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split('\0').filter(Boolean);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) e.name !== 'node_modules' && e.name !== '.git' && walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out;
}

// What disagrees with version `v`: a place that says another version, or
// is gone, and a tracked file that names `v` outside every place.
function problems(v) {
  const out = [];
  const list = places();
  const covered = new Map(); // file -> spans
  for (const p of list) {
    if (!p.found.length) out.push(`${p.file}: no longer has ${JSON.stringify(p.text)}; update PLACES in tools/version.js`);
    for (const f of p.found) {
      if (!covered.has(p.file)) covered.set(p.file, []);
      covered.get(p.file).push(f.span);
      for (const x of f.values) {
        const want = x.kind === 'v' ? v : series(v);
        if (x.value !== want) out.push(`${p.file}:${f.line}: says ${x.value}, not ${want}${p.built ? ' (run node tools/concat.js)' : ''}`);
      }
    }
  }
  const token = new RegExp(`(?<![\\d.])${esc(v)}(?!\\.?\\d)`, 'g');
  for (const file of tracked()) {
    let body;
    try {
      body = fs.readFileSync(path.join(ROOT, file));
    } catch {
      continue; // deleted but not yet staged
    }
    if (body.subarray(0, 8000).includes(0)) continue; // binary
    const text = body.toString('utf8');
    const spans = covered.get(file) || [];
    for (const m of text.matchAll(token)) {
      if (!spans.some(([a, b]) => m.index >= a && m.index < b)) out.push(`${file}:${lineOf(text, m.index)}: names ${v} where no place in tools/version.js is; add one, so a bump updates it`);
    }
  }
  return out;
}

// The version after `v`: a keyword, or one given.
function next(v, arg) {
  const [, x, y, z, pre] = SEMVER.exec(v).map((n, i) => (i >= 1 && i <= 3 ? Number(n) : n));
  if (arg === 'patch') return pre ? `${x}.${y}.${z}` : `${x}.${y}.${z + 1}`;
  if (arg === 'minor') return pre && z === 0 ? `${x}.${y}.0` : `${x}.${y + 1}.0`;
  if (arg === 'major') return pre && y === 0 && z === 0 ? `${x}.0.0` : `${x + 1}.0.0`;
  return arg.replace(/^v/, '');
}

// -1, 0 or 1; a pre-release comes before its release.
function compare(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (pa[4] === pb[4]) return 0;
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : 1;
  return pa[4] < pb[4] ? -1 : 1;
}

function fail(lines, hint) {
  for (const l of lines) console.log(`✗ ${l}`);
  if (hint) console.log(hint);
  process.exit(1);
}

function main() {
  const current = JSON.parse(read('package.json')).version;
  if (!SEMVER.test(current)) fail([`package.json: version "${current}" is not X.Y.Z or X.Y.Z-pre`]);
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const p = problems(current);
    if (p.length) fail(p);
    console.log(`✓ every place says ${current}`);
    return;
  }

  if (!args.length) {
    console.log(`tern ${current} (package.json)`);
    for (const p of places()) {
      if (!p.found.length) console.log(`  ✗ ${p.file}: ${JSON.stringify(p.text)} not found`);
      for (const f of p.found) console.log(`  ${f.values.every((x) => x.value === (x.kind === 'v' ? current : series(current))) ? '✓' : '✗'} ${p.file}:${f.line}  ${f.values.map((x) => x.value).join(', ')}`);
    }
    const p = problems(current);
    if (p.length) fail(p);
    return;
  }

  const want = next(current, args[0]);
  if (!SEMVER.test(want)) fail([`"${args[0]}" is not a version (X.Y.Z or X.Y.Z-pre) or patch, minor, major`]);
  if (compare(want, current) <= 0) fail([`${want} is not after ${current}`]);
  const before = problems(current);
  if (before.length) fail(before, `Fix these first, so that the bump leaves no ${current} behind.`);

  // Each place's values, last first so that earlier offsets hold.
  const edits = new Map(); // file -> [[start, end, text]]
  for (const p of places()) {
    if (p.built) continue;
    for (const f of p.found)
      for (const x of f.values) {
        if (!edits.has(p.file)) edits.set(p.file, []);
        edits.get(p.file).push([x.at[0], x.at[1], x.kind === 'v' ? want : series(want)]);
      }
  }
  for (const [file, list] of edits) {
    let text = read(file);
    for (const [a, b, value] of list.sort((l, r) => r[0] - l[0])) text = text.slice(0, a) + value + text.slice(b);
    fs.writeFileSync(path.join(ROOT, file), text);
  }
  const build = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'concat.js')], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) fail([`tools/concat.js failed: ${build.stdout}${build.stderr}`]);
  const after = problems(want);
  if (after.length) fail(after);

  console.log(`tern ${current} → ${want}: ${[...edits.keys(), 'tern.js'].join(', ')}`);
  console.log(`Next: npm test, commit, and once it is on main, tag it: git tag v${want} && git push origin v${want}`);
  console.log('The release workflow checks the tag against tern.version and package.json.');
}

main();
