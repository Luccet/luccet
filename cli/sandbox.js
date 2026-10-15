// SPDX-License-Identifier: MIT
// Runs a note's own code — the head's classic scripts and the script add-ons
// of its data-use — away from the tools, so `tern check`, `tern build`,
// `tern parse` and the language server can analyse an untrusted note without
// running it with their own privileges (docs/publishing.html#trust-tools).
// Two walls:
//   - a child process, started with Node's --permission and an empty
//     environment, allowed to read only tern.js and this file and capped in
//     memory: even past the inner wall it reaches no file, no other process,
//     no native add-on, no worker (node:permissions);
//   - inside it, one sealed vm context per note: the note's code sees a fresh
//     global holding the engine and a `tern`/`window` shim and nothing of
//     Node, so `this.constructor.constructor` and the like reach no host
//     object; a time limit stops a runaway script or transform, and dynamic
//     import() is off.
// Only data crosses back — the schema the note declares, its transformed AST
// and the diagnostics — as JSON. The host reads the add-on files (the child
// cannot) and sends their source; it emits HTML and checks links itself, on
// that data. The bridge is synchronous (the tools are): length-framed JSON
// over a pipe, so note.analyse keeps its signature.
//
//   analyse(req)   run a note's code and analyse it; req is
//                  {note, head, dataUse, dataLang, dataKatex, scripts, addons,
//                  transform}, the result {schema, lang, demo, ast,
//                  diagnostics, problems, failures} or {failed} on a child
//                  error (a timeout, a crash); scripts and addons are
//                  [{url, code, line?, column?}], read by the host.
//   shutdown()     stop the child (the CLI at exit; the LSP never needs to).
'use strict';

const path = require('path');

const TERN = path.resolve(__dirname, '..', 'tern.js');
const SELF = __filename;
const RUN_MS = 2000; // a note's scripts and transforms, together
const STARTUP_MS = 10000; // loading the engine into a fresh context
const MEMORY_MB = 256;
const WEDGED_MS = 10000; // the child itself stuck past its own limit: kill it

// ------------------------------------------------------------------ child

