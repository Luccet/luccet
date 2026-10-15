// SPDX-License-Identifier: MIT
// `tern lsp`, the language server (docs/tools.html#lsp): a hand-rolled
// JSON-RPC 2.0 server over stdio, with Content-Length framing and no
// dependencies; main() starts it. It runs the engine on a note and
// publishes its diagnostics, as the browser reports them, and the
// `tern/outline` digest; cli/language.js answers the requests from the
// analysis, and this file maps its answers onto the protocol's shapes. A
// file renamed in the editor gets tern mv's link edits (cli/relocate.js).
// Positions are UTF-16 code units, as the engine's columns are; note line n
// is file line n + the head's line count (cli/note.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const note = require('./note');
const language = require('./language');
const links = require('./links');
const { relocate } = require('./relocate');

const { tern } = note;
const DEBOUNCE = 150; // ms after the last change
const SEVERITY = { error: 1, warning: 2, info: 3 };
const SYMBOL = { heading: 15, container: 5, leaf: 8 }; // LSP SymbolKind: String, Class, Field
const COMPLETION = { name: 7, core: 14, closer: 14, element: 10, id: 18 }; // LSP CompletionItemKind: Class, Keyword, Property, Reference
const HIGHLIGHT = { read: 2, write: 3 }; // LSP DocumentHighlightKind
const ERROR = { invalid: -32602, refused: -32803 }; // a LanguageError's code: InvalidParams, RequestFailed

const log = (s) => process.stderr.write(`tern lsp: ${s}\n`);
const fail = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });
const guard = (fn) => {
  try {
    fn();
  } catch (e) {
    log((e && e.stack) || e);
  }
};

// ---------------------------------------------------------------- JSON-RPC

function send(msg) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const notify = (method, params) => send({ method, params });

// Content-Length framing. A header block without a length is skipped; a body
// that is not JSON gets a parse error.
function read(input, onMessage) {
  let buf = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let sep; (sep = buf.indexOf('\r\n\r\n')) >= 0; ) {
      const m = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(buf.toString('ascii', 0, sep));
      const end = m ? sep + 4 + Number(m[1]) : sep + 4;
      if (buf.length < end) return;
      const body = m ? buf.toString('utf8', sep + 4, end) : null;
      buf = buf.subarray(end);
      if (body === null) continue;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        send({ id: null, error: { code: -32700, message: 'the message is not JSON' } });
        continue;
      }
      guard(() => onMessage(msg));
    }
  });
}

let phase = 'new'; // 'running' after initialize, 'down' after shutdown

function receive(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send({ id: null, error: { code: -32600, message: 'not a JSON-RPC message' } });
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  if (typeof method !== 'string') {
    // A response, which the server never asked for, is dropped. A request
    // with an id and no method, or one that is not a string, is answered,
    // so that no client waits forever (JSON-RPC: an invalid request).
    if (id !== undefined && !('result' in msg) && !('error' in msg)) send({ id, error: { code: -32600, message: 'the request has no method' } });
    return;
  }
  if (id === undefined) {
    if (method === 'exit') return exit();
    const fn = phase === 'running' && NOTIFICATIONS[method];
    return fn && fn(params); // notifications are never answered
  }
  const fn = REQUESTS[method];
  let error = null;
  let result = null;
  if (phase === 'new' && method !== 'initialize') error = { code: -32002, message: 'the server is not initialized' };
  else if (phase === 'down') error = { code: -32600, message: 'the server is shut down' };
  else if (!fn) error = { code: -32601, message: `${method} is not supported` };
  else {
    try {
      result = fn(params) ?? null;
    } catch (e) {
      if (e && e.rpc) error = e.rpc;
      else if (e instanceof language.LanguageError) error = { code: ERROR[e.code], message: e.message };
      else {
        error = { code: -32603, message: String((e && e.message) || e) };
        log((e && e.stack) || e);
      }
    }
  }
  send(error ? { id, error } : { id, result });
}

const FILES = { filters: [{ scheme: 'file', pattern: { glob: '**' } }] }; // every file and folder: a link may name any
const CAPABILITIES = {
  positionEncoding: 'utf-16',
  textDocumentSync: { openClose: true, change: 1, save: { includeText: false } }, // full text
  completionProvider: { triggerCharacters: [':', '@', '/', '#'] },
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  documentHighlightProvider: true,
  renameProvider: { prepareProvider: true },
  documentSymbolProvider: true,
  foldingRangeProvider: true,
  workspace: { fileOperations: { willRename: FILES, didRename: FILES, didCreate: FILES, didDelete: FILES } },
};

