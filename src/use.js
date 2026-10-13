// SPDX-License-Identifier: MIT
// The leading `:::use` block: the add-ons a note loads, one per line, as the
// tern.js tag's data-use lists them. It is read from the note's text, not its
// tree, because the add-ons must be loaded before the note is parsed (the
// parser consults their schema): the runtime scans the file as it streams in,
// the tools scan it before they analyse. The parser reads the same block for
// the tree (block.js readUse), where `use.late` reports one that is not
// leading.
'use strict';

const OPENER = /^[ \t]*:{3,}(meta|use)(?:[ \t\[{].*)?$/;
const CLOSER = /^[ \t]*:{3,}(?:\/[A-Za-z][\w-]*)?[ \t]*$/;

// scanUse(text, {eof}) -> {entries, decided}: the entries of every leading
// `:::use` block ({url, line, column, offset}, 1-based line and column),
// `:::meta` blocks and blank lines skipped, stopping at the first other line.
// `decided` is false while the text ends inside an open block, or after the
// blocks with nothing else yet, and `eof` is false: more may still come. With
// `eof`, an open block ends at the text's end.
function scanUse(text, { eof = true } = {}) {
  const entries = [];
  let i = 0;
  let line = 0;
  let open = null; // 'meta' | 'use' while inside a block
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl < 0 ? text.length : nl;
    const complete = nl >= 0 || eof; // a last line without its newline may still be growing
    const s = text.slice(i, end);
    line++;
    if (!complete) return { entries, decided: false };
    if (open) {
      if (CLOSER.test(s)) open = null;
      else if (open === 'use') {
        const re = /\S+/g;
        for (let m; (m = re.exec(s)); ) entries.push({ url: m[0], line, column: m.index + 1, offset: i + m.index });
      }
    } else {
      const m = OPENER.exec(s);
      if (m) open = m[1];
      else if (/\S/.test(s)) return { entries, decided: true };
    }
    if (nl < 0) break;
    i = nl + 1;
  }
  return { entries, decided: !!eof };
}

module.exports = { scanUse };
