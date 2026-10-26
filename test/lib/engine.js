// SPDX-License-Identifier: MIT
// Loads the engine under test: luccet.js, or the file $LUCCET_ENGINE names
// (LUCCET_ENGINE=src/index.js runs the sources without a build).
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// {luccet, why}: the engine, or null and why it did not load.
function load() {
  const file = process.env.LUCCET_ENGINE ? path.resolve(process.env.LUCCET_ENGINE) : path.join(ROOT, 'luccet.js');
  try {
    return { luccet: require(file), why: null };
  } catch (e) {
    return { luccet: null, why: `cannot load ${path.relative(ROOT, file)}: ${e.message.split('\n')[0]}` };
  }
}

module.exports = { load, ROOT };
