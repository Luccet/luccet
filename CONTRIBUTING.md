# Contributing to Luccet

Luccet is a single-file engine, `luccet.js`, built from `src/`, with a command line in `cli/`, and documentation in `docs/` that is itself written in Luccet. The engine, the conformance corpus and the documentation are the reference together: when they disagree, that is a bug to report, not something to settle by adjusting whichever is easiest.

## Setting up

```sh
git clone https://github.com/Luccet/luccet.git && cd luccet
npm test                      # every Node harness: no dependency needed
npm ci && npx playwright install --with-deps chromium firefox
npm run smoke                 # the browser tests (the print test also needs mutool: mupdf-tools)
```

`luccet.js` is the build of `src/`: edit the sources, run `npm run build`, and commit both. `npm test` checks that they agree, and that every place that names the version does.

## Where things are explained

- [`docs/README.md`](docs/README.md): how the documentation is written, its pages, the live examples and the checks `test/docs.js` runs on every page.
- [`test/corpus/README.md`](test/corpus/README.md): the conformance corpus, its file format, the lint, and what to do when the documentation is silent.
- [`skills/README.md`](skills/README.md): the agent skill that teaches coding assistants to write and check notes.
- The documentation itself, at [luccet.dev](https://luccet.dev/): the syntax, the elements, the schema, the tools, publishing and the API.

## A change

1. **A branch per change**, from `main`, and a pull request. Keep a pull request to one thing: a fix, a feature, a page.
2. **A test that fails before the change** and passes after it: a corpus case for the engine (`test/corpus/*.txt`), a CLI or LSP test for the tools (`test/cli.js`, `test/lsp.js`), an API test (`test/api.js`), a smoke test for the runtime (`test/smoke.js`). The add-ons have their own repositories (github.com/Luccet), with their own tests. `node test/run.js --lint` checks that a corpus case cites the documentation section it tests.
3. **The documentation in the same pull request.** A change in behaviour changes a page in `docs/`; its live examples are checked against the engine by `npm test`, so an example that no longer holds fails the build.
4. **A line in `CHANGELOG.md`**, under the unreleased section at the top, saying what changed for a reader of the previous release. CI fails a pull request that leaves the changelog alone; label it `no-changelog` when there is nothing to say (a typo, a test alone).
5. **Every suite green**: `npm test`, and `npm run smoke` for anything the browser runs. CI runs both on every pull request, plus the command line and the language server on Windows and the smoke suite in WebKit, blocking too, and a coverage report (c8, as a run artifact) of the Node suites. A change to the language server should also be run against [luccet.nvim](https://github.com/Luccet/luccet.nvim), the Neovim plugin, which is a client of it: check the plugin out beside this repository and run `nvim --headless -u NONE -l test/run.lua` in it (`LUCCET_ROOT` names another checkout). The plugin’s own CI runs those tests against Luccet’s `main`; the engine does not depend on the plugin.

Releases are cut from `main` by the maintainer; the steps are in the README under Development. Security problems go through [`SECURITY.md`](SECURITY.md), not an issue.

## Style

Zero dependencies at runtime, and none for `npm test`; Playwright is the one development dependency. Plain CommonJS in `src/` and `cli/`, built by `tools/concat.js`; an add-on is one classic script that runs in the browser and under Node. Comments say why, and what a reader of the file needs to know, not what the code already says. Diagnostics and messages name what happened and what to do about it, in one sentence each.

## AI assistance

This project is developed with assistance from AI. Everything that lands is read and run by a person: the tests, the corpus and the documentation are the record of what was verified.
