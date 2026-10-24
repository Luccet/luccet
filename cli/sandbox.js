// SPDX-License-Identifier: MIT
// Runs a note's own code — the head's classic scripts and the script add-ons
// of its data-use — away from the tools, so `luccet check`, `luccet build`,
// `luccet parse` and the language server can analyse an untrusted note without
// running it with their own privileges (docs/publishing.html#trust-tools).
// Two walls:
//   - a child process, started with Node's --permission and an empty
//     environment, allowed to read only luccet.js and this file and capped in
//     memory: even past the inner wall it reaches no file, no other process,
//     no native add-on, no worker (node:permissions);
//   - inside it, one sealed vm context per note: the note's code sees a fresh
//     global holding the engine and a `luccet`/`window` shim and nothing of
//     Node, so `this.constructor.constructor` and the like reach no host
//     object; a time limit stops a runaway script or transform, and dynamic
//     import() is off.
// Only data crosses back — the schema the note declares, its transformed AST
// and the diagnostics — as JSON. When the note's code adds no transform and
// its schema holds no function but `dom` (which only the browser calls), the
// schema alone crosses: the host parses and transforms with it as data, which
// gives the same tree, and the child's cold engine and a tree several times
// the note's size in JSON are spared. The host reads the add-on files (the
// child cannot) and sends their source; it emits HTML and checks links
// itself, on that data. The bridge is length-framed JSON over the child's stdin and
// stdout, driven two ways: blocking, for the tools, so note.analyse keeps its
// signature; through the event loop, for the language server, which answers
// requests while a note's code runs. Each way has a child of its own. Where
// the blocking way cannot read the pipe itself (Windows, whose pipes are not
// file descriptors), a worker thread drives the event-loop way for the
// tools, with one child for the run, and the tools wait for each reply on a
// shared flag; LUCCET_SANDBOX_ONESHOT=1 forces that, for the tests (the name
// is from when that way started a child per note).
//
//   analyse(req)        run a note's code and analyse it, blocking; req is
//                       {note, head, dataUse, dataLang, scripts, addons,
//                       transform, hostParse}, the result {schema,
//                       lang, demo, ast, diagnostics, problems, failures}, or
//                       with hostParse, when the code allows it, {hostParse:
//                       true, schema, lang, demo, problems} for the host to
//                       parse; {failed} on a child error (a timeout, a
//                       crash); scripts and addons are [{url, code, line?,
//                       column?}], read by the host.
//   analyseAsync(req)   the same, as a promise; requests run one at a time,
//                       in order.
//   shutdown()          stop the children (the CLI at exit; the LSP never
//                       needs to).
// A child that dies before answering its first request, three times in a
// row, trips a breaker: for a minute no child is started and every request
// fails as 'tripped', said once; a note cannot be told from an environment
// that cannot run the child, so both are waited out.
'use strict';

const path = require('path');

const LUCCET = path.resolve(__dirname, '..', 'luccet.js');
const SELF = __filename;
const RUN_MS = 2000; // a note's scripts and transforms, together
const STARTUP_MS = 10000; // loading the engine into a fresh context
const MEMORY_MB = 256;
const WEDGED_MS = 10000; // the child itself stuck past its own limit: kill it

// ------------------------------------------------------------------ child

