#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Writes the highlight.js table in addons/code.js: the pinned version of
// @highlightjs/cdn-assets, the SRI hash of its highlight.min.js, and, for
// every language its common bundle lacks, the hash of languages/NAME.min.js
// and the aliases a fence may use for it (`tex` for latex). Run it to move
// to another version; it needs the network once per version.
//
// The package comes from the npm registry, checked against its sha512, and
// is kept in node_modules/.cache/tern-smoke/ (test/smoke.js serves the same
// copy). jsDelivr's /npm/ files are the package's bytes, so the hashes hold.
//
//   node tools/hljs.js [VERSION]   rewrite the table (default: the version in it)
//   node tools/hljs.js --check     exit 1 if the table is not what the version gives
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'addons', 'code.js');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'tern-smoke');
const PKG = '@highlightjs/cdn-assets';
const START = '  // <hljs> written by tools/hljs.js; do not edit by hand';
const END = '  // </hljs>';

// The files of a ustar/pax tarball whose path starts with `prefix`.
function untar(buf, prefix, onFile) {
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.toString('utf8', a, b).replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const name = paxPath || (field(345, 500) ? field(345, 500) + '/' : '') + field(0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    paxPath = null;
    if (type === 'x') paxPath = (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8')) || [])[1] || null;
    else if (type === '0' && name.startsWith(prefix)) onFile(name.slice(prefix.length), body);
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

// node_modules/.cache/tern-smoke/highlightjs-VERSION/, the package's files.
async function packageDir(version) {
  const dir = path.join(CACHE, `highlightjs-${version}`);
  if (fs.existsSync(path.join(dir, 'highlight.min.js'))) return dir;
  const meta = await (await fetch(`https://registry.npmjs.org/${PKG.replace('/', '%2f')}/${version}`)).json();
  if (!meta.dist) throw new Error(`${PKG}@${version} is not on the npm registry`);
  const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const want = String(meta.dist.integrity || '').replace(/^sha512-/, '');
  if (crypto.createHash('sha512').update(tgz).digest('base64') !== want) throw new Error(`${PKG}@${version}: the tarball does not match its sha512`);
  const tmp = `${dir}.tmp-${process.pid}`;
  untar(zlib.gunzipSync(tgz), 'package/', (rel, body) => {
    const out = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

const sri = (file) => `sha384-${crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64')}`;

// The table's source text for `version`.
async function table(version) {
  const dir = await packageDir(version);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(path.join(dir, 'highlight.min.js'), 'utf8'), ctx);
  const common = new Set(vm.runInContext('hljs.listLanguages()', ctx));
  const files = fs.readdirSync(path.join(dir, 'languages')).filter((n) => n.endsWith('.min.js')).sort();
  const langs = [];
  for (const f of files) {
    const name = f.slice(0, -'.min.js'.length);
    if (common.has(name)) continue;
    vm.runInContext(fs.readFileSync(path.join(dir, 'languages', f), 'utf8'), ctx);
    const aliases = vm.runInContext(`(hljs.getLanguage(${JSON.stringify(name)}) || {}).aliases || []`, ctx).map((a) => a.toLowerCase());
    langs.push({ name, file: f, aliases });
  }
  // An alias stays only when it names one language: not a core one, not
  // another's name, not one two languages claim (lasso and livescript: ls).
  const names = new Set(langs.map((l) => l.name));
  const claims = new Map();
  for (const l of langs) for (const a of new Set(l.aliases)) claims.set(a, (claims.get(a) || 0) + 1);
  const rows = langs.map(({ name, file, aliases }) => {
    const kept = [...new Set(aliases)].filter((a) => !common.has(a) && !names.has(a) && claims.get(a) === 1);
    return `    ${JSON.stringify(name)}: [${[sri(path.join(dir, 'languages', file)), ...kept].map((s) => JSON.stringify(s)).join(', ')}],`;
  });
  return [
    START,
    '  const HLJS = {',
    `    version: '${version}',`,
    `    core: '${sri(path.join(dir, 'highlight.min.js'))}',`,
    `    // In the core: ${[...common].sort().join(' ')}.`,
    '    // The others, loaded on first use: name: [SRI of languages/NAME.min.js, ...aliases].',
    '    languages: {',
    rows.map((r) => `  ${r}`).join('\n'),
    '    },',
    '  };',
    END,
  ].join('\n');
}

async function main() {
  const src = fs.readFileSync(ADDON, 'utf8');
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`addons/code.js has no table between "${START.trim()}" and "${END.trim()}"`);
  const current = /version: '([^']+)'/.exec(src.slice(a, b));
  const arg = process.argv.slice(2).find((x) => !x.startsWith('--'));
  const version = arg || (current && current[1]);
  if (!version) throw new Error('no version: give one, as node tools/hljs.js 11.12.0');
  const out = src.slice(0, a) + (await table(version)) + src.slice(b + END.length);
  if (process.argv.includes('--check')) {
    if (out !== src) {
      console.log(`✗ the highlight.js table in addons/code.js is not ${PKG}@${version}'s: run node tools/hljs.js`);
      process.exit(1);
    }
    console.log(`✓ addons/code.js has ${PKG}@${version}'s table`);
    return;
  }
  fs.writeFileSync(ADDON, out);
  console.log(`wrote ${PKG}@${version}'s table into addons/code.js`);
}

module.exports = { packageDir };

if (require.main === module)
  main().catch((e) => {
    console.error(`tools/hljs.js: ${e.message}`);
    process.exit(1);
  });
