// SPDX-License-Identifier: MIT
// luccet new, check, parse, build, mv, search and index, and the
// arguments of luccet lsp.
// Each command takes its arguments and returns the exit code (luccet lsp: none,
// it runs until its client exits it):
//   0  done
//   1  check: a diagnostic at or above --fail-on; new: it refused (the file
//      exists, or the line it would write is not detected); mv: it refused
//      (a destination exists, a folder into itself) or a move failed;
//      search: nothing matched; index --check: a file is missing or stale
//   2  a usage error, or a path that cannot be used
// Diagnostics print as `file:line:col: severity code: message`, the hint
// indented below, with file lines (cli/note.js filePosition).
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { spawnSync } = require('child_process');
const { split, notNote, attributes, analyse, htmlFiles, repository, luccet, clean, readText } = require('./note');
const { build, escAttr } = require('./build');
const links = require('./links');
const { relocate, apply } = require('./relocate');

// The commands, one table: luccet-cli.js dispatches from it, the usage
// below prints it, and test/cli.js checks that the docs, the README, the
// skill and the header comments name the same commands, and EXIT_1 the
// same reasons for exit 1.
const SYNOPSIS = {
  new: 'luccet new FILE [--luccet=PATH] [--use=LIST] [--title=TEXT] [--lang=TAG] [--bare] [--force]',
  check: 'luccet check PATH… [--json] [--fail-on=error|warning|info] [--quiet] [--no-scripts]',
  parse: 'luccet parse FILE [--transformed] [--compact] [--no-scripts]',
  build: 'luccet build FILE… [-o OUT] [--json] [--no-scripts]',
  mv: 'luccet mv FROM… TO [--root=DIR] [--dry-run] [--json]',
  search: 'luccet search QUERY [PATH…] [--index=FILE] [--json] [--limit=N|all] [--no-scripts]',
  index: 'luccet index [PATH…] [-o DIR] [--check] [--all] [--json] [--no-scripts]',
  lsp: 'luccet lsp [--stdio]',
};

// Why a command exits 1, by command; any other exits 0 or 2.
const EXIT_1 = {
  check: 'check found a diagnostic at or above --fail-on',
  new: 'new refused to write the file',
  mv: 'mv refused to move, or a move failed',
  search: 'search found nothing',
  index: 'index --check found a file missing or stale',
};
// The exit codes as the usage ends with them, wrapped as the rest is.
const exitCodes = () => {
  const list = Object.values(EXIT_1);
  const words = `Exit codes: 0 done; 1 ${list.slice(0, -1).join('; ')}; or ${list[list.length - 1]}; 2 a usage error.`.split(' ');
  const lines = [''];
  for (const w of words) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + 1 + w.length > 78) lines.push(w);
    else lines[last] += (lines[last] ? ' ' : '') + w;
  }
  return lines.join('\n');
};

const usage = () =>
  `usage: luccet COMMAND …

  ${SYNOPSIS.new}
      Write a new note: the canonical first line, loading the nearest luccet.js
      in FILE's directory or above (or PATH); --use lists add-ons in a :::use
      block (separated by commas or spaces), each preloaded from the first
      line; --title adds a :::meta block and --lang its language. The line
      ends with a guard that shows the source, readable, when luccet.js does
      not load, in the note's language; --bare leaves the guard out.
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
      loads luccet.js. Several FILEs, or a folder, need -o DIR: each note's
      page goes into DIR, under its name, or under its path in the folder
      given. Formulas are MathML, as the engine writes them.
      --json prints one object instead (the page in it without -o).
      --no-scripts builds without running the note's own code.
  ${SYNOPSIS.mv}
      Move or rename notes, files and folders, and rewrite the relative URLs
      that point at them, in every note under DIR (default: the repository
      FROM is in, else the current folder), and the moved notes' own. TO is
      a folder when it ends in / or exists. --dry-run (-n) prints the moves
      and the edits, and changes nothing. --json prints them as one object.
  ${SYNOPSIS.search}
      Search notes by word: the notes under each PATH (default: the current
      folder) are split into entries — every heading's section and every
      named block with an id — ranked for QUERY, and printed as FILE:LINE:
      the entry's label and title, then its passage with the matching words.
      A query word stands for the words it begins. --limit caps the results
      (20). --index searches a search.json that luccet index wrote instead of
      reading the notes. Exit 1 when nothing matches.
  ${SYNOPSIS.index}
      Write what a site's add-ons read about the notes under each PATH
      (default: the current folder): DIR/notes.json, a catalogue — each
      note's path, title, description, date, headings and links — for the
      ::notes list; DIR/search.json, the index ::search{index=…} loads
      instead of fetching every note; and DIR/glossary.json, the terms the
      notes define (:dfn[…], :::definition blocks) with their definitions,
      for the ::glossary list. DIR is -o, else the first PATH's folder; the
      paths in the files are relative to it. In a git repository only
      tracked files are indexed, so a private note is never published
      (--all indexes every file); a note whose meta says robots: noindex is
      left out. A term defined twice, and a :term[…] no note defines, are
      said on stderr. --check writes nothing and exits 1 when a file is
      missing or differs from what would be written. --json prints the
      summary as one object.
  ${SYNOPSIS.lsp}
      The language server, over stdio (--stdio, which some editors pass, is
      accepted and changes nothing).

${exitCodes()}
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

// A command: usage errors print with the synopsis and exit 2; a command
// that returns a promise (vendor) has its rejections read the same way.
const command = (name, fn) => (args) => {
  const usage = (e) => {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`luccet ${name}: ${e.message}\n${e.synopsis ? `usage: ${SYNOPSIS[name]}\n` : ''}`);
    return 2;
  };
  try {
    const r = fn(args || []);
    return r && typeof r.then === 'function' ? r.catch(usage) : r;
  } catch (e) {
    return usage(e);
  }
};

const say = (s) => process.stdout.write(`${s}\n`);
// A path as the commands print it: forward slashes on every platform.
const slash = (p) => String(p).split(path.sep).join('/');
const warn = (s) => process.stderr.write(`${s}\n`);
// --help prints the command's synopsis.
function help(name) {
  say(`usage: ${SYNOPSIS[name]}`);
  return 0;
}
// A command declines: the reason on stderr, exit 1.
function refuse(reason, name = 'new') {
  warn(`luccet ${name}: ${reason}`);
  return 1;
}
const RANK = { info: 1, warning: 2, error: 3 };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// A note file's text; one that is not UTF-8 is said on stderr (cli/note.js
// readText), as `luccet COMMAND: …`.
function read(file, command) {
  let r;
  try {
    r = readText(file);
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.code === 'EISDIR' ? 'it is a directory' : e.message}`, false);
  }
  if (r.warning && command) warn(`luccet ${command}: ${r.warning}`);
  return r.text;
}