// The trusted driver, set up once in each sealed context: it defines the
// globals a note's code sees (an inert `window`, a `luccet`/`window.luccet`
// shim, a buffering console) and __luccetDriver, which runs the code and
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
  // The pipeline's transform names, read through the engine's own getter,
  // taken before any note code runs: a transform the code adds, through the
  // shim or the engine itself, shows in the list.
  var transformNames = Object.getOwnPropertyDescriptor(engine, 'transforms').get;
  var names = function () { return transformNames.call(engine).join(' '); };
  // What tells plain data, for the host parse below.
  var protoOf = Object.getPrototypeOf;
  var ownNames = Object.getOwnPropertyNames;
  var describe = Object.getOwnPropertyDescriptor;
  var hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  var OBJECT = Object.prototype;
  var ARRAY = Array.prototype;
  var own = function (o, k) { return Object.prototype.propertyIsEnumerable.call(o, k); };
  var message = function (e) {
    try {
      return (e && e.message) || String(e);
    } catch (x) {
      return 'an exception';
    }
  };

  // Browser globals a note or add-on may touch while it loads: each accepts
  // anything and does nothing, so the code reaches its luccet.block calls.
  var inert = new Proxy(function () {}, {
    get: function (_, k) {
      return k === Symbol.toPrimitive ? function () { return ''; } : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : inert;
    },
    apply: function () { return inert; },
    construct: function () { return inert; },
  });
  var BROWSER = 'document customElements HTMLElement Element Node Event CustomEvent EventTarget CSS CSSStyleSheet navigator location history localStorage sessionStorage matchMedia getComputedStyle requestAnimationFrame cancelAnimationFrame requestIdleCallback setTimeout clearTimeout setInterval clearInterval queueMicrotask MutationObserver IntersectionObserver ResizeObserver fetch addEventListener removeEventListener dispatchEvent'.split(' ');

  // luccet.config as the runtime builds it (src/runtime.js readConfig): `use`
  // from window.LUCCET.use and data-use's query strings, and `lang`.
  function shimConfig(given, dataUse, lang) {
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
    return { use: use, lang: lang };
  }

  G.__luccetDriver = function (req) {
    // The request arrived as a global, and the driver is one: both go
    // before any note code runs, which sees the shim and the engine alone.
    delete G.__reqText;
    delete G.__luccetDriver;
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
    G.LUCCET = undefined;

    var run = function (code) {
      // Indirect eval: the code runs in the global scope, as luccet.js runs a
      // classic script, seeing the shim and nothing of this closure.
      return (0, eval)(code);
    };

    var problems = [];
    var builtinTransforms = names();
    // The head's classic scripts, in order; one that throws is a warning.
    for (var h = 0; h < req.scripts.length; h++) {
      var s = req.scripts[h];
      try {
        run(s.code);
      } catch (e) {
        problems.push({ kind: 'head', severity: 'warning', url: s.url, line: s.line, column: s.column, seq: s.seq, message: 'the head script ' + s.url + ' threw under node: ' + message(e) + '; vocabulary it declares may be missing' });
      }
    }

    // window.LUCCET as luccet.js reads it when it starts: after the head scripts,
    // before the add-ons. data-lang, even empty, wins over window.LUCCET.lang.
    var given = G.LUCCET && typeof G.LUCCET === 'object' ? G.LUCCET : null;
    var lang;
    var ownSchema = null;
    try {
      if (given && own(given, 'lang')) lang = given.lang;
      if (given) ownSchema = given.schema;
      if (req.dataLang !== undefined) lang = req.dataLang;
      lang = lang ? String(lang) : undefined;
    } catch (e) {
      lang = req.dataLang !== undefined && req.dataLang ? String(req.dataLang) : undefined;
      problems.push({ kind: 'head', severity: 'warning', url: 'window.LUCCET', message: 'window.LUCCET cannot be read: ' + message(e), line: 1, column: 1, seq: req.vocabSeq });
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
      string: function (key, params, fallback) { return fallback === undefined ? key : String(fallback); },
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
      config: shimConfig(given, req.dataUse, lang),
      version: E.version,
      parse: E.parse,
      emit: E.emit,
      toHTML: E.toHTML,
      check: E.check,
      visit: E.visit,
      outline: E.outline,
      css: E.css,
    };
    G.luccet = shim;
    G.window.luccet = shim;

    // The script add-ons, in order; a transform registers with this
    // context's engine, so engine.transform runs it below. A throw at the
    // top level, as in a browser, is an error; its syntax error is named.
    for (var a = 0; a < req.addons.length; a++) {
      current = req.addons[a].url;
      try {
        run(req.addons[a].code);
      } catch (e) {
        var syntax = e && typeof e === 'object' && e.name === 'SyntaxError';
        problems.push({ kind: 'addon', url: current, seq: req.addons[a].seq, message: syntax ? 'it does not parse as a classic script, which is how luccet.js runs an add-on: ' + message(e) : 'it threw: ' + message(e) });
      }
      current = null;
    }

    // window.LUCCET.schema on top: the note's declaration wins over an add-on's
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
      problems.push({ kind: 'head', severity: 'warning', url: 'window.LUCCET.schema', message: 'window.LUCCET.schema cannot be read: ' + message(e), line: 1, column: 1 });
    }

    // window.luccetDocs, a documentation add-on's data (its demo schema, pages
    // and examples), for cli/examples.js and test/docs.js; plain data.
    var luccetDocs = null;
    try {
      if (G.luccetDocs && typeof G.luccetDocs === 'object') luccetDocs = G.luccetDocs;
    } catch (e) {}

    // The host parses when nothing of the code would act on the tree: no
    // transform added, and no function in the schema but an entry's dom.
    // The schema must be plain data, so that what JSON carries is what the
    // engine here would read: objects and arrays, every property an
    // enumerable value. A getter, a class instance, a value that cannot be
    // read or that nests deeper than a schema does keeps the analysis here.
    var plain = function (v, depth) {
      if (typeof v === 'function') return false;
      if (!v || typeof v !== 'object') return true;
      var proto = protoOf(v);
      if (depth > 8 || (proto !== OBJECT && proto !== ARRAY && proto !== null)) return false;
      var keys = ownNames(v);
      for (var i = 0; i < keys.length; i++) {
        if ((depth === 2 && keys[i] === 'dom') || (proto === ARRAY && keys[i] === 'length')) continue;
        var d = describe(v, keys[i]);
        if (!d.enumerable || !hasOwn(d, 'value') || !plain(d.value, depth + 1)) return false;
      }
      return true;
    };
    var hostParse = false;
    try {
      hostParse = !!req.hostParse && names() === builtinTransforms && plain(schema, 0);
    } catch (e) {}
    if (hostParse) return stringify({ hostParse: true, schema: schema, lang: lang === undefined ? null : lang, luccetDocs: luccetDocs, problems: problems, failures: failures, consoleOut: consoleOut });

    var options = { schema: schema, head: req.head, lang: lang };
    var parsed = E.parse(req.note, options);
    var diagnostics = parsed.diagnostics;
    if (req.transform) {
      E.transform(parsed.ast, options);
      diagnostics = diagnostics.concat(parsed.ast.data.luccet.diagnostics);
    }

    return stringify({ schema: schema, lang: lang === undefined ? null : lang, luccetDocs: luccetDocs, ast: parsed.ast, diagnostics: diagnostics, problems: problems, failures: failures, consoleOut: consoleOut });
  };
}

