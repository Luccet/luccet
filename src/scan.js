// SPDX-License-Identifier: MIT
// The lexical pieces the block and inline parsers share: source
// normalisation, the character classes, the `{…}` attribute-group parser,
// and the reserved-name and custom-element tests.
'use strict';

// CRLF and CR become LF, a leading BOM goes, NUL becomes U+FFFD. Every
// offset in the AST and the diagnostics refers to the string this returns.
function normalise(source) {
  let s = String(source == null ? '' : source);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
}

// The character classes, as sticky regexes for matchAt: IDENT for ids,
// classes and references (no `:` and no `.`), NAME for element names, KEY
// for attribute names, LABEL for footnote labels (a digit may lead), VALUE
// for an unquoted attribute value.
const IDENT = /[\p{L}_][\p{L}\p{M}\p{N}_-]*/uy;
const NAME = /\p{L}[\p{L}\p{M}\p{N}_-]*/uy;
const KEY = /[\p{L}_][\p{L}\p{M}\p{N}_:.-]*/uy;
const LABEL = /[\p{L}\p{M}\p{N}_-]+/uy;
const VALUE = /[^\s"'=<>`{}]+/y;

// The index just after a match of the sticky `re` at text[i], or -1.
function matchAt(re, text, i) {
  re.lastIndex = i;
  return re.test(text) ? re.lastIndex : -1;
}

function isAsciiAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ASCII punctuation: what a backslash escapes.
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Space, tab or newline: the `ws` of the attribute grammar.
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

function skipWs(text, i, end) {
  while (i < end && isWs(text[i])) i++;
  return i;
}

const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

// o[k] = v as an own data property. `__proto__` is an attribute name like any
// other, and a plain assignment would set the prototype instead.
function put(o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
  return o;
}

// Elements luccet never produces, whatever the schema says; the names `luccet`,
// `t-*` and `end` are reserved too. `:::meta` is a core block, and
// `:::script`, `:::style`, `:::html` get their own report, so block.js
// handles those names before asking.
const RESERVED_TAGS = new Set('base body head html link main meta noscript script style template title'.split(' '));

function isReservedName(name) {
  return RESERVED_TAGS.has(name) || name === 'luccet' || name === 'end' || name.startsWith('t-');
}

// A class authors may not write, as luccet uses it on its own elements: `luccet`
// and `t-*`, case-sensitively (`.Luccet` is an ordinary class).
function isReservedClass(name) {
  return name === 'luccet' || name.startsWith('t-');
}

// HTML's valid custom-element name, as written: lower-case start, a hyphen,
// and none of the names HTML reserves.
const PCEN =
  /^[a-z][-.0-9_a-z\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]*$/u;
const NOT_CUSTOM = new Set('annotation-xml color-profile font-face font-face-src font-face-uri font-face-format font-face-name missing-glyph'.split(' '));
const isCustomName = (n) => n.includes('-') && PCEN.test(n) && !NOT_CUSTOM.has(n);

// ---------------------------------------------------------------- attributes

// Parses the attribute group whose `{` is text[i], looking no further than
// `limit`:
//
//   "{" ws* ITEM (ws+ ITEM)* ws* "}"    ITEM = #IDENT | .IDENT | KEY=VALUE | KEY
//
// A quote opens only right after `=`, and inside quotes nothing is special
// (no escapes). Returns
//
//   null                          no candidate: no unquoted `}` follows, or
//                                 an unquoted `{` comes first (abort, which
//                                 keeps `{{{{…` linear);
//   {end, empty: true}            `{}`, or only whitespace inside: not a group;
//   {end, ok: false, bad}         a candidate that does not parse; `bad` is
//                                 the index of the first rejected character;
//   {end, ok: true, strong, attrs, idAt, classAt, keyAt, reserved}
//
// `end` is the index just after the `}`. `strong`: the group holds an `#id`,
// a `.class` or a `key=value`; one of bare keys only (`{open}`) is weak, and
// several positions take strong groups only. `attrs` is flat and in emission
// order: `id` (the last wins), then `class` (space-separated, accumulated),
// then the other keys, ASCII-lower-cased as the browser does, in the order
// first written (the last value wins); a bare key's value is ''. `idAt` is
// the index of the winning id (its `#`, or the first letter of `id=`), or -1;
// `classAt` that of the first class kept (its `.`, or the first letter of
// `class=`), or -1; `keyAt` maps each other key to the index of its last
// occurrence. Callers point diagnostics at them. `reserved` lists what was
// dropped for `name.reserved` (the key `data-t`, the classes `luccet` and
// `t-*`), as {at, length, text, kind}.
function parseAttrs(text, i, limit) {
  let j = i + 1;
  let q = '';
  for (; j < limit; j++) {
    const c = text[j];
    if (q) {
      if (c === q) q = '';
      continue;
    }
    if (c === '}') break;
    if (c === '{') return null;
    if ((c === '"' || c === "'") && text[j - 1] === '=') q = c;
  }
  if (j >= limit) return null;
  const end = j + 1;
  let k = skipWs(text, i + 1, j);
  if (k === j) return { end, empty: true };

  let id;
  let idAt = -1;
  let classAt = -1;
  const classes = [];
  const rest = Object.create(null);
  const keyAt = Object.create(null);
  const reserved = [];
  const overridden = []; // an id or a key written again in the group: {at, length, text, kind}
  let idEnd = -1;
  let strong = false;
  const fail = (at) => ({ end, ok: false, bad: at });
  const addClasses = (list, at, length) => {
    for (const c of list) {
      if (isReservedClass(c)) reserved.push({ at, length, text: c, kind: 'class' });
      else if (classes.push(c) === 1) classAt = at;
    }
  };

  while (k < j) {
    const c = text[k];
    if (c === '#' || c === '.') {
      const e = matchAt(IDENT, text, k + 1);
      if (e < 0) return fail(k + 1);
      const name = text.slice(k + 1, e);
      strong = true;
      if (c === '#') {
        if (id !== undefined) overridden.push({ at: idAt, length: idEnd - idAt, text: id, kind: 'id', now: name });
        id = name;
        idAt = k;
        idEnd = e;
      } else addClasses([name], k, e - k);
      k = e;
    } else {
      const e = matchAt(KEY, text, k);
      if (e < 0) return fail(k);
      const at = k;
      const key = asciiLower(text.slice(k, e));
      k = e;
      let value = '';
      if (text[k] === '=') {
        strong = true;
        k++;
        const quote = text[k];
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, k + 1);
          value = text.slice(k + 1, close);
          k = close + 1;
        } else {
          const v = matchAt(VALUE, text, k);
          if (v < 0) return fail(k);
          value = text.slice(k, v);
          k = v;
        }
      }
      if (key === 'id') {
        if (id !== undefined) overridden.push({ at: idAt, length: idEnd - idAt, text: id, kind: 'id', now: value });
        id = value;
        idAt = at;
        idEnd = k;
      } else if (key === 'class') addClasses(value.split(/[ \t\n]+/).filter(Boolean), at, e - at);
      else if (key === 'data-t') reserved.push({ at, length: e - at, text: text.slice(at, e), kind: 'key' });
      else {
        if (key in rest) overridden.push({ at: keyAt[key], length: key.length, text: key, kind: 'key' });
        rest[key] = value;
        keyAt[key] = at;
      }
    }
    if (k < j && !isWs(text[k])) return fail(k);
    k = skipWs(text, k, j);
  }

  const attrs = {};
  if (id !== undefined) attrs.id = id;
  if (classes.length) attrs.class = classes.join(' ');
  for (const key in rest) put(attrs, key, rest[key]);
  return { end, ok: true, strong, attrs, idAt, classAt, keyAt, reserved, overridden };
}

