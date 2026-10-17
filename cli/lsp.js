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
// A note's code runs over the sandbox's asynchronous bridge, so the server
// keeps answering while it runs: from the last analysis, until the next one
// lands. A rename, whose edits must match the text, waits for it.
// Across files, a link `page.html#id` is a reference too: definition,
// references and rename follow it, over cli/links.js's view of the
// workspace's notes (parsed, their code not run), as do document links,
// and workspace symbols come from the same notes' outlines.
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const note = require('./note');
const language = require('./language');
const links = require('./links');
const { relocate } = require('./relocate');
const { pathEnd } = require('./relocate');

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
// A request of the server's to the client: its id, so the response is known.
const asked = new Map(); // id -> the method
let askedId = 0;
const request = (method, params) => {
  const id = `tern-${++askedId}`;
  asked.set(id, method);
  send({ id, method, params });
};

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
    // A response to a request of the server's (a registration) is noted
    // when it is an error; one the server never asked for is dropped. A
    // request with an id and no method, or one that is not a string, is
    // answered, so that no client waits forever (JSON-RPC: an invalid request).
    if (id !== undefined && asked.has(id)) {
      const what = asked.get(id);
      asked.delete(id);
      if (msg.error) log(`${what}: the client answered ${msg.error.code} ${msg.error.message}`);
    } else if (id !== undefined && !('result' in msg) && !('error' in msg)) send({ id, error: { code: -32600, message: 'the request has no method' } });
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
      error = errorOf(e);
    }
  }
  // A request answered later (a rename waiting for an analysis) is a promise.
  if (!error && result && typeof result.then === 'function') {
    result.then(
      (r) => send({ id, result: r ?? null }),
      (e) => send({ id, error: errorOf(e) }),
    );
    return;
  }
  send(error ? { id, error } : { id, result });
}

// What a request's throw answers: a LanguageError's code, a refusal's, else
// an internal error, logged.
function errorOf(e) {
  if (e && e.rpc) return e.rpc;
  if (e instanceof language.LanguageError) return { code: ERROR[e.code], message: e.message };
  log((e && e.stack) || e);
  return { code: -32603, message: String((e && e.message) || e) };
}

const FILES = { filters: [{ scheme: 'file', pattern: { glob: '**' } }] }; // every file and folder: a link may name any
const CAPABILITIES = {
  positionEncoding: 'utf-16',
  textDocumentSync: { openClose: true, change: 1, save: { includeText: false } }, // full text
  completionProvider: { triggerCharacters: [':', '@'] },
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  documentHighlightProvider: true,
  renameProvider: { prepareProvider: true },
  documentSymbolProvider: true,
  foldingRangeProvider: true,
  documentLinkProvider: { resolveProvider: false },
  codeActionProvider: { codeActionKinds: ['quickfix'] },
  workspaceSymbolProvider: true,
  workspace: {
    workspaceFolders: { supported: true, changeNotifications: true },
    fileOperations: { willRename: FILES, didRename: FILES, didCreate: FILES, didDelete: FILES },
  },
};
// The files whose change the server asks to hear of, when the client can
// watch them: notes and the files they link to, and the scripts and
// stylesheets they load.
const WATCH = { watchers: [{ globPattern: '**/*.{html,htm,md,markdown,js,mjs,css}' }] };

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
    const ws = params.capabilities && params.capabilities.workspace;
    watches = !!(ws && ws.didChangeWatchedFiles && ws.didChangeWatchedFiles.dynamicRegistration);
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
  'textDocument/documentLink': documentLink,
  'textDocument/codeAction': codeAction,
  'workspace/symbol': workspaceSymbol,
  'workspace/willRenameFiles': willRenameFiles,
};

