#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The agent skills in skills/ (skills/README.md), checked against the
// Agent Skills format (agentskills.io/specification) and against the engine,
// so that what they teach an agent is what Luccet does:
//   - each skill is skills/NAME/SKILL.md, its frontmatter `name` (1-64 of
//     a-z, 0-9 and single hyphens, the folder's name) and `description`
//     (1-1024 characters), and no field the format does not define;
//     SKILL.md has at most 500 lines;
//   - every ```luccet fence is a note body whose diagnostics are exactly its
//     expect= (none by default), under schema=none (the default) or demo,
//     as a documentation page's live examples (cli/examples.js);
//   - every ```html fence that is a note (its luccet.js line, cli/note.js) is
//     analysed as `luccet check` does, as if at the repository's root, so
//     that its luccet.js, add-ons and themes resolve: no diagnostic but its
//     expect=;
//   - every relative link names a file of the skill, and every link to the
//     published documentation names a page and an id it has;
//   - a backticked name such as `block.unclosed`, of a family of codes, is
//     a code; and a skill with references/diagnostics.md covers every code
//     (src/diag.js, and the runtime and tool codes in test/lib/spec.js).
//
//   node test/skills.js [--verbose]
'use strict';

const fs = require('fs');
const path = require('path');
const examples = require('../cli/examples');
const { split, analyse } = require('../cli/note');
const anchors = require('./lib/anchors');
const { SEVERITY } = require('../src/diag');
const fixture = require('./fixtures/schema');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');
const DOCS = 'https://luccet.dev/';
const verbose = process.argv.includes('--verbose');

const RUNTIME = fs
  .readFileSync(path.join(__dirname, 'lib', 'spec.js'), 'utf8')
  .match(/const RUNTIME_CODES = \[([^\]]*)\]/)[1]
  .match(/'([^']+)'/g)
  .map((s) => s.slice(1, -1));
const CODES = new Set([...Object.keys(SEVERITY), ...RUNTIME]);
const FAMILIES = new Set([...CODES].map((c) => c.split('.')[0]));
const FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

const problems = [];
const problem = (file, line, message) => problems.push(`${path.relative(ROOT, file)}${line ? `:${line}` : ''}: ${message}`);
let checked = 0;