// A diagnostic as printed. A message or hint may quote a note's own code (an
// add-on's error), so terminal control characters are taken out (cli/sandbox.js clean).
function format(file, d) {
  const p = d.filePosition.start;
  return `${file}:${p.line}:${p.column}: ${d.severity} ${d.code}: ${clean(d.message)}${d.hint ? `\n    ${clean(d.hint)}` : ''}`;
}

// ---------------------------------------------------------------- new

// The guard, the rest of the luccet.js line (left out with --bare): it shows
// the source when luccet.js does not run, and is inert when it does, since
// luccet.js's capture swallows the rest of the file, this included.
//   - Scripts on, luccet.js missing: the <noscript> is inert text in the head;
//     the script writes the message and an <xmp hidden> that the </xmp> right
//     after it closes, and <plaintext> shows the note as text, wrapped.
//   - Scripts off: the <noscript>'s <p> starts the body, and its <xmp hidden>
//     hides the guard script up to the same </xmp>; then <plaintext>.
// The message is in the note's language (--lang) when it is one of these,
// English otherwise, and the message and the text carry the language. An
// apostrophe is typographic: the second message is a single-quoted string.
const GUARD_WORDS = {
  en: ['JavaScript is off; the source follows.', 'luccet.js did not load; the source follows.'],
  de: ['JavaScript ist aus; es folgt der Quelltext.', 'luccet.js wurde nicht geladen; es folgt der Quelltext.'],
  fr: ['JavaScript est désactivé ; voici la source.', 'luccet.js n’a pas été chargé ; voici la source.'],
  es: ['JavaScript está desactivado; sigue el código fuente.', 'luccet.js no se cargó; sigue el código fuente.'],
  pt: ['O JavaScript está desativado; segue o código-fonte.', 'O luccet.js não foi carregado; segue o código-fonte.'],
  it: ['JavaScript è disattivato; segue il sorgente.', 'luccet.js non è stato caricato; segue il sorgente.'],
  nl: ['JavaScript staat uit; hierna volgt de brontekst.', 'luccet.js is niet geladen; hierna volgt de brontekst.'],
};
const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i; // a language tag as --lang takes it: en, pt-BR, zh-Hant
function guard(lang) {
  const l = String(lang || '').toLowerCase();
  const [off, missing] = GUARD_WORDS[l] || GUARD_WORDS[l.split('-')[0]] || GUARD_WORDS.en;
  const at = lang ? ` lang="${escAttr(lang)}"` : '';
  return `<noscript><p${at}>${off}</p><xmp hidden></noscript><script>self.luccet||document.write('<p${at}>${missing}</p><xmp hidden>')</script></xmp><plaintext${at} style="white-space:pre-wrap">`;
}

// The nearest luccet.js in dir or above, relative to dir with forward slashes.
function nearestTern(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, 'luccet.js');
    try {
      if (fs.statSync(f).isFile()) return path.relative(dir, f).split(path.sep).join('/');
    } catch {}
    if (path.dirname(d) === d) return null;
  }
}