// The trusted driver, set up once in each sealed context: it defines the
// globals a note's code sees (an inert `window`, a `tern`/`window.tern`
// shim, a buffering console) and __ternDriver, which runs the code and
// returns the analysis as a JSON string. Guest code runs by indirect eval
// in the context's global scope, as a classic script does; the driver's own
// helpers stay in this closure, out of its reach. Written as a function and
// stringified, so it is ordinary, checked source; it runs in the context,
// never in this process.
function driverSetup() {
  var G = globalThis;
  var engine = G.module.exports;
  // The engine functions, captured before any note code runs, so a script
  // that overwrites module.exports cannot redirect the analysis.
  var E = { parse: engine.parse, emit: engine.emit, toHTML: engine.toHTML, check: engine.check, visit: engine.visit, outline: engine.outline, css: engine.css, transform: engine.transform, version: engine.version };
  var stringify = G.JSON.stringify;
  var own = function (o, k) { return Object.prototype.propertyIsEnumerable.call(o, k); };
  var message = function (e) {
    try {
      return (e && e.message) || String(e);
    } catch (x) {
      return 'an exception';
    }
  };

  // Browser globals a note or add-on may touch while it loads: each accepts
  // anything and does nothing, so the code reaches its tern.block calls.
  var inert = new Proxy(function () {}, {
    get: function (_, k) {
      return k === Symbol.toPrimitive ? function () { return ''; } : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : inert;
    },
    apply: function () { return inert; },
    construct: function () { return inert; },
  });
  var BROWSER = 'document customElements HTMLElement Element Node Event CustomEvent EventTarget CSS CSSStyleSheet navigator location history localStorage sessionStorage matchMedia getComputedStyle requestAnimationFrame cancelAnimationFrame requestIdleCallback setTimeout clearTimeout setInterval clearInterval queueMicrotask MutationObserver IntersectionObserver ResizeObserver fetch addEventListener removeEventListener dispatchEvent'.split(' ');

  // tern.config as the runtime builds it (src/runtime.js readConfig): `use`
  // from data-use's query strings, `katex` from window.TERN.katex and
  // data-katex, `lang`.
  function shimConfig(given, dataUse, dataKatex, lang) {
    var g = given && typeof given === 'object' ? given : {};
    var use = Object.assign(Object.create(null), g.use && typeof g.use === 'object' ? g.use : null);
    (dataUse || '').split(/\s+/).filter(Boolean).forEach(function (entry) {
      var q = entry.indexOf('?');
      var file = (q < 0 ? entry : entry.slice(0, q)).replace(/#.*$/, '');
      file = file.slice(file.lastIndexOf('/') + 1);
      try {
        file = decodeURIComponent(file);
      } catch (x) {}
      var name = file.replace(/(?:\.min)?\.(?:m?js|css)$/i, '');
      var params = Object.create(null);
      // The query string's parameters, as URLSearchParams would read them
      // (+ for space, %xx decoded); URLSearchParams is not a realm global.
      var decode = function (s) {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch (x) {
          return s;
        }
      };
      if (q >= 0) entry.slice(q + 1).replace(/#.*$/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        params[decode(i < 0 ? pair : pair.slice(0, i))] = i < 0 ? '' : decode(pair.slice(i + 1));
      });
      use[name] = Object.assign(Object.create(null), use[name], params);
    });
    var katex = typeof g.katex === 'string' ? { base: g.katex } : Object.assign({}, g.katex);
    if (dataKatex !== undefined) katex.base = String(dataKatex).trim();
    return { use: use, katex: katex, lang: lang };
  }

  G.__ternDriver = function (req) {
    var consoleOut = [];
    var console = { log: say, warn: say, error: say, info: say, debug: say };
    function say() {
      consoleOut.push(Array.prototype.join.call(arguments, ' '));
    }
    for (var i = 0; i < BROWSER.length; i++) G[BROWSER[i]] = inert;
    G.window = G;
    G.self = G;
    G.globalThis = G;
    G.console = console;
    G.TERN = undefined;

    var run = function (code) {
      // Indirect eval: the code runs in the global scope, as tern.js runs a
      // classic script, seeing the shim and nothing of this closure.
      return (0, eval)(code);
    };

    var problems = [];
    // The head's classic scripts, in order; one that throws is a warning.
    for (var h = 0; h < req.scripts.length; h++) {
      var s = req.scripts[h];
      try {
        run(s.code);
      } catch (e) {
        problems.push({ kind: 'head', severity: 'warning', url: s.url, line: s.line, column: s.column, seq: s.seq, message: 'the head script ' + s.url + ' threw under node: ' + message(e) + '; vocabulary it declares may be missing' });
      }
    }

    // window.TERN as tern.js reads it when it starts: after the head scripts,
    // before the add-ons. data-lang, even empty, wins over window.TERN.lang.
    var given = G.TERN && typeof G.TERN === 'object' ? G.TERN : null;
    var lang;
    var ownSchema = null;
    try {
      if (given && own(given, 'lang')) lang = given.lang;
      if (given) ownSchema = given.schema;
      if (req.dataLang !== undefined) lang = req.dataLang;
      lang = lang ? String(lang) : undefined;
    } catch (e) {
      lang = req.dataLang !== undefined && req.dataLang ? String(req.dataLang) : undefined;
      problems.push({ kind: 'head', severity: 'warning', url: 'window.TERN', message: 'window.TERN cannot be read: ' + message(e), line: 1, column: 1, seq: req.vocabSeq });
    }

    var schema = { block: {}, leaf: {}, inline: {} };
    var failures = [];
    var current = null;
    var inertFn = function () { return function () {}; };
    var shim = {
      schema: schema,
      block: function (name, spec) { schema.block[name] = spec; },
      leaf: function (name, spec) { schema.leaf[name] = spec; },
      inline: function (name, spec) { schema.inline[name] = spec; },
      define: inertFn,
      undefine: function () {},
      on: inertFn,
      style: function () {},
      transform: function (name, fn, order) {
        if (typeof name !== 'string') return E.transform(name, fn); // run the pipeline on a tree
        var url = current;
        var wrapped = function (tree, ctx) {
          try {
            return fn.call(this, tree, ctx);
          } catch (e) {
            failures.push({ url: url, name: name, message: message(e) });
          }
        };
        var off = E.transform(name, wrapped, order);
        var done = false;
        return function () {
          if (done) return;
          done = true;
          off();
        };
      },
      render: function () { return Promise.resolve([]); },
      ready: new Promise(function () {}),
      diagnostics: [],
      config: shimConfig(given, req.dataUse, req.dataKatex, lang),
      version: E.version,
      parse: E.parse,
      emit: E.emit,
      toHTML: E.toHTML,
      check: E.check,
      visit: E.visit,
      outline: E.outline,
      css: E.css,
    };
    G.tern = shim;
    G.window.tern = shim;

    // The script add-ons, in order; a transform registers with this
    // context's engine, so engine.transform runs it below. A throw at the
    // top level, as in a browser, is an error; its syntax error is named.
    for (var a = 0; a < req.addons.length; a++) {
      current = req.addons[a].url;
      try {
        run(req.addons[a].code);
      } catch (e) {
        var syntax = e && typeof e === 'object' && e.name === 'SyntaxError';
        problems.push({ kind: 'addon', url: current, seq: req.addons[a].seq, message: syntax ? 'it does not parse as a classic script, which is how tern.js runs an add-on: ' + message(e) : 'it threw: ' + message(e) });
      }
      current = null;
    }

    // window.TERN.schema on top: the note's declaration wins over an add-on's
    // for the same name, and its `strict` sets schema.strict.
    try {
      var sc = ownSchema && typeof ownSchema === 'object' ? ownSchema : null;
      ['block', 'leaf', 'inline'].forEach(function (level) {
        var entries = sc ? sc[level] : null;
        if (entries && typeof entries === 'object') Object.keys(entries).forEach(function (name) {
          if (entries[name] && typeof entries[name] === 'object') schema[level][name] = entries[name];
        });
      });
      if (sc && sc.strict !== undefined) schema.strict = !!sc.strict;
    } catch (e) {
      problems.push({ kind: 'head', severity: 'warning', url: 'window.TERN.schema', message: 'window.TERN.schema cannot be read: ' + message(e), line: 1, column: 1 });
    }

    var options = { schema: schema, head: req.head, lang: lang };
    var parsed = E.parse(req.note, options);
    var diagnostics = parsed.diagnostics;
    if (req.transform) {
      E.transform(parsed.ast, options);
      diagnostics = diagnostics.concat(parsed.ast.data.tern.diagnostics);
    }

    // window.ternDocs, a documentation add-on's data (its demo schema, pages
    // and examples), for cli/examples.js and test/docs.js; plain data.
    var ternDocs = null;
    try {
      if (G.ternDocs && typeof G.ternDocs === 'object') ternDocs = G.ternDocs;
    } catch (e) {}

    return stringify({ schema: schema, lang: lang === undefined ? null : lang, ternDocs: ternDocs, ast: parsed.ast, diagnostics: diagnostics, problems: problems, failures: failures, consoleOut: consoleOut });
  };
}

