// SPDX-License-Identifier: MIT
// tern new, check, parse, build, mv, search, index and corpus, and the
// arguments of tern lsp.
// Each command takes its arguments and returns the exit code (tern lsp: none,
// it runs until its client exits it):
//   0  done
//   1  check: a diagnostic at or above --fail-on; new: it refused (the file
//      exists, or the line it would write is not detected); mv: it refused
//      (a destination exists, a folder into itself) or a move failed;
//      search: nothing matched; index --check: a file is missing or stale;
//      corpus: an example whose diagnostics differ from its expect, or a
//      bad schema=
//   2  a usage error, or a path that cannot be used
// Diagnostics print as `file:line:col: severity code: message`, the hint
// indented below, with file lines (cli/note.js filePosition).
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { spawnSync } = require('child_process');
const { split, notNote, attributes, analyse, htmlFiles, repository, tern } = require('./note');
const { build, escAttr } = require('./build');
const links = require('./links');
const examples = require('./examples');
const { relocate, apply } = require('./relocate');

const SYNOPSIS = {
  new: 'tern new FILE [--tern=PATH] [--use=LIST] [--title=TEXT] [--guarded] [--force]',
  check: 'tern check PATH… [--json] [--fail-on=error|warning|info] [--quiet] [--no-scripts]',
  parse: 'tern parse FILE [--transformed] [--compact] [--no-scripts]',
  build: 'tern build FILE [-o OUT] [--math katex|mathml] [--no-scripts]',
  mv: 'tern mv FROM… TO [--root=DIR] [--dry-run]',
  search: 'tern search QUERY [PATH…] [--index=FILE] [--json] [--limit=N|all] [--no-scripts]',
  index: 'tern index [PATH…] [-o DIR] [--check] [--all] [--no-scripts]',
  corpus: 'tern corpus PATH… [--out=DIR]',
  lsp: 'tern lsp [--stdio]',
};

const usage = () =>
  `usage: tern COMMAND …

  ${SYNOPSIS.new}
      Write a new note: the canonical first line, loading the nearest tern.js
      in FILE's directory or above (or PATH); --use sets data-use (add-ons,
      separated by commas or spaces); --title adds a :::meta block; --guarded
      shows the source when tern.js does not load.
  ${SYNOPSIS.check}
      Print the diagnostics of notes; directories are searched for .html
      notes. --quiet prints only those at or above --fail-on (default error).
      --no-scripts analyses without running the notes' head scripts and
      add-ons (no vocabulary from them; safe for a note you do not trust).
  ${SYNOPSIS.parse}
      Print the note's AST as JSON, parsed or after the transforms.
      --no-scripts analyses without running the note's own code.
  ${SYNOPSIS.build}
      Write a static, pre-rendered page (to stdout without -o) that still
      loads tern.js; --math katex pre-renders formulas with the katex
      package (--katex is the same), --math mathml renders native MathML
      with the temml package and turns KaTeX off. --no-scripts builds
      without running the note's own code.
  ${SYNOPSIS.mv}
      Move or rename notes, files and folders, and rewrite the relative URLs
      that point at them, in every note under DIR (default: the repository
      FROM is in, else the current folder), and the moved notes' own. TO is
      a folder when it ends in / or exists. --dry-run (-n) prints the moves
      and the edits, and changes nothing.
  ${SYNOPSIS.search}
      Search notes by word: the notes under each PATH (default: the current
      folder) are split into entries — every heading's section and every
      named block with an id — ranked for QUERY, and printed as FILE:LINE:
      the entry's label and title, then its passage with the matching words.
      A query word stands for the words it begins. --limit caps the results
      (20). --index searches a search.json that tern index wrote instead of
      reading the notes. Exit 1 when nothing matches.
  ${SYNOPSIS.index}
      Write what a site's add-ons read about the notes under each PATH
      (default: the current folder): DIR/notes.json, a catalogue — each
      note's path, title, description, date, headings and links — for the
      ::notes list, and DIR/search.json, the index ::search{index=…} loads
      instead of fetching every note. DIR is -o, else the first PATH's
      folder; the paths in both files are relative to it. In a git
      repository only tracked files are indexed, so a private note is never
      published (--all indexes every file); a note whose meta says
      robots: noindex is left out. --check writes nothing and exits 1 when
      a file is missing or differs from what would be written.
  ${SYNOPSIS.corpus}
      Print the live examples of documentation pages (tern fences with the
      class live) as conformance-corpus cases. A case's spec: line is the
      fence's spec=, else PAGE#ID, the section of docs/PAGE.html it is in
      (PAGE#top before any heading; guide#top for a page outside docs/).
      --out writes DIR/docs-PAGE.txt.
  ${SYNOPSIS.lsp}
      The language server, over stdio (--stdio, which some editors pass, is
      accepted and changes nothing).

Exit codes: 0 done; 1 check found problems, new or mv refused, search found
nothing, index --check found a file missing or stale, or corpus found an
example that does not match its expect; 2 a usage error.
`;

