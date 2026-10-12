# The command line and publishing

`tern-cli.js` is Tern's one command-line program: `new`, `check`, `parse`, `build`, `mv`, `corpus` and `lsp`. Every command runs the same engine as the browser, on the same file, with the note's own vocabulary, so `tern check` reports what the page's diagnostics panel reports, except problems found only at run time (a formula KaTeX rejects, a script that fails). A note never loads `tern-cli.js`; it needs only `tern.js`.

The examples below are real runs. Paths are relative to the folder the command ran in.

## Find and run it

1. `command -v tern`: `tern` is on `PATH` after `npm link` in a Tern checkout, or through a symbolic link to `tern-cli.js` (it is executable, with `#!/usr/bin/env node`).
2. Otherwise look for a checkout: `find . -name tern-cli.js -not -path '*/node_modules/*'` in the project (a vendored copy such as `tools/tern/`, or a submodule), then run `node path/to/tern-cli.js COMMAND …`.
3. It needs **Node 22 or later** (`node --version`) and nothing else: no `npm install`, no dependencies.
4. Tern is **not on npm**. Never run `npx tern` outside a checkout: it fetches an unrelated package called `tern`. Inside a checkout, `npx --no -- tern check notes/` is safe (`--no` refuses to download, `--` keeps npx's own options apart).
5. No checkout anywhere: say so. With the user's agreement, clone the release the notes load, outside the project: `git clone --depth 1 --branch vX.Y.Z https://github.com/OscarAC/tern.git`.

Match versions. `tern --version` prints the engine's version; line 2 of a `tern.js` names its own (`sed -n 2p tern.js`), and a jsDelivr URL carries it as its tag. A checkout of another release may report different diagnostics from the page.

```text
$ tern --version
X.Y.Z
$ sed -n 2p tern.js
// tern.js X.Y.Z: built from src/ by tools/concat.js. Edit the sources, not this file.
```

`tern help` prints the usage; `tern COMMAND --help` prints one synopsis. Options are strict: an unknown option is a usage error, printed with the synopsis. The rest of this file writes `tern` for whichever way you run it.

| Exit | Meaning |
|---|---|
| `0` | Done. Also `tern check` with nothing at or above `--fail-on`, or with no notes found. |
| `1` | `tern check` found a diagnostic at or above `--fail-on`; `tern new` or `tern mv` refused, or a move failed (and was undone); `tern corpus` left out an example. |
| `2` | Usage error (missing argument, unknown option, bad value), or a path that cannot be used: a missing or unreadable file; for `parse` and `build`, a file that is not a note. |

## Which files are notes

The same rule everywhere (commands, language server, editors): test each line in order; the **first line holding a matching `<script` tag** is the `tern.js` line. The note is every line after it; everything before the tag is the preserved head. A tag matches when:

- its `src` names a file called exactly `tern.js`: any path, any quotes or none, a query or fragment allowed (`../tern.js`, `/tern.js`, `https://…/tern.js`, `tern.js?v=2`);
- it has no `async`, `defer`, `type=module` or `data-built`;
- it is not inside a comment opened earlier on that line, and the whole tag is on one line.

Case is ignored. `tern.min.js` does not match, although a browser would run it. When you name a file that is not a note, the commands say why:

```text
$ tern check plain.html deferred.html module.html commented.html min.html
tern check: plain.html is not a note (no line loads tern.js); skipped
tern check: deferred.html is not a note (it loads tern.js with defer, so tern.js does not render it; use a plain <script src>); skipped
tern check: module.html is not a note (it loads tern.js with module, so tern.js does not render it; use a plain <script src>); skipped
tern check: commented.html is not a note (its tern.js tag is commented out or not on one line); skipped
tern check: min.html is not a note (no line loads tern.js); skipped
tern check: no notes found
```

A page written by `tern build` is skipped too: "it is a page written by tern build; check its source note". The exact rule, with its test cases: [Note detection](https://oscarac.github.io/tern/docs/tools.html#detection).

## tern new

```sh
tern new FILE [--tern=PATH] [--use=LIST] [--title=TEXT] [--guarded] [--force]
```

Writes one file: the canonical first line, with the right path to `tern.js`. Write the body after it; do not touch line 1.

```text
$ tern new notes/kernel.html
created notes/kernel.html, loading ../tern.js
$ cat notes/kernel.html
<!doctype html><meta charset="utf-8"><script src="../tern.js"></script>
```

- **The path to tern.js.** Without `--tern`, it looks for a file called `tern.js` in FILE's folder, then each folder above, and writes the nearest as a relative path (`../../tern.js` two levels down). With none, it writes `tern.js` and warns: `tern new: no tern.js in . or above; the note loads tern.js from its own directory`. Copy `tern.js` into place, or pass `--tern`.
- **`--tern=PATH`** is written as given: relative, root-relative, or a URL such as `https://cdn.jsdelivr.net/gh/OscarAC/tern@vX.Y.Z/tern.js` (pin a tag). Prefer relative paths for anything published or opened from disk.
- **`--use=LIST`** writes `data-use`. `--use=a.js,b.css`, `--use "a.js b.css"` and `--use=a.js --use=b.css` all give `data-use="a.js b.css"`. Paths are relative to the note; a local one that does not exist gets a warning on stderr, and the file is still written.
- **`--title=TEXT`** adds a `:::meta` block with `title: TEXT` and a blank line. One non-empty line.
- **`--guarded`** appends a guard to the first line: when `tern.js` does not load (or JavaScript is off), the reader sees a one-line message and the source as plain text instead of a run-together paragraph. It changes nothing when `tern.js` loads; `tern build` drops it.
- **`--force`** overwrites. Do not use it on an existing note unless the user asked for a fresh file.

```text
$ tern new notes/first.html --title="Linear maps" --use=theorems.js,theme.css
created notes/first.html, loading ../tern.js
tern new: data-use names theorems.js, which does not exist yet
tern new: data-use names theme.css, which does not exist yet
$ cat notes/first.html
<!doctype html><meta charset="utf-8"><script src="../tern.js" data-use="theorems.js theme.css"></script>
:::meta
title: Linear maps
:::

```

Refusals print on stderr and exit 1; nothing is written:

| Situation | Message |
|---|---|
| the file exists | `tern new: notes/kernel.html exists; --force overwrites it` |
| the path is a folder | `tern new: notes is a directory` |
| the folder is missing (it creates none: `mkdir -p` first) | `tern new: there is no directory drafts` |
| `--tern` names another file than `tern.js` | `tern new: <script src="lib/tern.min.js"> would not make notes/min.html a note: the src must name a file called tern.js` |
| the title does not survive in `:::meta` | `tern new: the title does not read back from :::meta` |

Usage errors (exit 2, with the synopsis): no FILE or more than one, a path with no file name (`notes/`), an empty `--tern`, an empty or multi-line `--title`.

## tern check

```sh
tern check PATH… [--json] [--fail-on=error|warning|info] [--quiet]
```

**Run it after every edit**, on the file you changed (`tern check notes/kernel.html`), and on the whole folder before you finish (`tern check notes --fail-on=warning`, so broken links count). Fix errors and warnings; read infos.

This note body (after its first line) has three problems:

```tern expect="ref.dangling block.unclosed math.unclosed"
# The kernel

See @rank for the dimension count.

:::aside
Every linear map has a kernel.

$$
\ker f = \{ v : f(v) = 0 \}
```

```text
$ tern check notes
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
tern check: 4 notes: 2 errors, 3 warnings, 0 infos
$ echo $?
1
```

- **Format:** `FILE:LINE:COL: SEVERITY CODE: MESSAGE`, then the hint indented on the next line. Diagnostics go to stdout in file order; the summary line goes to stderr.
- **`LINE` is a file line** (jump there). **Line numbers inside a message are note lines**, counted from the line after the `tern.js` tag: with a one-line head, note line 5 is file line 6. Columns count UTF-16 code units from 1.
- **The hint is the fix.** Every code, with its fix: [diagnostics.md](diagnostics.md).

### Files and folders

- A **folder** is searched for `.html` and `.htm` files, recursively, in sorted order. Folders starting with `.` and `node_modules` are skipped; symbolic links to files are followed, to folders not. A file found this way that is not a note is skipped silently.
- A file you **name** that is not a note is skipped with a note on stderr and does not change the exit code. **`tern check: no notes found` exits 0**: if you expected a note, its `tern.js` line is wrong.
- Each file is checked once, even if named twice. A missing path exits 2 (`tern check: cannot read nothere.html: no such file or directory`); an unreadable file is reported, the rest are checked, and the exit code is 2.

### --fail-on and --quiet

`--fail-on` sets the exit code; `--quiet` sets what prints. Without `--quiet`, everything prints whatever `--fail-on` says.

| The notes have | default (`error`) | `--fail-on=warning` | `--fail-on=info` |
|---|---|---|---|
| an error | 1 | 1 | 1 |
| warnings, no error | 0 | 1 | 1 |
| only infos | 0 | 0 | 1 |
| nothing | 0 | 0 | 0 |

`--quiet` prints only diagnostics at or above `--fail-on`, with no summary and no notes about skipped files: `tern check site/ --quiet` in CI prints exactly what fails the build. Any other `--fail-on` value is a usage error.

Broken links are **warnings**: the default check exits 0 on a note with a link to a missing page or image. Use `--fail-on=warning`, or read every line. A wrong path to `tern.js` is an error, since the note does not render.

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
| `position` | In the note: `start`, `end` (exclusive), each `line`, `column` (1-based) and `offset` (0-based UTF-16). Absent for problems in the head or on the `tern.js` line: `addon.failed`, `addon.remote`, `head.script`, and a `link.missing` found there. |
| `filePosition` | In the file: `start` and `end`, each `line` and `column`. Always present: use it to edit. |

### Add-ons and head scripts under Node

To know the note's vocabulary, the commands run, in one context, as the browser would: the head's classic scripts (inline, or a local `src`; not modules, `async`/`defer` ones or other origins), then `window.TERN`, then each script add-on of `data-use`, then `window.TERN.schema` on top. Transforms that add-ons register run; behaviours (`tern.define`, a schema's `dom`) do not. CSS add-ons are not run; their paths are link-checked. An add-on's `console` output goes to stderr. Each script gets 2 seconds.

```text
$ tern check addons.html
addons.html:3:1: info head.script: the head script https://cdn.example/analytics.js is not run under node, so vocabulary it declares in window.TERN.schema is unknown here
addons.html:4:1: warning head.script: the head script inline script on line 4 threw under node: undefinedFunction is not defined; vocabulary it declares may be missing
addons.html:5:1: error addon.failed: the add-on missing.js did not load: cannot read …/missing.js
addons.html:5:1: info addon.remote: the add-on https://cdn.example/remote.js is not loaded under node; names it declares are unknown to tern check
addons.html:5:1: warning link.missing: the add-on theme.css does not exist
    fix the path: it resolves from the folder of this note
tern check: 1 note: 1 error, 2 warnings, 2 infos
```

| Problem | Code | Severity |
|---|---|---|
| a script add-on missing, not a classic script (an ES module), or throwing; a transform that throws | `addon.failed` | error |
| a remote add-on (`https://…`), never fetched under Node | `addon.remote` | info |
| a head script with a remote `src` | `head.script` | info |
| a head script that is missing or throws | `head.script` | warning |

**Remote add-ons.** Their names are unknown to the CLI, so a note may get diagnostics (or lack labels in `tern build`) that the browser would not. That is not an error in the note. To check such a note fully, keep a local copy of the add-on and point `data-use` at it, if the user agrees.

### Links between files

`tern check` also checks each note's relative links against the disk, as warnings (the path to `tern.js` as an error):

- `link.missing`: the file does not exist, a folder has no `index.html`, or the case differs from the disk's (`Index.html is spelt index.html on this disk; a host that tells case apart will not find it`).
- `link.dangling`: the file exists but the `#fragment` names no id in it. For a note, its ids as rendered with its own add-ons; for other HTML, an `id` or `<a name>`; for Markdown, GitHub's heading anchors. `#top` always counts.

**Checked:** Tern links and images; `href`, `src`, `poster` and `data` of elements (`::video{src=…}`); `href` and `src` in raw HTML, in the note and the head (a `<link rel="stylesheet">`); on the `tern.js` line, the path to `tern.js`, `data-css` and the stylesheets in `data-use`. Links resolve from the note's folder; a query is ignored and `%20` decoded.

**Skipped:** URLs with a scheme (`https:`, `mailto:`) or starting with `//`; root-relative URLs (`/x.html`); every link of a note with a `<base href>`; anything in code, math and comments; fragments of non-HTML files (`paper.pdf#page=3`); ids a script adds at run time; `data-katex`. A same-note `[text](#id)` is the engine's `ref.dangling` instead.

## tern mv

```sh
tern mv FROM… TO [--root=DIR] [--dry-run]
```

Moves or renames notes, other files and folders, and rewrites the relative URLs that point at them, and the moved notes' own URLs. **Whenever notes link to what moves, use `tern mv` instead of `mv` or `git mv`, and run it with `--dry-run` (`-n`) first.**

```text
$ tern mv --dry-run notes/maps.html notes/linear/
would move notes/maps.html → notes/linear/maps.html
notes/index.html:4:17: maps.html → linear/maps.html
notes/index.html:4:47: maps.html → linear/maps.html
notes/linear/maps.html:1:51: ../tern.js → ../../tern.js
notes/linear/maps.html:1:73: theorems.js → ../theorems.js
notes/linear/maps.html:4:15: img/kernel.svg → ../img/kernel.svg
notes/linear/maps.html:10:21: index.html → ../index.html
notes/vectors/basis.html:4:24: ../maps.html → ../linear/maps.html
tern mv: README.md names maps.html but is not a note, so it is left as it is; look at it
tern mv: 1 move, 7 links in 3 notes; a dry run, so nothing changed
```

Without `--dry-run`, the first line reads `moved …` and the summary drops "a dry run". Each edit prints as `file:line:col: old → new`, with the file at its new path. Then run `tern check` on the folder.

- **TO** is a folder when it ends in `/` or exists; each FROM moves into it under its own name. Otherwise it is the new name: when `notes/algebra` does not exist, `tern mv notes/kernel.html notes/algebra` renames the note to a file called `algebra`. End with `/` to move into a new folder. With several FROMs, TO must be an existing folder. Missing folders on the way are created.
- **`--root=DIR`**: the notes searched for links to what moves (found as `tern check` finds them). Default: the repository FROM is in (the nearest folder above holding `.git`), else the current folder.
- **Rewritten:** links, images, element URLs, raw `<a href>`, stylesheets in `data-use`, and in moved notes also `tern.js`, add-ons and head scripts. Only the path changes: `#fragment` and `?query`, `./`, percent-escapes, `<…>` brackets, quotes and line endings stay.
- **Left alone:** URLs with a scheme, `//` or `/`; notes with a `<base href>` (named on stderr); and **files that are not notes**. Each non-note file that names a moved file is listed on stderr (`README.md names maps.html but is not a note …; look at it`). Open each one: fix real links by hand (a Markdown link in a README, a navigation list in an add-on), leave mere mentions.
- It does not run add-ons. It renames as `mv` does; git sees a rename once staged.

**Refusals** (exit 1, nothing moves): a destination exists (`tern mv: notes/linear/maps.html exists; move or remove it first`); a folder into itself (`tern mv: cannot move notes into itself`); two FROMs with the same name; FROM already at TO (`… is already there`). A case-only rename on a case-insensitive disk is allowed. A missing FROM, a FROM inside another FROM, or several FROMs with a TO that is not a folder are usage errors (exit 2). A move that fails halfway is undone: nothing moved, no link changed.

## tern build, tern parse, tern corpus

```sh
tern build FILE [-o OUT] [--katex]
```

Writes a static page holding the HTML the browser would mount, plus `:::meta` written into the head. The page still loads `tern.js` for behaviours, math, the panel, copy and print. Its tag gets `data-built`, so it is **not a note**: never edit it; edit the note and rebuild.

```text
$ tern build notes/build.html -o dist/
notes/build.html:10:13: warning ref.dangling: no id in this note has this name, so the reference stays text
    if it is not a reference, write \@nowhere
tern build: relative URLs (tern.js, add-ons, images, links) are kept as written, so they resolve from dist
tern build: wrote dist/build.html; 2 formulas
```

- **`-o OUT`**: without it, or with `-o -`, the page goes to stdout. `OUT` ending in `/` or naming an existing folder: written there under the note's name, folder created. Otherwise `OUT` is the file name (`-o dist2` writes a file `dist2`, and says so). `OUT` may not be the note itself (exit 2).
- **Relative URLs are kept as written**, and resolve from the page's folder. Build into a tree that mirrors the source (`notes/a.html` to `public/notes/a.html`) and copy `tern.js`, add-ons and images into the same layout.
- **Diagnostics** print on stderr, but the page is always written and the exit code is 0. Run `tern check` first when problems should stop you.
- **`--katex`** pre-renders math with the `katex` npm package, which is not a dependency: install it where Node finds it for `tern-cli.js`, in the note's folder or the current folder. Without it: `tern build: the katex package cannot be required (npm install katex); formulas are left to tern.js`. On success: `wrote dist/build.html; 2 formulas, 2 pre-rendered`. A formula KaTeX rejects is left for `tern.js`, with a `math.error` warning. Pre-rendered math carries `style` attributes (see CSP below).

```sh
tern parse FILE [--transformed] [--compact]
```

Prints the syntax tree as JSON (no diagnostics), for debugging what the parser saw. `--transformed` runs the transforms first (ids, numbers, references, `root.data.tern`); `--compact` prints one line. Positions are note lines. Example: `tern parse note.html --transformed --compact | jq '.data.tern.ids'`. Exit 2 for a file that is not a note.

`tern corpus` turns the live examples of Tern's own documentation pages into test cases; you will not need it.

## The language server

`tern lsp` speaks the Language Server Protocol over stdio (`--stdio` is accepted). It gives, as you type, the same diagnostics as `tern check` (links included, with unsaved buffers), completion of block, leaf and inline names and of ids (after `:::`, `::`, `:`, `@`, `](#`), hover, go to definition, references, rename of ids and element names, the outline, folding, and, when the editor renames a file, the edits `tern mv` would make. It answers nothing for HTML files that are not notes, so it can attach to every `.html` buffer, beside an HTML server.

Setting up the user's editor is the user's business: do not change editor configuration unasked. The command is `tern lsp` or `node /path/to/tern-cli.js lsp`, for HTML files, UTF-16 positions. Setup for Neovim, VS Code and Helix: [Editor setup](https://oscarac.github.io/tern/docs/tools.html#editors).

## Settings and tools that damage notes

A note is an `.html` file whose body is not HTML. Before editing, look for anything that will rewrite it; tell the user if you find one.

- **HTML formatters** (Prettier, js-beautify, an editor's "format document", format-on-save, a pre-commit hook such as lint-staged running Prettier on `*.html`) move the `tern.js` tag to its own line and run the note together into one paragraph. Never run one on a note, including a project-wide `prettier --write .`. The fix is `"requirePragma": true` in `.prettierrc`, or the notes in `.prettierignore`. Undo a formatted note from version control.
- **Hard wrap** (Vim's `textwidth` with `formatoptions+=t`, "wrap at column") breaks one-line constructs: openers (`block.opener-junk`), leaves (`leaf.demoted`), a heading's or a `$$` closer's `{#id}` pushed to the next line (`attributes.orphan` and `ref.dangling`, or silently onto the next block), and table rows (silently cut short). Use soft wrap; never re-wrap paragraphs yourself.
- **Trailing-whitespace trimming** breaks no syntax (no construct depends on trailing spaces), but it changes content kept byte for byte: fences, raw HTML, display math, `:::macros`, `:::meta` and `{raw}` bodies. Harmless elsewhere. EditorConfig: `trim_trailing_whitespace = false` under `[*.html]`.
- **Hosts and CDNs that minify or rewrite HTML** change the note, which is text inside the file. Turn that off.

The VS Code settings that avoid all three: [Settings for notes](https://oscarac.github.io/tern/docs/tools.html#editor-settings).

## Publishing

A note is a static file: no build step, no server code. Publishing is uploading files.

### What to upload

The notes, `tern.js`, every add-on, theme, stylesheet and image they use, keeping the folder layout their relative paths expect.

- **One `tern.js` at the site's root**, each note pointing at it relatively (`tern.js`, `../tern.js`): `tern new` writes that. Or load it from jsDelivr with a pinned tag (`@vX.Y.Z`), and give add-ons and themes from jsDelivr the same tag.
- **Relative paths only.** Root-relative `/tern.js` breaks from disk and under a sub-path. The file name must stay `tern.js` (not `tern.min.js`).
- **The canonical first line** keeps the doctype (without it: quirks mode, math as TeX, `doc.quirks`) and the charset (without it, a server that names no charset garbles non-ASCII text, with no diagnostic):

```html
<!doctype html><meta charset="utf-8"><script src="tern.js"></script>
```

- **Before uploading:** `tern check site/ --fail-on=warning`. A cache-busting query, `tern.js?v=2`, is fine: the tag is still detected.

### Opening locally

Double-clicking a note renders it from `file:` in Chromium and Firefox, with no server. Relative paths load from disk; root-relative ones do not. Math needs the network (KaTeX comes from a CDN) unless KaTeX is local. On `file:` and `localhost`, a diagnostics panel lists every problem at the bottom of the page; readers on other hosts do not see it (`data-diagnostics` on the tag shows it everywhere, `data-quiet` hides it). The console always has a `tern:` group. To see a note as served: `python3 -m http.server` in its folder, then `http://localhost:8000/note.html`.

### Static hosts and GitHub Pages

Any static host serves notes with no configuration: no rewrites, no headers; `.html` is served as `text/html`.

- **GitHub Pages from a branch:** add an empty `.nojekyll` at the root of what is published (otherwise Jekyll skips files and folders starting with `_` or `.`), put `tern.js` in the published folder, use relative paths. A project page lives under a sub-path (`https://USER.github.io/REPO/`), where `/tern.js` is not your file.
- **From a workflow:** check out the repository, set up Node 22, optionally run `node path/to/tern-cli.js check site/ --quiet` to fail the deployment on errors, then the Pages actions upload `site/` and deploy it (no Jekyll). Choose "GitHub Actions" as the Pages source. The full workflow: [GitHub Pages](https://oscarac.github.io/tern/docs/publishing.html#github-pages).

### Search engines and link previews

`:::meta` is written into the head only when `tern.js` runs; a crawler that runs no scripts sees the head and the raw source. Two fixes:

- Put `<title>`, `<meta name="description">` and `<html lang>` in the head itself. When the head and `:::meta` disagree, the head wins (`meta.conflict`).

```html
<!doctype html><html lang="en"><meta charset="utf-8"><title>Linear maps</title><meta name="description" content="Kernels, images and rank."><script src="tern.js"></script>
```

- Or publish pages from `tern build`: the content, title and description are in the HTML, and readers without JavaScript see the content styled. Publish the note itself instead when its add-ons are remote (the build lacks their labels and numbers) or the host sends a strict CSP. Keep the note as the source; rebuild when it changes.

### KaTeX and offline use

`tern.js` loads KaTeX from jsDelivr, pinned with integrity hashes, on every note (before it knows whether there is math). Offline, formulas stay TeX with a `katex.unavailable` error. To work offline:

1. Copy `katex.min.js`, `katex.min.css` and the `fonts/` folder from the `dist/` folder of the `katex` npm package, at the version `tern.js` pins (`grep -o 'katex@[0-9.]*' tern.js`; `npm pack katex@X.Y.Z` downloads it), into e.g. `vendor/katex/`, keeping `fonts/` next to the CSS.
2. Point the tag at it (relative to the note; no integrity hash, so compare hashes with [the pinned ones](https://oscarac.github.io/tern/docs/publishing.html#katex)):

```html
<!doctype html><meta charset="utf-8"><script src="tern.js" data-katex="vendor/katex"></script>
```

`data-katex="none"` turns math rendering off (formulas shown as TeX, no error, no download): use it on notes without math. `tern check` does not check `data-katex`.

### Content-Security-Policy

Without a CSP header, skip this. Under a strict policy (no `'unsafe-inline'`):

- **Link `tern.css`** (copy it from the checkout, next to `tern.js`) in the head, so `tern.js` does not inline its stylesheet; or use `data-css`, or `data-nonce`.
- **Allow KaTeX:** `https://cdn.jsdelivr.net` in `script-src`, `style-src` and `font-src`; or a local copy (`'self'` suffices); or `data-katex="none"`.
- **Still blocked, and yours:** `style` attributes (`{style="…"}`, raw HTML: use classes), inline `<script>` blocks in the note (unless allowed by nonce or hash; move code to a file), and in a built page the `style` attributes of aligned columns, `cols` grids and `--katex` math. Under a strict CSP, publish the note, not a `--katex` build.
- **Nonces** on a static host are fixed values, no better than `'unsafe-inline'`.

A policy that renders with no violation from Tern, math included:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:
```

```html
<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="tern.css"><script src="tern.js"></script>
```

Details: [Content-Security-Policy](https://oscarac.github.io/tern/docs/publishing.html#csp).

### Trust

- **In the browser a note is not sandboxed.** Its head scripts, its add-ons and the `<script>` blocks in its body run with the page's full privileges; raw HTML (event handlers, iframes, `javascript:` links) reaches the page as written. Opening someone's note is opening their web page.
- **The CLI runs a note's code in a sandbox.** `check`, `build`, `parse` and `lsp` run a note's local head scripts and script add-ons to learn its vocabulary, but inside a locked-down child process and a sealed context: the code reaches no file, process or Node global, and a hang is cut off at 2 s (an `addon.failed` error). Network access is not blocked, so it is a seat belt, not a vault. Pass `--no-scripts` to analyse a note without running its code at all (its own vocabulary is then unknown).
- **Do not add** scripts, add-ons or themes from origins the user has not chosen; pin jsDelivr tags.
- **Untrusted text** (comments posted by others) is never rendered safely by the runtime: render it with `tern.toHTML(text, { safe: true })` and insert the result. See [Trust](https://oscarac.github.io/tern/docs/publishing.html#trust).

### When a note does not render

Run `tern check FILE` first; then match the symptom.

| What the page shows | Cause and fix |
|---|---|
| The source run together as one paragraph (`#`, `*`, `:::` visible) | `tern.js` did not load or start. Check the `src` from the note's folder (`tern check` reports a `link.missing` error with "so the note does not render"); a root-relative path opened from disk; `tern.js` not uploaded. Or the tag has `async`, `defer` or `type="module"` (`tern check` says "is not a note"). `tern new --guarded` makes this case readable. |
| Math as TeX, `doc.quirks` | No `<!doctype html>` at the very start of the file. |
| Math as TeX, `katex.unavailable` | No network, the CDN blocked (CSP, filter), or a wrong `data-katex` base. |
| `CafÃ©` for `Café` | No `<meta charset="utf-8">` near the top, or the file not saved as UTF-8. |
| Plain boxes, no labels or numbers; `addon.failed` | A wrong path in `data-use`, a file not uploaded, or an add-on that throws. |
| Missing styles or scripts; CSP violations in the console | See CSP above. |
| A script's output missing: `script.document-write` | Build elements with the DOM (`document.currentScript.after(el)`). |
| A script's code never runs: `script.domcontentloaded` | Run the code directly, or use `tern.on('ready', fn)`. |
| The note is one line after saving | An HTML formatter. Undo it, turn it off. |
| `block.opener-junk`, `leaf.demoted`, `attributes.orphan` after editing; a table cut short | Hard wrap. Join the lines. |
| Code blocks lost trailing spaces | Whitespace trimming on save. |
| An old version of the content | A built page: rebuild it from the note. |
| Nothing new; "tern.js is already loaded" in the console | A second `tern.js` tag (for example in the note's raw HTML). Remove it. |
| 404s in Chromium's console for files only shown in code examples | The preload scanner. Harmless. |
| `_x_`, `[a][b]`, `\ref{x}` shown literally | Markdown or LaTeX habits: see [../SKILL.md](../SKILL.md) and [syntax.md](syntax.md). |

Every symptom in detail: [When it does not render](https://oscarac.github.io/tern/docs/publishing.html#troubleshooting).