// The child's loop: read a framed request on fd 3, run it in a fresh sealed
// context, write the framed reply on fd 4. stdout is left alone; the note's
// console output rides back in the reply. One malformed or oversized frame,
// or EOF, ends the child.
function childMain() {
  const fs = require('fs');
  const vm = require('vm');
  // A note's code runs no async of its own that we wait for; a promise it
  // leaves rejected (an await that never resolves, a refused import) must not
  // bring the child down after its reply is sent.
  process.on('unhandledRejection', () => {});
  // dynamic import() is refused, cleanly: without a handler the engine aborts
  // the process; with one it just rejects the promise.
  const noImport = () => {
    throw new Error('dynamic import() is not available in the tern sandbox');
  };
  const ternSource = fs.readFileSync(TERN, 'utf8');
  const ternScript = new vm.Script(ternSource, { filename: 'tern.js' });
  const driverScript = new vm.Script('(' + driverSetup.toString() + ')()', { filename: 'tern-sandbox-driver' });

  const readFrame = () => {
    const need = (n) => {
      const b = Buffer.allocUnsafe(n);
      let got = 0;
      while (got < n) {
        let r;
        try {
          r = fs.readSync(3, b, got, n - got, null);
        } catch (e) {
          if (e.code === 'EAGAIN') continue;
          throw e;
        }
        if (r === 0) return null;
        got += r;
      }
      return b;
    };
    const head = need(4);
    if (!head) return null;
    const len = head.readUInt32BE(0);
    if (len === 0 || len > 0x7fffffff) return null;
    const body = need(len);
    return body && body.toString('utf8');
  };
  const writeFrame = (text) => {
    const body = Buffer.from(text, 'utf8');
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(body.length, 0);
    const buf = Buffer.concat([head, body]);
    let off = 0;
    while (off < buf.length) {
      let w;
      try {
        w = fs.writeSync(4, buf, off, buf.length - off, null);
      } catch (e) {
        if (e.code === 'EAGAIN') continue;
        throw e;
      }
      off += w; // a full pipe takes the rest on the next write
    }
  };

  for (;;) {
    const reqText = readFrame();
    if (reqText === null) break;
    let reply;
    try {
      const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false }, microtaskMode: 'afterEvaluate' });
      ctx.__reqText = reqText;
      vm.runInContext('globalThis.module = { exports: {} };', ctx);
      ternScript.runInContext(ctx, { timeout: STARTUP_MS });
      driverScript.runInContext(ctx, { timeout: STARTUP_MS });
      reply = vm.runInContext('__ternDriver(JSON.parse(__reqText))', ctx, { timeout: RUN_MS, filename: 'tern-sandbox', importModuleDynamically: noImport });
      if (typeof reply !== 'string') throw new Error('the driver returned no analysis');
    } catch (e) {
      const timeout = e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      reply = JSON.stringify({ failed: timeout ? 'timeout' : 'error', message: (e && e.message) || String(e) });
    }
    writeFrame(reply);
  }
}