class UsageError extends Error {
  constructor(message, synopsis = true) {
    super(message);
    this.synopsis = synopsis;
  }
}

// util.parseArgs, strict, with --help on every command.
function options(args, spec) {
  try {
    return parseArgs({ args, options: { ...spec, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
}

// A command: usage errors print with the synopsis and exit 2.
const command = (name, fn) => (args) => {
  try {
    return fn(args || []);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`tern ${name}: ${e.message}\n${e.synopsis ? `usage: ${SYNOPSIS[name]}\n` : ''}`);
    return 2;
  }
};

const say = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);
// --help prints the command's synopsis.
function help(name) {
  say(`usage: ${SYNOPSIS[name]}`);
  return 0;
}
// A command declines: the reason on stderr, exit 1.
function refuse(reason, name = 'new') {
  warn(`tern ${name}: ${reason}`);
  return 1;
}
const RANK = { info: 1, warning: 2, error: 3 };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.code === 'EISDIR' ? 'it is a directory' : e.message}`, false);
  }
}

function format(file, d) {
  const p = d.filePosition.start;
  return `${file}:${p.line}:${p.column}: ${d.severity} ${d.code}: ${d.message}${d.hint ? `\n    ${d.hint}` : ''}`;
}

// ---------------------------------------------------------------- new

// With --guarded, the rest of the tern.js line shows the source when tern.js
// does not run; it is inert when it does, since tern.js's capture swallows
// the rest of the file, this included.
//   - Scripts on, tern.js missing: the <noscript> is inert text in the head;
//     the script writes the message and an <xmp hidden> that the </xmp> right
//     after it closes, and <plaintext> shows the note as text.
//   - Scripts off: the <noscript>'s <p> starts the body, and its <xmp hidden>
//     hides the guard script up to the same </xmp>; then <plaintext>.
const GUARD =
  "<noscript><p>JavaScript is off; the source follows.</p><xmp hidden></noscript><script>self.tern||document.write('<p>tern.js did not load; the source follows.</p><xmp hidden>')</script></xmp><plaintext>";

// The nearest tern.js in dir or above, relative to dir with forward slashes.
function nearestTern(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, 'tern.js');
    try {
      if (fs.statSync(f).isFile()) return path.relative(dir, f).split(path.sep).join('/');
    } catch {}
    if (path.dirname(d) === d) return null;
  }
}

function newNote(args) {
  const { values: o, positionals } = options(args, {
    tern: { type: 'string' },
    use: { type: 'string', multiple: true },
    title: { type: 'string' },
    guarded: { type: 'boolean' },
    force: { type: 'boolean' },
  });
  if (o.help) return help('new');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const given = positionals[0];
  if (!given || /[\\/]$/.test(given) || ['', '.', '..'].includes(path.basename(given))) throw new UsageError(`"${given}" names no file`);
  const file = path.resolve(given);
  const dir = path.dirname(file);
  if (o.title !== undefined && (!o.title.trim() || /[\r\n]/.test(o.title))) throw new UsageError('--title is one non-empty line');
  if (o.tern !== undefined && !o.tern.trim()) throw new UsageError('--tern is empty');
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {}
  if (st && st.isDirectory()) return refuse(`${given} is a directory`);
  if (st && !o.force) return refuse(`${given} exists; --force overwrites it`);
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error();
  } catch {
    return refuse(`there is no directory ${path.dirname(given)}`);
  }

  // The canonical first line, then the optional :::meta.
  const found = o.tern === undefined ? nearestTern(dir) : null;
  const src = o.tern !== undefined ? o.tern.trim() : found || 'tern.js';
  const use = (o.use || []).flatMap((u) => u.split(/[\s,]+/)).filter(Boolean);
  const title = o.title === undefined ? null : o.title.trim();
  const first = `<!doctype html><meta charset="utf-8"><script src="${escAttr(src)}"></script>${o.guarded ? GUARD : ''}`;
  const text = `${first}\n${title === null ? '' : `:::meta\ntitle: ${title}\n:::\n\n`}${use.length ? `:::use\n${use.join('\n')}\n:::\n\n` : ''}`;

  // What is written must read back as a note with that line, src and title.
  const parts = split(text);
  const meta = parts && tern.parse(parts.note, { head: parts.head }).ast.data;
  if (!parts || parts.line !== 1 || attributes(parts.tag).src !== src) {
    return refuse(`<script src="${src}"> would not make ${given} a note: the src must name a file called tern.js`);
  }
  if (title !== null && !(meta && meta.tern && meta.tern.meta && meta.tern.meta.title === title)) return refuse(`the title does not read back from :::meta`);
  if (use.length && JSON.stringify((meta && meta.tern && meta.tern.use ? meta.tern.use : []).map((u) => u.url)) !== JSON.stringify(use)) return refuse(`the add-ons do not read back from :::use`);

  try {
    fs.writeFileSync(file, text, { flag: o.force ? 'w' : 'wx' });
  } catch (e) {
    return refuse(`cannot write ${given}: ${e.code === 'EEXIST' ? 'it exists' : e.message}`);
  }
  say(`created ${given}, loading ${src}${o.guarded ? ', guarded' : ''}`);
  if (o.tern === undefined && !found) warn(`tern new: no tern.js in ${path.dirname(given)} or above; the note loads tern.js from its own directory`);
  for (const u of use) {
    const local = u.replace(/[?#].*$/, '');
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(local) || local.startsWith('/')) continue;
    if (!fs.existsSync(path.resolve(dir, local))) warn(`tern new: :::use names ${u}, which does not exist yet`);
  }
  return 0;
}

// ---------------------------------------------------------------- check

function check(args) {
  const { values: o, positionals } = options(args, { json: { type: 'boolean' }, 'fail-on': { type: 'string' }, quiet: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('check');
  const level = o['fail-on'] === undefined ? 'error' : o['fail-on'];
  if (!RANK[level]) throw new UsageError(`--fail-on is error, warning or info, not "${level}"`);
  if (!positionals.length) throw new UsageError('give at least one PATH');

  // Files named, then files found in directories, each once.
  const files = [];
  const seen = new Set();
  const add = (p, named) => {
    const key = path.resolve(p);
    if (!seen.has(key)) seen.add(key), files.push({ shown: p, named });
  };
  for (const p of positionals) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`, false);
    }
    if (st.isDirectory()) for (const f of htmlFiles(p)) add(f, false);
    else add(p, true);
  }

  const out = [];
  const count = { error: 0, warning: 0, info: 0 };
  let notes = 0;
  let failed = false;
  let broken = false;
  // Every file is analysed once, as a note checked or as a link's target.
  const targets = new links.Targets({ analyse: (text, file) => analyse(text, file, { noScripts: o['no-scripts'] }) });
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.shown, 'utf8');
    } catch (e) {
      warn(`tern check: cannot read ${f.shown}: ${e.message}`);
      broken = true;
      continue;
    }
    const file = path.resolve(f.shown);
    const a = targets.analyse(file, text);
    if (!a) {
      if (f.named && !o.quiet) warn(`tern check: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    notes++;
    for (const d of links.merge(a.diagnostics, links.check(file, a, targets))) {
      count[d.severity]++;
      const over = RANK[d.severity] >= RANK[level];
      failed = failed || over;
      if (o.quiet && !over) continue;
      if (o.json) out.push({ file: f.shown, ...d });
      else say(format(f.shown, d));
    }
  }
  if (o.json) say(JSON.stringify(out, null, 2));
  if (!o.quiet) {
    const found = [plural(count.error, 'error'), plural(count.warning, 'warning'), plural(count.info, 'info')].join(', ');
    warn(notes ? `tern check: ${plural(notes, 'note')}: ${found}` : 'tern check: no notes found');
  }
  return broken ? 2 : failed ? 1 : 0;
}

// ---------------------------------------------------------------- search

// The files a command takes: those named, then those found in directories,
// each once, in order.
function filesOf(positionals) {
  const files = [];
  const seen = new Set();
  const add = (p, named) => {
    const key = path.resolve(p);
    if (!seen.has(key)) seen.add(key), files.push({ shown: p, named });
  };
  for (const p of positionals) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`, false);
    }
    if (st.isDirectory()) for (const f of htmlFiles(p)) add(f, false);
    else add(p, true);
  }
  return files;
}