// The child: a framed request arrives on stdin, runs in a fresh sealed
// context, and the framed reply goes out on stdout; nothing else is written
// there, and the note's console output rides back in the reply. Requests are
// read through the event loop, so an idle child waits in the loop rather
// than reading, and either host below drives it the same way. One malformed
// or oversized frame, or EOF, ends the child.
function childMain() {
  const fs = require('fs');
  const net = require('net');
  const vm = require('vm');
  // A note's code runs no async of its own that we wait for; a promise it
  // leaves rejected (an await that never resolves, a refused import) must not
  // bring the child down after its reply is sent.
  process.on('unhandledRejection', () => {});
  // dynamic import() is refused, cleanly: without a handler the engine aborts
  // the process; with one it just rejects the promise.
  const noImport = () => {
    throw new Error('dynamic import() is not available in the luccet sandbox');
  };
  const luccetSource = fs.readFileSync(LUCCET, 'utf8');
  const luccetScript = new vm.Script(luccetSource, { filename: 'luccet.js' });
  const driverScript = new vm.Script('(' + driverSetup.toString() + ')()', { filename: 'luccet-sandbox-driver' });

  const writeFrame = (text) => {
    const body = Buffer.from(text, 'utf8');
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(body.length, 0);
    const buf = Buffer.concat([head, body]);
    let off = 0;
    while (off < buf.length) {
      let w;
      try {
        w = fs.writeSync(1, buf, off, buf.length - off, null);
      } catch (e) {
        if (e.code === 'EAGAIN') continue;
        throw e;
      }
      off += w; // a full pipe takes the rest on the next write
    }
  };
  const run = (reqText) => {
    let reply;
    try {
      const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false }, microtaskMode: 'afterEvaluate' });
      ctx.__reqText = reqText;
      vm.runInContext('globalThis.module = { exports: {} };', ctx);
      luccetScript.runInContext(ctx, { timeout: STARTUP_MS });
      driverScript.runInContext(ctx, { timeout: STARTUP_MS });
      reply = vm.runInContext('__luccetDriver(JSON.parse(__reqText))', ctx, { timeout: RUN_MS, filename: 'luccet-sandbox', importModuleDynamically: noImport });
      if (typeof reply !== 'string') throw new Error('the driver returned no analysis');
    } catch (e) {
      const timeout = e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      reply = JSON.stringify({ failed: timeout ? 'timeout' : 'error', message: (e && e.message) || String(e) });
    }
    writeFrame(reply);
  };

  const input = process.stdin;
  let buf = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len === 0 || len > 0x7fffffff) return process.exit(0);
      if (buf.length < 4 + len) return;
      const reqText = buf.toString('utf8', 4, 4 + len);
      buf = buf.subarray(4 + len);
      run(reqText);
    }
  });
  input.on('end', () => process.exit(0));
  input.on('error', () => process.exit(0));
}

