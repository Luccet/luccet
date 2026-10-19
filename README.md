<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/tern-white.png"><img src="docs/tern.png" alt="" width="128" height="128"></picture></p>

# Tern

Documents with the full power of HTML, CSS and JavaScript. A note is one HTML file: its first line loads `tern.js`, and everything below it is written in Tern's syntax and rendered in place when the file is opened.

```html
<!doctype html>
<meta charset="utf-8">
<script src="tern.js"></script>

# Linear maps {#maps}

:::theorem[Rank–nullity]{#thm-rn}
If $V$ is finite-dimensional then $\dim V = \dim \ker T + \dim \operatorname{im} T$.
:::

By @thm-rn, an injective map between spaces of equal dimension is surjective.
```


## Documentation

The documentation is published at **[ozkrac.github.io/tern](https://ozkrac.github.io/tern/)**. Start with the [guide](https://ozkrac.github.io/tern/docs/guide.html). The pages are themselves Tern notes: the same files are [`index.html`](index.html) and [`docs/`](docs/) in this repository, and they open locally in a browser too.

## Getting tern.js

A note needs only `tern.js` 

```html
<!doctype html>
<meta charset="utf-8">
<script src="tern.js"></script>

:::use
themes/nord.css
addons/katex.js
addons/code.js
:::
```

One add-on also fits on the tag, as `data-use="addons/katex.js"`; both forms work together.

**From jsDelivr**, which serves this repository's tagged releases:

```html
<!doctype html>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/gh/OzkrAC/tern@v0.6.0/tern.js"></script>
```

- **To follow releases,** use `@0.6` (the newest 0.6.x), `@0` (the newest 0.x: a major keeps every note rendering the same) or `@latest` (the newest release).
- **Not `tern.min.js`.** jsDelivr minifies any file on request, so `tern.min.js` exists beside `tern.js` at every tag and renders a note in the browser; do not use it. The tools and the editors take a note only from a tag whose file is called `tern.js`. Where bytes matter, each [GitHub Release](https://github.com/OzkrAC/tern/releases) carries a minified build under that name: `https://github.com/OzkrAC/tern/releases/download/vX.Y.Z/tern.js`, or copy it to your site.

**Themes:** [`themes/`](themes/) holds colour themes after well-known palettes (Solarized, Gruvbox, Nord, Dracula, Catppuccin, Tokyo Night and more), each an add-on: `themes/nord.css` in `:::use` (or `data-use`), or the same path on jsDelivr. See [themes](https://ozkrac.github.io/tern/docs/schema.html#themes).

**Add-ons:** [`addons/`](addons/) holds add-ons that come with Tern: `code.js` colours code by its language, `copy.js` puts a copy button on every fence, and `mermaid.js` draws `mermaid` fences as diagrams, both in the theme's colours; `lightbox.js` opens a figure's image full size; `switcher.js` gives a `::themes` control that picks a theme and remembers it; `katex.js` and `mathml.js` typeset math; `cite.js` cites the sources of a `:::bibliography` block, BibTeX or CSL-JSON, as `@key` and lists the cited ones; `search.js` gives a `::search` box over a set of notes, indexed in the browser or from the index `tern index` writes; `notes.js` lists the notes of a folder from the same command's catalogue; `glossary.js` lists the terms the notes define (`:dfn[…]`, `:::definition` blocks) from its glossary, and links every `:term[…]` to the entry. List them in `:::use`, one per line. See [add-ons](https://ozkrac.github.io/tern/docs/addons.html).


**With npm, from this repository:** `npm install github:OzkrAC/tern#vX.Y.Z` (a tag) puts the same `tern.js`, `tern.css`, the add-ons and the themes under `node_modules/@ozkrac/tern/`, with type declarations and the `tern` command ([Under node](https://ozkr.ac/tern/docs/api.html#under-node)). The package is not on the npm registry.

## Using the CLI tool

`npm install -g github:OzkrAC/tern#vX.Y.Z` installs the `tern` command from a tag; `npx github:OzkrAC/tern#vX.Y.Z …` runs it without installing; in a checkout, `node tern-cli.js …`:

```
node tern-cli.js new notes/linear-maps.html     # write the first line
node tern-cli.js check notes/                    # diagnostics and broken links, with file lines
node tern-cli.js build notes/linear-maps.html -o out.html   # a static, pre-rendered page
node tern-cli.js mv notes/linear-maps.html notes/algebra/    # move it, rewriting the links to and from it
node tern-cli.js vendor vendor/                  # local copies of KaTeX, highlight.js, Mermaid and Temml, for ?base=
node tern-cli.js search "rank nullity" notes/              # the sections and blocks that use these words, with lines
node tern-cli.js index notes/                    # notes.json, search.json and glossary.json, what ::notes, ::search and ::glossary read
node tern-cli.js lsp                              # the language server, over stdio
```

Named blocks such as `:::theorem` get labels, counters and elements from a schema: an add-on listed in `:::use` (or `data-use`), or `window.TERN = {schema: …}` in a script before the tern.js line ([Vocabulary and behaviour](docs/schema.html)).

## Editors

- **Neovim:** [tern.nvim](https://github.com/OzkrAC/tern.nvim) runs the language server and adds the commands (`:TernCheck`, `:TernBuild`, `:TernSearch` …), with the outline and a preview.
- **Any editor with a language-server client:** `node tern-cli.js lsp` speaks LSP over stdio: diagnostics as the browser reports them, completion, hover, definition, references, rename, symbols, folding, and link fixes when a file is moved. Setup, and the note-detection rule an editor needs, in [Command line and editors](https://ozkrac.github.io/tern/docs/tools.html#lsp).

## Agent skills

[`skills/tern-notes`](skills/tern-notes/SKILL.md) teaches coding agents (GitHub Copilot, Claude Code, Codex, Cursor) to write, check and fix notes. Install it in a project with `gh skill install OzkrAC/tern tern-notes`, or copy it into the project's `.github/skills/` ([skills/README.md](skills/README.md)).

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) says how a change is made and tested; [SECURITY.md](SECURITY.md) how to report a security problem.

```
npm run build       # src/ → tern.js and tern.css
npm test            # build check, corpus, samples, perf, fuzz, API, CLI, LSP, documentation
npm run smoke       # Chromium and Firefox (Playwright)
```

**A release.** `npm run bump -- X.Y.Z` (or `patch`, `minor`, `major`) sets the new version everywhere it is written: `package.json`, `tern.version`, the README's jsDelivr tag and the docs' examples. It rebuilds `tern.js`, starts the version's section in `CHANGELOG.md`, and refuses a version that is already a tag. Write the changelog section, run `npm test`, commit, and once the commit is on `main`, run `npm run tag`: it refuses what the release workflow would (a branch other than `main`, a working tree with changes, a place that disagrees, a missing changelog section, a tag that exists), then creates `vX.Y.Z`. Push the tag (`git push origin vX.Y.Z`): the release workflow checks it against the version, runs every test, publishes the site, drafts the GitHub Release with the changelog section as its notes and three assets (a minified `tern.js`, built with a pinned terser and checked to be the same version; `tern.css`; `tern-vX.Y.Z.zip` holding `tern.js`, `tern.css`, `tern.d.ts`, the add-ons and the themes), Publish the draft. The package is not published to the npm registry; `npm install github:OzkrAC/tern#vX.Y.Z` installs the tag. `npm test` fails if any place disagrees with `package.json`, or if a file names the version where `tools/version.js` does not look, so a new mention cannot be missed at the next bump.


MIT licensed.

## AI assistance

Tern is developed with the help of an AI coding assistant. 