// The version series an index must share with this tern.js: its stems are
// the stemmer's, which changes only in a minor release (src/search.js).
const series = (v) => String(v).split('.').slice(0, 2).join('.');

// A search.json `tern index` wrote, read back: its entries' URLs are
// relative to the file's folder, and its lines are file lines.
function readIndex(file) {
  let data;
  try {
    data = JSON.parse(read(file));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${file} is not JSON: ${e.message}`, false);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries) || !data.terms || typeof data.terms !== 'object' || !Array.isArray(data.lengths)) {
    throw new UsageError(`${file} is not a search index written by tern index`, false);
  }
  if (series(data.tern) !== series(tern.version)) throw new UsageError(`${file} was written by tern ${data.tern || '?'} and this is ${tern.version}: run tern index again`, false);
  return data;
}

function search(args) {
  const { values: o, positionals } = options(args, { index: { type: 'string' }, json: { type: 'boolean' }, limit: { type: 'string' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('search');
  if (!positionals.length) throw new UsageError('QUERY is missing');
  const [query, ...paths] = positionals;
  if (!tern.search.tokens(query).length) throw new UsageError('QUERY has no word to search for');
  let limit = 20;
  if (o.limit !== undefined) {
    if (o.limit === 'all') limit = Infinity;
    else if (/^[1-9]\d*$/.test(o.limit)) limit = Number(o.limit);
    else throw new UsageError(`--limit is a positive number or all, not "${o.limit}"`);
  }
  if (o.index !== undefined) {
    if (!o.index) throw new UsageError('--index is empty');
    if (paths.length) throw new UsageError('--index takes no PATH: the index names the notes');
    return searchIndex(o.index, query, limit, !!o.json);
  }
  const files = filesOf(paths.length ? paths : ['.']);
  const entries = [];
  const titles = new Map();
  let notes = 0;
  let broken = false;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.shown, 'utf8');
    } catch (e) {
      warn(`tern search: cannot read ${f.shown}: ${e.message}`);
      broken = true;
      continue;
    }
    const a = analyse(text, f.shown, { noScripts: o['no-scripts'] });
    if (!a) {
      if (f.named) warn(`tern search: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    notes++;
    const title = tern.search.title(a.head, a.ast) || path.basename(f.shown);
    titles.set(f.shown, title);
    for (const r of tern.search.records(a.ast, { url: f.shown, title })) {
      const pos = r.line ? a.toFile({ start: { line: r.line, column: 1 }, end: { line: r.endLine || r.line, column: 1 } }) : null;
      entries.push({ ...r, file: f.shown, fileLine: pos ? pos.start.line : undefined, fileEndLine: pos ? pos.end.line : undefined });
    }
  }
  const hits = tern.search.query(tern.search.index(entries), query, { limit });
  const out = [];
  for (const { entry, score, matched } of hits) {
    const snippet = tern.search.snippet(entry.text || entry.title || entry.label, matched);
    const heading = [entry.label, entry.title].filter(Boolean).join(' ');
    if (o.json) {
      const { file, fileLine, fileEndLine, url, text, line, endLine, ...rest } = entry;
      out.push({ file, line: fileLine, endLine: fileEndLine, ...rest, page: titles.get(file), score, snippet: snippet.text, marks: snippet.marks });
    } else {
      say(`${entry.file}:${entry.fileLine || 1}: ${heading}${entry.id ? ` (#${entry.id})` : ''}`);
      say(`    ${snippet.text}`);
    }
  }
  if (o.json) say(JSON.stringify(out, null, 2));
  warn(notes ? `tern search: ${plural(notes, 'note')}, ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}: ${plural(hits.length, 'result')}` : 'tern search: no notes found');
  return broken ? 2 : hits.length ? 0 : 1;
}

// tern search --index FILE: the same hits from a search.json, no note read.
// Files print relative to the current folder, as the live search prints
// the paths it was given.
function searchIndex(file, query, limit, json) {
  const idx = readIndex(file);
  const base = path.dirname(path.resolve(file));
  const shown = (url) => path.relative(process.cwd(), path.resolve(base, url)) || '.';
  const titles = new Map((idx.notes || []).map((n) => [n.url, n.title]));
  const hits = tern.search.query(idx, query, { limit });
  const out = [];
  for (const { entry, score, matched } of hits) {
    const snippet = tern.search.snippet(entry.text || entry.title || entry.label, matched);
    const heading = [entry.label, entry.title].filter(Boolean).join(' ');
    if (json) {
      const { url, text, ...rest } = entry;
      out.push({ file: shown(url), ...rest, page: titles.get(url), score, snippet: snippet.text, marks: snippet.marks });
    } else {
      say(`${shown(entry.url)}:${entry.line || 1}: ${heading}${entry.id ? ` (#${entry.id})` : ''}`);
      say(`    ${snippet.text}`);
    }
  }
  if (json) say(JSON.stringify(out, null, 2));
  const n = (idx.notes || []).length;
  warn(`tern search: ${plural(n, 'note')}, ${idx.entries.length} ${idx.entries.length === 1 ? 'entry' : 'entries'} in ${file}: ${plural(hits.length, 'result')}`);
  return hits.length ? 0 : 1;
}

// ---------------------------------------------------------------- index

const NOTES_JSON = 'notes.json';
const SEARCH_JSON = 'search.json';

// git, run in a repository: its stdout, or null when it fails or is not there.
function git(root, args) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// What git knows about a repository's files, for the index: the tracked
// files (absolute paths), the day each was last committed, and the files
// with changes not yet committed. null when git is not available.
const repos = new Map();
function repoInfo(root) {
  if (repos.has(root)) return repos.get(root);
  let info = null;
  const ls = git(root, ['ls-files', '-z']);
  if (ls !== null) {
    info = { tracked: new Set(ls.split('\0').filter(Boolean).map((f) => path.resolve(root, f))), dates: new Map(), changed: new Set() };
    const log = git(root, ['log', '--format=%x01%as', '--name-only']) || '';
    let day = '';
    for (const line of log.split('\n')) {
      if (line.startsWith('\x01')) day = line.slice(1).trim();
      else if (line.trim() && day && !info.dates.has(path.resolve(root, line))) info.dates.set(path.resolve(root, line), day);
    }
    // No HEAD yet (no commit): every file counts as changed.
    const diff = git(root, ['diff', '--name-only', '-z', 'HEAD']);
    if (diff === null) info.changed = null;
    else for (const f of diff.split('\0').filter(Boolean)) info.changed.add(path.resolve(root, f));
  }
  repos.set(root, info);
  return info;
}

// A file's day, YYYY-MM-DD, local time.
function dayOf(file) {
  const d = new Date(fs.statSync(file).mtimeMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// JSON with one item per line for the top-level arrays and objects, so the
// file diffs by note, entry and term; `sorted` keys sort an object's keys.
function lineJSON(obj, sorted = []) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length) parts.push(`${JSON.stringify(k)}: [\n${v.map((x) => ` ${JSON.stringify(x)}`).join(',\n')}\n]`);
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      const keys = sorted.includes(k) ? Object.keys(v).sort() : Object.keys(v);
      parts.push(`${JSON.stringify(k)}: {\n${keys.map((x) => ` ${JSON.stringify(x)}: ${JSON.stringify(v[x])}`).join(',\n')}\n}`);
    } else parts.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  return `{\n${parts.join(',\n')}\n}\n`;
}

// A relative URL as written in a note, as the file it names, or null for
// one that is not a relative path (a scheme, //host, /root-relative).
function linkFile(dir, url) {
  const plain = url.replace(/[?#].*$/, '');
  if (!plain || /^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(plain)) return null;
  try {
    return path.resolve(dir, decodeURIComponent(plain));
  } catch {
    return path.resolve(dir, plain);
  }
}

function index(args) {
  const { values: o, positionals } = options(args, { output: { type: 'string', short: 'o' }, check: { type: 'boolean' }, all: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('index');
  const paths = positionals.length ? positionals : ['.'];
  const files = filesOf(paths);
  let dir = o.output;
  if (dir === undefined) dir = fs.statSync(paths[0]).isDirectory() ? paths[0] : path.dirname(paths[0]);
  if (!dir) throw new UsageError('-o is empty');
  const outDir = path.resolve(dir);
  const stat = fs.statSync(outDir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new UsageError(`-o ${dir} is not a folder`, false);
  const rel = (file) => path.relative(outDir, file).split(path.sep).join('/');

  // Tracked files only, in a repository: a note git ignores or does not
  // know is not published. A file named on the command line is always in.
  let left = 0;
  let noGit = false;
  const kept = files.filter((f) => {
    if (o.all || f.named) return true;
    const abs = path.resolve(f.shown);
    const root = repository(path.dirname(abs));
    if (!root) return true;
    const info = repoInfo(root);
    if (!info) return (noGit = true);
    if (info.tracked.has(abs)) return true;
    left++;
    return false;
  });
  if (noGit) warn('tern index: git is not available, so untracked and ignored files are indexed too');

  const notes = [];
  const entries = [];
  let robots = 0;
  let broken = false;
  for (const f of kept) {
    let text;
    try {
      text = fs.readFileSync(f.shown, 'utf8');
    } catch (e) {
      warn(`tern index: cannot read ${f.shown}: ${e.message}`);
      broken = true;
      continue;
    }
    const a = analyse(text, f.shown, { noScripts: o['no-scripts'] });
    if (!a) {
      if (f.named) warn(`tern index: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    const d = tern.search.describe(a.head, a.ast);
    if (/\bnoindex\b/i.test(String(d.meta.robots || ''))) {
      robots++;
      continue;
    }
    const abs = path.resolve(f.shown);
    const url = rel(abs);
    const title = d.title || path.basename(f.shown);
    let date = String(d.meta.date || '').trim();
    if (!date) {
      const root = repository(path.dirname(abs));
      const info = root ? repoInfo(root) : null;
      date = info && info.changed !== null && !info.changed.has(abs) && info.dates.get(abs) ? info.dates.get(abs) : dayOf(abs);
    }
    const links = [];
    for (const u of d.links) {
      const file = linkFile(path.dirname(abs), u);
      if (file && file !== abs && !links.includes(file)) links.push(file);
    }
    notes.push({ url, title, description: d.description, date, headings: d.headings, links, abs });
    for (const r of tern.search.records(a.ast, { url, title })) {
      const pos = r.line ? a.toFile({ start: { line: r.line, column: 1 }, end: { line: r.endLine || r.line, column: 1 } }) : null;
      const e = { ...r, url };
      if (pos) (e.line = pos.start.line), (e.endLine = pos.end.line);
      entries.push(e);
    }
  }
  // A link counts when it names a note in the catalogue, as a path like the note's.
  const known = new Map(notes.map((n) => [n.abs, n.url]));
  for (const n of notes) {
    n.links = n.links.map((f) => known.get(f)).filter(Boolean);
    delete n.abs;
  }
  const idx = tern.search.index(entries);
  const outputs = [
    [NOTES_JSON, `${JSON.stringify({ tern: tern.version, notes }, null, 2)}\n`],
    [SEARCH_JSON, lineJSON({ tern: tern.version, notes: notes.map((n) => ({ url: n.url, title: n.title })), entries: idx.entries, terms: idx.terms, lengths: idx.lengths, avg: idx.avg }, ['terms'])],
  ];
  const where = (name) => path.join(dir, name);
  const summary = `${plural(notes.length, 'note')}, ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${left ? `; ${left} left out (not tracked by git)` : ''}${robots ? `; ${robots} noindex` : ''}`;
  if (o.check) {
    let stale = 0;
    for (const [name, text] of outputs) {
      let have = null;
      try {
        have = fs.readFileSync(path.join(outDir, name), 'utf8');
      } catch {}
      if (have === text) continue;
      stale++;
      warn(`tern index: ${where(name)} is ${have === null ? 'missing' : 'stale'}: run tern index${o.output !== undefined ? ` -o ${o.output}` : ''} ${paths.join(' ')}`);
    }
    warn(`tern index: ${summary}; ${stale ? `${stale} of 2 files to write` : 'both files are up to date'}`);
    return broken ? 2 : stale ? 1 : 0;
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, text] of outputs) fs.writeFileSync(path.join(outDir, name), text);
  } catch (e) {
    throw new UsageError(`cannot write ${dir}: ${e.message}`, false);
  }
  warn(`tern index: ${summary} → ${where(NOTES_JSON)}, ${where(SEARCH_JSON)}`);
  return broken ? 2 : 0;
}

// ---------------------------------------------------------------- parse

function parse(args) {
  const { values: o, positionals } = options(args, { transformed: { type: 'boolean' }, compact: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('parse');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const file = positionals[0];
  const text = read(file);
  const a = analyse(text, file, { transform: !!o.transformed, noScripts: o['no-scripts'] });
  if (!a) throw new UsageError(`${file} is not a note (${notNote(text)})`, false);
  // The vocabulary problems (no note position) as `tern parse` prints them.
  for (const d of a.diagnostics) if (!d.position) warn(`tern parse: ${d.message}`);
  say(JSON.stringify(a.ast, null, o.compact ? 0 : 2));
  return 0;
}

// ---------------------------------------------------------------- build

// -o OUT: a directory when it ends in a slash or is an existing directory
// (created, with its parents, if missing), and the page is DIR/FILE's name;
// otherwise the page's own path, its directory created if missing.
function buildPage(args) {
  const { values: o, positionals } = options(args, { output: { type: 'string', short: 'o' }, math: { type: 'string' }, katex: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('build');
  const math = o.math || (o.katex ? 'katex' : null);
  if (math && math !== 'katex' && math !== 'mathml') throw new UsageError(`--math must be katex or mathml, not ${math}`);
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const file = positionals[0];
  let out = o.output === undefined || o.output === '-' ? null : o.output;
  if (out !== null && !out) throw new UsageError('-o is empty');
  let into = null; // the directory to create before writing
  let asDir = false;
  if (out) {
    let st = null;
    try {
      st = fs.statSync(out);
    } catch {}
    asDir = out.endsWith('/') || (path.sep === '\\' && out.endsWith('\\')) || !!(st && st.isDirectory());
    into = asDir ? out : path.dirname(out);
    if (asDir) out = path.join(out, path.basename(file));
  }
  if (out && path.resolve(out) === path.resolve(file)) throw new UsageError(`-o ${o.output} is the note itself`, false);
  const text = read(file);
  const r = build(text, file, { math, noScripts: o['no-scripts'] });
  if (!r) throw new UsageError(`${file} is not a note (${notNote(text)})`, false);
  for (const w of r.warnings) warn(`tern build: ${w}`);
  for (const d of r.diagnostics) warn(format(file, d));
  for (const f of r.failures) warn(format(file, { severity: 'warning', code: 'math.error', message: f.message, filePosition: r.toFile(f.node.position) }));
  if (out && path.resolve(path.dirname(out)) !== path.dirname(path.resolve(file)))
    warn(`tern build: relative URLs (tern.js, add-ons, images, links) are kept as written, so they resolve from ${path.dirname(out)}`);
  if (!out) process.stdout.write(r.html);
  else {
    try {
      fs.mkdirSync(into, { recursive: true });
    } catch (e) {
      throw new UsageError(`cannot create the directory ${into}: ${e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'a file is in the way' : e.message}`, false);
    }
    try {
      fs.writeFileSync(out, r.html);
    } catch (e) {
      throw new UsageError(`cannot write ${out}: ${e.code === 'EISDIR' ? 'it is a directory' : e.message}`, false);
    }
  }
  const m = r.math;
  warn(`tern build: ${out ? `wrote ${out}` : 'wrote the page'}; ${plural(m.total, 'formula')}${m.engine ? `, ${m.prerendered} pre-rendered as ${m.engine === 'mathml' ? 'MathML' : 'HTML'}` : ''}`);
  if (out && !asDir && !path.extname(out)) warn(`tern build: ${o.output} is written as a file; end -o with / to write ${path.basename(file)} into a directory of that name`);
  return 0;
}

// ---------------------------------------------------------------- mv

// The files under root that are not notes but name a moved file or folder:
// tern mv does not rewrite them (a name in a script or a Markdown file is
// not a URL it can read), so it lists them to look at.
const TEXT = /\.(?:md|markdown|txt|html?|[cm]?js|css|json|ya?ml|toml|svg|xml)$/i;
function mentions(root, moves, notes) {
  const names = moves.map((m) => path.basename(m.from) + (m.folder ? '/' : ''));
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name) && !notes.has(p)) {
        let text = '';
        try {
          text = fs.readFileSync(p, 'utf8');
        } catch {}
        const named = names.filter((n) => text.includes(n));
        if (named.length) out.push({ file: p, named });
      }
    }
  };
  walk(root);
  return out;
}

// Moves first, then the edits relocate() asks for, each file written once,
// at its new path. With --dry-run, the same lines, and nothing changes.
function mv(args) {
  const { values: o, positionals } = options(args, { root: { type: 'string' }, 'dry-run': { type: 'boolean', short: 'n' } });
  if (o.help) return help('mv');
  if (positionals.length < 2) throw new UsageError('give FROM and TO');
  const shown = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
  const stat = (p) => fs.statSync(p, { throwIfNoEntry: false });
  const to = positionals[positionals.length - 1];
  const sources = positionals.slice(0, -1).map((p) => {
    if (!stat(p)) throw new UsageError(`cannot read ${p}: no such file or directory`, false);
    return path.resolve(p);
  });
  const dest = path.resolve(to);
  const into = !!(stat(dest) && stat(dest).isDirectory()) || /[\\/]$/.test(to);
  if (sources.length > 1 && !(stat(dest) && stat(dest).isDirectory())) throw new UsageError('with several FROMs, TO must be a folder that exists');
  for (const s of sources) for (const t of sources) if (s !== t && t.startsWith(s + path.sep)) throw new UsageError(`${shown(t)} is inside ${shown(s)}; name only ${shown(s)}`);
  const moves = sources.map((from) => ({ from, to: into ? path.join(dest, path.basename(from)) : dest, folder: stat(from).isDirectory() }));
  const same = (a, b) => {
    const x = stat(a);
    const y = stat(b);
    return !!(x && y && x.ino === y.ino && x.dev === y.dev);
  };
  for (const m of moves) {
    if (m.from === m.to) return refuse(`${shown(m.from)} is already there`, 'mv');
    if (m.to.startsWith(m.from + path.sep)) return refuse(`cannot move ${shown(m.from)} into itself`, 'mv');
    if (stat(m.to) && !same(m.from, m.to)) return refuse(`${shown(m.to)} exists; move or remove it first`, 'mv');
  }
  if (new Set(moves.map((m) => m.to)).size < moves.length) return refuse('two FROMs have the same name', 'mv');

  // Every note under the root, and the notes moved from outside it.
  const root = o.root === undefined ? repository(path.dirname(sources[0])) || process.cwd() : path.resolve(o.root);
  if (!(stat(root) && stat(root).isDirectory())) throw new UsageError(`--root ${o.root} is not a folder`);
  const files = new Set([...htmlFiles(root)].map((f) => path.resolve(f)));
  for (const s of sources) {
    if (stat(s).isDirectory()) for (const f of htmlFiles(s)) files.add(path.resolve(f));
    else if (/\.html?$/i.test(s)) files.add(s);
  }
  const notes = [];
  for (const file of files) {
    try {
      notes.push({ file, text: fs.readFileSync(file, 'utf8') });
    } catch (e) {
      warn(`tern mv: cannot read ${shown(file)}: ${e.message}; its links are left as they are`);
    }
  }
  const plan = relocate(notes, moves);
  const dry = !!o['dry-run'];

  // A move that fails undoes the ones before it, so nothing is half done.
  if (!dry) {
    const done = [];
    try {
      for (const m of moves) {
        fs.mkdirSync(path.dirname(m.to), { recursive: true });
        fs.renameSync(m.from, m.to);
        done.push(m);
      }
    } catch (e) {
      for (const m of done.reverse()) fs.renameSync(m.to, m.from);
      warn(`tern mv: ${e.message}; nothing was moved, and the links are left as they were`);
      return 1;
    }
  }
  for (const m of moves) say(`${dry ? 'would move' : 'moved'} ${shown(m.from)} → ${shown(m.to)}`);
  let count = 0;
  for (const p of plan) {
    for (const e of p.edits) say(`${shown(p.moved)}:${e.line}:${e.column}: ${e.was} → ${e.text}`);
    count += p.edits.length;
    if (p.base) warn(`tern mv: ${shown(p.moved)} has a <base href>, so its URLs do not resolve from its folder; they are left as they are`);
    for (const l of p.lost) warn(`tern mv: ${shown(p.moved)}:${l.line}:${l.column}: ${l.url} moves, but where it is written was not found; it is left as it is`);
  }
  const isNote = new Set(notes.filter((n) => split(n.text)).map((n) => n.file));
  for (const m of mentions(root, moves, isNote)) warn(`tern mv: ${shown(m.file)} names ${m.named.join(', ')} but is not a note, so it is left as it is; look at it`);
  const edited = plan.filter((p) => p.edits.length);
  const text = new Map(notes.map((n) => [n.file, n.text]));
  if (!dry) for (const p of edited) fs.writeFileSync(p.moved, apply(text.get(p.file), p.edits));
  warn(`tern mv: ${plural(moves.length, 'move')}, ${plural(count, 'link')} in ${plural(edited.length, 'note')}${dry ? '; a dry run, so nothing changed' : ''}`);
  return 0;
}

// ---------------------------------------------------------------- corpus

// The live examples of documentation pages as corpus cases (cli/examples.js
// toCorpus; test/corpus/README.md "Cases from the documentation"). Paths are
// files or directories, as for check. Without --out the cases go to stdout,
// page after page; with it, each page with examples is DIR/docs-PAGE.txt
// (DIR is created). An example that does not match its expect, or names an
// unknown schema, is left out and reported as `file:line: message`: exit 1.
function corpus(args) {
  const { values: o, positionals } = options(args, { out: { type: 'string' } });
  if (o.help) return help('corpus');
  if (!positionals.length) throw new UsageError('give at least one PATH');
  if (o.out !== undefined && !o.out) throw new UsageError('--out is empty');
  const files = [];
  const seen = new Set();
  for (const p of positionals) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`, false);
    }
    for (const f of st.isDirectory() ? [...htmlFiles(p)] : [p]) {
      const key = path.resolve(f);
      if (!seen.has(key)) seen.add(key), files.push({ shown: f, named: !st.isDirectory() });
    }
  }
  if (o.out) {
    try {
      fs.mkdirSync(o.out, { recursive: true });
    } catch (e) {
      throw new UsageError(`cannot create ${o.out}: ${e.message}`, false);
    }
  }
  let cases = 0;
  let pages = 0;
  let failed = false;
  const shown = (f) => f.split(path.sep).join('/');
  const written = new Map(); // output file -> the page that wrote it
  for (const f of files) {
    const text = read(f.shown);
    const x = examples.extract(text, f.shown);
    if (!x) {
      if (f.named) warn(`tern corpus: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    const c = examples.toCorpus(x, shown(f.shown));
    for (const p of c.problems) warn(`${f.shown}:${p.line}: ${p.message}`);
    failed = failed || c.problems.length > 0;
    if (!c.cases) continue;
    cases += c.cases;
    pages++;
    if (!o.out) {
      process.stdout.write(`${pages > 1 ? '\n' : ''}${c.text}`);
      continue;
    }
    const out = path.join(o.out, `docs-${examples.pageSlug(f.shown)}.txt`);
    if (written.has(out)) throw new UsageError(`${f.shown} and ${written.get(out)} would both write ${out}`, false);
    written.set(out, f.shown);
    fs.writeFileSync(out, c.text);
  }
  warn(`tern corpus: ${plural(cases, 'case')} from ${plural(pages, 'page')}${o.out ? `, written to ${o.out}` : ''}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- lsp

// The language server (cli/lsp.js): it runs until the client exits it.
// --clientProcessId, which some editors pass with --stdio, is accepted too.
function lsp(args) {
  const { values: o, positionals } = options(args, { stdio: { type: 'boolean' }, clientProcessId: { type: 'string' } });
  if (o.help) return help('lsp');
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  require('./lsp').main();
}

module.exports = {
  usage,
  new: command('new', newNote),
  check: command('check', check),
  parse: command('parse', parse),
  build: command('build', buildPage),
  mv: command('mv', mv),
  search: command('search', search),
  index: command('index', index),
  corpus: command('corpus', corpus),
  lsp: command('lsp', lsp),
};