function newNote(args) {
  const { values: o, positionals } = options(args, {
    luccet: { type: 'string' },
    use: { type: 'string', multiple: true },
    title: { type: 'string' },
    lang: { type: 'string' },
    bare: { type: 'boolean' },
    guarded: { type: 'boolean' }, // the default since 0.7; accepted, says nothing
    force: { type: 'boolean' },
  });
  if (o.help) return help('new');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const given = positionals[0];
  if (!given || /[\\/]$/.test(given) || ['', '.', '..'].includes(path.basename(given))) throw new UsageError(`"${given}" names no file`);
  const file = path.resolve(given);
  const dir = path.dirname(file);
  if (o.title !== undefined && (!o.title.trim() || /[\r\n]/.test(o.title))) throw new UsageError('--title is one non-empty line');
  if (o.luccet !== undefined && !o.luccet.trim()) throw new UsageError('--luccet is empty');
  if (o.lang !== undefined && !LANG_TAG.test(o.lang.trim())) throw new UsageError('--lang is a language tag such as en, de or pt-BR');
  if (o.bare && o.guarded) throw new UsageError('--bare and --guarded contradict; the guard is the default');
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
  const found = o.luccet === undefined ? nearestTern(dir) : null;
  const src = o.luccet !== undefined ? o.luccet.trim() : found || 'luccet.js';
  const use = (o.use || []).flatMap((u) => u.split(/[\s,]+/)).filter(Boolean);
  const title = o.title === undefined ? null : o.title.trim();
  const lang = o.lang === undefined ? null : o.lang.trim();
  // A preload for each add-on: luccet.js finds a :::use entry only once it has
  // the note, so the head asks for the file alongside luccet.js itself.
  const preload = use.map((u) => `<link rel="preload" href="${escAttr(u)}" as="${/\.css(?:[?#]|$)/i.test(u) ? 'style' : 'script'}">`).join('');
  const first = `<!doctype html><meta charset="utf-8">${preload}<script src="${escAttr(src)}"></script>${o.bare ? '' : guard(lang)}`;
  const fields = `${title === null ? '' : `title: ${title}\n`}${lang === null ? '' : `lang: ${lang}\n`}`;
  const text = `${first}\n${fields ? `:::meta\n${fields}:::\n\n` : ''}${use.length ? `:::use\n${use.join('\n')}\n:::\n\n` : ''}`;

  // What is written must read back as a note with that line, src and title.
  const parts = split(text);
  const meta = parts && luccet.parse(parts.note, { head: parts.head }).ast.data;
  if (!parts || parts.line !== 1 || attributes(parts.tag).src !== src) {
    return refuse(`<script src="${src}"> would not make ${given} a note: the src must name a file called luccet.js`);
  }
  if (title !== null && !(meta && meta.luccet && meta.luccet.meta && meta.luccet.meta.title === title)) return refuse(`the title does not read back from :::meta`);
  if (lang !== null && !(meta && meta.luccet && meta.luccet.meta && meta.luccet.meta.lang === lang)) return refuse(`the language does not read back from :::meta`);
  if (use.length && JSON.stringify((meta && meta.luccet && meta.luccet.use ? meta.luccet.use : []).map((u) => u.url)) !== JSON.stringify(use)) return refuse(`the add-ons do not read back from :::use`);

  try {
    fs.writeFileSync(file, text, { flag: o.force ? 'w' : 'wx' });
  } catch (e) {
    return refuse(`cannot write ${given}: ${e.code === 'EEXIST' ? 'it exists' : e.message}`);
  }
  say(`created ${given}, loading ${src}${o.bare ? ', bare' : ''}`);
  if (o.luccet === undefined && !found) warn(`luccet new: no luccet.js in ${path.dirname(given)} or above; the note loads luccet.js from its own directory`);
  for (const u of use) {
    const local = u.replace(/[?#].*$/, '');
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(local) || local.startsWith('/')) continue;
    if (!fs.existsSync(path.resolve(dir, local))) warn(`luccet new: :::use names ${u}, which does not exist yet`);
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
    if (!seen.has(key)) seen.add(key), files.push({ shown: slash(p), named });
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
      text = read(f.shown, 'check');
    } catch (e) {
      warn(`luccet check: ${e.message}`);
      broken = true;
      continue;
    }
    const file = path.resolve(f.shown);
    const a = targets.analyse(file, text);
    if (!a) {
      if (f.named && !o.quiet) warn(`luccet check: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    notes++;
    for (const d of links.merge(a.diagnostics, links.check(file, a, targets))) {
      count[d.severity]++;
      const over = RANK[d.severity] >= RANK[level];
      failed = failed || over;
      if (o.quiet && !over) continue;
      if (o.json) out.push({ file: f.shown, ...d, message: clean(d.message), ...(d.hint ? { hint: clean(d.hint) } : {}) });
      else say(format(f.shown, d));
    }
  }
  if (o.json) say(JSON.stringify(out, null, 2));
  if (!o.quiet) {
    const found = [plural(count.error, 'error'), plural(count.warning, 'warning'), plural(count.info, 'info')].join(', ');
    warn(notes ? `luccet check: ${plural(notes, 'note')}: ${found}` : 'luccet check: no notes found');
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
    if (!seen.has(key)) seen.add(key), files.push({ shown: slash(p), named });
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

// A search.json `luccet index` wrote, read back: its entries' URLs are
// relative to the file's folder, and its lines are file lines. It must be
// of the format this luccet.js reads (src/search.js FORMAT), whatever
// version wrote it; a file with no format is from before 1.0.
function readIndex(file) {
  let data;
  try {
    data = JSON.parse(read(file));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${file} is not JSON: ${e.message}`, false);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries) || !data.terms || typeof data.terms !== 'object' || !Array.isArray(data.lengths)) {
    throw new UsageError(`${file} is not a search index written by luccet index`, false);
  }
  if (data.format !== luccet.search.format) throw new UsageError(`${file} was written by luccet ${data.luccet || '?'} in a format this luccet (${luccet.version}) does not read: run luccet index again`, false);
  return data;
}

