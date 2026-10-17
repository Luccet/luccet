# Changelog

Every release of Tern, newest first. Versions follow [semantic versioning](https://semver.org) with a `0.x` caveat: until 1.0, a minor release may change how an existing note renders or what an add-on receives, and the entry says so when it does. The engine reports its version as `tern.version`; the tags on GitHub and jsDelivr carry the same number from 0.4.3 on.

## 0.6.0 (unreleased)


- The language server runs a note's code over an asynchronous sandbox bridge, so a script that never returns no longer freezes every document: requests are answered from the last analysis while one runs, a change made meanwhile is analysed after it, and a rename waits for the analysis. A note whose scripts time out or crash keeps the vocabulary of its last analysis until its head or add-ons change. `note.analyseAsync` is the asynchronous form of `analyse`; the commands keep the blocking one.
- The language server follows a link `page.html#id` as a reference: definition goes to the id's declaration in that file (or the element with that id in an HTML file, the heading with that anchor in a Markdown file), references and rename reach the fragment of every such link from the workspace's notes, and `textDocument/documentLink` gives every URL's target. `textDocument/codeAction` offers quick fixes: a near id for `ref.dangling` or its escape, a footnote's definition, a closer for `block.unclosed` and `math.unclosed`, a near name for `name.unknown`, braces for `block.opener-junk`, the disk's spelling for a `link.missing` in another case. `workspace/symbol` searches the headings and blocks of the workspace's notes. `language.idAt`, `declaration` and `actions` are new.
- The language server takes `workspace/didChangeWorkspaceFolders`, asks a client that can watch files to watch notes, what they link to and what they load, and analyses a note again when an add-on it loads changes on disk; what it keeps of the files it read is capped at 512 entries per table, and a file rename reads the notes through the same cache.
- `tern mv --json`, `tern build --json` (the page in the object without `-o`) and `tern index --json` print one object on stdout. A note that is not valid UTF-8, or is UTF-16, is said on stderr by every command that reads it. `tern index` asks git for the dates of the indexed notes alone, and says when a log cut at 256 MB left notes dated by their modification time; the dates were silently lost before. A sandbox process that dies three times in a row before answering trips a breaker for a minute, said once, instead of being started again for every note.
- tern.nvim, the Neovim plugin, takes the new capabilities in its own repository (code actions with `gra`, cross-file definition, references and rename, workspace symbols, and a `watch` option for the server’s file watching), and its own CI runs its tests against Tern’s `main`.
- Completion is triggered by `:` and `@` only (`/` and `#` are typed inside a trigger), and right after a keystroke it reads the trigger from the text as it is, answering from the last analysis instead of running one per trigger. `language.completion` takes the current text as a third argument for that.

## 0.5.1 (2026-10-16)

- A note script that calls `tern.render(el, source)` with a script in the source no longer disarms the `document.write` guard for the scripts after it; a later `document.write` wiped the page.
- An add-on that never loads no longer leaves a blank page: 12 seconds after the note has arrived (`tern.config.addonTimeout`, in milliseconds) the note mounts without it, with `addon.failed`; the console says what is still awaited after 2 seconds; the document carries `aria-busy` until the mount.
- Rendering a root again from a source retires what its scripts registered with `tern.define`, `tern.on` and `tern.style`, so a live preview does not stack a behaviour, a listener and a stylesheet per edit; `tern.render` takes `scripts: false` to leave the scripts inert.
- An add-on listed twice (`data-use` and `:::use`) loads once; a `<script` inside a note script's text no longer shifts the positions of `script.document-write` diagnostics; a `data-css` stylesheet that fails to load is `addon.failed`; a capture write refused by a Trusted Types policy is said in the console.
- `data-nonce` is taken off the tag once read, and the tag's own `nonce` is used when `data-nonce` is absent.
- The support floor is stated (Chrome 86, Firefox 78, Safari 14) and guarded: an older browser is shown the source with a line saying why.

## 0.5.0 (2026-10-16)

- Inline constructs nest at most 1,000 deep; one past that is shown as its source text with `nesting.limit`. Ten thousand nested `**` used to parse into a tree that `JSON.stringify`, `tern.visit`, `tern.outline` and `tern.search` could not walk (a `RangeError`); those readers now keep their own stacks too.
- A reference's text and a toc entry copy at most 200 characters of their target, with an ellipsis; a 60 KB heading referenced 10,000 times used to make 600 MB of HTML and a `RangeError`. The emitter has an output budget too, `maxOutput` (64 M characters), past which the HTML stops with an `output.limit` diagnostic.
- Under `safe`, the attributes that drive the host page (`form`, `popovertarget`, `popovertargetaction`, `usemap`, `name`) are dropped too, attribute names are checked without case (a schema's `Href` passed), and a new `idPrefix` option of `tern.emit` and `tern.toHTML` keeps an untrusted root's ids and fragment links apart from the page's.
- `maxDepth` that is not a finite number of 1 or more means 64 (`'abc'` and `Infinity` used to lift the limit); a schema `label` function that throws is `addon.failed`, once per element, instead of escaping `tern.check` and `tern.toHTML`.
- A root rendered with `tern.render(el, text, {safe: true})` stays untrusted: it is marked `data-t-safe`, and a `tern.define` registered later, a later render of it without a source and a render of a root that holds it run no behaviour on it; a trusted source rendered into it makes it trusted again. `render` and `math` listeners get `{safe}` as a second argument. `tern.render` takes `idPrefix`.
- The KaTeX and MathML add-ons typeset an untrusted root with trust off whatever the page sets, with a copy of the macro table, and ignore its `:::macros`: with `trust: true` set for the page, a safe render of `\href{javascript:…}` used to make a live link, and a `\gdef` in it reached every later formula.

## 0.4.4 (2026-10-15)

- KaTeX add-on: `?trust=false` and `?strict=false` on the add-on's URL now mean false. They arrived as strings, which KaTeX read as true, so an author who turned trust off turned it on.
- Notes and search add-ons: an entry of `notes.json` or `search.json` whose URL is not a page on the file's own origin is left out, with a warning; a crafted file could make a `javascript:` or `data:` link. `index=` and `from=` must name `http(s)` URLs, and one that is not a URL at all is reported in place instead of leaving the box at "Indexing…" or the list empty.
- KaTeX add-on: a stylesheet that fails to load (a 404, an SRI mismatch, a `style-src` that omits the CDN) leaves math as its TeX source, with a warning, as a failed script does; it used to typeset into unstyled markup, each formula shown three times over.
- Mermaid add-on: `securityLevel` stays strict whatever the add-on's options say.
- The `:::use` scan (`src/use.js`, what the runtime and the tools read before parsing) handles CRLF text and closes the block only at `:::` or `:::/use`, as the parser does; `:::/meta` inside it used to end it early. The command line and the language server normalise line endings before scanning, so they were not affected by the CRLF part.
- Search: the snippet's word matching is linear in the text; its regex backtracked on a long unbroken token (about five seconds for 50,000 letters, once per hit in the search add-on and `tern search`). A word that stems to a matched stem (`studies` for `study`) is now marked too.
- Language server: a request with an id and no method, or a method that is not a string, is answered with `-32600` instead of being dropped, so a client does not wait forever; a `didChange` entry with a `range` is logged and ignored instead of being applied as the whole text (the server syncs full text).
- `tern index`: a tracked note with changes not yet committed is dated today, the day of the commit a hook is about to make, so that `--check` holds once it is committed; it was dated by its modification day, which could differ. A file git does not track is still dated by its modification time.
- Command line: output piped to a reader that closes early (`tern parse FILE | head`) ends the command quietly with exit 0; it died with an unhandled `EPIPE` and a stack trace, exit 1.
- Command line: what a note's add-on throws or logs is printed without terminal control characters (ESC, C1, the rest of C0 but tab and newline), in diagnostics, hints, `--json` and the console relay, so a note you have not read cannot retitle or clear the terminal. `?securityLevel=loose` on the tag used to win over the documented default, which made a `click` with a `javascript:` URL a live link.
- Project files: `SECURITY.md`, with private vulnerability reporting enabled on GitHub; `CONTRIBUTING.md`; an Editors section in the README. The README and the publishing page say that `tern.min.js` exists on jsDelivr, minified on request, and must not be used: the tools take a note only from a tag whose file is called `tern.js`.
- CI: the actions run on Node 24, the runner image is pinned to Ubuntu 24.04, and a tag's push no longer runs the CI workflow beside the release one. A lockfile, `npm ci`, `npm audit`, and caches for the smoke tests' CDN copies and browsers.

## 0.4.3 (2026-10-15)

- Release process: `npm run tag` creates the release tag only on a clean `main` that passes `tools/version.js --check`, has a changelog section for the version and is not tagged yet; `npm run bump` starts that section. The release workflow was refusing 0.4.1 and 0.4.2 because their tags did not match the version inside them.
- Notes and search add-ons: a page reached as its folder (`blog/` for `blog/index.html`) is recognised as the page itself, so it is left out of its own `::notes` list and `::search` scope.
- A changelog, this file, from 0.1.0 on.

## 0.4.2 (2026-10-15)

- `tern index` writes `notes.json`, a catalogue of a folder's notes (path, title, description, date, headings, links), and `search.json`, the search index, beside them; in a git repository only tracked files are indexed, and a note with `robots: noindex` is left out.
- `addons/notes.js`: a `::notes` leaf that lists the catalogue's notes, newest first, with dates and descriptions.
- `::search{index=search.json}` reads the prebuilt index instead of fetching every note, and falls back to indexing in the browser when the file is missing or from another version series.
- `tern search --index=FILE` searches a prebuilt index; `:TernSearch` in tern.nvim passes `--index=` through.
- `tern.search.describe(head, ast)`: a note's title, description, meta, headings and links, for catalogues.

## 0.4.1 (2026-10-14)

- `addons/search.js`: a `::search` box over a set of notes, indexed in the browser from the notes a page links to, a `from=` page's links, or a `notes=` list; hits link to the heading or block they are in.
- `tern search QUERY [PATH…]`: the same search over files, each hit at its file and line, with `--json` for editors; `tern.search` is the engine module both use.
- `:TernSearch` in tern.nvim fills the quickfix list from `tern search --json`.

## 0.4.0 (2026-10-13)

- A leading `:::use` block lists a note's add-ons and themes, one per line, as an alternative to `data-use` on the tern.js tag; the runtime reads it from the first chunk of the file, and the tools from the text.
- README rewritten around the first line of a note and the ways to get `tern.js`.

## 0.3.0 (2026-10-12)

- Math is an add-on: `addons/katex.js` typesets with KaTeX and `addons/mathml.js` with Temml, each loaded from jsDelivr with SRI or from a local copy; the engine itself leaves formulas as TeX. A note that relied on built-in math now lists one of them. `tern build --math katex|mathml` pre-renders formulas.
- A safe render mode for untrusted text: `tern.toHTML(text, {safe: true})` and `tern.render(el, text, {safe: true})` escape raw HTML, neutralise running and navigating elements and attributes, and drop URLs that are not http(s), mailto or relative.
- The command-line tools run a note's own scripts and add-ons in a sandbox: a child process under Node's permission model and a sealed context with a time limit, so checking a note you have not read does not run it with your privileges; `--no-scripts` skips them.
- `tern check` and the language server check links between files: a target that does not exist, a fragment that names no id, a folder without an index.
- `tern mv FROM… TO` moves notes, files and folders and rewrites the links to and from them; the language server does the same when the editor renames a file (`workspace/willRenameFiles`).
- `tern check` reports a `tern.js` the note loads but that does not exist.
- `skills/tern-notes`: an agent skill for writing, checking and fixing notes with coding agents.
- Documentation redesigned (`docs/docs.css`), with two accuracy fixes from a prose audit; prose microtypography in the base stylesheet.

## 0.2.0 (2026-10-10)

- Counters can restart per section: `within` in a block's schema entry numbers theorems 1.1, 1.2, 2.1.
- Default themes in `themes/`, generated by `tools/themes.js` from well-known palettes, with contrast checks.
- `addons/code.js`: code highlighting with highlight.js, in the theme's colours.
- `addons/mermaid.js`: diagrams from `mermaid` fences, in the theme's colours.
- `tools/version.js` bumps the version everywhere it is written and checks that every place agrees.
- Positions of `math.error` diagnostics after `tern.render`, and problems in roots other than the note.

## 0.1.1 (2026-10-09)

- The language features moved out of `cli/lsp.js` into `cli/language.js`, a module an editor can embed; `test/language.js` covers it.

## 0.1.0 (2026-10-08)

- The first release: the engine (`parse`, `transform`, `emit`, `toHTML`, `check`), the browser runtime that renders a note from its first line, the command line (`new`, `check`, `parse`, `build`, `corpus`), the language server, the documentation as Tern notes, the conformance corpus, and a Neovim plugin.