// ------------------------------------------------------------------ host

let child = null; // the blocking bridge's: {proc, toFd, fromFd, alive, served} or null before the first note
let viaWorker = process.env.LUCCET_SANDBOX_ONESHOT === '1'; // the blocking way goes through a worker thread (Windows)
let broken = false; // a spawn that failed: fall back, warn once
const spin = new Int32Array(new SharedArrayBuffer(4));
const TRIP_AT = 3; // children dead before their first answer, in a row
const TRIP_MS = 60000;
let deaths = 0;
let trippedUntil = 0;

// A child answered: the run of deaths is over. A child died before it ever
// answered: one more; at TRIP_AT, the breaker trips.
function answered(c) {
  c.served = (c.served || 0) + 1;
  deaths = 0;
}
function died(c) {
  if (c.served) return (deaths = 0);
  if (++deaths < TRIP_AT) return;
  deaths = 0;
  trippedUntil = Date.now() + TRIP_MS;
  process.stderr.write(`luccet: the script sandbox died ${TRIP_AT} times in a row before answering; notes are analysed without their own scripts for ${TRIP_MS / 1000} s\n`);
}
const tripped = () => Date.now() < trippedUntil;

// The child's command line and environment: Node's permission model,
// reading only luccet.js and this file, a memory cap, and an empty environment
// but for what Node itself needs to start on Windows.
const ARGS = ['--permission', `--allow-fs-read=${LUCCET}`, `--allow-fs-read=${SELF}`, `--max-old-space-size=${MEMORY_MB}`, SELF, '--sandbox-child'];
function childEnv() {
  const env = {};
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// A child, speaking only over its stdin and stdout; a note's console output
// rides back in the reply, and its stderr carries nothing but a crash dump
// (an out-of-memory report), so it is dropped. It does not hold the process
// open: a finished command exits, and the child then reaches end-of-input
// and exits too.
function spawnProcess() {
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, ARGS, { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv() });
  proc.on('error', () => {});
  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error('the sandbox pipes are not available');
  }
  proc.unref();
  return proc;
}