const REQUESTS = {
  initialize(params) {
    if (phase !== 'new') throw fail(-32600, 'the server is already initialized');
    phase = 'running';
    const folders = Array.isArray(params.workspaceFolders) ? params.workspaceFolders.map((f) => f && f.uri) : [params.rootUri];
    roots = folders.map(fileOf).filter(Boolean);
    if (!roots.length && typeof params.rootPath === 'string') roots = [path.resolve(params.rootPath)];
    // initializationOptions.noScripts: true analyses without running notes'
    // own code (cli/sandbox.js), for a workspace of notes you do not trust.
    const init = params.initializationOptions;
    noScripts = !!(init && init.noScripts);
    return { capabilities: CAPABILITIES, serverInfo: { name: 'tern', version: tern.version } };
  },
  shutdown() {
    phase = 'down';
    for (const doc of docs.values()) clearTimeout(doc.timer);
    return null;
  },
  'textDocument/completion': completion,
  'textDocument/definition': definition,
  'textDocument/references': references,
  'textDocument/documentHighlight': documentHighlight,
  'textDocument/prepareRename': prepareRename,
  'textDocument/rename': rename,
  'textDocument/hover': hover,
  'textDocument/documentSymbol': documentSymbol,
  'textDocument/foldingRange': foldingRange,
  'workspace/willRenameFiles': willRenameFiles,
};

const NOTIFICATIONS = {
  'textDocument/didOpen': didOpen,
  'textDocument/didChange': didChange,
  'textDocument/didClose': didClose,
  'textDocument/didSave': () => refresh(null),
  'workspace/didChangeWatchedFiles': () => refresh(null),
  'workspace/didRenameFiles': () => refresh(null),
  'workspace/didCreateFiles': () => refresh(null),
  'workspace/didDeleteFiles': () => refresh(null),
};

function exit() {
  const code = phase === 'down' ? 0 : 1;
  process.stdout.write('', () => process.exit(code));
}

// ---------------------------------------------------------------- documents

// uri -> {uri, file, opened, version, text, timer, index, wasNote, a,
// analysed, links}: `a` is the last analysis, of version `analysed`, and
// `links` its link diagnostics as last published.
const docs = new Map();
let opened = 0;
let roots = []; // the workspace folders, from initialize
let noScripts = false; // initializationOptions.noScripts: do not run notes' code

function didOpen({ textDocument: d }) {
  if (!d || typeof d.uri !== 'string') return;
  const doc = { uri: d.uri, file: fileOf(d.uri), opened: ++opened, version: d.version, text: String(d.text ?? ''), timer: null, index: null, wasNote: false, a: null, analysed: null, links: [] };
  docs.set(d.uri, doc);
  analyse(doc);
}

function didChange({ textDocument: d, contentChanges }) {
  const doc = d && docs.get(d.uri);
  if (!doc) return;
  // Full sync (textDocumentSync.change = 1): each change is the whole text.
  // One with a range is a client's mistake, which applied as the whole text
  // would replace the note with a fragment: it is logged and ignored.
  let text = null;
  let ranged = 0;
  for (const c of Array.isArray(contentChanges) ? contentChanges : []) {
    if (!c || typeof c !== 'object') continue;
    if (c.range) ranged++;
    else text = String(c.text ?? '');
  }
  if (ranged) log(`${d.uri}: ${ranged} change(s) with a range ignored; the server syncs the full text (textDocumentSync.change = 1)`);
  if (text === null) return;
  doc.text = text;
  doc.version = d.version;
  clearTimeout(doc.timer);
  doc.timer = setTimeout(() => guard(() => analyse(doc)), DEBOUNCE);
}

function didClose({ textDocument: d }) {
  const doc = d && docs.get(d.uri);
  if (!doc) return;
  clearTimeout(doc.timer);
  docs.delete(d.uri);
  notify('textDocument/publishDiagnostics', { uri: doc.uri, diagnostics: [] });
  refresh(null); // a note that linked to it now reads the disk's copy
}