// ------------------------------------------------------------------ host

let child = null; // {proc, toFd, fromFd} or null before the first note
let broken = false; // a spawn that failed: fall back, warn once
const spin = new Int32Array(new SharedArrayBuffer(4));

function spawnChild() {
  const { spawn } = require('child_process');
  const proc = spawn(
    process.execPath,
    ['--permission', `--allow-fs-read=${TERN}`, `--allow-fs-read=${SELF}`, `--max-old-space-size=${MEMORY_MB}`, SELF, '--sandbox-child'],
    // The child speaks only over the pipe (fds 3, 4); a note's console output
    // rides back in the reply. Its own stdout and stderr carry nothing but a
    // crash dump (an out-of-memory report), so they are dropped.
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: {} },
  );
  proc.on('error', () => {});
  const to = proc.stdio[3];
  const from = proc.stdio[4];
  // The tools read the reply synchronously (below), so keep Node's stream
  // machinery off these pipes — it must not race the manual reads — and let
  // the child not hold the process open: a finished command exits, and the
  // child then reaches end-of-input and exits too.
  to.pause();
  from.pause();
  if (!to._handle || !from._handle) {
    proc.kill();
    throw new Error('the sandbox pipes are not available');
  }
  proc.unref();
  to.unref();
  from.unref();
  return { proc, toFd: to._handle.fd, fromFd: from._handle.fd, alive: true };
}