function spawnChild() {
  const proc = spawnProcess();
  const to = proc.stdin;
  const from = proc.stdout;
  // The tools read the reply synchronously (below), so keep Node's stream
  // machinery off these pipes — it must not race the manual reads.
  to.pause();
  from.pause();
  const fd = (s) => (s._handle && typeof s._handle.fd === 'number' && s._handle.fd >= 0 ? s._handle.fd : null);
  if (fd(to) === null || fd(from) === null) {
    // No descriptor to read (Windows): through a worker thread, below.
    proc.kill();
    viaWorker = true;
    return null;
  }
  to.unref();
  from.unref();
  return { proc, toFd: fd(to), fromFd: fd(from), alive: true, served: 0 };
}

// The blocking way without a readable pipe: a worker thread runs the
// event-loop bridge below, its one child serving every note of the run, and
// this thread sleeps on a shared flag until the reply is posted (Atomics.wait,
// then receiveMessageOnPort, which reads it without the event loop). The
// worker leaves the note's console output to this thread, which prints it in
// order. A worker that never answers is ended, and the note has timed out.
let bridge = null; // {worker, port, flag}
function startBridge() {
  const { Worker, MessageChannel } = require('worker_threads');
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(SELF, { workerData: { luccetSandboxBridge: port2, flag }, transferList: [port2] });
  worker.unref();
  port1.unref();
  const b = { worker, port: port1, flag };
  worker.on('error', () => bridge === b && (bridge = null));
  worker.on('exit', () => bridge === b && (bridge = null));
  return b;
}
function workerAnalyse(req) {
  const { receiveMessageOnPort } = require('worker_threads');
  const b = (bridge = bridge || startBridge());
  Atomics.store(b.flag, 0, 0);
  b.port.postMessage(req);
  if (Atomics.wait(b.flag, 0, 0, STARTUP_MS + WEDGED_MS) === 'timed-out') {
    bridge = null;
    b.worker.terminate();
    return { failed: 'timeout' };
  }
  const m = receiveMessageOnPort(b.port);
  if (!m) return { failed: 'crash' };
  const { said, ...reply } = m.message;
  if (said) process.stderr.write(said);
  return reply;
}
// In the worker: each request through analyseAsync, the reply posted back,
// then the flag raised. What the bridge itself says on stderr (a breaker
// tripped, a child that cannot start) rides in the reply, as `said`: the
// worker's own stderr would reach the terminal only once the tools' thread
// is free, out of order or after the command has exited.
function bridgeMain({ luccetSandboxBridge: port, flag }) {
  let said = '';
  process.stderr.write = (s) => ((said += String(s)), true);
  port.on('message', async (req) => {
    let reply;
    try {
      reply = await analyseAsync(req, true);
    } catch (e) {
      reply = { failed: 'error' }; // the flag is raised all the same: the tools never wait on a request that threw
    }
    port.postMessage(said ? { ...reply, said } : reply);
    said = '';
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });
}

function ensureChild() {
  if (child && child.alive && child.proc.exitCode === null && child.proc.signalCode === null) return child;
  child = spawnChild();
  if (!child) return null;
  const mark = () => { child && (child.alive = false); };
  child.proc.on('exit', mark);
  return child;
}

// A spawn that failed: no child runs for the rest of the process, said once.
function unavailable(e) {
  broken = true;
  process.stderr.write(`luccet: the script sandbox could not start (${e.message}); notes are analysed without their own scripts\n`);
  return { failed: 'unavailable' };
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
  if (tripped()) return { failed: 'tripped' };
  if (viaWorker) {
    let reply;
    try {
      reply = workerAnalyse(req);
    } catch (e) {
      return unavailable(e);
    }
    if (reply.consoleOut && reply.consoleOut.length) process.stderr.write(reply.consoleOut.map(clean).join('\n') + '\n');
    return reply;
  }
  let c;
  try {
    c = ensureChild();
    if (!c) return analyse(req); // the pipe gave no descriptor: through the worker now
  } catch (e) {
    return unavailable(e);
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
    if (text === null) died(c);
    return { failed: text === undefined ? 'timeout' : 'crash' };
  }
  answered(c);
  let reply;
  try {
    reply = JSON.parse(text);
  } catch (e) {
    return { failed: 'error' };
  }
  if (reply.consoleOut && reply.consoleOut.length) process.stderr.write(reply.consoleOut.map(clean).join('\n') + '\n');
  return reply;
}