const NOTIFICATIONS = {
  // A client that can watch files is asked to, once it is ready.
  initialized: () => watches && request('client/registerCapability', { registrations: [{ id: 'tern-watch', method: 'workspace/didChangeWatchedFiles', registerOptions: WATCH }] }),
  'textDocument/didOpen': didOpen,
  'textDocument/didChange': didChange,
  'textDocument/didClose': didClose,
  'textDocument/didSave': () => refresh(null),
  'workspace/didChangeWatchedFiles': didChangeWatchedFiles,
  'workspace/didChangeWorkspaceFolders': didChangeWorkspaceFolders,
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
// analysed, links, running, again, vocab}: `a` is the last analysis, of
// version `analysed`, `links` its link diagnostics as last published,
// `running` the analysis in flight (a promise) with `again` set when the
// text changed meanwhile, and `vocab` the vocabulary of the last analysis
// whose scripts ran, which stands in while they do not (cli/note.js).
const docs = new Map();
let opened = 0;
let roots = []; // the workspace folders, from initialize and didChangeWorkspaceFolders
let noScripts = false; // initializationOptions.noScripts: do not run notes' code
let watches = false; // the client can watch files for the server (dynamic registration)

// The workspace's folders changed: searches across files read the new set.
function didChangeWorkspaceFolders({ event }) {
  if (!event || typeof event !== 'object') return;
  const list = (k) => (Array.isArray(event[k]) ? event[k].map((f) => f && fileOf(f.uri)).filter(Boolean) : []);
  const gone = new Set(list('removed'));
  roots = [...roots.filter((r) => !gone.has(r)), ...list('added').filter((r) => !roots.includes(r))];
}

// A watched file changed on disk: the open notes' links are checked again,
// and a note that loads the file as a head script or an add-on is analysed
// again, so an add-on edited on disk takes effect at once.
function didChangeWatchedFiles({ changes }) {
  const changed = new Set((Array.isArray(changes) ? changes : []).map((c) => c && fileOf(c.uri)).filter(Boolean));
  for (const d of docs.values()) if (d.a && Array.isArray(d.a.files) && d.a.files.some((f) => changed.has(f)) && !d.timer) analyse(d);
  refresh(null);
}

function didOpen({ textDocument: d }) {
  if (!d || typeof d.uri !== 'string') return;
  const doc = { uri: d.uri, file: fileOf(d.uri), opened: ++opened, version: d.version, text: String(d.text ?? ''), timer: null, index: null, wasNote: false, a: null, analysed: null, links: [], running: null, again: false, vocab: null };
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

// The document a request names. A change still waiting starts its analysis
// now, but the request is answered from the last analysis: the server does
// not block on a note's code. A document never analysed yet (a request
// right after didOpen) has none to answer from, so that first analysis is
// waited for. Its `index` is cli/language.js's, or null for a file that is
// not a note.
async function current(params) {
  const doc = docs.get(params.textDocument && params.textDocument.uri);
  if (!doc) throw fail(-32602, 'unknown document: it was never opened');
  if (doc.timer) analyse(doc);
  while (doc.analysed === null && doc.running) await doc.running;
  return doc;
}

// The document once its text is analysed: what a rename waits for, as its
// edits must match the text as it is.
async function settled(doc) {
  while (doc.timer || doc.running) {
    if (doc.timer) analyse(doc);
    await doc.running;
  }
  return doc;
}

// Parses and transforms, over the sandbox's asynchronous bridge, then
// publishes the diagnostics, its links' among them, and the outline. A file
// that is not a note gets none, and an empty outline if it was one. Then the
// other open notes' links are checked again. One analysis runs per document
// at a time: a change during one is analysed after it.
function analyse(doc) {
  clearTimeout(doc.timer);
  doc.timer = null;
  if (doc.running) {
    doc.again = true;
    return;
  }
  const version = doc.version;
  doc.running = note
    .analyseAsync(doc.text, doc.file, { noScripts, lastVocab: doc.vocab })
    .then(
      (a) => guard(() => analysed(doc, version, a)),
      (e) => log(`analysing ${doc.uri}: ${(e && e.stack) || e}`),
    )
    .then(() => {
      doc.running = null;
      if (doc.again) {
        doc.again = false;
        if (docs.get(doc.uri) === doc && phase === 'running') analyse(doc);
      }
    });
}

function analysed(doc, version, a) {
  if (docs.get(doc.uri) !== doc || phase !== 'running') return; // closed, or shut down, meanwhile
  doc.a = a;
  doc.analysed = version;
  if (a && a.vocab && a.vocab.ran) doc.vocab = a.vocab;
  if (a && doc.file) targets.remember(doc.file, a);
  doc.links = linksOf(doc);
  publish(doc);
  if (a || doc.wasNote) guard(() => notify('tern/outline', { uri: doc.uri, version, ...language.outline(a) }));
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
const at = async (params) => [(await current(params)).index, params.position];

// From a reference in the note, the declaration in it; from a link to
// another file, `page.html#id`, the id's declaration there, or the file's
// first line without a fragment.
async function definition(params) {
  const doc = await current(params);
  const range = language.definition(doc.index, params.position);
  if (range) return { uri: doc.uri, range };
  const to = linkAt(doc, params.position);
  if (!to) return null;
  if (!to.frag) return { uri: uriOf(to.dest), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  return declarationIn(to.dest, to.frag);
}

// Every use of the id, in its note and from every note of the workspace
// that links to `page.html#id`; from a reference, a declaration, or such a
// link. The declaration first on request.
async function references(params) {
  const doc = await current(params);
  const want = !!(params.context && params.context.includeDeclaration);
  const t = idUnder(doc, params.position);
  if (!t) return null;
  const out = [];
  const own = t.index && language.references(t.index, t.at, { includeDeclaration: want });
  if (own) out.push(...own.map((range) => ({ uri: uriOf(t.file), range })));
  else if (want && t.index) {
    const decl = language.declaration(t.index, t.id);
    if (decl) out.push({ uri: uriOf(t.file), range: decl });
  }
  if (t.file) out.push(...incoming(t.file, t.id));
  return out;
}

async function documentHighlight(params) {
  const list = language.highlights(...(await at(params)));
  return list && list.map((h) => ({ range: h.range, kind: HIGHLIGHT[h.kind] }));
}

async function hover(params) {
  const h = language.hover(...(await at(params)));
  return h && { contents: { kind: 'markdown', value: h.markdown }, range: h.range };
}

async function prepareRename(params) {
  const doc = await settled(await current(params));
  return language.prepareRename(doc.index, params.position);
}

// An id's declaration and uses in its note, and the fragment of every link
// to it from the workspace's notes; from a reference, a declaration, or a
// link `page.html#id`. An element's name: its opener and closer only.
async function rename(params) {
  const doc = await settled(await current(params));
  const t = idUnder(doc, params.position);
  const changes = {};
  if (!t) {
    const edits = language.rename(doc.index, params.position, params.newName);
    return edits && { changes: { [doc.uri]: edits } };
  }
  if (!t.index) throw fail(ERROR.refused, `${shownPath(t.file)} is not a note, so its id "${t.id}" cannot be renamed here`);
  const edits = language.rename(t.index, t.at, params.newName);
  if (!edits) return null;
  changes[uriOf(t.file)] = edits;
  for (const loc of incoming(t.file, t.id)) (changes[loc.uri] = changes[loc.uri] || []).push({ range: loc.range, newText: params.newName });
  return { changes };
}

// The trigger is read from the text as it is, so that completion answers
// right after a keystroke, from the last analysis: the names and ids it
// knows, and where it was inside code or math.
async function completion(params) {
  const doc = await current(params);
  const now = doc.analysed === doc.version ? undefined : note.split(doc.text) || undefined;
  return language.completion(doc.index, params.position, now).map((i) => ({
    label: i.label,
    kind: COMPLETION[i.kind],
    detail: i.detail,
    sortText: i.sortText,
    filterText: i.filterText,
    textEdit: { range: i.range, newText: i.newText },
  }));
}

async function documentSymbol(params) {
  const symbol = (s) => ({ ...s, kind: SYMBOL[s.kind], children: s.children.map(symbol) });
  return language.symbols((await current(params)).index).map(symbol);
}

async function foldingRange(params) {
  return language.folds((await current(params)).index);
}

// textDocument/documentLink: every URL written in the note, the head and
// the tag, with where it goes: a file, with its fragment, or an absolute URL
// as it is. URLs that resolve from the site root (/…, //…) have no target
// here, so they are left out, as are links to files that do not exist.
async function documentLink(params) {
  const doc = await current(params);
  if (!doc.a) return [];
  return targets.during(() =>
    links
      .urls(doc.a)
      .map((u) => {
        if (!u.span) return null;
        const target = targetOf(doc, u);
        return target ? { range: lspRange(links.spanRange(doc.a, u.span)), target } : null;
      })
      .filter(Boolean),
  );
}

function targetOf(doc, u) {
  const url = u.url.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  const r = links.parse(url);
  if (!r) return null;
  if (!r.path) return r.frag === null ? null : `${doc.uri}#${encodeURIComponent(r.frag)}`;
  if (!doc.file) return null;
  const to = links.resolve(doc.file, url, targets);
  if (!to || to.problem === 'missing' || to.problem === 'no-index') return null;
  return pathToFileURL(to.dest).href + (to.frag ? `#${encodeURIComponent(to.frag)}` : '');
}

// textDocument/codeAction: the fixes of the diagnostics in the range, each
// a quickfix with its edit: cli/language.js's for the engine's diagnostics,
// and the disk's spelling for a link.missing in another case. The client's
// diagnostics are matched by code and range; none matching, the range's.
async function codeAction(params) {
  const doc = await current(params);
  if (!doc.a) return [];
  const published = links.merge(doc.a.diagnostics, doc.links).map((d) => ({ d, lsp: diagnostic(d) }));
  const given = (params.context && Array.isArray(params.context.diagnostics) ? params.context.diagnostics : []).filter((g) => g && typeof g === 'object');
  const same = (g, p) => g.code === p.code && JSON.stringify(g.range) === JSON.stringify(p.range);
  let picked = given.length ? published.filter((p) => given.some((g) => same(g, p.lsp))) : [];
  if (!picked.length && params.range) picked = published.filter((p) => overlaps(p.lsp.range, params.range));
  const out = [];
  for (const { d, lsp } of picked) {
    const fixes = d.code === 'link.missing' ? linkFixes(doc, d) : language.actions(doc.index, d);
    for (const f of fixes) out.push({ title: f.title, kind: 'quickfix', diagnostics: [lsp], isPreferred: !!f.preferred, edit: { changes: { [doc.uri]: f.edits } } });
  }
  return out;
}

// A link.missing whose hint spells the path as the disk does: that spelling.
function linkFixes(doc, d) {
  const m = /^write it as the disk does: (.+)$/.exec(d.hint || '');
  if (!m) return [];
  const at = JSON.stringify(d.filePosition);
  const u = links.urls(doc.a).find((x) => x.span && JSON.stringify(x.filePosition) === at);
  if (!u) return [];
  const text = u.span.in === 'head' ? doc.a.head : u.span.in === 'tag' ? doc.a.tag : doc.a.note;
  const end = u.span.from + pathEnd(text.slice(u.span.from, u.span.to));
  return [{ title: `Write it as the disk does: ${m[1]}`, edits: [{ range: lspRange(links.spanRange(doc.a, { ...u.span, to: end })), newText: m[1] }], preferred: true }];
}

const overlaps = (a, b) => !(before(a.end, b.start) && !same(a.end, b.start)) && !(before(b.end, a.start) && !same(b.end, a.start));
const before = (p, q) => p.line < q.line || (p.line === q.line && p.character <= q.character);
const same = (p, q) => p.line === q.line && p.character === q.character;

// workspace/symbol: the headings, and the blocks with an id or a title, of
// every note in the workspace folders and every open note, from their
// outlines (parsed, their code not run); `query` matches a name or an id,
// case ignored, and an empty query lists them all, up to a thousand.
function workspaceSymbol(params) {
  const q = String(params.query ?? '').toLowerCase();
  const out = [];
  const matches = (name, id) => !q || name.toLowerCase().includes(q) || (id !== undefined && `#${id}`.toLowerCase().includes(q));
  targets.during(() => {
    for (const file of workspaceNotes()) {
      if (out.length >= 1000) break;
      const { a } = targets.parsed(file);
      if (!a) continue;
      const uri = uriOf(file);
      const lines = a.note.split('\n');
      const location = (line, endLine) => ({ uri, range: { start: { line: line + a.line - 1, character: 0 }, end: { line: (endLine || line) + a.line - 1, character: (lines[(endLine || line) - 1] || '').length } } });
      const o = tern.outline(a.ast);
      const containerName = shownPath(file);
      for (const h of o.headings) if (matches(h.text, h.id)) out.push({ name: h.text || '(untitled)', kind: SYMBOL.heading, location: location(h.line), containerName });
      for (const b of o.blocks) {
        if (b.id === undefined && b.title === undefined) continue;
        const name = b.title || b.name;
        if (matches(name, b.id)) out.push({ name: b.id !== undefined ? `${name} #${b.id}` : name, kind: SYMBOL[b.kind], location: location(b.line, b.endLine), containerName });
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------- across files

// A position as the protocol's, from cli/links.js's 1-based file positions.
const lspRange = (r) => ({ start: { line: r.start.line - 1, character: r.start.column - 1 }, end: { line: r.end.line - 1, character: r.end.column - 1 } });
const within = (r, p) => before(r.start, p) && before(p, r.end);

// The document's uri for a file: an open document's, else the file's.
function uriOf(file) {
  for (const d of docs.values()) if (d.file === file) return d.uri;
  return pathToFileURL(file).href;
}

// A file as a message names it: relative to a workspace folder when it is in one.
function shownPath(file) {
  const dir = roots.find((r) => file === r || file.startsWith(r + path.sep));
  return dir ? path.relative(dir, file).split(path.sep).join('/') : file;
}

// The link to another file written at a position, resolved: {dest, frag,
// url} or null. A link to the note's own fragment is the engine's.
function linkAt(doc, pos) {
  if (!doc.a || !doc.file) return null;
  return targets.during(() => {
    for (const u of links.urls(doc.a)) {
      if (!u.span || u.own) continue;
      const r = links.parse(u.url);
      if (!r || !r.path || !within(lspRange(links.spanRange(doc.a, u.span)), pos)) continue;
      const to = links.resolve(doc.file, u.url, targets);
      if (!to || to.problem === 'missing' || to.problem === 'no-index') return null;
      return { dest: to.dest, frag: to.frag, url: u.url };
    }
    return null;
  });
}

// The id under a position, wherever it is declared: {file, id, index, at},
// `index` the index of the note declaring it (null for a file that is not a
// note) and `at` a position of the id in that note's index; or null off an
// id. In the note itself, or in the file a link `page.html#id` names.
function idUnder(doc, pos) {
  const own = language.idAt(doc.index, pos);
  if (own !== null) return { file: doc.file, id: own, index: doc.index, at: pos };
  const to = linkAt(doc, pos);
  if (!to || !to.frag) return null;
  const index = indexOf(to.dest);
  const decl = index && language.declaration(index, to.frag);
  return { file: to.dest, id: to.frag, index, at: decl ? decl.start : pos };
}

// The index of another note: an open document's, else of the file's
// analysis (cli/links.js's, kept while the file holds).
const indexes = new Map(); // file -> {stamp, index}
function indexOf(file) {
  for (const d of docs.values()) if (d.file === file && d.index) return d.index;
  const stamp = targets.source(file).stamp;
  const hit = indexes.get(file);
  if (hit && hit.stamp === stamp) return hit.index;
  const index = language.index(targets.analyse(file));
  indexes.delete(file);
  indexes.set(file, { stamp, index });
  if (indexes.size > 64) indexes.delete(indexes.keys().next().value);
  return index;
}

// Where an id is declared in a file: in a note, its declaration; in another
// HTML file, its id attribute or <a name>; in a Markdown file, the heading
// with that anchor. Each a location, or null.
function declarationIn(file, id) {
  const index = /\.html?$/i.test(file) ? indexOf(file) : null;
  if (index) {
    const range = language.declaration(index, id);
    return range && { uri: uriOf(file), range };
  }
  const { text } = targets.parsed(file);
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  const at = (i, column, length) => ({ uri: uriOf(file), range: { start: { line: i, character: column }, end: { line: i, character: column + length } } });
  if (/\.(md|markdown)$/i.test(file)) {
    // The heading whose GitHub anchor it is, as cli/links.js reads them.
    const seen = new Map();
    for (let i = 0; i < lines.length; i++) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]);
      if (!m) continue;
      const slug = m[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const n = seen.get(slug) || 0;
      seen.set(slug, n + 1);
      if ((n ? `${slug}-${n}` : slug) === id) return at(i, 0, lines[i].length);
    }
    return null;
  }
  const re = new RegExp(`<[a-zA-Z][^<>]*?\\s(?:id|name)\\s*=\\s*(?:"${escapeRe(id)}"|'${escapeRe(id)}'|${escapeRe(id)}(?=[\\s>]))`);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return at(i, m.index, m[0].length);
  }
  return null;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every link `page.html#id` to the id of a file, from the workspace's notes
// and the open ones: locations of the fragments as written.
function incoming(file, id) {
  const out = [];
  targets.during(() => {
    for (const f of workspaceNotes()) {
      const { a } = targets.parsed(f);
      if (!a) continue;
      for (const u of links.urls(a)) {
        if (!u.span || u.own) continue;
        const r = links.parse(u.url);
        if (!r || !r.path || r.frag !== id) continue;
        const to = links.resolve(f, u.url, targets);
        if (!to || to.dest !== file) continue;
        const span = links.fragmentSpan(a, u);
        if (span) out.push({ uri: uriOf(f), range: lspRange(links.spanRange(a, span)) });
      }
    }
  });
  return out;
}

// The notes a search over the workspace reads: those in the workspace
// folders, and every open document with a file. `more` adds folders.
function workspaceNotes(more = []) {
  const files = new Set();
  for (const d of docs.values()) if (d.file) files.add(d.file);
  for (const dir of new Set([...roots, ...more])) {
    try {
      for (const f of note.htmlFiles(dir)) files.add(path.resolve(f));
    } catch (e) {
      log(`reading ${dir}: ${e.message}`);
    }
  }
  return files;
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
  // Each note as the targets hold it: an open document's text, else the
  // file's, parsed once while its stamp holds.
  const notes = [];
  targets.during(() => {
    for (const file of workspaceNotes([...folders])) {
      const p = targets.parsed(file);
      if (p.a) notes.push({ file, text: p.text, parsed: p.a });
    }
  });
  const shown = (f) => {
    const dir = [...folders].find((r) => inside(f, r));
    return dir ? path.relative(dir, f).split(path.sep).join('/') : f;
  };
  const changes = {};
  const left = [];
  for (const p of relocate(notes, moves)) {
    if (p.edits.length) changes[uriOf(p.file)] = p.edits.map(textEdit);
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