function ensureChild() {
  if (child && child.alive && child.proc.exitCode === null && child.proc.signalCode === null) return child;
  child = spawnChild();
  const mark = () => { child && (child.alive = false); };
  child.proc.on('exit', mark);
  return child;
}

const fs = require('fs');
// Write a whole frame, looping over partial writes: a reply or request larger
// than the pipe buffer is written in several goes as the other end drains it.
function writeFrame(fd, text) {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  const buf = Buffer.concat([head, body]);
  let off = 0;
  let idle = 0;
  while (off < buf.length) {
    let w;
    try {
      w = fs.writeSync(fd, buf, off, buf.length - off, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        if (++idle < 2000) continue;
        Atomics.wait(spin, 0, 0, 1);
        continue;
      }
      throw e;
    }
    off += w;
    idle = 0;
  }
}
// Read one framed reply, blocking. A short busy-spin covers the usual quick
// reply; a longer wait sleeps 1 ms at a time. The child's own limit bounds
// the work, so this returns promptly; WEDGED_MS kills a child that never does.
function readFrame(fd, deadline) {
  const need = (n) => {
    const b = Buffer.allocUnsafe(n);
    let got = 0;
    let idle = 0;
    while (got < n) {
      let r;
      try {
        r = fs.readSync(fd, b, got, n - got, null);
      } catch (e) {
        if (e.code === 'EAGAIN') {
          if (++idle < 2000) continue;
          if (Date.now() > deadline) return undefined; // wedged
          Atomics.wait(spin, 0, 0, 1);
          continue;
        }
        throw e;
      }
      if (r === 0) return null; // the child closed the pipe: it died
      got += r;
    }
    return b;
  };
  const head = need(4);
  if (!head) return head; // null (died) or undefined (wedged)
  const body = need(head.readUInt32BE(0));
  return body ? body.toString('utf8') : body;
}

// What a note's code prints or throws reaches the terminal through the
// tools: the control characters that would drive it are taken out — ESC and
// the rest of C0 but tab and newline, DEL, and C1 — so that a note you have
// not read cannot retitle the terminal, clear it or plant an OSC hyperlink.
const clean = (s) => String(s).replace(/[\0-\x08\x0b-\x1f\x7f-\x9f]/g, '');

// Run a note's code in the child and return the parsed reply, or {failed} on
// a timeout, a crash or a spawn that is not possible here.
function analyse(req) {
  if (broken) return { failed: 'unavailable' };
  let c;
  try {
    c = ensureChild();
  } catch (e) {
    broken = true;
    process.stderr.write(`tern: the script sandbox could not start (${e.message}); notes are analysed without their own scripts\n`);
    return { failed: 'unavailable' };
  }
  let text;
  try {
    writeFrame(c.toFd, JSON.stringify(req));
    text = readFrame(c.fromFd, Date.now() + WEDGED_MS);
  } catch (e) {
    text = null;
  }
  if (text === null || text === undefined) {
    c.alive = false;
    try {
      c.proc.kill();
    } catch (e) {}
    child = null;
    return { failed: text === undefined ? 'timeout' : 'crash' };
  }
  let reply;
  try {
    reply = JSON.parse(text);
  } catch (e) {
    return { failed: 'error' };
  }
  if (reply.consoleOut && reply.consoleOut.length) process.stderr.write(reply.consoleOut.map(clean).join('\n') + '\n');
  return reply;
}

function shutdown() {
  if (child) {
    try {
      child.proc.stdio[3].end();
      child.proc.kill();
    } catch (e) {}
    child = null;
  }
}

if (require.main === module && process.argv.includes('--sandbox-child')) childMain();
else module.exports = { analyse, shutdown, clean };
