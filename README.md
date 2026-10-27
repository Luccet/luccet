<p align="center"><img src="docs/luccet.png" alt="" width="128" height="128"></p>

# Luccet

Documents with the full power of HTML, CSS and JavaScript. A note is one HTML file: its first line loads `luccet.js`, and everything below it is written in Luccet's syntax and rendered in place when the file is opened.

*Luccet was called Tern until version 2.0. A note written for Tern needs its first line changed: see [Migrating a note](CHANGELOG.md#200-2026-10-27).*

```html
<!doctype html>
<meta charset="utf-8">
<script src="luccet.js"></script>

# Linear maps {#maps}

:::theorem[Rank–nullity]{#thm-rn}
If $V$ is finite-dimensional then $\dim V = \dim \ker T + \dim \operatorname{im} T$.
:::

By @thm-rn, an injective map between spaces of equal dimension is surjective.
```

It renders as plain HTML, in the browser's own type and colours, light or dark, and the formulas as MathML: Luccet translates the TeX itself, with nothing to load ([math](https://luccet.dev/docs/math.html)). For a look, list a [theme](https://github.com/Luccet/themes): `<script src="luccet.js" data-use="https://cdn.jsdelivr.net/gh/Luccet/themes@1/classic.css"></script>`.


## Documentation

The documentation is published at **[luccet.dev](https://luccet.dev/)**. Start with the [guide](https://luccet.dev/docs/guide.html). The pages are themselves Luccet notes: the same files are [`index.html`](index.html) and [`docs/`](docs/) in this repository, and they open locally in a browser too.

## Getting luccet.js

A note needs only `luccet.js` 

```html
<!doctype html>
<meta charset="utf-8">
<script src="luccet.js"></script>

:::use
https://cdn.jsdelivr.net/gh/Luccet/themes@1/classic.css
https://cdn.jsdelivr.net/gh/Luccet/code@1/code.js
:::
```

One add-on also fits on the tag, as `data-use="…/code.js"`; both forms work together.

**From jsDelivr**, which serves this repository's tagged releases:

```html
<!doctype html>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/gh/Luccet/luccet@v2.0.0/luccet.js"></script>
```

- **To follow releases,** use `@2.0` (the newest 2.0.x), `@2` (the newest 2.x: a major keeps every note rendering the same) or `@latest` (the newest release).
- **Not `luccet.min.js`.** jsDelivr minifies any file on request, so `luccet.min.js` exists beside `luccet.js` at every tag and renders a note in the browser; do not use it. The tools and the editors take a note only from a tag whose file is called `luccet.js`. Where bytes matter, each [GitHub Release](https://github.com/Luccet/luccet/releases) carries a minified build under that name: `https://github.com/Luccet/luccet/releases/download/vX.Y.Z/luccet.js`, or copy it to your site.

**Themes:** colour themes after well-known palettes (Solarized, Gruvbox, Nord, Dracula, Catppuccin, Tokyo Night and more) live in their own repository, [Luccet/themes](https://github.com/Luccet/themes). Each is an add-on: `https://cdn.jsdelivr.net/gh/Luccet/themes@1/nord.css` in `:::use` (or `data-use`). See [themes](https://luccet.dev/docs/schema.html#themes).

**Add-ons** live in repositories of their own, each with its page: [code](https://github.com/Luccet/code) colours code by its language, [mermaid](https://github.com/Luccet/mermaid) draws `mermaid` fences as diagrams, [lightbox](https://github.com/Luccet/lightbox) opens a figure's image full size, [cite](https://github.com/Luccet/cite) cites the sources of a `:::bibliography` block, [wiki](https://github.com/Luccet/wiki) makes a folder of notes a wiki, with a `::notes` list of them, a `::search` box and a `::glossary` of the terms they define, and [katex](https://github.com/Luccet/katex) typesets math with KaTeX instead of the engine's MathML. List them in `:::use`, one per line, from jsDelivr: `https://cdn.jsdelivr.net/gh/Luccet/code@1/code.js`, `https://cdn.jsdelivr.net/gh/Luccet/wiki@1/search.js`. See [add-ons](https://luccet.dev/docs/addons.html).


**With npm, from this repository:** `npm install github:Luccet/luccet#vX.Y.Z` (a tag) puts the same `luccet.js` and `luccet.css` under `node_modules/luccet/`, with type declarations and the `luccet` command ([Under node](https://luccet.dev/docs/api.html#under-node)). The package is not on the npm registry.

## Using the CLI tool

`npm install -g github:Luccet/luccet#vX.Y.Z` installs the `luccet` command from a tag; `npx github:Luccet/luccet#vX.Y.Z …` runs it without installing; in a checkout, `node luccet-cli.js …`:

```
node luccet-cli.js new notes/linear-maps.html     # write the first line
node luccet-cli.js check notes/                    # diagnostics and broken links, with file lines
node luccet-cli.js build notes/linear-maps.html -o out.html   # a static, pre-rendered page
node luccet-cli.js mv notes/linear-maps.html notes/algebra/    # move it, rewriting the links to and from it
node luccet-cli.js search "rank nullity" notes/              # the sections and blocks that use these words, with lines
node luccet-cli.js index notes/                    # notes.json, search.json and glossary.json, what ::notes, ::search and ::glossary read
node luccet-cli.js lsp                              # the language server, over stdio
```

Named blocks such as `:::theorem` get labels, counters and elements from a schema: an add-on listed in `:::use` (or `data-use`), or `window.LUCCET = {schema: …}` in a script before the luccet.js line ([Vocabulary and behaviour](docs/schema.html)).

## Editors

- **Neovim:** [luccet.nvim](https://github.com/Luccet/luccet.nvim) runs the language server and adds the commands (`:LuccetCheck`, `:LuccetBuild`, `:LuccetSearch` …), with the outline and a preview.
- **Any editor with a language-server client:** `node luccet-cli.js lsp` speaks LSP over stdio: diagnostics as the browser reports them, completion, hover, definition, references, rename, symbols, folding, and link fixes when a file is moved. Setup, and the note-detection rule an editor needs, in [Command line and editors](https://luccet.dev/docs/tools.html#lsp).

## Agent skills

[`skills/luccet-notes`](skills/luccet-notes/SKILL.md) teaches coding agents (GitHub Copilot, Claude Code, Codex, Cursor) to write, check and fix notes. Install it in a project with `gh skill install Luccet/luccet luccet-notes`, or copy it into the project's `.github/skills/` ([skills/README.md](skills/README.md)).

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) says how a change is made and tested; [SECURITY.md](SECURITY.md) how to report a security problem.

```
npm run build       # src/ → luccet.js and luccet.css
npm test            # build check, corpus, samples, perf, fuzz, API, CLI, LSP, documentation
npm run smoke       # Chromium and Firefox (Playwright)
```

**A release.** `npm run bump -- X.Y.Z` (or `patch`, `minor`, `major`) sets the new version everywhere it is written: `package.json`, `luccet.version`, the README's jsDelivr tag and the docs' examples. It rebuilds `luccet.js`, starts the version's section in `CHANGELOG.md`, and refuses a version that is already a tag. Write the changelog section, run `npm test`, commit, and once the commit is on `main`, run `npm run tag`: it refuses what the release workflow would (a branch other than `main`, a working tree with changes, a place that disagrees, a missing changelog section, a tag that exists), then creates `vX.Y.Z`. Push the tag (`git push origin vX.Y.Z`): the release workflow checks it against the version, runs every test, publishes the site (its `luccet.js` minified, as the release's asset is), drafts the GitHub Release with the changelog section as its notes and three assets (a minified `luccet.js`, built with a pinned terser and checked to be the same version; `luccet.css`; `luccet-vX.Y.Z.zip` holding `luccet.js`, `luccet.css`, `luccet.d.ts`, the add-ons and the themes). Publish the draft. Between releases, the `site` workflow, run by hand from the Actions tab on `main`, publishes the pages of `main` (`index.html`, `docs/`, `examples/`) with the engine of the newest tag, its `luccet.js` minified the same way, once the docs and samples suites pass against that engine. The package is not published to the npm registry; `npm install github:Luccet/luccet#vX.Y.Z` installs the tag. `npm test` fails if any place disagrees with `package.json`, or if a file names the version where `tools/version.js` does not look, so a new mention cannot be missed at the next bump.


MIT licensed.

## AI assistance

Luccet is developed with the help of an AI coding assistant. 