// The document a request names, analysed: a pending change is analysed
// first, so the debounce spaces out publishing but never serves stale text.
// Its `index` is cli/language.js's, or null for a file that is not a note.
function current(params) {
  const doc = docs.get(params.textDocument && params.textDocument.uri);
  if (!doc) throw fail(-32602, 'unknown document: it was never opened');
  if (doc.timer) analyse(doc);
  return doc;
}

// Parses and transforms, then publishes the diagnostics, its links' among
// them, and the outline. A file that is not a note gets none, and an empty
// outline if it was one. Then the other open notes' links are checked again.
function analyse(doc) {
  clearTimeout(doc.timer);
  doc.timer = null;
  let a;
  try {
    a = note.analyse(doc.text, doc.file, { noScripts });
  } catch (e) {
    return log(`analysing ${doc.uri}: ${(e && e.stack) || e}`);
  }
  doc.a = a;
  doc.analysed = doc.version;
  if (a && doc.file) targets.remember(doc.file, a);
  doc.links = linksOf(doc);
  publish(doc);
  if (a || doc.wasNote) guard(() => notify('tern/outline', { uri: doc.uri, version: doc.version, ...language.outline(a) }));
  doc.wasNote = !!a;
  doc.index = null;
  guard(() => (doc.index = language.index(a)));
  refresh(doc);
}

function publish(doc) {
  const list = doc.a ? links.merge(doc.a.diagnostics, doc.links) : [];
  notify('textDocument/publishDiagnostics', { uri: doc.uri, version: doc.analysed, diagnostics: list.map(diagnostic) });
}

// ---------------------------------------------------------------- links

// cli/links.js over the disk, an open document's text winning over its
// file's; its values are kept while their file, or document version, holds.
const targets = new links.Targets({
  open(file) {
    for (const d of docs.values()) if (d.file === file) return { text: d.text, stamp: `${d.opened} ${d.version}` };
    return undefined;
  },
  analyse: (text, file) => note.analyse(text, file, { noScripts }),
});

// The link diagnostics of an open note; none for an untitled document.
function linksOf(doc) {
  if (!doc.a || !doc.file) return [];
  try {
    return links.check(doc.file, doc.a, targets);
  } catch (e) {
    log(`checking the links of ${doc.uri}: ${(e && e.stack) || e}`);
    return [];
  }
}

// The other open notes' links, checked again: a file they link to may have
// changed, been made or gone. A note is published again only when its link
// diagnostics changed; one with a change pending waits for its analysis.
function refresh(except) {
  for (const d of docs.values()) {
    if (d === except || d.timer || !d.a) continue;
    const next = linksOf(d);
    if (JSON.stringify(next) === JSON.stringify(d.links)) continue;
    d.links = next;
    publish(d);
  }
}

// The note's path, for its head scripts and add-ons; null for an untitled or
// remote document. A folder's has no trailing separator.
function fileOf(uri) {
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return null;
  }
}

// An engine diagnostic as LSP's: a 0-based range from the file position, the
// tern code, and the hint after the message and in `data`.
function diagnostic(d) {
  const p = d.filePosition;
  const at = (q) => ({ line: Math.max(q.line - 1, 0), character: Math.max(q.column - 1, 0) });
  const out = { range: { start: at(p.start), end: at(p.end) }, severity: SEVERITY[d.severity] || 3, code: d.code, source: 'tern' };
  out.message = d.hint ? `${d.message}\n${d.hint}` : d.message;
  if (d.hint) out.data = { hint: d.hint };
  return out;
}

// ---------------------------------------------------------------- features

// Each request asks cli/language.js and gives its answer the protocol's
// shape: a location carries the document's uri, kinds are numbers.
const at = (params) => [current(params).index, params.position];

function definition(params) {
  const doc = current(params);
  const range = language.definition(doc.index, params.position);
  return range && { uri: doc.uri, range };
}

function references(params) {
  const doc = current(params);
  const ranges = language.references(doc.index, params.position, { includeDeclaration: !!(params.context && params.context.includeDeclaration) });
  return ranges && ranges.map((range) => ({ uri: doc.uri, range }));
}

function documentHighlight(params) {
  const list = language.highlights(...at(params));
  return list && list.map((h) => ({ range: h.range, kind: HIGHLIGHT[h.kind] }));
}

