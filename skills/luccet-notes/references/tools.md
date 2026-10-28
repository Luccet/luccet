# The command line and publishing

`luccet-cli.js` is Luccet's one command-line program: `new`, `check`, `parse`, `build`, `mv`, `search`, `index` and `lsp`. Every command runs the same engine as the browser, on the same file, with the note's own vocabulary, so `luccet check` reports what the page's diagnostics panel reports, except problems found only at run time (a script that fails). A note never loads `luccet-cli.js`; it needs only `luccet.js`.

The examples below are real runs. Paths are relative to the folder the command ran in.

## Find and run it

1. `command -v luccet`: `luccet` is on `PATH` after `npm link` in a Luccet checkout, or through a symbolic link to `luccet-cli.js` (it is executable, with `#!/usr/bin/env node`).
2. Otherwise look for a checkout: `find . -name luccet-cli.js -not -path '*/node_modules/*'` in the project (a vendored copy such as `tools/luccet/`, or a submodule), then run `node path/to/luccet-cli.js COMMAND …`.
3. It needs **Node 22 or later** (`node --version`) and nothing else: no `npm install`, no dependencies.
4. Luccet is **not on npm**. Never run `npx luccet` outside a checkout: it fetches an unrelated package called `luccet`. Inside a checkout, `npx --no -- luccet check notes/` is safe (`--no` refuses to download, `--` keeps npx's own options apart).
5. No checkout anywhere: say so. With the user's agreement, clone the release the notes load, outside the project: `git clone --depth 1 --branch vX.Y.Z https://github.com/Luccet/luccet.git`.

Match versions. `luccet --version` prints the engine's version; line 2 of a `luccet.js` names its own (`sed -n 2p luccet.js`), and a cdn.luccet.dev URL carries it as its folder (`/vX.Y.Z/luccet.js`), a jsDelivr URL as its tag. A checkout of another release may report different diagnostics from the page.

```text
$ luccet --version
X.Y.Z
$ sed -n 2p luccet.js
// luccet.js X.Y.Z: built from src/ by tools/concat.js. Edit the sources, not this file.
```

`luccet help` prints the usage; `luccet COMMAND --help` prints one synopsis. Options are strict: an unknown option is a usage error, printed with the synopsis. The rest of this file writes `luccet` for whichever way you run it.

| Exit | Meaning |
|---|---|
| `0` | Done. Also `luccet check` with nothing at or above `--fail-on`, or with no notes found. |
| `1` | `luccet check` found a diagnostic at or above `--fail-on`; `luccet new` or `luccet mv` refused, or a move failed (and was undone); `luccet search` found nothing; `luccet index --check` found a file missing or stale. |
| `2` | Usage error (missing argument, unknown option, bad value), or a path that cannot be used: a missing or unreadable file; for `parse` and `build`, a file that is not a note. |

## Which files are notes

The same rule everywhere (commands, language server, editors): test each line in order; the **first line holding a matching `<script` tag** is the `luccet.js` line. The note is every line after it; everything before the tag is the preserved head. A tag matches when:

- its `src` names a file called exactly `luccet.js`: any path, any quotes or none, a query or fragment allowed (`../luccet.js`, `/luccet.js`, `https://…/luccet.js`, `luccet.js?v=2`);
- it has no `async`, `defer`, `type=module` or `data-built`;
- it is not inside a comment opened earlier on that line, and the whole tag is on one line.

Case is ignored. `luccet.min.js` does not match, although a browser would run it. When you name a file that is not a note, the commands say why:

```text
$ luccet check plain.html deferred.html module.html commented.html min.html
luccet check: plain.html is not a note (no line loads luccet.js); skipped
luccet check: deferred.html is not a note (it loads luccet.js with defer, so luccet.js does not render it; use a plain <script src>); skipped
luccet check: module.html is not a note (it loads luccet.js with module, so luccet.js does not render it; use a plain <script src>); skipped
luccet check: commented.html is not a note (its luccet.js tag is commented out or not on one line); skipped
luccet check: min.html is not a note (no line loads luccet.js); skipped
luccet check: no notes found
```

A page written by `luccet build` is skipped too: "it is a page written by luccet build; check its source note". The exact rule, with its test cases: [Note detection](https://luccet.dev/docs/tools.html#detection).

## luccet new

```sh
luccet new FILE [--luccet=PATH] [--use=LIST] [--title=TEXT] [--lang=TAG] [--bare] [--force]
```

Writes one file: the canonical first line, with the right path to `luccet.js`, and after the tag the guard, which shows the source as readable text when `luccet.js` does not load. Write the body after it; do not touch line 1.

```text
$ luccet new notes/kernel.html
created notes/kernel.html, loading ../luccet.js
$ cat notes/kernel.html
<!doctype html><meta charset="utf-8"><script src="../luccet.js"></script><noscript><p>JavaScript is off; the source follows.</p><xmp hidden></noscript><script>self.luccet||document.write('<p>luccet.js did not load; the source follows.</p><xmp hidden>')</script></xmp><plaintext style="white-space:pre-wrap">
```

- **The path to luccet.js.** Without `--luccet`, it looks for a file called `luccet.js` in FILE's folder, then each folder above, and writes the nearest as a relative path (`../../luccet.js` two levels down). With none, it writes `luccet.js` and warns: `luccet new: no luccet.js in . or above; the note loads luccet.js from its own directory`. Copy `luccet.js` into place, or pass `--luccet`.
- **`--luccet=PATH`** is written as given: relative, root-relative, or a URL such as `https://cdn.luccet.dev/vX.Y.Z/luccet.js` (pin a release). Prefer relative paths for anything published or opened from disk.
- **`--use=LIST`** writes a `:::use` block, one entry per line, after the `:::meta` block. `--use=a.js,b.css`, `--use "a.js b.css"` and `--use=a.js --use=b.css` all give the same block. Paths are relative to the note; a local one that does not exist gets a warning on stderr, and the file is still written.
- **`--title=TEXT`** adds a `:::meta` block with `title: TEXT` and a blank line. One non-empty line.
- **`--lang=TAG`** adds `lang: TAG` to the `:::meta` block (after the title), which `luccet.js` puts on `<html>`; a language tag such as `en`, `de` or `pt-BR`. The guard's message is then in that language when the command has it (de, en, es, fr, it, nl, pt), English otherwise, and marked with the tag.
- **The guard** is the rest of line 1 after the tag: when `luccet.js` does not load (or JavaScript is off), the reader sees a one-line message and the source as wrapped plain text instead of a run-together paragraph. It changes nothing when `luccet.js` loads; `luccet build` drops it. **`--bare`** leaves it out (`--guarded`, the old option, is accepted and changes nothing).
- **`--force`** overwrites. Do not use it on an existing note unless the user asked for a fresh file.

```text
$ luccet new notes/first.html --title="Linear maps" --use=theorems.js,theme.css
created notes/first.html, loading ../luccet.js
luccet new: :::use names theorems.js, which does not exist yet
luccet new: :::use names theme.css, which does not exist yet
$ cat notes/first.html
<!doctype html><meta charset="utf-8"><link rel="preload" href="theorems.js" as="script"><link rel="preload" href="theme.css" as="style"><script src="../luccet.js"></script><noscript><p>JavaScript is off; the source follows.</p><xmp hidden></noscript><script>self.luccet||document.write('<p>luccet.js did not load; the source follows.</p><xmp hidden>')</script></xmp><plaintext style="white-space:pre-wrap">
:::meta
title: Linear maps
:::

:::use
theorems.js
theme.css
:::

```

Refusals print on stderr and exit 1; nothing is written:

| Situation | Message |
|---|---|
| the file exists | `luccet new: notes/kernel.html exists; --force overwrites it` |
| the path is a folder | `luccet new: notes is a directory` |
| the folder is missing (it creates none: `mkdir -p` first) | `luccet new: there is no directory drafts` |
| `--luccet` names another file than `luccet.js` | `luccet new: <script src="lib/luccet.min.js"> would not make notes/min.html a note: the src must name a file called luccet.js` |
| the title does not survive in `:::meta` | `luccet new: the title does not read back from :::meta` |

Usage errors (exit 2, with the synopsis): no FILE or more than one, a path with no file name (`notes/`), an empty `--luccet`, an empty or multi-line `--title`, a `--lang` that is not a language tag, `--bare` with `--guarded`.

## luccet check

```sh
luccet check PATH… [--json] [--fail-on=error|warning|info] [--quiet]
```

**Run it after every edit**, on the file you changed (`luccet check notes/kernel.html`), and on the whole folder before you finish (`luccet check notes --fail-on=warning`, so broken links count). Fix errors and warnings; read infos.

This note body (after its first line) has three problems:

```luccet expect="ref.dangling block.unclosed math.unclosed"
# The kernel

See @rank for the dimension count.

:::aside
Every linear map has a kernel.

$$
\ker f = \{ v : f(v) = 0 \}
```

```text
$ luccet check notes
notes/index.html:5:3: warning link.missing: kernal.html does not exist
    fix the path: it resolves from the folder of this note
notes/kernel.html:4:5: warning ref.dangling: no id in this note has this name, so the reference stays text
    if it is not a reference, write \@rank
notes/kernel.html:6:1: error block.unclosed: `:::aside` opened on line 5 is still open at line 9
    add `:::` or `:::/aside`
notes/kernel.html:9:1: error math.unclosed: `$$` opened on line 8 is never closed
    add a line holding only `$$`
notes/vectors/basis.html:4:5: warning link.dangling: ../maps.html has no element with the id thm-rank
    check the id after #: ids are case-sensitive
luccet check: 4 notes: 2 errors, 3 warnings, 0 infos
$ echo $?
1
```

- **Format:** `FILE:LINE:COL: SEVERITY CODE: MESSAGE`, then the hint indented on the next line. Diagnostics go to stdout in file order; the summary line goes to stderr.
- **`LINE` is a file line** (jump there). **Line numbers inside a message are note lines**, counted from the line after the `luccet.js` tag: with a one-line head, note line 5 is file line 6. Columns count UTF-16 code units from 1.
- **The hint is the fix.** Every code, with its fix: [diagnostics.md](diagnostics.md).

### Files and folders

- A **folder** is searched for `.html` and `.htm` files, recursively, in sorted order. Folders starting with `.` and `node_modules` are skipped; symbolic links to files are followed, to folders not. A file found this way that is not a note is skipped silently.
- A file you **name** that is not a note is skipped with a note on stderr and does not change the exit code. **`luccet check: no notes found` exits 0**: if you expected a note, its `luccet.js` line is wrong.
- Each file is checked once, even if named twice. A missing path exits 2 (`luccet check: cannot read nothere.html: no such file or directory`); an unreadable file is reported, the rest are checked, and the exit code is 2.

### --fail-on and --quiet

`--fail-on` sets the exit code; `--quiet` sets what prints. Without `--quiet`, everything prints whatever `--fail-on` says.

| The notes have | default (`error`) | `--fail-on=warning` | `--fail-on=info` |
|---|---|---|---|
| an error | 1 | 1 | 1 |
| warnings, no error | 0 | 1 | 1 |
| only infos | 0 | 0 | 1 |
| nothing | 0 | 0 | 0 |

`--quiet` prints only diagnostics at or above `--fail-on`, with no summary and no notes about skipped files: `luccet check site/ --quiet` in CI prints exactly what fails the build. Any other `--fail-on` value is a usage error.

Broken links are **warnings**: the default check exits 0 on a note with a link to a missing page or image. Use `--fail-on=warning`, or read every line. A wrong path to `luccet.js` is an error, since the note does not render.

### --json

One JSON array of every diagnostic (`[]` when there are none), filtered by `--quiet` as the lines are; the summary still goes to stderr unless `--quiet`.

```json
[
  {
    "file": "notes/vectors/basis.html",
    "code": "link.dangling",
    "severity": "warning",
    "message": "../maps.html has no element with the id thm-rank",
    "hint": "check the id after #: ids are case-sensitive",
    "position": { "start": { "line": 3, "column": 5, "offset": 15 }, "end": { "line": 3, "column": 46, "offset": 56 } },
    "filePosition": { "start": { "line": 4, "column": 5 }, "end": { "line": 4, "column": 46 } }
  }
]
```

(The real output puts every field on its own line.)

| Field | Holds |
|---|---|
| `file` | The path as named, or as found in a folder. |
| `code`, `severity` | The code; `error`, `warning` or `info`. |
| `message`, `hint` | What happened (citing note lines); the fix, when there is one. |
| `position` | In the note: `start`, `end` (exclusive), each `line`, `column` (1-based) and `offset` (0-based UTF-16). Absent for problems in the head or on the `luccet.js` line: `addon.failed`, `addon.remote`, `head.script`, and a `link.missing` found there. |
| `filePosition` | In the file: `start` and `end`, each `line` and `column`. Always present: use it to edit. |

### Add-ons and head scripts under Node

To know the note's vocabulary, the commands run, in one context, as the browser would: the head's classic scripts (inline, or a local `src`; not modules, `async`/`defer` ones or other origins), then `window.LUCCET`, then each script add-on of `data-use` and of the leading `:::use` block, then `window.LUCCET.schema` on top. Transforms that add-ons register run; behaviours (`luccet.define`, a schema's `dom`) do not. CSS add-ons are not run; their paths are link-checked. An add-on's `console` output goes to stderr. The scripts, and the parse and transforms run with them, share 2 seconds.

```text
$ luccet check addons.html
addons.html:3:1: info head.script: the head script https://cdn.example/analytics.js is not run under node, so vocabulary it declares in window.LUCCET.schema is unknown here
addons.html:4:1: warning head.script: the head script inline script on line 4 threw under node: undefinedFunction is not defined; vocabulary it declares may be missing
addons.html:5:1: error addon.failed: the add-on missing.js did not load: cannot read …/missing.js
addons.html:5:1: info addon.remote: the add-on https://cdn.example/remote.js is not loaded under node; names it declares are unknown to luccet check
addons.html:5:1: warning link.missing: the add-on theme.css does not exist
    fix the path: it resolves from the folder of this note
luccet check: 1 note: 1 error, 2 warnings, 2 infos
```

| Problem | Code | Severity |
|---|---|---|
| a script add-on missing, not a classic script (an ES module), or throwing; a transform that throws | `addon.failed` | error |
| a remote add-on (`https://…`), never fetched under Node | `addon.remote` | info |
| a head script with a remote `src` | `head.script` | info |
| a head script that is missing or throws | `head.script` | warning |

**Remote add-ons.** Their names are unknown to the CLI, so a note may get diagnostics (or lack labels in `luccet build`) that the browser would not. That is not an error in the note. To check such a note fully, keep a local copy of the add-on and point `data-use` at it, if the user agrees.

### Links between files

`luccet check` also checks each note's relative links against the disk, as warnings (the path to `luccet.js` as an error):

- `link.missing`: the file does not exist, a folder has no `index.html`, or the case differs from the disk's (`Index.html is spelt index.html on this disk; a host that tells case apart will not find it`).
- `link.dangling`: the file exists but the `#fragment` names no id in it. For a note, its ids as rendered with its own add-ons; for other HTML, an `id` or `<a name>`; for Markdown, GitHub's heading anchors. `#top` always counts.

**Checked:** Luccet links and images; `href`, `src`, `poster` and `data` of elements (`::video{src=…}`); `href` and `src` in raw HTML, in the note and the head (a `<link rel="stylesheet">`); on the `luccet.js` line, the path to `luccet.js`, `data-css` and the stylesheets in `data-use` or `:::use`. Links resolve from the note's folder; a query is ignored and `%20` decoded.

**Skipped:** URLs with a scheme (`https:`, `mailto:`) or starting with `//`; root-relative URLs (`/x.html`); every link of a note with a `<base href>`; anything in code, math and comments; fragments of non-HTML files (`paper.pdf#page=3`); ids a script adds at run time. A same-note `[text](#id)` is the engine's `ref.dangling` instead.

## luccet mv

```sh
luccet mv FROM… TO [--root=DIR] [--dry-run] [--json]
```

Moves or renames notes, other files and folders, and rewrites the relative URLs that point at them, and the moved notes' own URLs. **Whenever notes link to what moves, use `luccet mv` instead of `mv` or `git mv`, and run it with `--dry-run` (`-n`) first.**

```text
$ luccet mv --dry-run notes/maps.html notes/linear/
would move notes/maps.html → notes/linear/maps.html
notes/index.html:4:17: maps.html → linear/maps.html
notes/index.html:4:47: maps.html → linear/maps.html
notes/linear/maps.html:1:51: ../luccet.js → ../../luccet.js
notes/linear/maps.html:1:73: theorems.js → ../theorems.js
notes/linear/maps.html:4:15: img/kernel.svg → ../img/kernel.svg
notes/linear/maps.html:10:21: index.html → ../index.html
notes/vectors/basis.html:4:24: ../maps.html → ../linear/maps.html
luccet mv: README.md names maps.html but is not a note, so it is left as it is; look at it
luccet mv: 1 move, 7 links in 3 notes; a dry run, so nothing changed
```

Without `--dry-run`, the first line reads `moved …` and the summary drops "a dry run". Each edit prints as `file:line:col: old → new`, with the file at its new path. Then run `luccet check` on the folder.

- **TO** is a folder when it ends in `/` or exists; each FROM moves into it under its own name. Otherwise it is the new name: when `notes/algebra` does not exist, `luccet mv notes/kernel.html notes/algebra` renames the note to a file called `algebra`. End with `/` to move into a new folder. With several FROMs, TO must be an existing folder. Missing folders on the way are created.
- **`--root=DIR`**: the notes searched for links to what moves (found as `luccet check` finds them). Default: the repository FROM is in (the nearest folder above holding `.git`), else the current folder.
- **Rewritten:** links, images, element URLs, raw `<a href>`, stylesheets in `data-use` or `:::use`, and in moved notes also `luccet.js`, add-ons and head scripts. Only the path changes: `#fragment` and `?query`, `./`, percent-escapes, `<…>` brackets, quotes and line endings stay.
- **Left alone:** URLs with a scheme, `//` or `/`; notes with a `<base href>` (named on stderr); and **files that are not notes**. Each non-note file that names a moved file is listed on stderr (`README.md names maps.html but is not a note …; look at it`). Open each one: fix real links by hand (a Markdown link in a README, a navigation list in an add-on), leave mere mentions.
- It does not run add-ons. It renames as `mv` does; git sees a rename once staged.

**Refusals** (exit 1, nothing moves): a destination exists (`luccet mv: notes/linear/maps.html exists; move or remove it first`); a folder into itself (`luccet mv: cannot move notes into itself`); two FROMs with the same name; FROM already at TO (`… is already there`). A case-only rename on a case-insensitive disk is allowed. A missing FROM, a FROM inside another FROM, or several FROMs with a TO that is not a folder are usage errors (exit 2). A move that fails halfway is undone: nothing moved, no link changed.

## luccet build, luccet parse

```sh
luccet build FILE… [-o OUT] [--json]
```

Writes a static page holding the HTML the browser would mount, plus `:::meta` written into the head. Several FILEs, or a folder, need `-o DIR/` and build in one process: a folder's notes keep their paths under `DIR`. The page still loads `luccet.js` for behaviours, the panel, copy and print. Its tag gets `data-built`, so it is **not a note**: never edit it; edit the note and rebuild.

```text
$ luccet build notes/build.html -o dist/
notes/build.html:10:13: warning ref.dangling: no id in this note has this name, so the reference stays text
    if it is not a reference, write \@nowhere
luccet build: relative URLs (luccet.js, add-ons, images, links) are kept as written, so they resolve from dist
luccet build: wrote dist/build.html; 2 formulas
```

- **`-o OUT`**: without it, or with `-o -`, the page goes to stdout. `OUT` ending in `/` or naming an existing folder: written there under the note's name, folder created. Otherwise `OUT` is the file name (`-o dist2` writes a file `dist2`, and says so). `OUT` may not be the note itself (exit 2).
- **Relative URLs are kept as written**, and resolve from the page's folder. Build into a tree that mirrors the source (`notes/a.html` to `public/notes/a.html`) and copy `luccet.js`, add-ons and images into the same layout.
- **Diagnostics** print on stderr, but the page is always written and the exit code is 0. Run `luccet check` first when problems should stop you.
- **Math** is in the page as MathML, as the engine writes it: nothing to pre-render, nothing fetched at view time. `--math` and `--katex` (1.x) are gone and are usage errors.

```sh
luccet parse FILE [--transformed] [--compact]
```

Prints the syntax tree as JSON (no diagnostics), for debugging what the parser saw. `--transformed` runs the transforms first (ids, numbers, references, `root.data.luccet`); `--compact` prints one line. Positions are note lines. Example: `luccet parse note.html --transformed --compact | jq '.data.luccet.ids'`. Exit 2 for a file that is not a note.

## The language server

`luccet lsp` speaks the Language Server Protocol over stdio (`--stdio` is accepted). It gives, as you type, the same diagnostics as `luccet check` (links included, with unsaved buffers), completion of block, leaf and inline names and of ids (after `:::`, `::`, `:`, `@`, `](#`), hover, go to definition, references, rename of ids and element names, the outline, folding, and, when the editor renames a file, the edits `luccet mv` would make. It answers nothing for HTML files that are not notes, so it can attach to every `.html` buffer, beside an HTML server.

Setting up the user's editor is the user's business: do not change editor configuration unasked. The command is `luccet lsp` or `node /path/to/luccet-cli.js lsp`, for HTML files, UTF-16 positions. Setup for Neovim, VS Code and Helix: [Editor setup](https://luccet.dev/docs/tools.html#editors).

## Settings and tools that damage notes

A note is an `.html` file whose body is not HTML. Before editing, look for anything that will rewrite it; tell the user if you find one.

- **HTML formatters** (Prettier, js-beautify, an editor's "format document", format-on-save, a pre-commit hook such as lint-staged running Prettier on `*.html`) move the `luccet.js` tag to its own line and run the note together into one paragraph. Never run one on a note, including a project-wide `prettier --write .`. The fix is `"requirePragma": true` in `.prettierrc`, or the notes in `.prettierignore`. Undo a formatted note from version control.
- **Hard wrap** (Vim's `textwidth` with `formatoptions+=t`, "wrap at column") breaks one-line constructs: openers (`block.opener-junk`), leaves (`leaf.demoted`), a heading's or a `$$` closer's `{#id}` pushed to the next line (`attributes.orphan` and `ref.dangling`, or silently onto the next block), and table rows (silently cut short). Use soft wrap; never re-wrap paragraphs yourself.
- **Trailing-whitespace trimming** breaks no syntax (no construct depends on trailing spaces), but it changes content kept byte for byte: fences, raw HTML, display math, `:::macros`, `:::meta` and `{raw}` bodies. Harmless elsewhere. EditorConfig: `trim_trailing_whitespace = false` under `[*.html]`.
- **Hosts and CDNs that minify or rewrite HTML** change the note, which is text inside the file. Turn that off.

The VS Code settings that avoid all three: [Settings for notes](https://luccet.dev/docs/tools.html#editor-settings).

## Publishing

A note is a static file: no build step, no server code. Publishing is uploading files.

### What to upload

The notes, `luccet.js`, every add-on, theme, stylesheet and image they use, keeping the folder layout their relative paths expect.

- **One `luccet.js` at the site's root**, each note pointing at it relatively (`luccet.js`, `../luccet.js`): `luccet new` writes that. Or load it from cdn.luccet.dev with a pinned release (`https://cdn.luccet.dev/vX.Y.Z/luccet.js`); add-ons and themes are on jsDelivr, with versions of their own (`@1`).
- **Relative paths only.** Root-relative `/luccet.js` breaks from disk and under a sub-path. The file name must stay `luccet.js` (not `luccet.min.js`).
- **The canonical first line** keeps the doctype (without it: quirks mode, math as TeX, `doc.quirks`) and the charset (without it, a server that names no charset garbles non-ASCII text, with no diagnostic):

```html
<!doctype html><meta charset="utf-8"><script src="luccet.js"></script>
```

- **Before uploading:** `luccet check site/ --fail-on=warning`. A cache-busting query, `luccet.js?v=2`, is fine: the tag is still detected.

### Opening locally

Double-clicking a note renders it from `file:` in Chromium and Firefox, with no server. Relative paths load from disk; root-relative ones do not. Math renders with nothing else: the engine writes it as MathML. On `file:` and `localhost`, a diagnostics panel lists every problem at the bottom of the page; readers on other hosts do not see it (`data-diagnostics` on the tag shows it everywhere, `data-quiet` hides it). The console always has a `luccet:` group. To see a note as served: `python3 -m http.server` in its folder, then `http://localhost:8000/note.html`.

### Static hosts and GitHub Pages

Any static host serves notes with no configuration: no rewrites, no headers; `.html` is served as `text/html`.

- **GitHub Pages from a branch:** add an empty `.nojekyll` at the root of what is published (otherwise Jekyll skips files and folders starting with `_` or `.`), put `luccet.js` in the published folder, use relative paths. A project page lives under a sub-path (`https://USER.github.io/REPO/`), where `/luccet.js` is not your file.
- **From a workflow:** check out the repository, set up Node 22, optionally run `node path/to/luccet-cli.js check site/ --quiet` to fail the deployment on errors, then the Pages actions upload `site/` and deploy it (no Jekyll). Choose "GitHub Actions" as the Pages source. The full workflow: [GitHub Pages](https://luccet.dev/docs/publishing.html#github-pages).

### Search engines and link previews

`:::meta` is written into the head only when `luccet.js` runs; a crawler that runs no scripts sees the head and the raw source. Two fixes:

- Put `<title>`, `<meta name="description">` and `<html lang>` in the head itself. When the head and `:::meta` disagree, the head wins (`meta.conflict`).

```html
<!doctype html><html lang="en"><meta charset="utf-8"><title>Linear maps</title><meta name="description" content="Kernels, images and rank."><script src="luccet.js"></script>
```

- Or publish pages from `luccet build`: the content, title and description are in the HTML, and readers without JavaScript see the content styled. Publish the note itself instead when its add-ons are remote (the build lacks their labels and numbers) or the host sends a strict CSP. Keep the note as the source; rebuild when it changes.

### Math and offline use

Math needs nothing: the engine turns each formula's TeX into MathML, and the browser lays it out with the reader's math font, offline too. `luccet.css` names the common math fonts; on a computer with none (some Linux systems), brackets do not stretch and big operators stay small. KaTeX's look, the same in every browser, is an optional add-on, [Luccet/katex](https://github.com/Luccet/katex). Details: [Math](https://luccet.dev/docs/math.html).

Offline, load `luccet.js`, the add-ons and the themes from copies next to the notes. An add-on that fetches a library from a CDN (code highlighting, diagrams, KaTeX) has its own way to use a local copy: see its page, from [Add-ons](https://luccet.dev/docs/addons.html#top).

### Content-Security-Policy

Without a CSP header, skip this. Under a strict policy (no `'unsafe-inline'`):

- **Link `luccet.css`** (copy it from the checkout, next to `luccet.js`) in the head, so `luccet.js` does not inline its stylesheet; or use `data-css`, or `data-nonce`.
- **Math needs nothing:** it is MathML in the page, with no script, stylesheet or font to fetch. Allow `https://cdn.jsdelivr.net` only for add-ons loaded from it, or that load a library from it (code highlighting, diagrams, KaTeX); or serve copies, as each add-on's page says.
- **Still blocked, and yours:** `style` attributes (`{style="…"}`, raw HTML: use classes), inline `<script>` blocks in the note (unless allowed by nonce or hash; move code to a file), and in a built page the `style` attributes of aligned columns and `cols` grids; under a strict CSP, publish the note itself.
- **Nonces** on a static host are fixed values, no better than `'unsafe-inline'`.

A policy that renders with no violation from Luccet, math included:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:
```

```html
<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="luccet.css"><script src="luccet.js"></script>
```

Details: [Content-Security-Policy](https://luccet.dev/docs/publishing.html#csp).

### Trust

- **In the browser a note is not sandboxed.** Its head scripts, its add-ons and the `<script>` blocks in its body run with the page's full privileges; raw HTML (event handlers, iframes, `javascript:` links) reaches the page as written. Opening someone's note is opening their web page.
- **The CLI runs a note's code in a sandbox.** `check`, `build`, `parse`, `search`, `index` and `lsp` run a note's local head scripts and script add-ons (`--no-scripts`, or the server's `noScripts`, runs none) to learn its vocabulary, but inside a locked-down child process and a sealed context: the code reaches no file, process or Node global, and a hang is cut off at 2 s (an `addon.failed` error). Network access is not blocked, so it is a seat belt, not a vault. Pass `--no-scripts` to analyse a note without running its code at all (its own vocabulary is then unknown).
- **Do not add** scripts, add-ons or themes from origins the user has not chosen; pin versions: a release's folder on cdn.luccet.dev, a tag on jsDelivr.
- **Untrusted text** (comments posted by others) is never rendered safely by the runtime: render it with `luccet.toHTML(text, { safe: true })` and insert the result. See [Trust](https://luccet.dev/docs/publishing.html#trust).

### When a note does not render

Run `luccet check FILE` first; then match the symptom.

| What the page shows | Cause and fix |
|---|---|
| The source run together as one paragraph (`#`, `*`, `:::` visible) | `luccet.js` did not load or start. Check the `src` from the note's folder (`luccet check` reports a `link.missing` error with "so the note does not render"); a root-relative path opened from disk; `luccet.js` not uploaded. Or the tag has `async`, `defer` or `type="module"` (`luccet check` says "is not a note"). The guard `luccet new` writes makes this case readable; a note written by hand, or with `--bare`, has none. |
| Layout broken, add-ons misbehave; `doc.quirks` | No `<!doctype html>` at the very start of the file, so the browser is in quirks mode. |
| A formula shown as its TeX, in red | Its TeX does not translate: `luccet check` names the `tex.*` code and the command at fault (a typo, a missing brace, an unsupported command). |
| Brackets do not stretch, big operators small | No math font on the reader's computer: install one (STIX Two Math, Latin Modern Math), or use a theme that brings one. |
| `CafÃ©` for `Café` | No `<meta charset="utf-8">` near the top, or the file not saved as UTF-8. |
| Plain boxes, no labels or numbers; `addon.failed` | A wrong path in `data-use`, a file not uploaded, or an add-on that throws. |
| Missing styles or scripts; CSP violations in the console | See CSP above. |
| A script's output missing: `script.document-write` | Build elements with the DOM (`document.currentScript.after(el)`). |
| A script's code never runs: `script.domcontentloaded` | Run the code directly, or use `luccet.on('ready', fn)`. |
| The note is one line after saving | An HTML formatter. Undo it, turn it off. |
| `block.opener-junk`, `leaf.demoted`, `attributes.orphan` after editing; a table cut short | Hard wrap. Join the lines. |
| Code blocks lost trailing spaces | Whitespace trimming on save. |
| An old version of the content | A built page: rebuild it from the note. |
| Nothing new; "luccet.js is already loaded" in the console | A second `luccet.js` tag (for example in the note's raw HTML). Remove it. |
| 404s in Chromium's console for files only shown in code examples | The preload scanner. Harmless. |
| `_x_`, `[a][b]`, `\ref{x}` shown literally | Markdown or LaTeX habits: see [../SKILL.md](../SKILL.md) and [syntax.md](syntax.md). |

Every symptom in detail: [When it does not render](https://luccet.dev/docs/publishing.html#troubleshooting).
