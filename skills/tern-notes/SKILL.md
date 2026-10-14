---
name: tern-notes
description: Write, edit, check and fix Tern notes, HTML files whose first line loads tern.js and whose body is Tern markup, a Markdown-like syntax with ::: blocks, {#id .class} attributes, @references, footnotes and TeX math, rendered in place by the browser. Use when creating or changing a .html file that loads tern.js, turning Markdown or LaTeX into a Tern note, or fixing what `tern check` or the page's diagnostics panel reports.
license: MIT
---

# Tern notes

A Tern note is one `.html` file. Its first line loads `tern.js`; everything after that line is the note, written in Tern's syntax, and `tern.js` renders it in place when the browser opens the file. There is no build step. The command line (`tern check`) and the language server run the same engine on the same file.

Tern looks like Markdown but is not Markdown, and the body is not HTML. Most mistakes come from those two habits; the sections below list them.

## Recognize a note

- **A note** has a line with a plain `<script src="…tern.js"></script>` (any path to a file named `tern.js`). Everything before it is the head, ordinary HTML. Everything after it is Tern source.
- **Not a note:** the tag has `async`, `defer`, `type="module"` (tern.js cannot read the file), or `data-built`. A `data-built` page was written by `tern build`: edit its source note, not the page.
- **The vocabulary** of a note is in its head. Look for `data-use="…"` on the tern.js line and a `:::use` block at the top of the note (add-ons, themes), and a `window.TERN = {schema: …}` script before the line. Names such as `theorem` or `proof` only number and label when the vocabulary declares them.

## The first line

```html
<!doctype html><meta charset="utf-8"><script src="tern.js"></script>

# Hello

A note with *emphasis* and a formula, $e^{i\pi} + 1 = 0$.
```

- The `src` is relative to the note: `../tern.js` from a subfolder. Keep the tag plain.
- The doctype is required (quirks mode breaks math: `doc.quirks`), and so is `<meta charset="utf-8">`.
- A `<title>`, `<html lang>`, stylesheets and a `window.TERN` script go before the tern.js tag, on lines of their own if you like. Put the page's title and language in a `:::meta` block instead when you prefer to keep them in the note.
- `tern new FILE --title="…"` writes the line with the right path to the nearest `tern.js`.

## The loop

1. **Read** the note and its head: the path to `tern.js`, `data-use`, a leading `:::use` block, `window.TERN.schema`.
2. **Edit** in Tern's syntax (below).
3. **Check:** `tern check FILE` (or a folder). Fix every error and warning; each comes with a hint that spells the fix. The `file:line:col` in front is a line of the file; a line number inside a message counts from the note's first line.
4. **Repeat** until the check is clean. An info is a hint: fix it when it points at something you did not mean.

Finding the command line: `tern` is on `PATH` after `npm link` in a Tern checkout; otherwise run `node /path/to/tern/tern-cli.js check FILE`, with the checkout that holds the note's `tern.js` if there is one. It needs Node 22 or later. Without it, say so: the user can open the note in a browser, where a panel lists the same problems (on `file:` pages and `localhost`).

`tern check` cannot see the habits in the next two sections: they render without a diagnostic, as literal text. Get them right while writing.

## The body is not HTML

- **Do not escape** text for HTML. Write `a < b`, `&`, quotes and non-ASCII characters as they are; save the file as UTF-8.
- **Do not wrap** content in `<p>`, `<div>`, `<section>` or `<details>` tags, and do not add `</body></html>`. Use a `:::` block: `:::div{.box}`, `:::section`, `:::details[Summary]`. Markup inside a raw HTML block is not Tern; Tern warns (`html.wrapper`).
- **Never run Prettier** or any HTML formatter on a note, and never hard-wrap its lines. A formatter rewrites the body as if it were HTML. Wrapping breaks one-line constructs: block openers, leaves, table rows, headings with `{…}`.
- **Raw HTML is allowed** when you mean it: a block tag such as `<form>` or `<svg>` on its own line, an inline tag such as `<sub>` in text, or a ```` ```=html ```` fence. Its content is emitted as written.

## Markdown and LaTeX habits that do not work

| Habit | In Tern |
|---|---|
| `_em_`, `__strong__` | `*em*`, `**strong**`. Underscores are always text. |
| Two trailing spaces for a line break | `\` at the end of the line. |
| `\\` at the end of a line | A literal backslash (`latex.linebreak`). Use `\`. |
| `---` front matter | A `:::meta` block (`doc.frontmatter`). |
| `Title` underlined with `===` | `# Title`. |
| `[text][label]` with `[label]: url` | `[text](url)`, inline. There are no reference links. |
| Four-space indented code | A fence. Indentation changes nothing. |
| Table rows without outer pipes | Every row starts with `\|` (`table.stray-delimiter`). |
| `> [!NOTE]` alerts | A `:::note` block (a vocabulary name) or `:::aside`. |
| `#heading` without a space | `# heading`. `#tag` is text. |
| `\ref{x}`, `\eqref{x}`, "Theorem 3" typed by hand | `@x`, a reference: its text comes from the target. |
| `\label{x}` | `{#x}` on the element. |
| `\begin{theorem}` … `\end{theorem}` | `:::theorem` … `:::` (`latex.delimiters`). |
| `\cite{key}` | No citations: a footnote `[^key]` or a link. |
| `\newcommand` in the text | A `:::macros` block with `\gdef` lines. |

## The syntax at a glance

| Construct | Write |
|---|---|
| Paragraph | lines of text; a blank line ends it |
| Emphasis, strong, strike, highlight | `*em*`, `**strong**`, `~~gone~~`, `==key==` |
| Code span | `` `code` `` |
| Heading | `## Title {#id}`, one line, `#` then a space |
| Link, image | `[text](url "Title")`, `![alt](img.png){width=50%}` |
| List, task | `- item`, `1. item`, `- [x] done` |
| Quote | `> text` |
| Rule | `---` |
| Fence | ```` ```js[Title]{#id lines hl=2} ```` … ```` ``` ```` |
| Inline math | `$x^2$`, or `` $`]0,1[` `` when the TeX holds `$` or odd brackets |
| Display math | `$$` on its own line, TeX, `$$ {#eq-id}` (numbered when it has an id) |
| Table | `\| a \| b \|`, then `\|---\|--:\|`, then rows |
| Block | `:::name[Title]{#id .class key=value}` … `:::` or `:::/name` |
| Cells | `+++` lines inside a block make a grid; `{cols="2 1"}` on the block |
| Leaf | `::name[content]{attrs}` alone on a line: `::video{src=a.mp4 controls}` |
| Inline element | `:name[content]{attrs}`: `:kbd[Esc]`, `:abbr[HTML]{title="…"}` |
| Span | `[words]{.class}` |
| Attribute line | `{#id .class}` alone on the line before a paragraph, list, table or rule |
| Reference | `@id`, `@id{ref=title}` |
| Footnote | `[^a]` in the text, `[^a]: text` anywhere |
| Metadata | `:::meta` with `key: value` lines (`title`, `lang`, `description` …) |
| Macros | `:::macros` with `\gdef\R{\mathbb{R}}` lines |
| Escape | `\` before any ASCII punctuation: `\*`, `\$`, `\@`, `\#` |

```tern
:::meta
title: Linear maps
lang: en
:::

# Linear maps {#maps}

A map $T: V \to W$ is **linear** when it keeps sums and scalar multiples.[^def]

## Kernel and image {#kernel}

$$
\dim V = \dim \ker T + \dim \operatorname{im} T
$$ {#eq-rn}

By @eq-rn, see also [the start](#maps).

- [x] state the theorem
- [ ] prove it

| Map | Rank |
|---|--:|
| zero | 0 |
| identity | $n$ |

[^def]: As in any course on linear algebra.
```

## Blocks, leaves and inline elements

A name becomes an element. An HTML name becomes that element (`:::aside` is an `<aside>`, `::video` a `<video>`, `:kbd[…]` a `<kbd>`), a lower-case name with a hyphen a custom element (`::tide-chart`), and any other name a `div` or `span` with the name as its class.

```tern
:::aside[A title]{#side .muted}
Any content: paragraphs, lists, math, other blocks.
:::

:::details[Show the answer]
The answer is 42.
:::

:::section
:::aside
Inner.
:::
Back in the section.
:::/section

::iframe{src=map.svg width=320 height=180 title="Map"}

Press :kbd[Ctrl]+:kbd[S]. A [defined term]{.term}.
```

- The title goes in brackets, attributes in braces, both glued to the name: `:::aside Danger` and `:::aside[Danger] #id` are errors (`block.opener-junk`).
- `:::` closes the innermost block; `:::/name` closes that block and everything open inside it. Close every block (`block.unclosed`).
- No space after the colons (`::: aside` is text). An inline element's colon is not glued to a letter: `press :kbd[S]`, not `press:kbd[S]`.
- `{raw}` keeps a block's body as text, for a script to read.

## Attributes

`{#id .class key=value flag}`: an id, classes, attributes, and boolean attributes. Quote values with spaces: `title="Two words"`. They go right after a link, image, span, inline element, reference, code span, formula or emphasis; at the end of a block's opening line or a heading; after a closing `$$`; or alone on the line before a block.

```tern
{.lead}
An introduction with a [link](https://example.com){target=_blank} and **bold**{.key} text.

## Results {#results .wide}
```

On a display formula the braces go after the closing `$$`; on the opening line they are TeX (`math.opener-tail`).

## Math

TeX between dollars. The engine leaves each formula as its TeX source and renders nothing; load a math add-on in `:::use` or `data-use` to typeset it — `addons/katex.js` (KaTeX) or `addons/mathml.js` (native MathML). Inside math everything is TeX; outside it, a backslash before a letter is just a backslash.

```tern
Inline $\sum_{i=1}^n x_i$, a price of $5 left alone, and $`]0,1[` verbatim.

$$
a^2 + b^2 = c^2
$$ {#eq-pythagoras}

:::macros
\gdef\R{\mathbb{R}}
:::

For $x \in \R$, @eq-pythagoras holds.
```

- A `$` pair is math only when it looks like math: the opener followed by a non-space, the closer after a non-space and not before a digit. Prices need no escaping; escape one with `\$` when it shares a sentence with a formula (`math.suspect-price`).
- Display math: `$$` lines, no blank line inside (`math.unclosed`). An id after the closing `$$` numbers the equation; `@id` reads "(1)".
- Without a math add-on, formulas show as their TeX source (like a code fence with no `addons/code.js`). Load one to typeset them; for offline use point it at a local copy: `addons/katex.js?base=vendor/katex`.
- `addons/search.js` gives a `::search` leaf: a box that searches the notes the page links to (`::search{from=index.html}` for another page's links), indexed in the browser, each hit linking to its heading or block. Load the notes' vocabulary add-on on that page too. `tern search QUERY [PATH…]` is the same search on files, printing `FILE:LINE:` and the entry's label; use it to find where a topic is treated before editing.

## Ids and references

- Every heading gets an id made from its text; give `{#id}` to anything you link to, so the id survives rewording.
- `@id` is a link whose text comes from the target: a heading's text, "Theorem 1" for a numbered element, "(1)" for an equation, else a title. `@id{ref=title}` (or `label`, `number`, `full`) picks the part. `[own text](#id)` links with your own words.
- `@name` with no such id stays text, with a warning (`ref.dangling`). Write a handle as `\@alice`; an e-mail address needs nothing.
- Ids are unique (`id.duplicate`).

## Vocabulary

Tern's core knows HTML's names and nothing else. Theorems, proofs, numbered figures and callouts come from a vocabulary, declared in the head or by an add-on. Without one, `:::theorem` is a plain `div.theorem` with no label or number.

```html
<!doctype html><meta charset="utf-8">
<script>
window.TERN = {schema: {block: {
  theorem: {tag: 'section', counter: 'theorem', label: 'Theorem'},
  proof: {tag: 'section', label: 'Proof', end: '∎'},
}}};
</script>
<script src="tern.js"></script>

:::theorem[Rank–nullity]{#thm-rn}
$\dim V = \dim \ker T + \dim \operatorname{im} T$.
:::

:::proof
Extend a basis of the kernel.
:::

By @thm-rn, …
```

Use the names the note's vocabulary declares. To number a new kind of element, add it to the schema (or the add-on) rather than numbering by hand. [references/vocabulary.md](references/vocabulary.md) has the fields, add-ons, themes and behaviours.

## Common diagnostics

| Code | Fix |
|---|---|
| `block.unclosed` | Add `:::` or `:::/name` where the block ends. |
| `block.opener-junk` | Title in brackets, attributes in braces: `:::aside[Title]{#id}`. |
| `block.unclosed-fence` | Close the fence with a line of at least as many backticks as opened it. |
| `math.unclosed` | Add the closing `$$` line; no blank line inside display math. |
| `ref.dangling` | Fix the id, give the target `{#id}`, or escape a handle as `\@name`. |
| `id.duplicate` | Give one of the two elements another id. |
| `footnote.undefined` | Add `[^label]: text`, or escape `\[^label]`. |
| `table.stray-delimiter` | Start every row with `\|`. |
| `attr.malformed` | Fix the braces: `{#id .class key=value}`; quote values with spaces. |
| `html.wrapper` | Replace the raw HTML wrapper with a `:::` block. |
| `doc.frontmatter` | Move `key: value` lines into a `:::meta` block. |

Every code, with what it means and how to fix it: [references/diagnostics.md](references/diagnostics.md).

## More

- [references/syntax.md](references/syntax.md): every construct, its edge cases and escapes.
- [references/vocabulary.md](references/vocabulary.md): schemas, add-ons (`:::use`, `data-use`), themes, styling and behaviours.
- [references/diagnostics.md](references/diagnostics.md): every diagnostic code.
- [references/tools.md](references/tools.md): `tern new`, `check`, `build`, `mv`, the language server, and publishing.
- The documentation: [the guide](https://oscarac.github.io/tern/docs/guide.html#top), [the eight rules](https://oscarac.github.io/tern/docs/guide.html#rules).
