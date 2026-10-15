# Changelog

Every release of Tern, newest first. Versions follow [semantic versioning](https://semver.org) with a `0.x` caveat: until 1.0, a minor release may change how an existing note renders or what an add-on receives, and the entry says so when it does. The engine reports its version as `tern.version`; the tags on GitHub and jsDelivr carry the same number from 0.4.3 on.

## 0.4.4 (unreleased)

Phase 1 of the [remediation plan](https://github.com/OzkrAC/tern): the confirmed defects that are a few lines and a test each, and the project files a repository is expected to have.

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
- CI: the actions run on Node 24, the runner image is pinned to Ubuntu 24.04, and a tag's push no longer runs the CI workflow beside the release one. A lockfile, `npm ci`, `npm audit`, and caches for the smoke tests' CDN copies and browsers.

## 0.4.3 (2026-10-15)

The first release whose tag, `package.json` and `tern.version` agree, and the first with a changelog and a GitHub Release.

- Release process: `npm run tag` creates the release tag only on a clean `main` that passes `tools/version.js --check`, has a changelog section for the version and is not tagged yet; `npm run bump` starts that section. The release workflow was refusing 0.4.1 and 0.4.2 because their tags did not match the version inside them.
- Notes and search add-ons: a page reached as its folder (`blog/` for `blog/index.html`) is recognised as the page itself, so it is left out of its own `::notes` list and `::search` scope.
- A changelog, this file, from 0.1.0 on.

## 0.4.2 (2026-10-15)

Mislabeled: the tag exists on GitHub and jsDelivr, but `tern.version` and `package.json` inside it say 0.4.0, so the release workflow refused it. Prefer 0.4.3, which has the same content plus the fixes above.

- `tern index` writes `notes.json`, a catalogue of a folder's notes (path, title, description, date, headings, links), and `search.json`, the search index, beside them; in a git repository only tracked files are indexed, and a note with `robots: noindex` is left out.
- `addons/notes.js`: a `::notes` leaf that lists the catalogue's notes, newest first, with dates and descriptions.
- `::search{index=search.json}` reads the prebuilt index instead of fetching every note, and falls back to indexing in the browser when the file is missing or from another version series.
- `tern search --index=FILE` searches a prebuilt index; `:TernSearch` in tern.nvim passes `--index=` through.
- `tern.search.describe(head, ast)`: a note's title, description, meta, headings and links, for catalogues.

## 0.4.1 (2026-10-14)

Mislabeled like 0.4.2: `tern.version` inside it says 0.4.0.

- `addons/search.js`: a `::search` box over a set of notes, indexed in the browser from the notes a page links to, a `from=` page's links, or a `notes=` list; hits link to the heading or block they are in.
- `tern search QUERY [PATH…]`: the same search over files, each hit at its file and line, with `--json` for editors; `tern.search` is the engine module both use.
- `:TernSearch` in tern.nvim fills the quickfix list from `tern search --json`.
- The project moved to the GitHub account OzkrAC; the documentation is published at ozkrac.github.io/tern (now ozkr.ac/tern).

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