function hover(params) {
  const h = language.hover(...at(params));
  return h && { contents: { kind: 'markdown', value: h.markdown }, range: h.range };
}

function prepareRename(params) {
  return language.prepareRename(...at(params));
}

function rename(params) {
  const doc = current(params);
  const edits = language.rename(doc.index, params.position, params.newName);
  return edits && { changes: { [doc.uri]: edits } };
}

function completion(params) {
  return language.completion(...at(params)).map((i) => ({
    label: i.label,
    kind: COMPLETION[i.kind],
    detail: i.detail,
    sortText: i.sortText,
    filterText: i.filterText,
    textEdit: { range: i.range, newText: i.newText },
  }));
}

function documentSymbol(params) {
  const symbol = (s) => ({ ...s, kind: SYMBOL[s.kind], children: s.children.map(symbol) });
  return language.symbols(current(params).index).map(symbol);
}

function foldingRange(params) {
  return language.folds(current(params).index);
}

// ---------------------------------------------------------------- files

// workspace/willRenameFiles: the edits tern mv makes, which the client
// applies before it renames, so they name the files where they are. The
// notes read are the workspace folders' and the open documents, an open
// note's text winning over its file's; a move outside the workspace reads
// its repository, or its folder. URLs left alone are told in one message.
function willRenameFiles(params) {
  const moves = [];
  for (const f of Array.isArray(params.files) ? params.files : []) {
    const from = f && fileOf(f.oldUri);
    const to = f && fileOf(f.newUri);
    if (from && to && from !== to) moves.push({ from, to });
  }
  if (!moves.length) return null;
  const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  const folders = new Set(roots);
  for (const m of moves) if (!roots.some((r) => inside(m.from, r))) folders.add(note.repository(path.dirname(m.from)) || path.dirname(m.from));
  const open = new Map();
  for (const d of docs.values()) if (d.file) open.set(d.file, d);
  const files = new Set(open.keys());
  for (const dir of folders) {
    try {
      for (const f of note.htmlFiles(dir)) files.add(path.resolve(f));
    } catch (e) {
      log(`reading ${dir}: ${e.message}`);
    }
  }
  const notes = [];
  for (const file of files) {
    try {
      notes.push({ file, text: open.has(file) ? open.get(file).text : fs.readFileSync(file, 'utf8') });
    } catch (e) {
      log(`reading ${file}: ${e.message}; its links are left as they are`);
    }
  }
  const shown = (f) => {
    const dir = [...folders].find((r) => inside(f, r));
    return dir ? path.relative(dir, f).split(path.sep).join('/') : f;
  };
  const changes = {};
  const left = [];
  for (const p of relocate(notes, moves)) {
    if (p.edits.length) changes[open.has(p.file) ? open.get(p.file).uri : pathToFileURL(p.file).href] = p.edits.map(textEdit);
    if (p.base) left.push(`${shown(p.file)} has a <base href>, so its URLs do not resolve from its folder; they are left as they are`);
    for (const l of p.lost) left.push(`${shown(p.file)}:${l.line}:${l.column}: ${l.url} moves, but where it is written was not found; it is left as it is`);
  }
  if (left.length) notify('window/showMessage', { type: 2, message: left.map((s) => `tern: ${s}`).join('\n') });
  return Object.keys(changes).length ? { changes } : null;
}

// A relocate() edit as a TextEdit: it replaces `was`, from its line and
// column (the file's, 1-based).
function textEdit(e) {
  const lines = e.was.split('\n');
  const last = lines.length - 1;
  const end = { line: e.line - 1 + last, character: (last ? 0 : e.column - 1) + lines[last].length };
  return { range: { start: { line: e.line - 1, character: e.column - 1 }, end }, newText: e.text };
}

// ---------------------------------------------------------------- main

function main() {
  // stdout carries the protocol and nothing else: whatever a script logs
  // through `console` goes to stderr.
  const err = new console.Console(process.stderr, process.stderr);
  for (const k of Object.keys(console)) if (typeof console[k] === 'function' && typeof err[k] === 'function') console[k] = err[k].bind(err);
  process.on('uncaughtException', (e) => log((e && e.stack) || e));
  read(process.stdin, receive);
  process.stdin.on('end', () => process.exit(phase === 'down' ? 0 : 1));
}

module.exports = { main };