// Reports `name.reserved` for what parseAttrs dropped from a group that was
// used, and `attr.overridden` for an id or a key it holds twice (the last
// wins). `toOffset(index)` maps a text index to a source offset.
function reportReserved(ctx, res, toOffset) {
  for (const o of res.overridden || []) {
    const at = toOffset(o.at);
    if (o.kind === 'id') ctx.report('attr.overridden', at, at + o.length, `the id "${o.text}" is replaced by "${o.now}", written later in the same group; an element has one id`, `keep one: remove #${o.text}, or #${o.now}`);
    else ctx.report('attr.overridden', at, at + o.length, `\`${o.text}\` is written again later in the same group, and that value wins`, 'keep one of them');
  }
  for (const r of res.reserved) {
    const at = toOffset(r.at);
    if (r.kind === 'key')
      ctx.report('name.reserved', at, at + r.length, `the attribute "${r.text}" is reserved for luccet's own use and is dropped`, 'remove it; luccet sets data-t itself');
    else
      ctx.report('name.reserved', at, at + r.length, `the class "${r.text}" is reserved for luccet's own use and is dropped`, 'choose a class that is not "luccet" and does not start with "t-"');
  }
}

// ---------------------------------------------------------------- raw HTML hazards

// What in raw HTML would hide the rest of the page once the browser reads it
// (docs/elements.html#raw-hazards), read as the browser's tokenizer reads
// it, with no DOM: a comment, or a CDATA section in svg or math, never
// closed; a tag never ended with `>` (a quote left open in it, say); an
// element whose content is text (script, style, textarea, title, xmp,
// iframe, noembed, noframes, noscript) without its end tag, or a plaintext,
// which has none; a template or a select left open; and `/>` on an element
// that is not void, which HTML ignores, outside svg and math, where it
// closes. Returns the first, {kind, name, at, end} with offsets in s
// (kind: 'comment', 'tag', 'text', 'open' or 'self'), or null.
const TEXT_ELEMENT = new Set('script style textarea title xmp iframe noembed noframes noscript'.split(' '));
const VOID_ELEMENT = new Set('area base br col embed hr img input link meta source track wbr param keygen'.split(' '));
const HELD = new Set(['template', 'select']);
const textEnd = new Map(); // a text element's name -> its end tag, as a sticky-free global regex
const isTagSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
function htmlHazard(s) {
  let i = s.indexOf('<');
  if (i < 0) return null;
  const n = s.length;
  const open = { template: [], select: [] }; // each one's start tags still open: at, end
  let foreign = 0; // svg or math depth
  for (; i >= 0 && i < n; i = s.indexOf('<', i)) {
    if (s.startsWith('<!--', i)) {
      if (s.startsWith('<!-->', i) || s.startsWith('<!--->', i)) {
        i += s[i + 4] === '>' ? 5 : 6;
        continue;
      }
      const e = s.indexOf('-->', i + 4);
      if (e < 0) return { kind: 'comment', name: '<!--', at: i, end: i + 4 };
      i = e + 3;
      continue;
    }
    if (foreign && s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      if (e < 0) return { kind: 'comment', name: '<![CDATA[', at: i, end: i + 9 };
      i = e + 3;
      continue;
    }
    const c = s.charCodeAt(i + 1);
    if (c === 33 || c === 63) {
      // `<!…>` or `<?…>`: a bogus comment, to the next `>`
      const e = s.indexOf('>', i + 2);
      if (e < 0) return { kind: 'tag', name: s.slice(i, i + 2), at: i, end: i + 2 };
      i = e + 1;
      continue;
    }
    const close = c === 47;
    const k0 = close ? i + 2 : i + 1;
    if (!isAlpha(s.charCodeAt(k0))) {
      i++;
      continue;
    }
    let k = k0;
    while (k < n && !isTagSpace(s.charCodeAt(k)) && s[k] !== '/' && s[k] !== '>') k++;
    const name = s.slice(k0, k).toLowerCase();
    // The attributes, to the `>`: a `/` right before it, outside a value, self-closes.
    let j = k;
    let self = false;
    while (j < n && s[j] !== '>') {
      const ch = s.charCodeAt(j);
      if (ch === 47) {
        self = s[j + 1] === '>';
        j++;
      } else if (isTagSpace(ch)) j++;
      else {
        const a0 = j; // an attribute's name; an `=` that starts it is part of it
        while (j < n && !isTagSpace(s.charCodeAt(j)) && s[j] !== '/' && s[j] !== '>' && (s[j] !== '=' || j === a0)) j++;
        while (j < n && isTagSpace(s.charCodeAt(j))) j++;
        if (s[j] !== '=') continue;
        j++;
        while (j < n && isTagSpace(s.charCodeAt(j))) j++;
        if (s[j] === '"' || s[j] === "'") {
          const e = s.indexOf(s[j], j + 1);
          if (e < 0) return { kind: 'tag', name, at: i, end: k };
          j = e + 1;
        } else while (j < n && !isTagSpace(s.charCodeAt(j)) && s[j] !== '>') j++; // unquoted: a `/` is part of it
        self = false;
      }
    }
    if (j >= n) return { kind: 'tag', name, at: i, end: k };
    const after = j + 1;
    i = after;
    if (close) {
      if (name === 'svg' || name === 'math') foreign = Math.max(0, foreign - 1);
      else if (!foreign && HELD.has(name)) open[name].length -= open[name].length ? 2 : 0;
      continue;
    }
    if (name === 'svg' || name === 'math') {
      if (!self) foreign++;
      continue;
    }
    if (foreign) continue; // there `/>` closes, and no element's content is text
    if (self && !VOID_ELEMENT.has(name)) return { kind: 'self', name, at: k0 - 1, end: after };
    if (name === 'plaintext') return { kind: 'text', name, at: k0 - 1, end: after };
    if (TEXT_ELEMENT.has(name)) {
      let re = textEnd.get(name);
      if (!re) textEnd.set(name, (re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi')));
      re.lastIndex = after;
      const m = re.exec(s);
      if (!m) return { kind: 'text', name, at: k0 - 1, end: after };
      i = m.index;
      continue;
    }
    if (HELD.has(name)) open[name].push(k0 - 1, after);
  }
  const t = open.template;
  const sel = open.select;
  if (!t.length && !sel.length) return null;
  const name = !sel.length || (t.length && t[0] < sel[0]) ? 'template' : 'select';
  return { kind: 'open', name, at: open[name][0], end: open[name][1] };
}

module.exports = {
  normalise,
  IDENT,
  NAME,
  LABEL,
  matchAt,
  isAsciiAlnum,
  isAsciiPunct,
  skipWs,
  put,
  isReservedName,
  isCustomName,
  parseAttrs,
  reportReserved,
  htmlHazard,
};
