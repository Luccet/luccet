#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// luccet, the command line. Node only: a note never loads this file. The
// commands live in cli/commands.js, the language server in cli/lsp.js.
//
//   luccet new FILE      write a note's first line
//   luccet check PATH…   print diagnostics; exit 1 on errors
//   luccet parse FILE    print the AST as JSON
//   luccet build FILE…   write static, pre-rendered pages
//   luccet mv FROM… TO   move notes and files, rewriting the links to and from them
//   luccet search QUERY  search notes by word, each hit with its file and line
//   luccet index [PATH…] write notes.json and search.json, what the ::notes and ::search add-ons read
//   luccet corpus PATH…  print documentation examples as corpus cases
//   luccet vendor DIR    write local copies of the add-ons' libraries, for ?base=
//   luccet lsp           the language server, over stdio
'use strict';

const commands = require('./cli/commands');

// A reader that closes early (luccet parse FILE | head) ends the command
// quietly, exit 0, instead of an unhandled EPIPE with a stack trace; the
// language server exits 1, as it does when its client closes stdin first.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(process.argv[2] === 'lsp' ? 1 : 0);
    throw e;
  });
}

const COMMANDS = ['new', 'check', 'parse', 'build', 'mv', 'search', 'index', 'corpus', 'vendor', 'lsp'];
const [name, ...args] = process.argv.slice(2);
const run = COMMANDS.includes(name) ? commands[name] : null;
if (name === '--version' || name === '-v' || name === 'version') {
  process.stdout.write(`${require('./luccet.js').version}\n`);
} else if (!run) {
  const help = !name || name === 'help' || name === '--help' || name === '-h';
  (help ? process.stdout : process.stderr).write(`${help ? '' : `luccet: unknown command "${name}"\n`}${commands.usage()}`);
  process.exitCode = help ? 0 : 2;
} else {
  new Promise((resolve) => resolve(run(args))).then(
    (code) => (process.exitCode = code || 0),
    (e) => {
      process.stderr.write(`luccet ${name}: ${(e && e.message) || e}\n`);
      process.exitCode = 2;
    },
  );
}