// ------------------------------------------------- host, through the event loop

// The asynchronous bridge's child, for the language server: the same child,
// read and written with Node's streams. Requests go one at a time, in the
// order they came; a reply settles the request in flight. A child that dies
// fails that request and a fresh child takes the next; one that answers
// nothing within WEDGED_MS is killed, and the request has timed out.
let achild = null; // {proc, to, from, buf, job, alive}
const queue = []; // {req, resolve, timer} waiting for a child

function spawnAsync() {
  const proc = spawnProcess();
  const c = { proc, to: proc.stdin, from: proc.stdout, buf: Buffer.alloc(0), job: null, alive: true, served: 0 };
  c.to.on('error', () => {});
  c.from.on('error', () => {});
  c.from.on('data', (chunk) => {
    c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
    while (c.buf.length >= 4) {
      const len = c.buf.readUInt32BE(0);
      if (c.buf.length < 4 + len) return;
      const text = c.buf.toString('utf8', 4, 4 + len);
      c.buf = c.buf.subarray(4 + len);
      let reply;
      try {
        reply = JSON.parse(text);
      } catch (e) {
        reply = { failed: 'error' };
      }
      answered(c);
      settle(c, reply);
    }
  });
  proc.on('exit', () => {
    retire(c);
    if (c.job) {
      died(c);
      settle(c, { failed: 'crash' });
    } else pump();
  });
  // The pipes keep the process open only while a request is in flight.
  c.to.unref();
  c.from.unref();
  return c;
}

// `quiet`: the reply keeps the note's console output for the caller to
// print (the worker bridge's), instead of printing it here.
function analyseAsync(req, quiet = false) {
  return new Promise((resolve) => {
    queue.push({ req, resolve, timer: null, quiet });
    pump();
  });
}

// Starts the next request when the child is free, spawning one when there is
// none; the spawn failing settles every waiting request as unavailable.
function pump() {
  if (!queue.length) return;
  if (broken) return queue.splice(0).forEach((j) => j.resolve({ failed: 'unavailable' }));
  if (tripped()) return queue.splice(0).forEach((j) => j.resolve({ failed: 'tripped' }));
  if (!achild || !achild.alive) {
    try {
      achild = spawnAsync();
    } catch (e) {
      const r = unavailable(e);
      return queue.splice(0).forEach((j) => j.resolve(r));
    }
  }
  const c = achild;
  if (c.job) return;
  const job = queue.shift();
  c.job = job;
  c.from.ref();
  job.timer = setTimeout(() => {
    retire(c);
    try {
      c.proc.kill();
    } catch (e) {}
    settle(c, { failed: 'timeout' });
  }, WEDGED_MS);
  const body = Buffer.from(JSON.stringify(job.req), 'utf8');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  c.to.write(Buffer.concat([head, body]));
}

// A child that died or wedged is done with; the next request gets a fresh one.
function retire(c) {
  c.alive = false;
  if (achild === c) achild = null;
}

function settle(c, reply) {
  const job = c.job;
  if (!job) return;
  c.job = null;
  clearTimeout(job.timer);
  c.from.unref();
  if (!job.quiet && reply.consoleOut && reply.consoleOut.length) process.stderr.write(reply.consoleOut.map(clean).join('\n') + '\n');
  job.resolve(reply);
  pump();
}

function shutdown() {
  for (const c of [child, achild]) {
    if (!c) continue;
    try {
      c.proc.stdin.end();
      c.proc.kill();
    } catch (e) {}
  }
  child = null;
  achild = null;
  if (bridge) bridge.worker.terminate();
  bridge = null;
}

const thread = require('worker_threads');
if (require.main === module && process.argv.includes('--sandbox-child')) childMain();
else if (!thread.isMainThread && thread.workerData && thread.workerData.luccetSandboxBridge) bridgeMain(thread.workerData);
else module.exports = { analyse, analyseAsync, shutdown, clean };