function search(args) {
  const { values: o, positionals } = options(args, { index: { type: 'string' }, json: { type: 'boolean' }, limit: { type: 'string' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('search');
  if (!positionals.length) throw new UsageError('QUERY is missing');
  const [query, ...paths] = positionals;
  if (!luccet.search.tokens(query).length) throw new UsageError('QUERY has no word to search for');
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
      text = read(f.shown, 'search');
    } catch (e) {
      warn(`luccet search: ${e.message}`);
      broken = true;
      continue;
    }
    const a = analyse(text, f.shown, { noScripts: o['no-scripts'] });
    if (!a) {
      if (f.named) warn(`luccet search: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    notes++;
    const title = luccet.search.title(a.head, a.ast) || path.basename(f.shown);
    titles.set(f.shown, title);
    for (const r of luccet.search.records(a.ast, { url: f.shown, title })) {
      const pos = r.line ? a.toFile({ start: { line: r.line, column: 1 }, end: { line: r.endLine || r.line, column: 1 } }) : null;
      entries.push({ ...r, file: f.shown, fileLine: pos ? pos.start.line : undefined, fileEndLine: pos ? pos.end.line : undefined });
    }
  }
  const hits = luccet.search.query(luccet.search.index(entries), query, { limit });
  const out = [];
  for (const { entry, score, matched } of hits) {
    const snippet = luccet.search.snippet(entry.text || entry.title || entry.label, matched);
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
  warn(notes ? `luccet search: ${plural(notes, 'note')}, ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}: ${plural(hits.length, 'result')}` : 'luccet search: no notes found');
  return broken ? 2 : hits.length ? 0 : 1;
}

// luccet search --index FILE: the same hits from a search.json, no note read.
// Files print relative to the current folder, as the live search prints
// the paths it was given.
function searchIndex(file, query, limit, json) {
  const idx = readIndex(file);
  const base = path.dirname(path.resolve(file));
  const shown = (url) => slash(path.relative(process.cwd(), path.resolve(base, url))) || '.';
  const titles = new Map((idx.notes || []).map((n) => [n.url, n.title]));
  const hits = luccet.search.query(idx, query, { limit });
  const out = [];
  for (const { entry, score, matched } of hits) {
    const snippet = luccet.search.snippet(entry.text || entry.title || entry.label, matched);
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
  warn(`luccet search: ${plural(n, 'note')}, ${idx.entries.length} ${idx.entries.length === 1 ? 'entry' : 'entries'} in ${file}: ${plural(hits.length, 'result')}`);
  return hits.length ? 0 : 1;
}

// ---------------------------------------------------------------- index

const NOTES_JSON = 'notes.json';
const SEARCH_JSON = 'search.json';
const GLOSSARY_JSON = 'glossary.json';
// The format of notes.json, as luccet.search.format is search.json's: a
// reader takes a file of its own format, whatever version wrote it. 1 since
// 2.0 (a file with none is 1.x's); it changes only in a major release, and
// fields may be added in a minor one, which a reader ignores.
const NOTES_FORMAT = 1;

// The innermost entry of a note's search records (luccet.search.records,
// a section or a named block) with an id that holds note line `line`: the
// id a link is written in, or null before any.
function within(records, line) {
  let best = null;
  for (const r of records) {
    if (!r.id || !r.line || line < r.line || line > (r.endLine || r.line)) continue;
    if (!best || (r.endLine || r.line) - r.line < (best.endLine || best.line) - best.line) best = r;
  }
  return best ? best.id : null;
}
const fragmentOf = (url) => {
  const k = url.indexOf('#');
  if (k < 0 || k === url.length - 1) return null;
  try {
    return decodeURIComponent(url.slice(k + 1));
  } catch {
    return url.slice(k + 1);
  }
};

// git, run in a repository: {out, truncated}, or null when it fails or is
// not there. Output past the buffer's size is cut, and said so, rather than
// lost whole.
const GIT_BUFFER = 1 << 28;
function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: GIT_BUFFER, input });
  if (r.error && r.error.code === 'ENOBUFS') return { out: r.stdout || '', truncated: true };
  return r.error || r.status !== 0 ? null : { out: r.stdout, truncated: false };
}

// What git knows about a repository's files, for the index: the tracked
// files (absolute paths), the files with changes not yet committed, and
// `dates`, the day each indexed note was last committed, once dateNotes()
// has asked for the notes in it. null when git is not available.
const repos = new Map();
function repoInfo(root) {
  if (repos.has(root)) return repos.get(root);
  let info = null;
  const ls = git(root, ['ls-files', '-z']);
  if (ls !== null) {
    info = { tracked: new Set(ls.out.split('\0').filter(Boolean).map((f) => path.resolve(root, f))), dates: new Map(), changed: new Set(), truncated: false };
    // No HEAD yet (no commit): every file counts as changed.
    const diff = git(root, ['diff', '--name-only', '-z', 'HEAD']);
    if (diff === null) info.changed = null;
    else for (const f of diff.out.split('\0').filter(Boolean)) info.changed.add(path.resolve(root, f));
  }
  repos.set(root, info);
  return info;
}

// The day each of the files was last committed, from a log limited to
// them (their paths on git's stdin, so that a repository full of other
// files costs nothing); a log too long for the buffer gives the dates it
// reached, and `truncated`.
function dateNotes(root, info, files) {
  const rel = files.map((f) => path.relative(root, f)).filter((f) => f && !f.includes('\n'));
  if (!rel.length) return;
  const log = git(root, ['log', '--format=%x01%as', '--name-only', '--stdin'], `--\n${rel.join('\n')}\n`);
  if (!log) return;
  info.truncated = info.truncated || log.truncated;
  let day = '';
  for (const line of log.out.split('\n')) {
    if (line.startsWith('\x01')) day = line.slice(1).trim();
    else if (line.trim() && day && !info.dates.has(path.resolve(root, line))) info.dates.set(path.resolve(root, line), day);
  }
}

// A day as YYYY-MM-DD, local time: a file's modification day, or today.
const day = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dayOf = (file) => day(fs.statSync(file).mtimeMs);
const today = () => day(Date.now());

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
  const { values: o, positionals } = options(args, { output: { type: 'string', short: 'o' }, check: { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
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
  if (noGit) warn('luccet index: git is not available, so untracked and ignored files are indexed too');
  // The commit dates of the notes to index, by repository, from one log each.
  const byRepo = new Map();
  for (const f of kept) {
    const abs = path.resolve(f.shown);
    const root = repository(path.dirname(abs));
    if (root && repoInfo(root)) (byRepo.get(root) || byRepo.set(root, []).get(root)).push(abs);
  }
  for (const [root, files] of byRepo) dateNotes(root, repoInfo(root), files);

  const notes = [];
  const entries = [];
  const terms = []; // what the notes define (luccet.glossary), for glossary.json
  const uses = []; // every :term[…], to say which has no definition
  let robots = 0;
  let broken = false;
  let undated = 0;
  for (const f of kept) {
    let text;
    try {
      text = read(f.shown, 'index');
    } catch (e) {
      warn(`luccet index: ${e.message}`);
      broken = true;
      continue;
    }
    const a = analyse(text, f.shown, { noScripts: o['no-scripts'] });
    if (!a) {
      if (f.named) warn(`luccet index: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    const d = luccet.search.describe(a.head, a.ast);
    if (/\bnoindex\b/i.test(String(d.meta.robots || ''))) {
      robots++;
      continue;
    }
    const abs = path.resolve(f.shown);
    const url = rel(abs);
    const title = d.title || path.basename(f.shown);
    let date = String(d.meta.date || '').trim();
    // The catalogue's dates are YYYY-MM-DD (a time after it allowed): one
    // that is not is written as it is, said here, and sorts last in ::notes.
    if (date && !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(date)) warn(`luccet index: ${f.shown}: the date "${clean(date)}" is not YYYY-MM-DD; it is written as it is, and lists sort it last`);
    if (!date) {
      const root = repository(path.dirname(abs));
      const info = root ? repoInfo(root) : null;
      // The day of the last commit; for a tracked file with changes, or with
      // no commit yet, today, the day of the commit a hook is about to make,
      // so that --check holds once it is committed; the modification day for
      // a file git does not know.
      const committed = info && info.changed !== null && !info.changed.has(abs) ? info.dates.get(abs) : null;
      if (info && info.truncated && !committed && info.changed !== null && !info.changed.has(abs)) undated++;
      date = committed || (info && (info.changed === null || info.changed.has(abs)) ? today() : dayOf(abs));
    }
    const fileLine = (line) => (line ? a.toFile({ start: { line, column: 1 }, end: { line, column: 1 } }).start.line : 0);
    const records = luccet.search.records(a.ast, { url, title });
    // Every link to another file, in order: kept below when it names a note
    // of the catalogue, with its fragment, its file line, and the id of the
    // section or block it is written in.
    const links = [];
    luccet.visit(a.ast, 'link', (n) => {
      if (typeof n.url !== 'string' || !n.url || n.url.startsWith('#')) return;
      const file = linkFile(path.dirname(abs), n.url);
      const line = n.position ? n.position.start.line : 0;
      if (file && file !== abs) links.push({ file, fragment: fragmentOf(n.url), line: fileLine(line), from: line ? within(records, line) : null });
    });
    notes.push({ url, title, description: d.description, date, meta: d.meta, headings: d.headings, links, abs });
    for (const t of luccet.glossary.terms(a.ast)) terms.push({ ...t, url, title, line: fileLine(t.line), shown: f.shown });
    for (const u of luccet.glossary.uses(a.ast)) uses.push({ ...u, url, line: fileLine(u.line), shown: f.shown });
    for (const r of records) {
      const pos = r.line ? a.toFile({ start: { line: r.line, column: 1 }, end: { line: r.endLine || r.line, column: 1 } }) : null;
      const e = { ...r, url };
      if (pos) (e.line = pos.start.line), (e.endLine = pos.end.line);
      entries.push(e);
    }
  }
  // A link counts when it names a note in the catalogue, as a path like the note's.
  const known = new Map(notes.map((n) => [n.abs, n.url]));
  for (const n of notes) {
    n.links = n.links.filter((l) => known.has(l.file)).map((l) => ({ url: known.get(l.file), fragment: l.fragment, line: l.line, from: l.from }));
    delete n.abs;
  }
  const idx = luccet.search.index(entries);
  // The glossary: the terms by key, then by note; a key defined more than
  // once is said, and so is a use no note defines. Both are kept as they
  // are: the list shows every definition, and a use links to the page.
  terms.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.url < y.url ? -1 : x.url > y.url ? 1 : x.line - y.line));
  const defined = new Map();
  for (const t of terms) (defined.get(t.key) || defined.set(t.key, []).get(t.key)).push(t);
  for (const list of defined.values()) {
    if (list.length < 2) continue;
    const at = list.map((t) => `${t.shown}:${t.line}`);
    warn(`luccet index: the term "${clean(list[0].term)}" is defined in ${at.slice(0, -1).join(', ')} and ${at[at.length - 1]}; the glossary lists ${list.length === 2 ? 'both' : 'all of them'}`);
  }
  for (const u of uses) if (!defined.has(u.key)) warn(`luccet index: ${u.shown}:${u.line}: the term "${clean(u.term)}" has no definition in these notes`);
  const outputs = [
    [NOTES_JSON, `${JSON.stringify({ luccet: luccet.version, format: NOTES_FORMAT, notes }, null, 2)}\n`],
    [SEARCH_JSON, lineJSON({ luccet: luccet.version, format: luccet.search.format, notes: notes.map((n) => ({ url: n.url, title: n.title })), entries: idx.entries, terms: idx.terms, lengths: idx.lengths, avg: idx.avg }, ['terms'])],
    [GLOSSARY_JSON, lineJSON({ luccet: luccet.version, format: luccet.glossary.format, notes: notes.map((n) => ({ url: n.url, title: n.title })), terms: terms.map(({ shown, title, ...t }) => t) })],
  ];
  const where = (name) => slash(path.join(dir, name));
  if (undated) warn(`luccet index: the git log was longer than ${GIT_BUFFER >> 20} MB and was cut, so ${plural(undated, 'note')} ${undated === 1 ? 'is' : 'are'} dated by ${undated === 1 ? 'its' : 'their'} modification time`);
  const summary = `${plural(notes.length, 'note')}, ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${terms.length ? `, ${plural(terms.length, 'term')}` : ''}${left ? `; ${left} left out (not tracked by git)` : ''}${robots ? `; ${robots} noindex` : ''}`;
  // --json: the summary as one object, on stdout.
  const report = (extra) => say(JSON.stringify({ notes: notes.length, entries: entries.length, terms: terms.length, leftOut: left, noindex: robots, unreadable: broken, files: { notes: where(NOTES_JSON), search: where(SEARCH_JSON), glossary: where(GLOSSARY_JSON) }, ...extra }, null, 2));
  if (o.check) {
    const stale = [];
    for (const [name, text] of outputs) {
      let have = null;
      try {
        have = fs.readFileSync(path.join(outDir, name), 'utf8');
      } catch {}
      if (have === text) continue;
      stale.push(where(name));
      warn(`luccet index: ${where(name)} is ${have === null ? 'missing' : 'stale'}: run luccet index${o.output !== undefined ? ` -o ${o.output}` : ''} ${paths.join(' ')}`);
    }
    warn(`luccet index: ${summary}; ${stale.length ? `${stale.length} of 3 files to write` : 'all three files are up to date'}`);
    if (o.json) report({ wrote: false, stale });
    return broken ? 2 : stale.length ? 1 : 0;
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, text] of outputs) fs.writeFileSync(path.join(outDir, name), text);
  } catch (e) {
    throw new UsageError(`cannot write ${dir}: ${e.message}`, false);
  }
  warn(`luccet index: ${summary} → ${where(NOTES_JSON)}, ${where(SEARCH_JSON)}, ${where(GLOSSARY_JSON)}`);
  if (o.json) report({ wrote: true });
  return broken ? 2 : 0;
}