// The frontmatter's top-level `key: value` lines; a value may be quoted, and
// `metadata` holds indented lines.
function frontmatter(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return problem(file, 1, 'no frontmatter: SKILL.md starts with --- and a name and a description'), null;
  const out = {};
  for (const line of m[1].split('\n')) {
    if (/^\s/.test(line) || !line.trim()) continue;
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      problem(file, 1, `frontmatter line is not key: value: ${line}`);
      continue;
    }
    let v = kv[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

// The fences of a Markdown file: [{lang, info: {key: value}, body, line}].
function fences(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const [, indent, mark, lang, rest] = open;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
      if (close.test(lines[j])) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    }
    const info = {};
    for (const m of rest.matchAll(/([a-z]+)=(?:"([^"]*)"|(\S+))/g)) info[m[1]] = m[2] !== undefined ? m[2] : m[3];
    out.push({ lang, info, body: body.join('\n'), line: i + 1 });
    i = j;
  }
  return out;
}

const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
const schemaOf = (name, file, line) => {
  if (!name || name === 'none') return examples.NONE;
  if (name === 'demo') return fixture;
  problem(file, line, `schema=${name}: none or demo`);
  return null;
};
const differs = (want, got) => {
  const left = got.slice();
  const missing = [];
  for (const c of want) {
    const i = left.indexOf(c);
    if (i < 0) missing.push(c);
    else left.splice(i, 1);
  }
  return missing.length || left.length ? `expect="${want.join(' ')}" but the engine reports ${got.join(' ') || 'nothing'}` : null;
};

function checkFences(text, file) {
  for (const f of fences(text)) {
    if (f.lang === 'luccet') {
      const schema = schemaOf(f.info.schema, file, f.line);
      if (!schema) continue;
      checked++;
      const r = examples.check({ source: `${f.body}\n`, expect: words(f.info.expect), schema });
      const got = r.diagnostics.map((d) => d.code);
      const bad = differs(words(f.info.expect), got);
      if (bad) problem(file, f.line, `${bad}${verbose ? `\n${r.diagnostics.map((d) => `    ${d.code}: ${d.message}`).join('\n')}` : ''}`);
    } else if (f.lang === 'html' && split(`${f.body}\n`)) {
      checked++;
      const a = analyse(`${f.body}\n`, path.join(ROOT, 'skill-example.html'));
      const got = a.diagnostics.map((d) => d.code);
      const bad = differs(words(f.info.expect), got);
      if (bad) problem(file, f.line, `a note: ${bad}${verbose ? `\n${a.diagnostics.map((d) => `    ${d.code}: ${d.message}`).join('\n')}` : ''}`);
    }
  }
}

// Links: relative ones to files of the skill; the published documentation's
// to a page and an id it has.
function checkLinks(text, file, skillDir) {
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const prose = text.replace(/^(\s*)(`{3,})[\s\S]*?^\1\2\s*$/gm, blank).replace(/(`+)[^`][\s\S]*?\1/g, blank);
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    const url = m[1];
    if (url.startsWith(DOCS)) {
      const rest = url.slice(DOCS.length);
      const pm = /^(?:(docs\/[a-z-]+\.html)|(index\.html)?)(?:#(.+))?$/.exec(rest);
      if (!pm) {
        problem(file, lineOf(m.index), `${url}: not a page of the documentation`);
        continue;
      }
      const page = anchors.load(path.join(ROOT, pm[1] || 'index.html'));
      if (!page || page.error) problem(file, lineOf(m.index), `${url}: ${pm[1] || 'index.html'} is not a documentation page`);
      else if (pm[3] && !page.ids.has(decodeURIComponent(pm[3]))) problem(file, lineOf(m.index), `${url}: ${pm[1] || 'index.html'} has no id ${pm[3]}`);
    } else if (!/^[a-z][a-z0-9+.-]*:|^#/i.test(url)) {
      const target = path.resolve(path.dirname(file), url.replace(/#.*$/, ''));
      if (!target.startsWith(skillDir + path.sep) || !fs.existsSync(target)) problem(file, lineOf(m.index), `${url}: no such file in the skill`);
    }
  }
}

// A backticked name of a code family is a code.
function checkCodes(text, file) {
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(/`([a-z]+)\.([a-z][a-z-]*)`/g)) {
    if (FAMILIES.has(m[1]) && !CODES.has(`${m[1]}.${m[2]}`)) problem(file, lineOf(m.index), `\`${m[1]}.${m[2]}\` is not a diagnostic code`);
  }
}

const skills = fs.existsSync(SKILLS) ? fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
if (!skills.length) problem(SKILLS, 0, 'no skills');
for (const dir of skills) {
  const skillDir = path.join(SKILLS, dir.name);
  const main = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(main)) {
    problem(skillDir, 0, 'no SKILL.md');
    continue;
  }
  const text = fs.readFileSync(main, 'utf8');
  const fm = frontmatter(text, main);
  if (fm) {
    for (const k of Object.keys(fm)) if (!FIELDS.has(k)) problem(main, 1, `frontmatter field ${k} is not in the format`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name || '') || fm.name.length > 64) problem(main, 1, `name ${JSON.stringify(fm.name)}: 1-64 of a-z, 0-9 and single hyphens`);
    if (fm.name !== dir.name) problem(main, 1, `name ${JSON.stringify(fm.name)} is not the folder's name, ${dir.name}`);
    if (!fm.description || fm.description.length > 1024) problem(main, 1, `description: 1-1024 characters, not ${(fm.description || '').length}`);
    if (fm.compatibility !== undefined && (!fm.compatibility || fm.compatibility.length > 500)) problem(main, 1, 'compatibility: 1-500 characters');
  }
  const lines = text.split('\n').length;
  if (lines > 500) problem(main, 0, `${lines} lines; keep SKILL.md under 500 and move detail into references/`);
  const files = [main];
  const refs = path.join(skillDir, 'references');
  if (fs.existsSync(refs)) for (const f of fs.readdirSync(refs).sort()) if (f.endsWith('.md')) files.push(path.join(refs, f));
  for (const file of files) {
    const t = fs.readFileSync(file, 'utf8');
    checkFences(t, file);
    checkLinks(t, file, skillDir);
    checkCodes(t, file);
  }
  const diagnostics = path.join(refs, 'diagnostics.md');
  if (fs.existsSync(diagnostics)) {
    const t = fs.readFileSync(diagnostics, 'utf8');
    for (const code of CODES) if (!t.includes(`\`${code}\``)) problem(diagnostics, 0, `does not cover ${code}`);
  }
}

for (const p of problems) console.log(`✗ ${p}`);
console.log(`skills: ${skills.length} skill(s), ${checked} example(s); ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
