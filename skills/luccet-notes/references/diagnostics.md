# Diagnostics

Every code Luccet reports, what triggers it, and the fix in Luccet's syntax. Load this when `luccet check`, the language server or the browser's panel reports a code. Luccet never drops what you wrote: it keeps the text visible and reports a diagnostic with a code, a severity, a message, a position and a hint. Match on the code; the hint usually spells the fix.

Each code has a section in the documentation at `diagnostics.html#` plus the code with dots turned into hyphens, such as [block.unclosed](https://luccet.dev/docs/diagnostics.html#block-unclosed). The syntax is in [syntax.md](syntax.md), vocabularies in [vocabulary.md](vocabulary.md), the commands in [tools.md](tools.md).

## Reading a diagnostic

`luccet check FILE` (or a folder) prints one line per diagnostic, the hint indented below, and a summary on stderr:

```text
notes/maps.html:3:9: error block.opener-junk: this is not part of the opener; it is shown as an error paragraph
    a title goes in brackets: `:::note[Danger]`
notes/maps.html:5:1: error math.unclosed: `$$` opened on line 4 ends at the blank line on line 6 without a closing `$$`; TeX forbids blank lines in display math
    add a line holding only `$$`
luccet check: 1 note: 2 errors, 0 warnings, 0 infos
```

- **`file:line:col`** is a file position: the line your editor shows, and a 1-based column (an emoji counts as two). Go there to fix it.
- **Line numbers inside a message** count *note lines*: line 1 is the first line after the `luccet.js` line. With the usual one-line head, file line = note line + 1 ("opened on line 4" above is file line 5); in general, add the number of lines up to and including the `luccet.js` line.
- **Codes about the head** (`addon.failed`, `addon.remote`, `head.script`, a link in the head) point at the `luccet.js` line or the head tag, column 1.
- **The hint** quotes the fix, built from your text. Two hints quote a fixed sample instead: `table.stray-delimiter` always says `| Keys | Action |`, and `ref.unreferenceable` always says `{#plan-2024}`. Adapt them.
- **Exit status.** `luccet check` exits with 1 only for a diagnostic at or above `--fail-on`, `error` by default: warnings do not fail it. `--fail-on=warning` makes them fail, `--quiet` prints only what is at or above it, and `--json` prints one array whose items have `code`, `severity`, `message`, `hint`, `position` (note lines) and `filePosition` (file lines).

| Severity | Means | What to do |
|---|---|---|
| error | Content was lost or its meaning changed: a block swallowed what follows, a formula shows as source. | Always fix. |
| warning | Probably not what the author meant; everything is still shown. | Fix. If the text is meant literally, write the escape the hint gives, so the next check is clean. |
| info | A hint: the output is likely what was meant, or a Markdown or LaTeX habit was noticed. | Fix when it points at something not meant ([Diagnostics that may stay](#diagnostics-that-may-stay)). |

### Where they appear, and who reports what

| Where | What shows | Lines |
|---|---|---|
| `luccet check`, `luccet build` (stderr) | `file:line:col: severity code: message`, hint below | file lines |
| The language server | each diagnostic in the editor, message then hint | file lines |
| The browser's panel | an aside after the note: severity, code, `line 1:9 (file line 2)`, message, hint | both |
| The browser's console | one collapsed group, `luccet: N problems` | both |

The panel shows on pages opened from `file:`, `localhost`, `127.0.0.1` or `[::1]`, and opens itself on an error; elsewhere only with `data-diagnostics` on the `luccet.js` tag, and never with `data-quiet`. When the head puts `<!doctype html>` and `<html>` on lines of their own, the panel's file line reads 2 too low; `luccet check` is exact.

| Codes | Reported by |
|---|---|
| The 62 engine codes, `block.unclosed` to `ref.unreferenceable` below | `luccet check`, the language server, `luccet build`, the browser |
| `doc.quirks`, `script.document-write`, `script.domcontentloaded` | the browser's panel only |
| `addon.failed` | the browser, `luccet check` and the language server |
| `output.limit` | the browser and `luccet build`, which emit; not `luccet check` |
| `head.script`, `addon.remote`, `link.missing`, `link.dangling` | `luccet check` and the language server only |

So a clean `luccet check` does not prove that the file starts with `<!doctype html>`, or that note scripts behave. Check those by eye, or ask the user to open the note in a browser and read the panel. It does prove that every formula translates: a formula's problems are engine codes (`tex.*`).

## Blocks

### `block.unclosed` · error

A `:::name` block has no closer before the note ends, before the quote, list item or footnote definition around it ends, or before a `:::/outer` closes a block around it. Everything after the missing closer is inside the block. The position is the opener; the message names the line where it was still open.
**Fix:** add `:::` or `:::/name` where the block ends, not at the end of the note. Inside a list item, indent the closer to the item's content column. When the hint says a fence or `<script>` inside is unclosed, close that: it swallowed the closer.

```luccet expect="block.unclosed"
:::note
A note with no closer.

This paragraph ends up inside the note.
```

### `block.closer-mismatch` · error

A named closer `:::/name` names no open block (names are case-sensitive; inside a quote or list item only blocks opened inside it count). The line becomes text, and the block meant usually gets `block.unclosed` too.
**Fix:** name the block you opened, as the hint offers, or write a bare `:::`.

```luccet expect="block.closer-mismatch block.unclosed"
:::note
A note.
:::/box
```

### `block.stray-closer` · warning

A bare `:::` line when no block is open; it becomes text. A closer inside a quote or list item sees only blocks opened inside it, so `> :::` does not close a block around the quote.
**Fix:** remove the line, or add the opener it was meant for. After `block.bad-opener` or `block.spaced-name`, fix that opener and this goes away.

```luccet expect="block.stray-closer"
A paragraph.
:::
```

### `block.closer-count` · info

A bare closer's colon count differs from the block it closes. A bare `:::` always closes the innermost block; colon counts are cosmetic, so the output may be right by luck.
**Fix:** write the named closer the hint gives (`:::/outer`), or match the counts.

```luccet expect="block.closer-count"
::::outer
:::inner
Text.
::::
::::
```

### `block.opener-junk` · error

After `:::name` comes something other than an optional `[title]`, an optional `{…}` group and the end of the line: attributes without braces, a title without brackets, an unclosed `[`, a group that does not parse, text after the group. The block opens, and the junk shows as a red paragraph inside it. An auto-wrapped opener gives this too.
**Fix:** title in brackets, attributes in braces, glued to the name, on one line: `:::note[Danger]`, `:::aside[Side]{#side .muted}`.

```luccet expect="block.opener-junk"
:::aside[Side] #side .muted
Text.
:::
```

### `block.bad-opener` · warning

A line starts with `:::` but no name follows: `:::{.x}`, `:::2col`, `:::/`, `:::/box extra`. A name starts with a letter. The line is text, and its closer usually becomes `block.stray-closer`.
**Fix:** name the block; a plain `div` is `:::div{.warning}`.

```luccet expect="block.bad-opener block.stray-closer"
:::{.warning}
An anonymous block.
:::
```

### `block.spaced-name` · warning

A space between the colons and the name, `::: note` or `:: toc`; the line is paragraph text.
**Fix:** glue the name to the colons: `:::note`, `::toc`.

```luccet expect="block.spaced-name block.stray-closer"
::: note
Body.
:::
```

## Fences and raw HTML

### `block.unclosed-fence` · error

A fence has no closing line of at least as many of the same character before its note, quote, list item or footnote definition ends. Everything to that end is code, `:::` closers and headings included, so a block around it also gets `block.unclosed`, and problems after it are hidden until it is closed.
**Fix:** add the closing fence the hint gives, as many backticks (or tildes) as the opener, or more.

````luccet expect="block.unclosed block.unclosed-fence"
:::note
```js
let x = 1;
:::
````

### `fence.info-junk` · warning

A fence's info holds more than a language, a `[Title]` and a `{…}` group, in that order: an extra word, a title after the group, an unclosed `[`, a bad group. On an `=html` fence any title or group is junk. The fence is still code; the junk is kept in `data-meta` (dropped on `=html`).
**Fix:** language, title, group, with options in braces: ```` ```python[Greeting]{lines hl=2} ````. On an `=html` fence put attributes in the HTML.

````luccet expect="fence.info-junk"
```python linenos
print("hi")
```
````

### `html.unclosed` · error

A raw HTML block never ends: `<!--` with no `-->`; `<script>`, `<style>`, `<pre>` or `<textarea>` with no end tag; a block element (`<div>`, `<form>` …) whose tags never balance. An unclosed comment or raw-text block runs to the end of its container or the note and is shown as escaped source. An unclosed generic block stops at the next `:::` line and is emitted anyway.
Also raw HTML, a block or an `=html` fence, that holds what would hide the rest of the page: a comment never closed, a tag never ended with `>` (an open quote), `<script>`, `<style>`, `<textarea>`, `<title>`, `<iframe>`, `<noscript>` … without its end tag, `<plaintext>`, or a `<template>` or `<select>` left open. It is shown as escaped source. Inline, an `<iframe>` or `<select>` never closed in its paragraph is shown as text.
**Fix:** add the end the hint gives, where the element ends.

```luccet expect="html.unclosed"
:::note
<div class="box">
Boxed text.
:::
```

### `html.stray-closer` · info

An end tag closes nothing: a line holding only `</div>` (or another block end tag), or an inline `</b>` with no `<b>` before it in the same paragraph, heading or cell. It passes through as written.
**Fix:** remove it; to wrap Luccet content, use a block, `:::div{.box}` … `:::`. A tag opened in one paragraph and closed in the next gives `html.inline-unclosed` then this: keep both in one paragraph.

```luccet expect="html.stray-closer"
Some text</b> here.
```

### `html.wrapper` · warning

Luccet written inside a raw HTML block: a line inside a `<div>`, `<section>`, `<details>` … that follows a blank line or holds Luccet syntax (`*`, a backtick, `$`, `[`, `:::`, a heading, list or quote marker, `|`). Nothing in a raw block is parsed; there is no Markdown-in-HTML.
**Fix:** replace the wrapper with a block of that name (the hint names it): classes go in braces, a `<summary>` becomes the title.

```luccet expect="html.wrapper"
<details class="box">
<summary>More</summary>

Some **bold** text.
</details>
```

```luccet
:::details[More]{.box}
Some **bold** text.
:::
```

### `html.self-closed` · error

Raw HTML writes `/>` on an element that is not void: `<video … />`, `<iframe/>`, `<div/>`, `<my-widget/>`. HTML ignores the `/`, so the element stays open and the rest of the page becomes its content (a video's hidden fallback). The block is shown as escaped source. Void elements (`<br/>`, `<img … />`) and anything inside `<svg>` or `<math>` are fine.
**Fix:** write the end tag: `<video src="talk.mp4" controls></video>`.

```luccet expect="html.self-closed"
<video src="talk.mp4" controls />
```

### `html.inline-unclosed` · warning

A paragraph, heading, cell or title opens a non-void inline tag (`<b>`, `<span>`, `<my-tag>`) and never closes it; the browser would carry it into what follows. (An `<iframe>` or `<select>` is `html.unclosed`.)
**Fix:** close it in the same paragraph, or use Luccet's spelling: `**bold**`, `[text]{.class}`.

```luccet expect="html.inline-unclosed"
Some <b>bold text.
```

### `html.inline-escaped` · info

A start tag in a sentence is shown as text: a block tag such as `<div>` or `<p>`, or an upper-case tag such as `<B>` or `<Span>`. Only lower-case phrasing tags pass through inline; `Vec<T>` and `Box<A>` stay silent.
**Fix:** lower case (`<b>`), block HTML on its own line, or Luccet's syntax. When the tag is the topic, put it in a code span: `` `<div>` ``.

```luccet expect="html.inline-escaped html.inline-escaped"
Make it <B>bold</B>. Put <div> here.
```

## Math

Display math (`$$` lines), inline `$…$` and verbatim `` $`…` ``: Luccet's delimiters. For the TeX inside a formula, see the `tex.*` codes below.

### `math.unclosed` · error

A multi-line `$$` block meets a blank line, a heading, a fence, a `:::` line, a `+++` line or the end of its container before its closing `$$`. It is shown as red source; the line that ended it is read normally.
**Fix:** add a line holding only `$$`, and remove blank lines inside display math (TeX forbids them).

```luccet expect="math.unclosed"
$$
a^2 + b^2 = c^2

## Next section
```

### `math.opener-tail` · error

A group such as `{#eq}` on the opening `$$` line is TeX, not attributes: the equation gets no id or number, and the `#` in it is not TeX either (`tex.misplaced`), so the formula stays as its TeX source marked `t-error`.
**Fix:** move the group after the closing `$$`.

```luccet expect="math.opener-tail tex.misplaced"
$$ {#eq-pythagoras}
a^2 + b^2 = c^2
$$
```

### `math.closer-tail` · warning

Text after the closing `$$`, other than one attribute group. The text starts a paragraph; a group followed by text is junk as a whole, and the equation loses its id.
**Fix:** only `{#id}` may follow the closing `$$`; start the text on a line of its own.

```luccet expect="math.closer-tail"
$$
E = mc^2
$$ where m is the mass.
```

### `math.inline-display` · warning

`$$` inside a line, reported once per `$$`. It is text: display math goes on its own lines.
**Fix:** inline math takes one dollar (`$\displaystyle …$` for display style), or put the formula between `$$` lines.

```luccet expect="math.inline-display math.inline-display"
The energy $$E = mc^2$$ is famous.
```

### `math.unclosed-inline` · warning

A `$` followed by a backslash never closes, or its only candidate closer is rejected (say, a `$` right after `{`). It stays text. A `$` before a digit, a price, is silent.
**Fix:** close the formula with `$`, or write `\$` for a dollar sign.

```luccet expect="math.unclosed-inline"
The $\alpha never closes.
```

### `math.bracket` · warning

A span between dollars is not math because a `]` follows the opening `$` or a `[` precedes the closing one: an interval such as `]0,1[`.
**Fix:** verbatim math, which is always math: `` $`]0,1[` `` (the hint spells it with your interval).

```luccet expect="math.bracket"
The interval $]0,1[$ is open.
```

### `math.suspect-price` · warning

A formula starts with a digit and holds a word of three or more letters outside a TeX command's argument: a price found a later `$` and became math. `$5 \text{ per item}$` is fine.
**Fix:** escape the price: `\$5`.

```luccet expect="math.suspect-price"
Costs $5 then x$ more.
```

## Inside a formula

Luccet turns each formula's TeX into MathML itself. A formula whose TeX does not translate is shown as its TeX, marked `t-error`, with one of these codes at the command at fault: the first problem in it. All are errors.

### `tex.unknown` · error

A command Luccet does not know, usually a typo; the hint names the nearest known command.
**Fix:** correct the spelling, or define the command in a `:::macros` block.

```luccet expect="tex.unknown"
The angle is $\thetha$.
```

### `tex.unsupported` · error

A LaTeX command Luccet leaves out: `\label`, `\ref`, `\eqref`, `\tag` (Luccet numbers equations itself), `\href`, `\url`, `\includegraphics`, `\html…` (a formula writes no link, image or attribute), `\ce` (chemistry), the numbered environments `align`, `equation`, `gather`, `multline`, and a few rare commands.
**Fix:** follow the hint: an id after the closing `$$` numbers an equation and `@id` refers to it; `aligned` or `gathered` inside `$$` (or `align*`) for lines.

```luccet expect="tex.unsupported"
$$
E = mc^2 \tag{1}
$$
```

### `tex.unbalanced` · error

A `{`, `\left` or `\begin{…}` never closed, or a `}`, `\right` or `\end{…}` with nothing to close.
**Fix:** close what is open, at the place the message names.

```luccet expect="tex.unbalanced"
Half of it is $\frac{a}{b$.
```

### `tex.argument` · error

A command missing an argument (`\frac{1}`), or with one it cannot read: a colour that is not a CSS name or hex, a length without a unit, a delimiter after `\left` that is not one, an `array` column other than `l`, `c`, `r`, `|`.
**Fix:** give every argument in braces.

```luccet expect="tex.argument"
A ratio $\frac{1}$ alone.
```

### `tex.script` · error

A second superscript or subscript on one base (`x^2^3`), or a prime after a superscript.
**Fix:** group them: `x^{23}`, or `{x^2}^3`.

```luccet expect="tex.script"
Not $x^2^3$ but this.
```

### `tex.misplaced` · error

Something where it cannot stand: `&` or `\\` outside an environment, `#` outside a macro definition, `\middle` outside `\left…\right`, `\limits` after a non-operator, `^` in `\text{…}`, `align*` in inline math.
**Fix:** align lines inside `\begin{aligned}` … `\end{aligned}`; write a literal `&` as `\&`.

```luccet expect="tex.misplaced"
$$
a &= b
$$
```

### `tex.macro` · error

A definition that does not work: `\newcommand` for a command that exists (use `\renewcommand`), `#3` in a macro of two parameters, delimited `\def` parameters, a page macro in `window.LUCCET.macros` that is not a name and a body.
**Fix:** choose another name, or redefine on purpose with `\renewcommand`.

```luccet expect="tex.macro"
:::macros
\newcommand{\sin}{s}
:::

Then $\sin x$.
```

### `tex.limit` · error

Macros that expand without end (10,000 expansions in one formula), or groups nested more than 100 deep. The limit keeps the page from hanging.
**Fix:** give the macro a body that ends.

```luccet expect="tex.limit"
:::macros
\gdef\again{\again}
:::

Then $\again$.
```

## Attributes

### `attr.malformed` · warning

An attribute group does not parse, or a reserved key is wrong. The message says which:

- **does not parse** (after a link, image, span, inline element or reference; at the end of a heading or leaf; alone on a line): a bad character, an id starting with a digit (`{#2024}`), an unquoted value with spaces. The group stays text.
- **`cols`** is `0` or negative (write `cols=2` or `cols="2 1"`), or is on a span or other element with no grid.
- **`ref=`** is not `label`, `number`, `title` or `full`, or is not on a reference (`@id{ref=title}`).
- **`raw`** off a block; **`tag=`** on a reserved name (which also gets `name.reserved`) or on a core block such as `:::macros`.
- **an id, class or key on `:::meta`**, which emits no element: each is dropped.

On a block opener a bad group is `block.opener-junk`, on a fence `fence.info-junk`.
**Fix:** `{#id .class key=value flag}`: an id or class starts with a letter or `_` and holds letters, digits, `_` and `-`; quote values with spaces, `title="Two words"`. Remove misplaced reserved keys.

```luccet expect="attr.malformed attr.malformed"
## Results {#results!}

See [the plan]{#2024}.
```

### `attr.overridden` · warning

An element gets two ids, or one key twice, and the later one wins: `{#a}` above `:::note{#b}`, `{#a #b}` or `{#a id=b}` in one group, `{k=1 k=2}` (keys are not case-sensitive, so `{Title=a title=b}` too), or a key on an attribute line and again on its block. Reported at the one replaced, which is dropped. Classes add up and are never overridden.
**Fix:** keep the one you mean; an element has one id.

```luccet expect="attr.overridden"
{#intro}
:::note{#summary}
Short.
:::
```

### `attributes.orphan` · warning

An attribute line (groups alone on a line) with no block right after it: a blank line, a closer, a `+++` line, the end, or a footnote definition (which takes none) follows. It shows as text. An auto-wrap that moves `{#eq}` off the closing `$$` line gives this too.
**Fix:** put the line directly above its block, no blank line between; on display math, put the group on the closing `$$` line.

```luccet expect="attributes.orphan"
{.lead}

The opening paragraph.
```

### `attributes.raw` · warning

An attribute line above raw HTML or an `=html` fence; attributes do not apply to raw HTML, and the line shows as text.
**Fix:** put them in the tag: `<div class="note">`.

```luccet expect="attributes.raw"
{.note}
<div>Raw HTML.</div>
```

## Tables and cells

### `table.stray-delimiter` · warning

A paragraph line shaped like a delimiter row (`---|---`) that starts no table: usually a GitHub-style table without leading pipes, or a header row ending in a continuation `\`.
**Fix:** start every row with `|` (the hint's `| Keys | Action |` is a fixed sample: use your header). A header row cannot continue onto the next line.

```luccet expect="table.stray-delimiter"
Keys | Action
---|---
:w | write
```

```luccet
| Keys | Action |
|---|---|
| :w | write |
```

### `table.row-unterminated` · warning

A row ends with a single `\`, a continuation, but the next line cannot continue it: a blank line, the end, a closer, a `+++` line. The `\` stays in the last cell. A row ending in `\\` is a literal backslash, silently.
**Fix:** continue the row on the next line, or remove the `\`.

```luccet expect="table.row-unterminated"
| Key | Action |
|---|---|
| :w | write \
```

### `table.misplaced-separator` · warning

A second delimiter row inside a table; it shows as a row of `---` cells.
**Fix:** remove it, or end the table with a blank line and start another.

```luccet expect="table.misplaced-separator"
| Key | Action |
|---|---|
| :w | write |
|---|---|
```

### `table.extra-cell` · warning

A row has more cells than the header; the extras are kept (missing cells are added silently). Usually an unescaped `|` in a cell.
**Fix:** escape it as `\|`, or put it in a code span (`` `a | b` ``), where it needs no escape; or add a header cell.

```luccet expect="table.extra-cell"
| Expression | Meaning |
|---|---|
| a | b | a or b |
```

### `table.body` · warning

A block whose element would be `table` (`:::table`, `tag=table`, or a schema's `tag`) holds anything but exactly one pipe table; it becomes a `div`.
**Fix:** put exactly one pipe table in it (the title becomes its caption), or use another name.

```luccet expect="table.body"
:::table[Phases]
Two phases, described in prose.
:::
```

### `cell.orphan` · warning

A `+++` line outside any block, or inside a quote or list item within one: cells split only a block's own body. It is text.
**Fix:** put the cells directly in a block, with the grid on it: `:::div{cols=2}` … `+++` … `:::`.

```luccet expect="cell.orphan"
Left.
+++
Right.
```

## Leaves and inline elements

### `leaf.demoted` · warning

A line starts with `::name` but is not a leaf: text follows it, or a `[` is unclosed. A leaf broken over two lines, by hand or by an auto-wrap, gives this.
**Fix:** keep the whole leaf on one line (`::video{src=tide.mp4 controls}`), or use a block for longer content. When the line is prose, escape the colons: `\::before`.

```luccet expect="leaf.demoted"
::video{src=tide.mp4
controls}
```

### `leaf.void-content` · warning

A leaf or inline element that is a void element (`hr`, `img`, `embed`, `wbr` …) has bracket content, which is emitted after it.
**Fix:** remove the brackets (`::hr`, then a heading or paragraph), or choose an element that holds content.

```luccet expect="leaf.void-content"
::hr[Part two]
```

### `inline.unclosed` · warning

`:name[` with no matching `]` in the same paragraph, heading or cell. A lone backtick inside can pair with a later one and hide the `]`; in a table, a `|` inside splits the cell first.
**Fix:** close each element (`:kbd[Ctrl]+:kbd[S]`); write a literal `]` as `\]`, a lone backtick as `` \` ``, a pipe in a table as `\|`.

```luccet expect="inline.unclosed"
Press :kbd[Ctrl and S.
```

### `inline.glued` · warning

`:name[` right after an ASCII letter or digit, as in `press:kbd[S]`; it stays text. After `_`, `:`, `/` or a non-ASCII letter it is silent.
**Fix:** put a space before the colon.

```luccet expect="inline.glued"
Then press:kbd[S] to save.
```

## Footnotes

### `footnote.undefined` · warning

A `[^label]` with no definition; it stays text. A definition needs a space after its colon: `[^src]:text` is a paragraph holding a second reference.
**Fix:** add `[^label]: text` anywhere in the note, or write `\[^label]` for literal text.

```luccet expect="footnote.undefined"
A claim.[^src]
```

### `footnote.duplicate` · error

A label defined twice (`[^a]:` and `[^A]:` count as the same). The first wins; the later one is dropped.
**Fix:** merge the definitions, or give one another label and reference it.

```luccet expect="footnote.duplicate"
A claim.[^a]

[^a]: First.
[^A]: Second.
```

### `footnote.nested` · warning

A `[^label]` inside a footnote definition. Footnotes cannot nest: it stays text, and its definition often becomes `footnote.unused`.
**Fix:** put the text in the one footnote, or move the reference into the main text.

```luccet expect="footnote.nested footnote.unused"
A claim.[^a]

[^a]: See also[^b].
[^b]: Another source.
```

### `footnote.unused` · info

A definition no reference uses. It is still listed, after the referenced footnotes, without a back link.
**Fix:** reference it with `[^label]` where it belongs, or remove it.

```luccet expect="footnote.unused"
Text.

[^a]: Never used.
```

## LaTeX habits

### `latex.delimiters` · warning

Once per note: `\(…\)`, `\[…\]` around TeX, or `\begin{` at the start of a line. A backslash before punctuation is an escape, so `\(` renders `(`; `\begin{…}` stays text.
**Fix:** inline math is `$…$`; display math and environments such as `aligned` go between `$$` lines. A theorem environment is a block, `:::theorem` … `:::`.

```luccet expect="latex.delimiters"
Let \(x^2\) be small.
```

### `latex.linebreak` · warning

A paragraph line ends with `\\` and the paragraph continues: a literal backslash and a soft break, not a line break. Not reported in table rows.
**Fix:** a line break is a single trailing `\`.

```luccet expect="latex.linebreak"
Roses are red,\\
violets are blue.
```

## The document and metadata

### `nesting.limit` · error

An opener that would nest blocks more than 64 deep (blocks, list items, quotes and footnote definitions count) becomes text; inline, a construct (emphasis, a span, a link, an inline element) nested more than 1,000 deep is shown as its source text, once per paragraph. In practice: a long run of `>` markers, or generated content gone wrong.
**Fix:** flatten the structure.

### `output.limit` · error

The note's HTML is longer than the emitter's budget (64 million characters, or `maxOutput` where the emitter is called) and was cut short there. Reported by the browser and `luccet build`, never by `luccet check`, which does not emit. A reference copies at most 200 characters of its target and a toc entry as much of a heading, so a normal note never reaches it: it takes something huge repeated.
**Fix:** shorten what repeats.

### `doc.frontmatter` · warning

The note starts with YAML front matter: `---`, `key: value` lines, `---`. Luccet reads a rule, a paragraph and a rule.
**Fix:** move the lines into a `:::meta` block.

```luccet expect="doc.frontmatter"
---
title: Linear maps
lang: en
---
```

### `meta.conflict` · warning

A `:::meta` key that the head sets to another value: `title` by `<title>`, `lang` and `dir` by `<html lang dir>`, other keys by `<meta name="key" content="…">`. The head wins; `lang` compares case-insensitively.
**Fix:** set each key in one place: remove it from the head or from `:::meta`.

```html expect="meta.conflict"
<!doctype html><meta charset="utf-8"><title>Old title</title><script src="luccet.js"></script>

:::meta
title: New title
:::
```

### `meta.duplicate` · warning

The same key twice, in one `:::meta` block or across several (they merge). The first value wins.
**Fix:** keep one.

```luccet expect="meta.duplicate"
:::meta
title: One
title: Two
:::
```

### `meta.malformed` · error

A line in `:::meta` that is not `key: value`: no colon, no space after it, an indented line, a key not starting with a letter. The line is ignored. Keys may hold `.`, `:` and `-`: `og:title: …` is fine.
**Fix:** one `key: value` per line, unindented.

```luccet expect="meta.malformed meta.malformed"
:::meta
title Linear maps
  author: O. Carrera
:::
```

### `meta.nested` · error

A `:::meta` block inside a block, quote, list item or footnote definition; it is ignored.
**Fix:** move it to the top level, usually the top of the note.

```luccet expect="meta.nested"
:::note
:::meta
title: Linear maps
:::
:::
```

## Names and elements

How a name becomes an element; the vocabulary is in [vocabulary.md](vocabulary.md).

### `use.late` · error

A `:::use` block after any content, or inside a block, quote, list item or footnote definition; it is ignored and its add-ons are not loaded. Only `:::meta`, blank lines and other `:::use` blocks may come before it.
**Fix:** move it to the top of the note, after `:::meta` at most.

```luccet expect="use.late"
Text.

:::use
lib/callout.js
:::
```

### `name.reserved` · warning

A reserved name, key or class:

- a block, leaf or inline name `base`, `body`, `head`, `html`, `link`, `main`, `meta` (as `::meta` or `:meta[…]`), `noscript`, `script`, `style`, `template`, `title`, `luccet`, `t-…` or `end`. It falls back to a `div` or `span` without the name as class; `:::script`, `:::style` and `:::html` show their body as text, never run; `:::end` alone on its line is read as `:::`, and with text after it the line is text and the block stays open;
- `{tag=x}`, or a schema's `tag`, naming a reserved element (ignored);
- the key `data-t`, the class `luccet`, or a `t-…` class (dropped).

**Fix:** another name (`:::article` for `:::main`), class or element. A script is raw HTML, `<script>` … `</script>` on lines of their own. Close blocks with `:::` or `:::/name`.

```luccet expect="name.reserved name.reserved name.reserved"
:::main
The main content.
:::end

A [word]{.t-box}.
```

### `tag.not-allowed` · warning

`{tag=x}`, or a schema's `tag`, asks for an element the level cannot be: a phrasing element (`span`) for a block, a flow element (`div`) for an inline element, `table` for a leaf. Or `tag=` is off a named element: on a span, link, image, code span, heading or attribute line. The `tag` is ignored or dropped.
**Fix:** an element the level allows (the hint lists some), or name the element directly: `:kbd[Ctrl]`, `:::aside`. A custom element is written as the name, `:::my-widget`.

```luccet expect="tag.not-allowed"
:::aside{tag=span}
Aside text.
:::
```

### `name.unknown` · info

Only when the vocabulary sets `strict: true`: a block, leaf or inline name with no schema entry that is no HTML or custom-element name, so it falls back to a `div` or `span` with the name as class. Usually a typo (`:::theorm`) or an undeclared name; names are case-sensitive.
**Fix:** correct the spelling, or declare the name in the schema ([vocabulary.md](vocabulary.md)).

```html expect="name.unknown"
<!doctype html><meta charset="utf-8"><script>window.LUCCET = {schema: {strict: true}}</script>
<script src="luccet.js"></script>
:::theorm
A typo.
:::
```

## Ids and references

### `id.invalid` · warning

An `id=` value that is empty or holds whitespace, such as `id="final results"`. It is dropped; a heading falls back to its slug.
**Fix:** an id without spaces, best written `{#final-results}`.

```luccet expect="id.invalid"
## Results {id="final results"}
```

### `id.duplicate` · warning

Two elements have the same written id (or a footnote's `fn-…`, `fnref-…` id, or an `id=` in raw HTML); both are reported. The first keeps it and references resolve to it; the later one drops it. Raw HTML keeps its ids wherever it stands, so the note's element is the one that drops it; two raw elements both keep theirs. Luccet's own ids `luccet-style`, `luccet-color-scheme`, `luccet-source` and `luccet-diagnostics` are taken too. Heading slugs never collide (a taken slug becomes `kernel-2`).
**Fix:** give each element its own id, then check which one each `@id` meant.

```luccet expect="id.duplicate id.duplicate"
## One {#part}

## Two {#part}
```

### `ref.dangling` · warning

An `@name`, or a fragment link `[text](#name)`, whose id is nowhere in the note: a typo, a target without `{#id}`, or a handle such as `@alice`. `@name` stays text (with a group after it, in a `<span>` that carries it); a link stays a link. An e-mail address is never a reference. Also an `@name` whose id is in raw HTML, which has no label or number to show; a fragment link reaches it.
**Fix:** correct the id, or give the target `{#name}`; for a handle or a literal `@`, write `\@alice`; for raw HTML, `[text of your own](#name)`. A link to an id in another file is checked as `link.dangling`.

```luccet expect="ref.dangling ref.dangling"
Thanks to @alice. See [the proof](#proof).
```

### `ref.unreferenceable` · warning

An `id=` value that is a valid HTML id but not a Luccet identifier: it starts with a digit or holds `:` or `.` (`id=2024`, `id=a.b`). It is kept and fragment links reach it, but `@` cannot. Written `{#2024}`, it is `attr.malformed`.
**Fix:** an id that starts with a letter or `_` and holds letters, digits, `_` and `-`. The hint always says `{#plan-2024}`; adapt it.

```luccet expect="ref.unreferenceable"
[The plan]{id=2024}
```

## Browser only

The browser reports four codes while it renders, in the panel and the console; `luccet check` cannot, except `addon.failed`. All four are errors: `addon.failed`, `script.document-write`, `script.domcontentloaded` and `doc.quirks`.

### `addon.failed` · error

An add-on in `data-use` did not load (a wrong path, a missing file) or threw, or a transform it registered threw. The note renders without it, so its names get the core output: no labels, counters or behaviours. `luccet check` and the language server report it too, at the `luccet.js` line, with the reason: cannot read, does not parse as a classic script, threw.
**Fix:** correct the path in `data-use`, which resolves from the note's folder (`../lib/…` from a subfolder); for one that throws, fix its code. An `addons/…` path from Luccet 1 names a folder Luccet 2 no longer has: load that add-on from its own repository ([Add-ons](https://luccet.dev/docs/addons.html#top)).

```html expect="addon.failed"
<!doctype html><meta charset="utf-8"><script src="luccet.js" data-use="missing.js"></script>
Hello.
```

### `script.document-write` · error

A `<script>` in the note body calls `document.write` or `document.writeln`. Note scripts run after the page is parsed, so the output is dropped. A page written by `luccet build` is not affected.
**Fix:** build elements with the DOM and insert them, for example with `document.currentScript.after(element)`.

### `script.domcontentloaded` · error

A `<script>` in the note body calls `addEventListener('DOMContentLoaded', …)` on `document` or `window`. The event fired before note scripts run, so the listener never runs.
**Fix:** run the code directly (the note is already in the page), or use `luccet.on('ready', () => setup())`.

### `doc.quirks` · error

The file does not start with `<!doctype html>`, so the browser renders it in quirks mode, where the layout and some add-ons misbehave. `luccet check` does not report it (`luccet build` adds the doctype, with a warning), so check the first line yourself.
**Fix:** start the file with the canonical first line, keeping your `src` and `data-use`: `<!doctype html><meta charset="utf-8"><script src="luccet.js"></script>`.

## Command line and editor only

`luccet check` and the language server report these; the browser never does.

### `head.script` · info or warning

To learn a note's vocabulary, the tools run its head's classic scripts under node. This reports one they could not run: an **info** for a remote script, never loaded; a **warning** for a local script that cannot be read or that throws. There is no hint. The note is checked without that vocabulary; the page in the browser is not affected.
**Fix:** for the warning, correct the path or the script. For the info, nothing is wrong; to check with the vocabulary, keep it in a local file or inline in the head.

```html expect="head.script head.script"
<!doctype html><meta charset="utf-8">
<script src="https://example.com/vocab.js"></script>
<script src="vocab.js"></script>
<script src="luccet.js"></script>
Hello.
```

### `addon.remote` · info

A `data-use` entry is a remote URL (`https://…`). The tools load nothing from the network, so they check the note without the names it declares. No hint; it never fails `luccet check`.
**Fix:** nothing is wrong with the page. To check with the vocabulary, list a local copy of the add-on in `data-use`. Until then, read reports about that add-on's names with care.

```html expect="addon.remote"
<!doctype html><meta charset="utf-8"><script src="luccet.js" data-use="https://example.com/vocab.js"></script>
Hello.
```

### `link.missing` · warning or error

A relative URL in the note (a link or image, a `src` or `href` in raw HTML or the head, a `data-use` entry) names a file that does not exist, a folder with no `index.html`, or a file whose name differs only in case, which a case-sensitive host will not find. A warning, except for the note's `luccet.js`: without it the note does not render at all, so a wrong path to it is an error.
**Fix:** correct the path relative to the note's folder, in the disk's case, or add the file. To move or rename notes, use `luccet mv`, which rewrites the links ([tools.md](tools.md)).

```text
notes/index.html:4:5: warning link.missing: kernal.html does not exist
    fix the path: it resolves from the folder of this note
```

### `link.dangling` · warning

A link finds its file, but the part after `#` names nothing there: no id in another note or HTML file, no heading with that anchor in a Markdown file. `#top` always counts; fragments of other kinds of file (`paper.pdf#page=3`) are not checked. A Luccet link `[text](#id)` within the note is `ref.dangling`; a fragment in raw HTML, `<a href="#id">`, is this code.
**Fix:** correct the id after `#` (ids are case-sensitive), or give the target that id in its file, `:::theorem{#thm-rank}`. An id a script adds at run time is unknown to `luccet check`: link to one written in the source.

```text
notes/rank.html:4:4: warning link.dangling: maps.html has no element with the id thm-rank
    check the id after #: ids are case-sensitive
```

## Working through a report

### Fix from the top

Fix in file order, not by severity, and run `luccet check` again after each fix or small batch. An early problem changes how everything after it is read:

- **Something unclosed hides what follows.** An unclosed fence, `<!--`, `<script>` or `<style>` swallows the rest of its block or of the note, so later problems are not reported until it is closed. Here `block.opener-junk` and `block.unclosed` appear only once `-->` closes the comment:

```luccet expect="html.unclosed"
<!-- draft

:::note Danger
Mind the gap.
```

- **A missing closer shifts the others.** The report lands on the block left open at the end, which may not be the one that lost its closer. Here the `:::` meant for the section closed the aside, and the section is reported; the fix is a `:::` after "Inner.":

```luccet expect="block.unclosed"
:::section
:::aside
Inner.
Back in the section.
:::
```

- **Some reports come in pairs; fix the first and the second goes:** `block.bad-opener` or `block.spaced-name`, then `block.stray-closer`; `block.closer-mismatch`, then `block.unclosed`; `block.unclosed-fence` or `html.unclosed` inside a block, then that block's `block.unclosed`; `html.inline-unclosed`, then `html.stray-closer`; `footnote.nested`, then `footnote.unused`; `name.reserved` with `attr.malformed` for `tag=` on a reserved name; `id.duplicate` at both elements.
- **Fix the cause.** Put a closer where the block ends, never at the end of the note just to silence `block.unclosed`. Do not delete content to silence a report, and do not change what a sentence says.
- **Positions move** as you add or remove lines: re-run rather than reuse old line numbers.

### Diagnostics that may stay

Errors never stay. Warnings should not either: when the text is meant as written, the hint's escape (`\@alice`, `\$5`, `\|`, `\[^x]`) keeps it and silences the report. Infos may stay when they flag something meant:

| Info | May stay when |
|---|---|
| `footnote.unused` | the definition is kept on purpose; it is listed after the others. |
| `block.closer-count` | the output is right; `:::/name` would make it robust. |
| `html.stray-closer`, `html.inline-escaped` | the tag passes through or shows as text on purpose (a tag that is the topic reads better in a code span). |
| `math.inline-display`, `math.unclosed-inline`, `math.bracket` | the dollars are prose, not math (`\$` silences them). |
| `latex.delimiters`, `latex.linebreak` | the backslashes are meant literally (a code span silences them). |
| `leaf.demoted`, `inline.glued` | the colons are prose, as in CSS's `::before` (`\::before`, `word\:name[` silence them). |
| `name.unknown` | the name is meant as a plain `div` or `span` with that class. |
| `addon.remote`, `head.script` (info) | always: the page is fine; the check just lacks that vocabulary. |

Front matter is never what was meant (`doc.frontmatter`): move it to `:::meta`. Tell the user about any warning or info you leave, and why.

**What no tool reports.** Some habits render as literal text with no diagnostic, so a clean check does not catch them: `_em_` and `__strong__`, `#heading` without a space, reference-style links, `> [!NOTE]` alerts, `\ref` and `\eqref`, `</body></html>` at the end, an unknown block name without `strict`, a vocabulary name the note does not declare. [../SKILL.md](../SKILL.md) lists them; get them right while writing.
