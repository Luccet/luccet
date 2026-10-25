// SPDX-License-Identifier: MIT
// The terms a note defines (docs/api.html#glossary), for the glossary
// add-on (addons/glossary.js) and `luccet index`, which gathers a folder's
// into glossary.json. A term is the defining instance of a word, as HTML
// has it: a `:dfn[…]` inline (any inline whose element is dfn), whose
// definition is the paragraph it stands in; or a block of a listed name
// (`definition` by default) with a title, the title being the term and the
// body the definition. `title=` on a dfn is the term's canonical form, as
// HTML's rule says, so `:dfn[truisms]{title=truism}` defines "truism". A
// dfn inside such a block that names the block's own term is not a second
// term. A dfn in a heading is defined by the paragraph after the heading; in
// a table cell, by the cell.
//
//   terms(ast, {blocks}) -> [{term, key, slug, id, line, how, definition}]
//     key: the term folded as search folds words (one form for Café and
//          cafe); slug: an id for the term on a glossary page, from the key;
//     id: the anchor nearest above the term: its own, else its block's, else
//         its section's heading's ('' at the top of the note);
//     line: the note line the term is on; how: 'dfn' or the block's name;
//     definition: the definition's nodes, positions removed, for luccet.emit
//     on another page (empty for a term with no paragraph).
//   uses(ast) -> [{term, key, line}]   every `:term[…]`, for luccet index's check
//   key(text), slug(text)              the folding and the id, for add-ons
//   format                             the number of glossary.json's format
'use strict';

const { plain, fold } = require('./search');

// The format of a glossary file: the terms' fields and the definitions'
// trees. 1 since 1.0; the next number comes with a major release. The
// add-on takes a file of its own format whatever version wrote it.
const FORMAT = 1;

const key = (text) => fold(String(text)).replace(/\s+/g, ' ').trim();
const slug = (text) => `glossary-${key(text).replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'term'}`;

// A deep copy without positions (`position`, and the `…Position` spans the
// transforms keep), so a definition travels light and emits the same.
const strip = (nodes) => JSON.parse(JSON.stringify(nodes, (k, v) => (k === 'position' || k === 'texAt' || /Position$/.test(k) ? undefined : v)));

const entry = (term, id, node, how, nodes) => ({ term, key: key(term), slug: slug(term), id, line: node.position ? node.position.start.line : 0, how, definition: strip(nodes) });
const isTitle = (k) => k && k.type === 'paragraph' && k.data && k.data.directiveLabel;

function terms(ast, opts) {
  const blocks = new Set(((opts && opts.blocks) || ['definition']).map(String));
  const out = [];
  let current = '';
  // Explicit frames, so a deep tree cannot overflow the call stack: each
  // holds a child list, the index in it, the paragraph that defines a dfn
  // found in the list, the listed block the list is in, and the anchor to
  // come back to when the list ends.
  const frames = [{ list: (ast && ast.children) || [], i: 0, para: null, block: null, back: null }];
  while (frames.length) {
    const f = frames[frames.length - 1];
    if (f.i >= f.list.length) {
      frames.pop();
      if (f.back !== null) current = f.back;
      continue;
    }
    const n = f.list[f.i++];
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'heading') {
      current = (n.attributes && n.attributes.id) || '';
      const next = f.list[f.i];
      frames.push({ list: n.children || [], i: 0, para: next && next.type === 'paragraph' ? next : null, block: f.block, back: null });
      continue;
    }
    if (n.type === 'containerDirective') {
      const id = n.attributes && n.attributes.id;
      const kids = n.children || [];
      const title = kids.find(isTitle);
      let block = f.block;
      if (blocks.has(n.name) && title) {
        const term = plain(title).trim();
        if (term) {
          block = { key: key(term) };
          out.push(entry(term, id || current, n, n.name, kids.filter((k) => k !== title)));
        }
      }
      frames.push({ list: kids, i: 0, para: null, block, back: id ? current : null });
      if (id) current = id;
      continue;
    }
    if (n.type === 'textDirective') {
      const tag = n.data && n.data.luccet && n.data.luccet.tag;
      if (tag === 'dfn' || (!tag && n.name === 'dfn')) {
        const a = n.attributes || {};
        const term = (typeof a.title === 'string' && a.title.trim()) || plain(n).trim();
        if (term && !(f.block && f.block.key === key(term))) out.push(entry(term, (typeof a.id === 'string' && a.id) || current, n, 'dfn', f.para ? [f.para] : []));
      }
    }
    if (!n.children) continue;
    const para = n.type === 'paragraph' ? n : n.type === 'tableCell' ? { type: 'paragraph', children: n.children } : n.type === 'heading' ? f.para : n.children.some((k) => k.type === 'paragraph' || k.type === 'listItem') ? null : f.para;
    frames.push({ list: n.children, i: 0, para, block: f.block, back: null });
  }
  return out;
}

function uses(ast) {
  const out = [];
  const frames = [(ast && ast.children) || []];
  const at = [0];
  while (frames.length) {
    const list = frames[frames.length - 1];
    const i = at[at.length - 1]++;
    if (i >= list.length) {
      frames.pop();
      at.pop();
      continue;
    }
    const n = list[i];
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'textDirective' && n.name === 'term') {
      const a = n.attributes || {};
      const term = (typeof a.title === 'string' && a.title.trim()) || plain(n).trim();
      if (term) out.push({ term, key: key(term), line: n.position ? n.position.start.line : 0 });
    }
    if (n.children) frames.push(n.children), at.push(0);
  }
  return out;
}

module.exports = { terms, uses, key, slug, format: FORMAT };