// ---------------------------------------------------------------- parse

function parse(args) {
  const { values: o, positionals } = options(args, { transformed: { type: 'boolean' }, compact: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('parse');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const file = positionals[0];
  const text = read(file, 'parse');
  const a = analyse(text, file, { transform: !!o.transformed, noScripts: o['no-scripts'] });
  if (!a) throw new UsageError(`${file} is not a note (${notNote(text)})`, false);
  // The vocabulary problems (no note position) as `luccet parse` prints them.
  for (const d of a.diagnostics) if (!d.position) warn(`luccet parse: ${clean(d.message)}`);
  say(JSON.stringify(a.ast, null, o.compact ? 0 : 2));
  return 0;
}

// ---------------------------------------------------------------- build

// One FILE: -o OUT is a directory when it ends in a slash or is an existing
// directory (created, with its parents, if missing), and the page is
// DIR/FILE's name; otherwise the page's own path, its directory created if
// missing; without -o the page goes to stdout. Several FILEs, or a folder,
// take -o DIR, and one process builds them all: a named note is written as
// DIR/its name, a note found in a folder as DIR/its path in that folder, and
// the files there that are not notes are left out.
async function buildPage(args) {
  const { values: o, positionals } = options(args, { output: { type: 'string', short: 'o' }, math: { type: 'string' }, katex: { type: 'boolean' }, diagrams: { type: 'boolean' }, json: { type: 'boolean' }, 'no-scripts': { type: 'boolean' } });
  if (o.help) return help('build');
  if (o.math !== undefined || o.katex) throw new UsageError(`${o.katex ? '--katex' : '--math'} is gone: since 2.0 every formula is MathML, written by the engine, with nothing to pre-render`);
  if (o.diagrams) throw new UsageError('--diagrams is gone: since 2.0 the diagram add-ons are separate (github.com/Luccet/diagrams), and draw a built page\'s diagrams ahead with their own tools/diagrams.js');
  if (!positionals.length) throw new UsageError('FILE is missing');
  const stat = (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  };
  let out = o.output === undefined || o.output === '-' ? null : o.output;
  if (out !== null && !out) throw new UsageError('-o is empty');
  if (positionals.length > 1 || (stat(positionals[0]) || { isDirectory: () => false }).isDirectory()) return buildMany(positionals, out, o);
  const file = positionals[0];
  let into = null; // the directory to create before writing
  let asDir = false;
  if (out) {
    const st = stat(out);
    asDir = out.endsWith('/') || (path.sep === '\\' && out.endsWith('\\')) || !!(st && st.isDirectory());
    into = asDir ? out : path.dirname(out);
    if (asDir) out = path.join(out, path.basename(file));
  }
  if (out && path.resolve(out) === path.resolve(file)) throw new UsageError(`-o ${o.output} is the note itself`, false);
  const json = await buildOne(file, out, into, o, { named: true, urls: true });
  if (out && !asDir && !path.extname(out)) {
    const w = `${o.output} is written as a file; end -o with / to write ${path.basename(file)} into a directory of that name`;
    json.warnings.push(clean(w));
    warn(`luccet build: ${clean(w)}`);
  }
  if (o.json) say(JSON.stringify(json, null, 2));
  return 0;
}

// Several notes, one process: each written into DIR as buildPage says, and
// every output path checked before anything is written (two notes onto one
// page, or a page onto its note, stop the run). Pages already in DIR, when
// DIR is inside a folder given, are not notes to build.
async function buildMany(positionals, dir, o) {
  if (!dir) throw new UsageError('several notes, or a folder, need -o DIR');
  let st = null;
  try {
    st = fs.statSync(dir);
  } catch {}
  if (st && !st.isDirectory()) throw new UsageError(`-o ${dir} is a file: several notes need a directory`, false);
  const root = path.resolve(dir);
  const inside = (f) => {
    const r = path.relative(root, path.resolve(f));
    return !!r && !r.startsWith('..') && !path.isAbsolute(r);
  };
  const jobs = [];
  const seen = new Set();
  const add = (file, page, named) => {
    const k = path.resolve(file);
    if (!seen.has(k)) seen.add(k), jobs.push({ file, page, named });
  };
  for (const p of positionals) {
    let pst;
    try {
      pst = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`, false);
    }
    if (pst.isDirectory()) {
      for (const f of htmlFiles(p)) if (!inside(f)) add(f, path.join(dir, path.relative(p, f)), false);
    } else add(p, path.join(dir, path.basename(p)), true);
  }
  const pages = new Map();
  for (const j of jobs) {
    const k = path.resolve(j.page);
    if (k === path.resolve(j.file)) throw new UsageError(`-o ${dir} would write ${slash(j.page)} over its note`, false);
    if (pages.has(k)) throw new UsageError(`${slash(pages.get(k))} and ${slash(j.file)} would both be written to ${slash(j.page)}`, false);
    pages.set(k, j.file);
  }
  const built = [];
  let left = 0;
  for (const j of jobs) {
    const json = await buildOne(j.file, j.page, path.dirname(j.page), o, { named: j.named, urls: false });
    if (json) built.push(json);
    else left++;
  }
  warn(`luccet build: ${plural(built.length, 'page')} written into ${slash(dir)}${left ? `; ${plural(left, 'file')} in the folders not a note, left out` : ''}`);
  if (built.length) warn(`luccet build: relative URLs (luccet.js, add-ons, images, links) are kept as written, so they resolve from each page's folder in ${slash(dir)}`);
  if (o.json) say(JSON.stringify(built, null, 2));
  return 0;
}

// One note built and written (to stdout when page is null, unless --json),
// its warnings and diagnostics on stderr: the --json object, or null for a
// file found in a folder that is not a note (a named one is an error).
// `urls`: say when the page's relative URLs resolve from another folder.
async function buildOne(file, out, into, o, { named, urls }) {
  const shown = slash(file); // paths printed, and in --json, with forward slashes on every platform
  const text = read(file, 'build');
  const r = build(text, file, { noScripts: o['no-scripts'] });
  if (!r) {
    if (!named) return null;
    throw new UsageError(`${shown} is not a note (${notNote(text)})`, false);
  }
  // --json: the warnings and diagnostics in one object on stdout, with the
  // page when no -o takes it; the summary and the warnings go to stderr too.
  const warnings = [];
  const diagnostics = r.diagnostics;
  const said = (w) => {
    warnings.push(clean(w));
    warn(`luccet build: ${clean(w)}`);
  };
  for (const w of r.warnings) said(w);
  for (const d of diagnostics) warn(format(shown, d));
  if (urls && out && path.resolve(path.dirname(out)) !== path.dirname(path.resolve(file))) said(`relative URLs (luccet.js, add-ons, images, links) are kept as written, so they resolve from ${slash(path.dirname(out))}`);
  if (!out && !o.json) process.stdout.write(r.html);
  else if (out) {
    try {
      fs.mkdirSync(into, { recursive: true });
    } catch (e) {
      throw new UsageError(`cannot create the directory ${slash(into)}: ${e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'a file is in the way' : e.message}`, false);
    }
    try {
      fs.writeFileSync(out, r.html);
    } catch (e) {
      throw new UsageError(`cannot write ${slash(out)}: ${e.code === 'EISDIR' ? 'it is a directory' : e.message}`, false);
    }
  }
  const m = r.math;
  warn(`luccet build: ${out ? `wrote ${slash(out)}` : 'wrote the page'}; ${plural(m.total, 'formula')}`);
  const json = { file: shown, out: out ? slash(out) : null, math: { total: m.total }, warnings, diagnostics: diagnostics.map((d) => ({ file: shown, ...d, message: clean(d.message), ...(d.hint ? { hint: clean(d.hint) } : {}) })) };
  if (!out) json.html = r.html;
  return json;
}

// ---------------------------------------------------------------- mv

// The files under root that are not notes but name a moved file or folder:
// luccet mv does not rewrite them (a name in a script or a Markdown file is
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
  const { values: o, positionals } = options(args, { root: { type: 'string' }, 'dry-run': { type: 'boolean', short: 'n' }, json: { type: 'boolean' } });
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
      const r = readText(file);
      if (r.warning) warn(`luccet mv: ${r.warning.replace(file, shown(file))}`);
      notes.push({ file, text: r.text });
    } catch (e) {
      warn(`luccet mv: cannot read ${shown(file)}: ${e.message}; its links are left as they are`);
    }
  }
  const plan = relocate(notes, moves);
  const dry = !!o['dry-run'];
  // --json: the moves, the edits and what is left alone, as one object.
  const json = o.json ? { dryRun: dry, moves: moves.map((m) => ({ from: shown(m.from), to: shown(m.to) })), edits: [], left: [] } : null;
  const leave = (file, why, more) => {
    if (json) json.left.push({ file: shown(file), ...more, reason: why });
    warn(`luccet mv: ${shown(file)}${more && more.line ? `:${more.line}:${more.column}` : ''}${more && more.line ? ': ' : ' '}${why}`);
  };

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
      warn(`luccet mv: ${e.message}; nothing was moved, and the links are left as they were`);
      return 1;
    }
  }
  if (!json) for (const m of moves) say(`${dry ? 'would move' : 'moved'} ${shown(m.from)} → ${shown(m.to)}`);
  let count = 0;
  for (const p of plan) {
    for (const e of p.edits) {
      if (json) json.edits.push({ file: shown(p.moved), line: e.line, column: e.column, was: e.was, text: e.text });
      else say(`${shown(p.moved)}:${e.line}:${e.column}: ${e.was} → ${e.text}`);
    }
    count += p.edits.length;
    if (p.base) leave(p.moved, 'has a <base href>, so its URLs do not resolve from its folder; they are left as they are');
    for (const l of p.lost) leave(p.moved, `${l.url} moves, but where it is written was not found; it is left as it is`, { line: l.line, column: l.column, url: l.url });
  }
  const isNote = new Set(notes.filter((n) => split(n.text)).map((n) => n.file));
  for (const m of mentions(root, moves, isNote)) leave(m.file, `names ${m.named.join(', ')} but is not a note, so it is left as it is; look at it`, { names: m.named });
  const edited = plan.filter((p) => p.edits.length);
  const text = new Map(notes.map((n) => [n.file, n.text]));
  if (!dry) for (const p of edited) fs.writeFileSync(p.moved, apply(text.get(p.file), p.edits));
  warn(`luccet mv: ${plural(moves.length, 'move')}, ${plural(count, 'link')} in ${plural(edited.length, 'note')}${dry ? '; a dry run, so nothing changed' : ''}`);
  if (json) say(JSON.stringify(json, null, 2));
  return 0;
}

// ---------------------------------------------------------------- vendor

// `luccet vendor` went with the add-ons it served, in 2.0: each add-on that
// loads a library has its own tools/vendor.js.
function vendor() {
  throw new UsageError('this command is gone: since 2.0 the add-ons are separate (github.com/Luccet), and each one that loads a library has its own tools/vendor.js; math needs nothing', false);
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
  SYNOPSIS,
  EXIT_1,
  usage,
  new: command('new', newNote),
  check: command('check', check),
  parse: command('parse', parse),
  build: command('build', buildPage),
  mv: command('mv', mv),
  search: command('search', search),
  index: command('index', index),
  vendor: command('vendor', vendor),
  lsp: command('lsp', lsp),
};
