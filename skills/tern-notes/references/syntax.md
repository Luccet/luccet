# Tern syntax reference

Every construct of a note's body, with its exact rules, its edge cases, its escape, and the diagnostic a mistake produces. Read [../SKILL.md](../SKILL.md) first; come here when a construct does not do what you expect, or before you write one you have not used. What vocabulary names such as `theorem`, `proof` or `::toc` become is in [vocabulary.md](vocabulary.md); every diagnostic code is explained in [diagnostics.md](diagnostics.md).

The examples are note bodies, the text after the `tern.js` line, rendered with no vocabulary unless the fence says `schema=demo`. Each one was run through the engine; one that shows a mistake lists, in its fence's `expect=`, the codes it produces.

Sections: [the eight rules](#the-eight-rules) · [lines, names and case](#lines-names-and-case) · [how a line is read](#how-a-line-is-read) · [blocks](#blocks) · [inline](#inline) · [attributes](#attributes) · [what a name becomes](#what-a-name-becomes) · [ids](#ids) · [escapes](#escapes).

## The eight rules

1. **Blocks own their lines.** A block is decided by its first line, and its end is fixed when it opens. Only a table reads one line ahead, for its delimiter row. So there are no setext headings: `Title` over `=====` is one paragraph.
2. **Indentation is insignificant**, except for list-item and footnote membership, and for fence and display-math content, which loses the opener's indentation. There is no indented code; indent `:::` bodies freely.
3. **Trailing whitespace means nothing.** Lines are right-trimmed before they are read (verbatim bodies excepted). A hard break is `\` at the end of a line, never two spaces.
4. **Two alphabets.** Tern's marks are `:` `[ ]` `{ }` `@` `#` `|` `>` `*` `~~` `==`, the backtick and `$`; TeX's are `\` `{ }` `^` `_` `&`. Inside math (`$…$`, `` $`…` ``, `$$`, `:::macros`) nothing is Tern. Outside math, `\` before a letter is a literal backslash: `\alpha` and `C:\Users` stay as written.
5. **One attribute grammar**, `{#id .class key=value flag}`, always in braces, in a few fixed places ([attributes](#attributes)).
6. **Elements are names.** `:::name`, `::name` and `:name[…]` become the element the name denotes, else a `div` or `span` with the name as its class ([what a name becomes](#what-a-name-becomes)).
7. **Nothing is lost silently.** A malformed construct stays visible where it is and gets a diagnostic: an error (content lost or meaning changed), a warning (probably not what you meant) or an info (a hint).
8. **One spelling per construct.** A few Markdown alternates are accepted (`***`, `___`, `- - -` for `---`; `~~~` for a fence). Write the documented spelling.

Docs: [the eight rules](https://ozkrac.github.io/tern/docs/syntax-blocks.html#rules).

## Lines, names and case

- **The note** starts on the line after the one holding the `tern.js` tag; everything before it is the HTML head. Line numbers inside messages count from the note's first line; `tern check` puts the file line in front.
- **Normalisation:** CRLF and CR become LF, a leading byte-order mark is dropped, NUL becomes U+FFFD.
- **Right-trimming** applies to every line except those of a verbatim body: fence content, a raw HTML block, display math, and the body of `:::macros`, `:::meta` or a `{raw}` container. A whitespace-only line is blank.
- **Tabs** advance to the next multiple of 4 columns. Columns matter only for list and footnote membership and for dedenting fences and display math.

| Class | Pattern | Used for |
|---|---|---|
| IDENT | `[\p{L}_][\p{L}\p{M}\p{N}_-]*` | `#id`, `.class`, `@id` |
| NAME | `[\p{L}][\p{L}\p{M}\p{N}_-]*` | the name after `:::`, `::` and `:` |
| KEY | `[\p{L}_][\p{L}\p{M}\p{N}_:.-]*` | attribute keys: `data-x`, `aria-label`, `xml:lang` |
| LABEL | `[\p{L}\p{M}\p{N}_-]+` | footnote labels; digits anywhere |
| LANG | no whitespace, brackets, braces or backticks | a fence's language |

- An id or a class starts with a letter or `_`: `{#2024-plan}` and `{.2col}` do not parse (`attr.malformed`). Write `{#plan-2024}`.
- An `#id` holds no `:` and no `.`. LaTeX-style `{#sec:intro}` does not parse: write `{#sec-intro}`. `{#a.b}` does not parse either; `{#a .b}` is an id and a class. Any script works: `{#über}`, `@über`, `[^注]`.

| What | Case |
|---|---|
| element names: `:::Aside` is not `aside` but `div.Aside` | sensitive |
| ids and references: `@kern` does not reach `{#Kern}` | sensitive |
| classes: `.Tern` is ordinary, `.tern` is reserved | sensitive |
| attribute keys: `{ID=k CLASS=w}` is `{#k .w}` | ASCII-insensitive, lower-cased |
| footnote labels: `[^A]` reaches `[^a]:` | insensitive |
| tag names in a raw HTML block: `<DIV>` … `</div>` balance | insensitive |
| raw inline tags: `<B>` is text | lower case only |
| `:::meta` keys: only `title` sets the title | sensitive |

The "glued to a word" tests for `:` (inline element), `@` (reference), `~~` and `==` look only at ASCII letters and digits, so `これは==重要==です` and `漢:rt[kan]` work.

## How a line is read

Tern first matches the prefixes of the open containers: a quote's `>` (plus one optional space or tab), a list item's indentation to its content column (or a blank line), a footnote definition's indentation of 2 or more (or a blank line). `:::` blocks have no prefix. Then it classifies the rest of the line, leading whitespace ignored; the first row that matches wins.

| # | The line is | Construct |
|---|---|---|
| 1 | empty or whitespace | blank |
| 2 | `:::` (3 or more colons) alone, or `:::/NAME` | closer |
| 3 | 3 or more backticks or tildes, then the info | fence |
| 4 | `<!--`, `<script`, `<style`, `<pre`, `<textarea`, or a block-level or custom tag | raw HTML block |
| 5 | 1 to 6 `#`, then a space, a tab or the end | heading |
| 6 | 3 or more of one of `-` `*` `_`, spaces allowed, nothing else | thematic break |
| 7 | `\|` … over a delimiter row; or a delimiter row at a block start | table |
| 8 | `>` then a space, a tab or the end | blockquote |
| 9 | `-` `*` `+`, or 1 to 9 digits and `.` or `)`, then a space, a tab or the end | list item |
| 10 | `:::` glued to a NAME | container opener |
| 11 | `+++` (3 or more), optionally a group, inside a container | cell separator |
| 12 | `::NAME[…]{…}` filling the whole line | leaf |
| 13 | `$$` … | display math |
| 14 | `[^LABEL]:` then a space or the end | footnote definition |
| 15 | one or more strong `{…}` groups | attribute line |
| 16 | anything else | paragraph line |

- After a quote marker, a list marker or `[^x]:`, the rest of the line is classified again: `> - item` opens a quote and an item.
- **Interrupting a paragraph.** A line that starts a block ends the open paragraph, no blank line needed, except these, which continue it: an ordered item not numbered 1 (`1945. That year`), an empty item (`-` alone), a delimiter row (`|---|`), a `::name` line with text after the leaf, a line starting with a phrasing tag (`<b>`), and a weak or unparsable group (`{x}`, `{1, 2}`).
- **Lazy continuation.** A line that fails a quote, item or footnote prefix still continues an open paragraph if it starts no block: `> a` then `b` is one quoted paragraph. After a heading, a fence or display math nothing is lazy.
- **Fallback lines.** A closer-shaped or `+++` line that cannot act (stray, mismatched, orphan) is text, but it still ends the paragraph above and starts its own. A `::: name` line or a demoted `::word` line is an ordinary paragraph line.
- **Depth.** Containers, quotes, items and footnotes nest 64 deep; a deeper opener is text (`nesting.limit`).

Docs: [the line algorithm](https://ozkrac.github.io/tern/docs/syntax-blocks.html#line-algorithm).

## Blocks

Docs: [Syntax: blocks](https://ozkrac.github.io/tern/docs/syntax-blocks.html#top), one section per construct.

### Paragraphs and line breaks

- A paragraph is consecutive lines that start nothing else. Each line loses its leading and trailing whitespace; the lines are joined by soft breaks, shown as spaces. A blank line ends it; extra blank lines produce nothing.
- **Hard break:** `\` at the end of a line inside a paragraph, also in a quote, item, footnote or `:::` block, and inside a named element that spans lines. On a paragraph's last line, and in a heading, a title or a leaf, the `\` is literal. In a table row it continues the row.
- Two trailing spaces do nothing. `\\` at the end of a line is an escaped backslash followed by a soft break (`latex.linebreak`); `\\\` is a backslash and a break.

```tern
Roses are red,\
violets are blue.
   Leading spaces on a line are dropped.
```

### Headings

- One to six `#`, then a space, a tab or the end of the line. One line only; the text is inline content. `#hashtag`, `#1`, `C#` and seven `#` are paragraph text. A lone `#` is an empty heading.
- A closing run of `#` is text: `## Title ##` keeps its `##`. Delete it when converting Markdown.
- A trailing **strong** group, glued or after spaces, gives the id, classes and attributes: `## Kernel {#kernel .wide}`. A group followed by more text, a weak group (`{open}`) or `\{` stays heading text. A broken group that starts with `#` or `.` stays text with `attr.malformed`. An attribute line before the heading works too.
- **Slugs.** A heading without an id gets one from its plain text (math as its TeX, a reference as its target's id, a link as its text, footnote references ignored): NFKC, lower case, everything before the first letter or `_` dropped, each run of characters other than letters, marks, digits, `_` and `-` replaced by one `-`, `-` trimmed, `section` if nothing is left. `## 2. Results` is `results`; `## 2024` is `section`. A taken slug gets `-2`, `-3` silently; ids written anywhere in the note are registered first, so a slug yields to them.
- Give `{#id}` to every heading you link to or reference: a slug changes when the wording does.

```tern expect="attr.malformed"
## Kernel and image {#kernel .wide}
## Closing hashes stay ##
## Plan {#2024-plan}
#hashtag is text.
```

### Thematic breaks

- `---` alone on a line (accepted too: `***`, `___`, `- - -`, `* * *`). It is tested before list items, so `- - -` is a rule.
- It takes no trailing group: `--- {.thin}` is a paragraph. Put `{.thin}` on the line before, or write `::hr{.thin}`.
- Under a line of text, `---` is a rule, never a setext heading.
- **No front matter.** A note whose first block is `---`, `key: value` lines and `---` renders as a rule, a paragraph and a rule, with `doc.frontmatter`. Move the lines into `:::meta`.

```tern expect="doc.frontmatter"
---
title: Linear maps
---
```

### Blockquotes

- `>` then a space, a tab or the end of the line opens a quote; `>5`, `>=` and `>>` are text (nest quotes as `> >`). One space or tab after `>` is stripped, and the rest is parsed as blocks: lists, fences, `:::` blocks and quotes nest.
- A continuing line needs only `>`. Lazy paragraph lines continue it too. A bare `>` line is a blank line inside the quote. A blank line ends the quote, so two quotes separated by a blank line stay two.
- A line that would interrupt a paragraph, such as `---` or a heading, ends the quote.
- A `:::` closer inside a quote sees only the blocks opened inside the quote; otherwise it is `block.stray-closer`.

```tern
> A quote,
lazily continued.
>
> - a list inside
>
> > a nested quote
```

### Lists and tasks

- **Markers:** `-`, `*`, `+`; or 1 to 9 digits and `.` or `)`. A space, a tab or the end of the line must follow: `-no` is text.
- **Content column** = indentation + marker width + the spaces after it: `- a` is 2, `1. a` is 3, `10. a` is 4. With 5 or more spaces after the marker, or a marker alone on its line, it is indentation + marker width + 1.
- **A line belongs to the item** when it is indented to the content column, when it is blank and the next non-blank line is indented that far, or as a lazy paragraph continuation. Deeper indentation means nothing.
- **Nesting:** indent nested lists, fences, tables, quotes and `:::` blocks to the parent's content column. Under `1.` that is 3 spaces: `1. a` then `  - b` (2 spaces) ends the ordered list and starts a bullet list.
- **One list or two:** the same bullet character, or the same delimiter (`.` or `)`), continues a list; another starts a new one. An attribute line between items starts a new list that takes the attributes.
- **Loose lists:** a blank line between items, or directly inside one, wraps the items' text in `<p>`.
- **Numbers:** a list starting at n gets `start="n"`; later numbers are ignored; `007.` is 7.
- **Interrupting:** only a non-empty bullet or an item numbered 1 interrupts a paragraph. A wrapped line `1945. was a year` stays prose, but after a blank line it is a list item: write `1945\.`. A wrapped line starting `- ` or `+ ` is a bullet: write `\-` or `\+`.
- **Tasks:** an item that starts with `[ ]`, `[x]` or `[X]` and then a space or the end of the line is a task, `li.t-task` with a disabled checkbox. `[x]Done` and `[-]` are text. Ordered items can be tasks.
- A `:::` closer inside an item must be indented to the content column; at a lower column it ends the item.

````tern
1. Install:
   ```sh
   npm install
   ```
   - nested, indented three spaces
2. Run it.

- [x] done
- [ ] to do
````

```tern expect="block.unclosed block.stray-closer"
- an item
  :::aside
  inside the item
:::
```

### Fences

- **Opener:** 3 or more backticks (or tildes), then the info: a language, a `[Title]` and a `{group}`, each optional, in that order, spaces allowed between. The language is verbatim (`c++` gives `language-c++`). Leading whitespace before the fence sets the dedent.
- In a backtick fence the info may not contain a backtick; such a line is a paragraph, usually a code span. A tilde fence's info may, so its title can hold a code span.
- **Junk** in the info (parts out of order, an unclosed `[`, a group that does not parse) gets `fence.info-junk`; the fence still opens and the junk is kept in `data-meta`. Once junk starts, the rest of the info is junk.
- **Closer:** a line with at least as many of the same character and nothing else, at any indentation. A shorter run, or a run with text after it, is content. A tilde fence closes only with tildes.
- **Fences in fences:** make the outer fence longer (four backticks around three), or use tildes outside.
- **Content** is verbatim: no escapes, and nothing is Tern (`:::`, `$$`, `#` and blank lines are code). Each line loses up to the opener's indentation.
- **Line keys**, reserved and never emitted: `lines` numbers the lines; `hl=2,4-6` highlights lines, counted as displayed; `start=10` starts the numbering at 10. Other keys and classes go on `<pre>`.
- **A titled fence is a listing:** a `figure.t-block.code` holding the `<pre>` and a `<figcaption>`; author attributes go on the figure, line keys on `<pre>`. It is numbered ("Listing 1") only when the vocabulary declares `code`. An empty title, ```` ```js[] ````, makes a plain fence.
- **Unclosed:** a fence runs to the end of the quote, item or footnote that holds it, or of the note, through `:::` closers: `block.unclosed-fence`, plus `block.unclosed` for each container it swallowed.
- Every fence carries `data-t="code"`; highlighting and diagrams (a `mermaid` fence) come from add-ons ([vocabulary.md](vocabulary.md)).

`````tern
```python[Take n items]{#lst-take lines hl=2 start=10}
def take(it, n):
    return [x for _, x in zip(range(n), it)]
```

````text
```js
an inner fence, shown as code
```
````
`````

Docs: [fenced code](https://ozkrac.github.io/tern/docs/syntax-blocks.html#fence).

### The `=html` fence

- A fence whose info is exactly `=html` (lower case) emits its body as raw HTML, with no `<pre>`. Use it for HTML that starts with phrasing content, has omitted or unbalanced tags, or does not fit the raw-block rules below. It ends like a fence, so the next line is Tern again.
- A title or a group on it is `fence.info-junk`, dropped; an attribute line before it stays text (`attributes.raw`). Unclosed, it runs to the end (`block.unclosed-fence`) and is still raw.
- Any other `=word`, `=HTML` included, is an ordinary code fence with the class `language-word`.

### Raw HTML blocks

A line starting with `<` starts a raw block when it is one of four kinds. The content is never Tern and is emitted as written.

| Kind | First line | Ends |
|---|---|---|
| comment | `<!--` | at the first line containing `-->`, all of that line included |
| raw text | `<script`, `<style`, `<pre`, `<textarea` | at the first line containing the matching end tag |
| one line | an end tag, a void tag (`<hr>`, `<link>`), a self-closed tag, or `<p>` `<li>` `<dd>` `<dt>` `<tr>` `<td>` `<th>` `<thead>` `<tbody>` `<tfoot>` | on the same line |
| generic | a block-level or custom element | on the line where the openings and closings of that name balance |

- **Block-level names:** `address article aside audio blockquote canvas details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr iframe link math menu nav noscript object ol picture search section summary svg table template ul video`. A custom element is lower case, starts with a letter and holds a hyphen: `<tide-clock>`.
- **Phrasing tags** (`<b>`, `<span>`, `<a>`, `<img>`, `<input>`, `<kbd>`) start a paragraph and pass through inline; `<3` and `< 5` are text.
- **Tern inside raw HTML is not parsed.** In a generic block, the first inner line that does not start with `<` and either follows a blank line or holds Tern marks (`*`, a backtick, `$`, `[`, `:::`, or a heading, list, `>` or `|` start) gets `html.wrapper`. Write a container instead: `:::div{.box}`, `:::details[Summary]`, `:::section`.
- `<p>`, a line of Tern, `</p>` on three lines give a raw `<p>`, a Tern paragraph and a stray `</p>` (`html.stray-closer`).
- **Unclosed:** a generic block is cut before the next `:::` opener or closer line (`html.unclosed`). An unclosed comment or raw-text block runs to the end of its parent or of the note, and is shown as escaped source in `pre.t-error`, never as HTML (`html.unclosed`).
- An attribute line before a raw block stays text (`attributes.raw`): put the attributes in the tag.
- `\<` at the start of the line makes it a paragraph.

```tern expect="html.wrapper"
<div class="box">
Some **bold** text
</div>
```

```tern
:::div{.box}
Some **bold** text
:::

<form id="guess">
  <label>Guess <input name="n"></label>
  <button>Check</button>
</form>
```

Docs: [raw HTML blocks](https://ozkrac.github.io/tern/docs/syntax-blocks.html#raw-html).

### Display math

- **Forms:** `$$` alone, TeX lines, then a line holding the closing `$$`; or `$$ TeX $$` on one line; or `$$ TeX` with the TeX continuing below. Text after the closing `$$` of a one-line form (`$$ x $$ is…`) makes the line a paragraph, with `math.inline-display`.
- **Closer:** the first later line containing an unescaped `$$`, at any indentation; text before it is the last TeX line. After it comes nothing, or one group (strong or weak). Anything else is `math.closer-tail` and becomes a paragraph after the equation.
- **Attributes go after the closing `$$`.** On the opening line, a group starting with `#` or `.` is `math.opener-tail`: it stays in the TeX and the equation gets no id.
- **No blank lines inside.** A blank line, a heading, a fence, a `:::` line, a `+++` line, or the end of the parent or the note ends the equation as `math.unclosed`, shown as its source, marked as an error; that line is then read normally. Lines shaped like lists, quotes, table rows, tags or `{…}` are TeX.
- **Content** is verbatim TeX, dedented like a fence; nothing in it is Tern. Use TeX environments such as `aligned` inside `$$`.
- **Numbering:** an equation with an id (after the closer, or from an attribute line before the opener) is numbered `(n)` on the counter `equation`, with or without a vocabulary; `@id` reads "(1)". A class alone does not number it.
- `\$$` at the start of a line is text. `$$` inside a line is never math (`math.inline-display`): write `$\displaystyle …$`.

```tern
$$
\begin{aligned}
a &= b + c \\
  &= d
\end{aligned}
$$ {#eq-chain}

$$ e^{i\pi} + 1 = 0 $$ {#eq-euler}

By @eq-chain and @eq-euler.
```

```tern expect="math.opener-tail"
$$ {#eq-wrong}
x^2
$$
```

```tern expect="math.unclosed"
$$
a^2 + b^2

## The heading survives
```

Docs: [display math](https://ozkrac.github.io/tern/docs/syntax-blocks.html#display-math).

### Tables

- **Start:** a line starting with `|` whose next line is a delimiter row (the header form, which interrupts a paragraph), or a delimiter row at a block start (a headerless table). Every row starts with `|`: a Markdown table without leading pipes is a paragraph (`table.stray-delimiter`).
- **Delimiter row:** cells of dashes, `---` (no alignment), `:--` (left), `--:` (right), `:-:` (center), separated by `|`, spaces allowed, trailing `|` optional.
- **Rows:** each following line starting with `|`, at any indentation. A blank line or any other line ends the table.
- **Cells** split at each unescaped `|` outside code spans, math, verbatim math, autolinks and raw inline tags; a trailing `|` adds no cell. Everywhere else, inside links, emphasis and `:kbd[…]` too, write `\|`. `$|x|$`, `` `a|b` `` and `| Price ($) |` need nothing. A lone backtick pairs with a later one in the row and swallows the pipes between them.
- **Continuation:** a row ending in a single unescaped `\` (outside atoms) continues on the next line, after a hard break, whatever that line starts with. `\\` does not continue. When the next line cannot join (a blank line, a closer, `+++`), the row gets `table.row-unterminated`. The header row cannot continue (`table.stray-delimiter`).
- **Columns:** the header fixes the count. Missing cells are empty; extra cells are kept, with `table.extra-cell`. A delimiter row inside the body is a text row, with `table.misplaced-separator`.
- **Attributes** come from an attribute line before the table; a `{…}` line after it belongs to the next block.
- **Caption and number:** wrap the table in `:::table[Caption]{#tbl-id}`. When the body is exactly one pipe table, the two merge into one `<table>` with a `<caption>`, the container's id and keys winning. Any other body is a `div`, with `table.body`. "Table 1" labels need the vocabulary.

```tern
{.wide}
| Phase | Weeks | Note |
|:--|--:|---|
| P2 | 2 | `a|b` and $|x|$ need no escape; a \| b does |
| P3 | 3 | a long cell,\
  continued on the next line |

:::table[Phases]{#tbl-phases}
| Phase | Exit |
|---|---|
| P0 | every rule has a case |
:::

|---|--:|
| apples, in a headerless table | 3 |

See @tbl-phases.
```

```tern expect="table.stray-delimiter"
Key | Action
---|---
w | next word
```

Docs: [tables](https://ozkrac.github.io/tern/docs/syntax-blocks.html#tables).

### Containers

- **Opener:** 3 or more colons glued to a NAME, then an optional `[Title]` and an optional group, in that order, spaces allowed between them, nothing after. The colon count is cosmetic. An opener interrupts a paragraph, and a prose line that starts with `:::word` always opens a block: write `\:::`.
- **Title:** inline content on one line. Brackets nest, `\]` is a literal bracket, and code and math spans are atoms, so `[See $f[x]$]` works. `[]` is no title. Where the title goes depends on the element ([title slots](#what-a-name-becomes)).
- **Body:** any blocks, indented freely. An attribute line before the opener merges into it.

| Line | Result |
|---|---|
| `:::aside Danger` | opens; `Danger` is shown as junk: `block.opener-junk` (a title goes in brackets) |
| `:::aside[T] #id .big` | opens; junk: `block.opener-junk` (attributes go in braces) |
| `:::aside[T` or `:::aside{#a!}` | opens; junk from the `[` or the `{`: `block.opener-junk` |
| `::: aside` | paragraph text, `block.spaced-name`; its closer is then stray |
| `:::{.x}`, `:::123`, `:::_x`, `:::/box extra` | paragraph text, `block.bad-opener` |
| `:::end` | acts as a bare closer, `name.reserved` |

### Closers

- `:::` (any count of 3 or more) closes the innermost open container. A count that differs from the opener's gets `block.closer-count` (info), and still closes the innermost one.
- `:::/NAME` closes the nearest open container with exactly that name, and every container still open inside it (each gets `block.unclosed`). With no such container open it is `block.closer-mismatch`: the line is text and nothing closes.
- A closer with nothing open is `block.stray-closer`. Inside a quote, item or footnote, a closer sees only the containers opened inside it.
- At the end of the note, every container still open gets `block.unclosed` at its opener.
- Use `:::/name` for long or nested blocks: a forgotten inner closer is then reported at the inner block, and the outer block still ends where you meant.

```tern
:::section
:::details[Show the answer]{open}
The answer is 42.
:::
Back in the section.
:::/section
```

```tern expect="block.unclosed"
:::section
:::aside
The aside is never closed.
:::/section
```

```tern expect="block.closer-count"
::::section
:::aside
The next line closes the aside, not the section.
::::
::::
```

Docs: [containers](https://ozkrac.github.io/tern/docs/syntax-blocks.html#container), [closers](https://ozkrac.github.io/tern/docs/syntax-blocks.html#closer).

### Cells and grids

- A `+++` line (3 or more `+`, optionally one group, glued or spaced) at the innermost container's own level starts a new cell, `div.t-cell`, and closes whatever was open inside the container. A `+++` as the body's first non-blank line opens the first cell, so it can carry attributes; a trailing `+++` adds an empty cell. The title stays first, before the cells.
- The container gets the class `t-cols` and a grid: one column per cell; `cols=N`, N equal columns; or `cols="2 1"`, relative widths, where an entry that is not a number, such as `12rem`, is used as written. `cols=0` or a negative number is `attr.malformed`. `cols` without `+++` makes each direct child a grid item.
- A `+++` outside any container, or inside a list item or a quote, is text with `cell.orphan`. `+++ text` and `++` are plain text. An attribute line before `+++` is an orphan: put the group on the `+++` line.

```tern
:::row{cols="2 1"}
+++ {.lead}
Left, twice as wide.
+++ {.muted}
Right.
:::
```

### Leaves

- `::NAME[content]{group}` alone on a line, filling it. The content is inline, on one line, with the title rules; content and group are optional, spaces allowed between.
- Media and void elements are leaf names, so they need no raw HTML: `::video{src=a.mp4 controls}`, `::img{src=a.png alt="…"}`, `::iframe{src=… title="…"}`, `::hr{.thin}`, `::p[…]{.lead}`. Content on a void element (`::hr[x]`) is emitted after it in a paragraph, with `leaf.void-content`.
- A `::name` line with text after the leaf is a paragraph line (`leaf.demoted`, info); `:: name` is `block.spaced-name`; a broken trailing group makes the line a paragraph, with `attr.malformed`. `::` alone is text.
- An attribute line before a leaf merges into it. `::toc` is filled with the headings only when the vocabulary declares it ([vocabulary.md](vocabulary.md)); otherwise it is an empty `div.toc`.

```tern expect="leaf.demoted"
::video{src=tide.mp4 controls width=640}
::tide-clock{station=leith}
::before and ::after are CSS pseudo-elements.
```

### Raw bodies: `{raw}`, `:::macros`, `:::meta`

A raw body is one verbatim text node in which nothing is Tern. It ends only at a bare `:::` (any count) or at `:::/` and its own name. Every other line, openers and closers included, is content, so an opener inside does not nest and the first bare `:::` ends the block.

- **`{raw}` on any container** keeps the body as text, escaped inside the element, for a script or an add-on to read (diagrams, data). The title, id, classes and keys stay.
- **`:::macros`** holds TeX definitions, one per line: `\gdef\R{\mathbb{R}}`. Every macros block is read before any formula is typeset, so its macros work in every formula of the note, wherever the block stands; it may sit inside other blocks. It renders as a hidden `div.t-macros`. TeX a math add-on cannot parse stays as its TeX source, marked `t-error`, with the reason in the browser console; `tern build --math` reports it as a `math.error` warning.
- **`:::meta`** sets the page's metadata with `key: value` lines, and renders nothing.
  - A key starts with an ASCII letter, continues with letters, digits, `_ . : -`, and does not end in `:`. The separator is the first colon followed by a space, so `title: Maps: a survey` works. A line without it, an indented line or a bad key is `meta.malformed`. Blank lines are ignored.
  - A value is plain text, right-trimmed; nothing in it is Tern.
  - `title` sets `<title>`; `lang` and `dir` set `<html lang>` and `<html dir>` (`lang` also picks the language of labels); every other key becomes `<meta name="key" content="value">`: `author`, `date`, `description`, `keywords`, `viewport`, `color-scheme` … Keys are case-sensitive. Open Graph tags need `property=`: put them in the head.
  - Only top-level blocks count; anywhere else it is `meta.nested`. Several blocks merge; a repeated key is `meta.duplicate` (the first wins). A key the head sets to a different value is `meta.conflict` (the head wins).
  - An id, class or key on `:::meta` applies to nothing: `attr.malformed`.
  - With no title anywhere, the page title is the text of the first `#` heading.
- **`:::script`, `:::style` and `:::html`** are reserved: the body is shown as text in `pre.t-error` and never runs (`name.reserved`). Write a raw `<script>` … `</script>` block or an `=html` fence.

```tern
:::meta
title: Linear maps: kernel and image
lang: en
author: O. Carrera
:::

:::macros
\gdef\R{\mathbb{R}}
\gdef\norm#1{\lVert #1 \rVert}
:::

For $x \in \R^n$, $\norm{x} \ge 0$.

:::mermaid[Flow]{raw #flow}
graph TD
  A --> B
:::
```

Docs: [raw bodies](https://ozkrac.github.io/tern/docs/syntax-blocks.html#raw-body), [metadata](https://ozkrac.github.io/tern/docs/elements.html#metadata).

### Footnote definitions

- `[^LABEL]:` then a space or the end of the line, at a block start, anywhere in the note (inside containers and quotes too). A LABEL is letters, marks, digits, `_` and `-`, with no spaces; labels match case-insensitively.
- **Content** is block-level: the rest of the first line, then lines indented 2 or more columns (2 are stripped). A blank line followed by an indented line continues it, and so do lazy paragraph lines. An unindented line that is not lazy ends it.
- Definitions are collected at the end of the note, numbered in order of first reference, each with a back link. An unreferenced one is `footnote.unused` and listed last. A second definition of a label is `footnote.duplicate`, dropped. A reference inside a definition is `footnote.nested`, left as text.
- A definition takes no attributes: an attribute line before one is an orphan.

```tern
A claim.[^src] The same source again.[^SRC]

[^src]: The first paragraph of the footnote.

  A second paragraph, indented two spaces.
  - and a list
```

### Attribute lines

- One or more **strong** groups alone on a line attach to the block that starts on the next line, in the same container. Consecutive attribute lines merge.
- Targets: a paragraph, heading, list, table, quote or rule (its element); a fence (`<pre>`, or a listing's `<figure>`); display math (`div.t-eq`; an `#id` numbers it); a container or a leaf (merged: the line's classes come first, the opener's own id and keys win); a paragraph holding only an image (an `#id` makes it a figure).
- With nothing to attach to (a blank line, a closer, `+++`, a footnote definition or the end of the note next), the line is text, with `attributes.orphan`. Before a raw HTML block or an `=html` fence it is text, with `attributes.raw`.
- A weak or unparsable group (`{x}`, `{1, 2}`) is paragraph text, silently; a broken line starting `{#` or `{.` gets `attr.malformed`.
- Between list items it ends the list, and the next item starts a new list with the attributes.

```tern expect="attributes.orphan"
{.lead}
An introduction in a larger font.

{#steps .compact} {lang=en}
- one
- two

{.note}

A blank line came between, so the line above is an orphan.
```

## Inline

Inline content is the text of paragraphs, headings, titles, leaf and element content, and table cells. Docs: [Syntax: inline](https://ozkrac.github.io/tern/docs/syntax-inline.html#top), [figures](https://ozkrac.github.io/tern/docs/elements.html#figures).

### Reading order

Left to right, Tern first reads **atoms**: escapes, code spans, math and verbatim math, `<…>` (autolinks, comments, raw tags), entities, bare URLs, `@` references and `[^x]` footnote references. Nothing inside an atom is seen by another rule: no emphasis, brackets, references or table pipes. Then brackets (`[`, `![`, `:name[`) pair with `]`, and runs of `*`, `~~` and `==` pair. So:

- The first atom wins: in `` `a$` and b$ `` the code holds the dollar; in `` $a `b$ `` the math holds the backtick.
- A backtick inside link text, a destination or an attribute value pairs with a later backtick and breaks the construct. Write `` \` ``, or `%60` in a URL, or `&#96;` in a quoted value.
- Emphasis never crosses a link's or an element's brackets.
- Links cannot contain links: the inner one wins and the outer brackets are text. Spans, images and inline elements may hold links.

### Escapes

- `\` before any ASCII punctuation character, `` !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~ ``, is that character, and cannot start or end anything. Before anything else (a letter, a digit, a space, a non-ASCII character) it is a literal backslash.
- There are no escapes in code spans, fences, raw HTML, raw bodies or attribute values; in math the backslash is TeX's. Link destinations and titles do take escapes.
- `\(…\)` and `\[…\]` are escaped parentheses and brackets, not math (`latex.delimiters`, once per note; also for `\begin{` at the start of a line). Write `$…$` and a `$$` block.

### Emphasis, strong, strikethrough, highlight

| Write | Get |
|---|---|
| `*em*` | `<em>` |
| `**strong**` | `<strong>` |
| `***both***` | `<em><strong>` |
| `~~gone~~` | `<del>` |
| `==key==` | `<mark>` |

- Underscores are never emphasis: `snake_case`, `__init__` and `_x_` stay text.
- `*` runs follow CommonMark: a run opens when the next character is not whitespace (and, if it is punctuation, the previous one is whitespace or punctuation), and closes the other way round. `2 * 3 * 4` is text, but `2*3*4` is `2<em>3</em>4`: write `2\*3\*4` or math. Leftover stars are text.
- `~~` and `==` are runs of exactly two, flanking as `*` does, and not glued on the outside to an ASCII letter or digit: `a==b`, `x == y`, `x~~y~~z`, `~x~` and `===` are text.
- Emphasis crosses soft line breaks, never a blank line.
- A strong group glued to the closing run lands on the element: `**b**{.key}`.

### Code spans

- A run of n backticks opens; the span closes at the next run of exactly n. With no such run, the backticks are literal.
- A newline inside becomes a space. One leading and one trailing space are stripped when both are there and the content is not all spaces, so a span can start or end with a backtick: ``` `` `a` `` ``` shows `` `a` ``.
- The content is literal: no escapes, no entities, no syntax. To show a backtick, use a longer run: ``` ``a`b`` ```.
- A lone backtick pairs with the next single backtick in the paragraph or row, however far. For a literal backtick outside code write `` \` ``, especially inside `:kbd[…]`.
- A strong group glued after it lands on the `<code>`: `` `x`{.lang-js} ``; a weak one stays text.

### Inline math and the dollar rule

- **Opener:** a `$` not next to another `$`, followed by a non-space that is not one of `)` `]` `}` `,` `.` `;` `:`.
- **Closer:** only the next unescaped `$` is a candidate: the first dollar decides. It closes when it follows a non-space that is not an unescaped `(` `[` `{`, is not followed by a digit or a `$`, and is at most one line break from the opener. Otherwise the opener is text, and the candidate gets its own chance to open.
- Everything inside is TeX: `_`, `^`, `*`, `|` and `@` are not Tern, and entities are not decoded.
- A strong group glued after the closer lands on the formula: `$x${#e}`. Inline math is never numbered.

| Text | Result |
|---|---|
| `costs $5 and $10` | text |
| `costs $5 and $x$` | text, then the math `x` |
| `Cost ($) and revenue ($)` | text |
| `the $n$th term`, `$2^n$th` | math |
| `$5/$8`, `$5–$10` | text |
| `a $x$2 b` | text: a digit follows the closer |
| `$5 then x$` | math, with `math.suspect-price`: write `\$5` |
| `$]0,1[$` | text, with `math.bracket`: write `` $`]0,1[` `` |
| `$\alpha never closes` | text, with `math.unclosed-inline` |

- Prices need no escaping, except when a price and a formula share a sentence and pair up: escape the price, `\$5`.
- `$$` inside a line never opens anything (`math.inline-display`): put display math on its own lines, or write `$\displaystyle …$`. Two literal dollars are `\$\$`.

### Verbatim math

`` $` `` opens math that is always math: a dollar glued to a run of n backticks, closed by the next run of exactly n backticks, with no closing dollar. No price rules, no bracket clause, no line limit; it is trimmed like a code span. Use it for TeX holding a dollar or odd brackets: `` $`\$5 + \$10` ``, `` $`]0,1[` ``. With no closing run, the `$` is text. `\$` before a code span is a dollar and a code span.

```tern expect="math.suspect-price"
Prices stay text: $5, or $10 at peak hours. The $n$th term is math.
Verbatim math: $`]0,1[` and $`\$5 + \$10`. A mix that pairs wrongly: $5 then x$.
```

Docs: [inline math](https://ozkrac.github.io/tern/docs/syntax-inline.html#inline-math), [verbatim math](https://ozkrac.github.io/tern/docs/syntax-inline.html#verbatim-math).

### Links

- `[text](destination "Title"){group}`. The `(` must follow the `]` directly. The destination is `<…>` (spaces and unbalanced parentheses allowed; no `<`, `>` or line break) or a run without whitespace whose parentheses balance. The title is `"…"` or `'…'`, after whitespace; a `(…)` title fails. Whitespace, a line break included, may surround both.
- There are no reference links: `[text][label]`, `[text][]` and `[label]: url` lines are text. Write every link inline.
- Destinations take escapes and entities, and are percent-encoded (spaces, non-ASCII); an existing `%XX` stays.
- `[own text](#id)` links into the note; a fragment that names no id gets `ref.dangling`, and stays a link.
- Link text is inline content (emphasis, code, math, images, elements); an `@x` or a bare URL inside it is text.
- Any glued group lands on the `<a>`, weak ones too: `{download}`, `{target=_blank rel=noopener}`.

```tern
See [the guide](https://example.com/guide "The guide"){.btn}, [week 1](<notes/week 1.html>), [the report](r.pdf){download}, <https://example.com> and https://example.com/docs.
```

### Images and figures

- `![alt](src "Title"){group}` is an `<img>` whose `alt` is the plain text of the brackets; `alt=` replaces it. Any glued group lands on the `<img>`: `{width=50%}`.
- `![` followed by `^` is `!` and a footnote reference. `![a]{.c}`, with no destination, is `!` and a span.
- **Implicit figure:** an image alone in its paragraph, with an `#id` (on the image, or on an attribute line before it), and not inside a `figure`, becomes a `<figure>`. The bracket text is the caption (inline content, last child); the id goes to the figure, the image's other attributes stay on the `<img>`, and its `alt` is empty unless `alt=` is given, so the caption is not read twice. Without an id it stays an image. "Figure 1" labels need the vocabulary.
- For a video, several images or a map, write `:::figure[Caption]{#fig-id}` around them. A figure whose body is one image paragraph drops the `<p>`.

```tern
![Osprey over the estuary.](osprey.jpg){#fig-osprey width=320 alt="An osprey in flight"}

See @fig-osprey. Inline, ![an icon](icon.png){width=16} stays an image.

:::figure[A map of the estuary.]{#fig-map}
::iframe{src=map.svg width=320 height=180 title="Estuary map"}
:::
```

### Spans

`[words]{group}` is a `<span>` with exactly those attributes; any group works, weak ones included: `[answer]{.spoiler hidden}`. It has no name and no `data-t`, and `tag=` cannot change it (`tag.not-allowed`): use a named element such as `:kbd[…]`. A space before the brace (`[x] {.c}`) or an empty `{}` leaves plain text. A group right after the `]` that does not parse is `attr.malformed`, even `{1, 2}`; one holding a `{` is silent text.

### Inline elements

- `:NAME[content]{group}`. The `:` must not follow an ASCII letter, digit, `_`, `:` or `/`, and the NAME and `[` are glued to it. `press:kbd[S]` is text with `inline.glued`: put a space before the colon. `10:30[x]`, `:)` and `/users/:id[0]` are silent text.
- The content is inline, may span lines, and brackets nest in it; `\]` is a literal bracket. With no matching `]`, the element is text (`inline.unclosed`). A `(…)` after it is text.
- The element comes from the inline allowlist, phrasing elements only ([what a name becomes](#what-a-name-becomes)); any other name is a `span` with the name as its class, so `:aside[x]` is a `span.aside`.
- `:wbr[]` is a void element; content given to a void element is emitted after it (`leaf.void-content`).
- In a table row, write a `|` inside an element as `\|`.

```tern expect="inline.glued"
Press :kbd[Ctrl]+:kbd[S]. :abbr[HTML]{title="HyperText Markup Language"} and :ruby[漢:rt[kan]].
A subscript glued to a word needs the tag, H<sub>2</sub>O; press:kbd[S] stays text.
```

### References

- `@IDENT` is a link to the element with that id, `<a class="t-ref">`, whose text comes from the target. The `@` must not follow an ASCII letter, digit, `_`, `-`, `.`, `/` or `@`, so e-mail addresses, `@2024`, `@ noon` and `a/@b` are text, as is an `@` inside code, math and link text.
- The id runs as far as IDENT characters go: `@kernel.`, `@kernel,`, `(@kernel)` and `@kernel's` work, and trailing hyphens are given back. Before CJK text, end it with a space or `{}`: `これは@kernel{}です`.

| Target | Text, with no `ref=` |
|---|---|
| an element counted by the vocabulary | label and number: "Theorem 1" |
| an equation with an id | "(1)" |
| a heading | its content |
| a titled element that is not counted | its title |
| a labelled element, neither counted nor titled | its label: "Proof" |
| anything else | the id |

- `@id{ref=label}`, `{ref=number}`, `{ref=title}` and `{ref=full}` ("Theorem 1 (Rank–nullity)") pick a part. A part the target lacks gives the default text, silently; any other value is `attr.malformed`. A group after a space is not glued.
- A reference to no id stays text, with `ref.dangling`. For a handle, write `\@alice`.
- For your own words, link to the fragment: `[the main result](#thm-rn)`.
- A reference may come before its target. Without a vocabulary nothing is counted, so `@thm` to a titled `:::theorem` reads as its title.

```tern expect="ref.dangling"
## Kernel and image {#ki}

$$ e^{i\pi} + 1 = 0 $$ {#eq-euler}

See @ki, @ki{ref=title} and @eq-euler. Write to me@example.org, in @2024. Thanks @alice and \@bob.
```

Docs: [references](https://ozkrac.github.io/tern/docs/syntax-inline.html#reference).

### Footnote references

`[^label]` anywhere in the text, also right after `!`, refers to a `[^label]:` definition. It is an atom, a numbered `<sup class="t-fnref">`; a repeated reference shows the same number. `[^]` and `[^ x]` are text. With no definition it stays text, with `footnote.undefined`. A strong group glued after it lands on the `<sup>`. Write `\[^x]` for the literal text.

### Autolinks

- **Angle:** `<scheme:…>` with no spaces and a scheme of 2 to 32 characters, or `<user@host>`, a `mailto:` link. The text is the URL as written.
- **Bare:** `http://` or `https://`, in any case, at the start of the text or after whitespace or one of `( [ | * ~ = " ' >`. It stops at whitespace and at `< > [ ] { } | "` and a backtick; trailing `. , : ; ! ? ' * ~ = \` and an unbalanced `)` are left out. `www.example.com`, a bare `ftp://…` and `xhttps://…` are text. Write `https\://` for a literal URL.
- Both are atoms; a strong group glued after one lands on the `<a>`.

### Raw inline HTML

- Lower-case phrasing tags pass through as written, attributes and all: `a abbr audio b bdi bdo br button canvas cite code data datalist del dfn em embed i iframe img input ins kbd label mark meter object optgroup option output picture progress q rp rt ruby s samp select small source span strong sub sup time track u var video wbr`; so do custom elements (`<tide-chip>`) and comments. Text between an open and a close tag is Tern.
- An inline `<svg>`, `<math>` or `<textarea>` is taken verbatim up to its closing tag.
- Everything else is text with `<` escaped: `a < b`, `Vec<T>`, `<3`. An inline `<div>` or `<p>`, or a tag with capitals (`<B>bold</B>`, `<Span>`), gets `html.inline-escaped`.
- Close every inline tag in the same paragraph: an unclosed one is `html.inline-unclosed`, an end tag with no opener `html.stray-closer` (void tags such as `<br>`, `<img>` and `<input>` are exempt).
- `\<` is a literal `<`. `x <b and c> y` is a raw `<b>` tag: escape it.

### Entities

`&nbsp;`, `&copy;`, `&#8704;` and `&#x2203;` pass through; any other `&` is escaped, so `AT&T` and `R&D` need nothing. An entity is an atom: `&#42;` is a star, not emphasis. Code spans and math do not decode entities. `\&amp;` shows the spelling.

## Attributes

```text
ATTRS = "{" ws* ITEM ( ws+ ITEM )* ws* "}"
ITEM  = "#" IDENT | "." IDENT | KEY "=" VALUE | KEY
VALUE = '"' [^"]* '"'  |  "'" [^']* "'"  |  [^\s"'=<>`{}]+
```

| Item | Meaning |
|---|---|
| `#id` | the id (an IDENT: a letter or `_` first, no `:` or `.`) |
| `.class` | a class; several accumulate |
| `key=value` | an attribute; quote a value holding spaces or any of `` " ' = < > ` { } `` |
| `key` | a boolean attribute: `open`, `controls`, `hidden` |

- **Quotes are literal:** there are no escapes inside, so `pattern="\d+"` means what it says. For a `"` in a value use single quotes, and the other way round. An entity such as `&quot;` is kept as written.
- **Finding the group:** from `{` to the first `}` outside quotes. An unquoted `{` before it means "not a group": silent text. `{}`, or braces holding only spaces, are never a group.
- **Strong** groups hold at least one `#id`, `.class` or `key=value`; **weak** groups hold only bare keys, such as `{open}`.

| Place | Example | Takes | A group that does not parse |
|---|---|---|---|
| glued after a link, image, span, inline element or reference | `[t](u){.btn}`, `[x]{hidden}`, `@id{ref=title}` | any group | text, `attr.malformed` |
| glued after a code span, formula, `*` `**` `~~` `==` closer, autolink or footnote reference | `` `c`{.x} ``, `$x${#e}`, `**b**{.y}` | strong only | text; `attr.malformed` when it starts with `#` or `.` |
| the end of a structural line: container opener, leaf, fence opener, `$$` closer, `+++` | `:::details[More]{open}`, `$$ {#eq}`, `+++ {.muted}` | any group, glued or after spaces | as each construct says |
| the end of a heading | `## Kernel {#kernel}` | strong only, glued or after spaces | heading text; `attr.malformed` when it starts with `#` or `.` |
| alone on a line before a block | `{#intro .lead}` | strong only | paragraph text; `attr.malformed` when it starts `{#` or `{.` |

So in three places braces count only with an `#id`, a `.class` or a `key=value`: after a code span, formula or emphasis; at the end of a heading; alone on a line. "Glued" means no space before the `{`. Everywhere else a `{` is text: `the set {1, 2}`, `f{x}`, `[x] {.c}`.

**Merging (last wins).** Keys are lower-cased first. The last `#id` (or `id=`) wins; classes accumulate in order, and `class="a b"` adds two; for any other repeated key the last value wins. Between two groups for one element the same holds, with three exceptions: a container's or leaf's opener wins over its attribute line (whose classes come first), an image's id wins over the id of its attribute line, and a `:::table` wins over the table it wraps. HTML gets `id`, then `class`, then the rest in order of first appearance; a bare key is a boolean attribute.

**Reserved keys** are consumed by Tern and never emitted:

| Key | Applies to | Elsewhere |
|---|---|---|
| `tag=` | `:::name`, `::name`, `:name[…]` | `tag.not-allowed`; on a reserved or core name (`:::main`, `:::macros`) `attr.malformed` |
| `raw` | containers | `attr.malformed` |
| `cols=` | containers, leaves, inline elements (not core blocks) | `attr.malformed` |
| `ref=` | references | `attr.malformed` |
| `lines`, `hl=`, `start=` | fences | ordinary attributes |

**Reserved names:** the key `data-t` (in any case), the class `tern` and every class starting with `t-` belong to Tern's output; each is dropped, with `name.reserved`. `.Tern` is an ordinary class.

```tern expect="tag.not-allowed name.reserved attr.malformed"
{#intro .lead data-level=1}
A [link](https://example.com){target=_blank rel=noopener}, `code`{.lang-js}, $x${#ex}, **strong**{.key} and a [span]{title="Two words"}.

A [span]{tag=b}, a [chip]{.t-chip} and [x]{#k!}.
```

Docs: [attributes](https://ozkrac.github.io/tern/docs/syntax-blocks.html#attributes), [the five positions](https://ozkrac.github.io/tern/docs/syntax-blocks.html#positions).

## What a name becomes

`:::name`, `::name` and `:name[…]` each become one element. Reserved names are checked first; then the first rule that applies wins:

1. `tag=x`, when `x` is in the level's allowlist (else `tag.not-allowed`, and the next rule decides);
2. the vocabulary's `tag` for the name, when it is in the allowlist;
3. the name itself, when it is a valid custom-element name: lower case, starting with `a`–`z`, holding a hyphen, and not one of HTML's reserved names (`annotation-xml`, `color-profile`, `missing-glyph`, `font-face` and the `font-face-*` names);
4. the name itself, when it is in the level's allowlist;
5. otherwise a `div` (container, leaf) or a `span` (inline) with the name as its class.

| Level | Allowlist |
|---|---|
| container `:::` | `address article aside blockquote details dialog div dl dd dt fieldset figure footer form header hgroup li menu nav ol search section ul`, and `table` (only around one pipe table) |
| leaf `::` | the container names without `table`, plus `figcaption legend p summary` and `audio canvas embed hr iframe img object picture video` |
| inline `:` | `abbr b bdi bdo button cite code data del dfn em i ins kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr` |

- A name from another level's list falls back: `:::video` and `::span` are `div`s; `:aside[…]` and `:section[…]` are `span`s. `a`, `img` and `br` are not inline names: write a link, an image, a `\` break.
- `tag=` cannot name a custom element; make the custom element the name.
- Names are case-sensitive: `:::Section` is a `div.Section`.
- A vocabulary name (`theorem`, `note`) without a vocabulary is a plain `div.theorem`: no label, no number ([vocabulary.md](vocabulary.md)). With a strict vocabulary, a fallback name it does not declare gets `name.unknown`.

**Reserved names** never become their element: `html head body base link meta title noscript template script style main tern end` and every `t-*` name. They fall back to a `div` or `span` without the name as a class, with `name.reserved`. Special cases: `:::script`, `:::style` and `:::html` show their body as text; `:::end` is a closer; `:::meta` and `:::macros` are core blocks (`::macros` is an ordinary `div.macros`).

**Output shape.** A container is `<TAG id class="t-block NAME …" data-t="NAME" …>` holding the title slot, the body and any end mark; a leaf or an inline element is `<TAG id class="NAME …" data-t="NAME" …>` holding its label, when the vocabulary gives one, and its content. Style and script against `data-t` and the name class, never the tag.

| Container's element | The title becomes |
|---|---|
| `details` | `<summary class="t-title">`, first |
| `figure` | `<figcaption class="t-title">`, last |
| `table` | `<caption class="t-title">`, first |
| `fieldset` | `<legend class="t-title">`, first |
| any other | `<div class="t-title">`, first |

The slot follows the resolved element, so `:::box[More]{tag=details}` gets a `<summary>`. Leaves and inline elements have no title: their brackets are their content.

```tern expect="name.reserved"
:::box[More]{tag=details}
Hidden until opened.
:::

:::tide-panel{station=leith}
A custom element.
:::

:::main
Not a main element: a div, with a warning.
:::
```

Docs: [names](https://ozkrac.github.io/tern/docs/elements.html#names), [allowlists](https://ozkrac.github.io/tern/docs/elements.html#allowlists), [reserved names](https://ozkrac.github.io/tern/docs/elements.html#reserved), [title slots](https://ozkrac.github.io/tern/docs/elements.html#title-slots).

## Ids

- Every id lives in one registry: headings, containers, leaves, elements, spans, links, images, code and math spans, equations, tables and footnotes. Author ids (`#id`, `id=`, attribute lines, `$$` closers) and footnote ids are registered first, then heading slugs, which yield silently with `-2`, `-3`.
- Two author ids that collide get `id.duplicate` at both places; the first keeps the id, later elements lose it, and references go to the first. A heading that loses its id gets its slug.
- `tern-style`, `tern-color-scheme`, `tern-source` and `tern-diagnostics` belong to Tern: an author id with one of these names is dropped, with `id.duplicate`.
- Through `id=` only: an empty id or one with whitespace is dropped (`id.invalid`); one that starts with a digit or holds `:` or `.` is kept, but `@` cannot reach it (`ref.unreferenceable`).
- Footnotes get `fn-LABEL` and `fnref-LABEL` (`fnref-LABEL-2` for a repeat), so a hand-written `#fn-x` collides with footnote `x`.
- An id on `:::meta` is not registered.
- Prefer short kebab-case ids with a kind prefix, as the documentation does: `#thm-rank`, `#eq-euler`, `#fig-map`, `#tbl-phases`, `#lst-setup`.

Docs: [ids](https://ozkrac.github.io/tern/docs/elements.html#ids).

## Escapes

| To keep … as text | Write |
|---|---|
| a heading start | `\#` at the start of the line |
| a quote | `\>` |
| a list item | `\-`, `\+`, `\*`, `1\.` |
| a table row | `\|`, on the delimiter row too |
| a container, a leaf | `\:::`, `\::` |
| display math | `\$$` |
| an attribute line | `\{` |
| a raw HTML block | `\<` |
| a footnote definition | `\[^x]:` |
| a cell separator, a rule | `\+++`, `\---` |
| a fence | ```` \``` ```` |
| `*`, `~~`, `==` | `\*`, `\~`, `\=` |
| a dollar | `\$`; two: `\$\$` |
| a handle | `\@alice` |
| a link, span or footnote reference | `\[`; `\]` inside titles and content |
| an attribute group after a construct | `\{` |
| a pipe in a table row | `\|` |
| an inline element | `\:kbd[x]` |
| a backtick | `` \` `` |
| an inline tag or an angle autolink | `\<` |
| an entity | `\&` |
| an image's `!` | `\!` |
| a bare URL | `https\://` |
| a backslash | `\\` (at the end of a line: `latex.linebreak`) |

Nothing needs escaping for `_`, a `#` inside a line, `%`, a lone `~` or `^`, `<` before a space or a digit, an `&` that forms no entity, the `@` of an e-mail address, ordinary prices, or `{` in prose. Escapes do not work inside code spans, fences, raw HTML, raw bodies and attribute values; inside math, `\` is TeX's.

Docs: [escapes](https://ozkrac.github.io/tern/docs/syntax-inline.html#escapes), [residual cases](https://ozkrac.github.io/tern/docs/syntax-inline.html#residuals).
