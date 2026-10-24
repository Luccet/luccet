# Security

Luccet renders documents with the full power of HTML, CSS and JavaScript, and a note trusts itself: its own scripts run on its own page, as on any web page. What this policy covers is the boundaries Luccet promises to hold:

- **`safe` rendering** (`luccet.render(el, text, {safe: true})`, [Trust](https://luccet.dev/docs/publishing.html#trust)): text a page does not trust must not run scripts, set handlers, or make links to `javascript:` and the like.
- **The command-line sandbox** ([Running a note's code](https://luccet.dev/docs/tools.html#sandbox)): `luccet check`, `luccet build`, `luccet parse` and the language server run a note's own code in a sealed context inside a process under Node's permission model, so that checking a note you have not read does not hand it your machine. The sandbox is a seat belt, not a vault; a way out of it is still a report worth making. The local files a note names as head scripts or add-ons are read only inside its project (the folder of the `luccet.js` it loads, or its repository), so a note cannot have the tools read a file outside it and run it as code.
- **The add-ons in `addons/`**: their options and the files they read (`search.json`, `notes.json`, `glossary.json`) must not let a page or a catalogue do more than the documentation says.
- **The engine on hostile input**: a note that crashes or hangs the engine, the tools or the editor.

Out of scope: what a note's own scripts do on their own page, and the libraries the add-ons load (KaTeX, Mermaid, highlight.js, Temml), which have their own policies; a vulnerability in one of them is fixed here by moving the pinned version.

## Reporting

Report privately through [GitHub's vulnerability reporting](https://github.com/Luccet/luccet/security/advisories/new) for this repository, with the note or the steps that show the problem and the version (`luccet.version`, or the tag). Please do not open a public issue for a security problem until a fix is released.

Luccet is maintained by one person. A report is acknowledged within a week; a confirmed problem is fixed in the next patch release, the fix named in `CHANGELOG.md` and the GitHub Release, and the reporter credited there if they wish.

## Supported versions

The latest release receives fixes, as a patch release that changes nothing else; older releases do not. The tags `v0.4.1` and `v0.4.2` were cut without a version bump and are kept only because jsDelivr caches them; pin the newest release instead, the one at the top of `CHANGELOG.md`.
