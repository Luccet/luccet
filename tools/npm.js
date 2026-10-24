// SPDX-License-Identifier: MIT
// npm packages for the tools and the tests: a version's tarball from the npm
// registry, checked against its sha512, unpacked once into
// node_modules/.cache/luccet-smoke/FOLDER/. jsDelivr's /npm/ files are the
// package's bytes, so SRI hashes taken from these copies hold, and
// test/smoke.js answers CDN requests from them.
//
//   packageDir(name, version, { folder, keep, has }) -> Promise of the folder
//     keep: the package paths to unpack, a folder ending in / (default all)
//     has:  a file whose presence means the folder is already there
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'luccet-smoke');

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

async function packageDir(name, version, { folder, keep = [''], has }) {
  const dir = path.join(CACHE, folder);
  if (fs.existsSync(path.join(dir, has))) return dir;
  const meta = await (await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`)).json();
  if (!meta.dist) throw new Error(`${name}@${version} is not on the npm registry`);
  const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const want = String(meta.dist.integrity || '').replace(/^sha512-/, '');
  if (crypto.createHash('sha512').update(tgz).digest('base64') !== want) throw new Error(`${name}@${version}: the tarball does not match its sha512`);
  const tmp = `${dir}.tmp-${process.pid}`;
  untar(zlib.gunzipSync(tgz), 'package/', (rel, body) => {
    if (!keep.some((k) => (k.endsWith('/') || !k ? rel.startsWith(k) : rel === k))) return;
    const out = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  });
  if (!fs.existsSync(path.join(tmp, has))) throw new Error(`${name}@${version} has no ${has}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

// The SRI hash of a file, as integrity= takes it.
const sri = (file) => `sha384-${crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64')}`;

module.exports = { CACHE, untar, packageDir, sri };
