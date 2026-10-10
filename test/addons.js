#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Tern's add-ons in addons/ (docs/addons.html), under node: each runs under
// the command line, as `tern check` and `tern build` run a note's add-ons,
// with no diagnostic and no change to the page; and code.js's highlight.js
// table is well formed, and is the pinned version's when that package is in
// node_modules/.cache/tern-smoke/ (tools/hljs.js --check; skipped if not).
// Their behaviour in the browser is test/smoke.js's.
//
//   node test/addons.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'addons');

let failed = 0;
const results = [];
function test(name, fn) {
  try {
    const note = fn();
    results.push(`✓ ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    failed++;
    results.push(`✗ ${name}\n  ${(e && e.message) || e}`);
  }
}

const addons = fs.readdirSync(DIR).filter((n) => n.endsWith('.js')).sort();

test('every add-on runs under tern check and tern build with no diagnostic', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-addons-'));
  try {
    for (const n of addons) {
      const note = path.join(tmp, `${n}.html`);
      const use = path.relative(tmp, path.join(DIR, n)).split(path.sep).join('/');
      fs.writeFileSync(note, `<!doctype html><meta charset="utf-8"><title>T</title><script src="tern.js" data-use="${use}"></script>\n\n# Hello\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n`);
      const check = spawnSync(process.execPath, [path.join(ROOT, 'tern-cli.js'), 'check', note], { encoding: 'utf8' });
      if (check.status !== 0 || !/0 errors, 0 warnings, 0 infos/.test(check.stdout + check.stderr)) throw new Error(`${n}: tern check: ${check.stdout}${check.stderr}`);
      const out = path.join(tmp, `${n}.built.html`);
      const build = spawnSync(process.execPath, [path.join(ROOT, 'tern-cli.js'), 'build', note, '-o', out], { encoding: 'utf8' });
      if (build.status !== 0) throw new Error(`${n}: tern build: ${build.stdout}${build.stderr}`);
      if (/hljs-/.test(fs.readFileSync(out, 'utf8'))) throw new Error(`${n}: tern build wrote highlighting, which is the browser's to do`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return `${addons.length} add-on(s)`;
});

test("code.js: the highlight.js table is well formed", () => {
  const src = fs.readFileSync(path.join(DIR, 'code.js'), 'utf8');
  const block = /\/\/ <hljs>[^\n]*\n([\s\S]*?)\n\s*\/\/ <\/hljs>/.exec(src);
  if (!block) throw new Error('no <hljs> table');
  const HLJS = new Function(`${block[1]}; return HLJS;`)();
  if (!/^\d+\.\d+\.\d+$/.test(HLJS.version)) throw new Error(`version ${HLJS.version}`);
  const sri = /^sha384-[A-Za-z0-9+/]{64}$/;
  if (!sri.test(HLJS.core)) throw new Error(`core hash ${HLJS.core}`);
  const core = new Set((/In the core: ([^.]+)\./.exec(block[1]) || [])[1].split(' '));
  const seen = new Map();
  for (const [name, [hash, ...aliases]] of Object.entries(HLJS.languages)) {
    if (!sri.test(hash)) throw new Error(`${name}: hash ${hash}`);
    if (core.has(name)) throw new Error(`${name} is in the core too`);
    for (const k of [name, ...aliases]) {
      if (k !== k.toLowerCase()) throw new Error(`${name}: "${k}" is not lower case`);
      if (seen.has(k)) throw new Error(`"${k}" names both ${seen.get(k)} and ${name}`);
      seen.set(k, name);
    }
  }
  return `highlight.js ${HLJS.version}: ${core.size} languages in the core, ${Object.keys(HLJS.languages).length} on demand`;
});

test("code.js: the table is the pinned version's (tools/hljs.js --check)", () => {
  const version = /version: '([\d.]+)'/.exec(fs.readFileSync(path.join(DIR, 'code.js'), 'utf8'))[1];
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '.cache', 'tern-smoke', `highlightjs-${version}`, 'highlight.min.js'))) return `skipped: highlight.js ${version} is not cached; node tools/hljs.js --check fetches it`;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'hljs.js'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  return 'checked against the cached package';
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} add-on checks pass`);
process.exit(failed ? 1 : 0);
