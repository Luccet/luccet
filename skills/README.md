# Agent skills

Skills that teach coding agents (GitHub Copilot, Claude Code, Codex, Cursor and others) to work with Tern. Each folder is one skill in the [Agent Skills](https://agentskills.io/specification) format: a `SKILL.md` that the agent reads when a task matches its description, and reference files it reads when it needs more.

| Skill | What it teaches |
|---|---|
| [`tern-notes`](tern-notes/SKILL.md) | Writing, editing, checking and fixing notes: the first line, the syntax and the Markdown and LaTeX habits that do not carry over, vocabularies, `tern check` and every diagnostic, `tern mv`, publishing. |

## Installing a skill in your project

With the GitHub CLI, from the release of Tern your notes use:

```sh
gh skill install OscarAC/tern tern-notes                        # Copilot, Codex, Cursor …: .agents/skills/
gh skill install OscarAC/tern tern-notes --agent claude-code    # Claude Code
```

Or copy the folder into the directory your agent reads: `.github/skills/`, `.agents/skills/` or `.claude/skills/` in the project, or `~/.copilot/skills/`, `~/.agents/skills/` or `~/.claude/skills/` for all your projects. The agent then uses the skill when you ask it to write or fix a note; you can also name it, as in "use /tern-notes to …".

A skill describes the Tern of its release: install the one that matches the `tern.js` your notes load.

## Keeping them true

`node test/skills.js` (part of `npm test` and CI) checks every skill against the format and against the engine:

- the frontmatter: `name` (the folder's name) and `description`, and no field the format does not define; `SKILL.md` under 500 lines;
- every ```` ```tern ```` fence is a note body whose diagnostics are exactly its `expect="…"` (none by default), with `schema=demo` for the demo vocabulary (`test/fixtures/schema.js`), as the documentation's live examples are;
- every ```` ```html ```` fence that is a whole note is analysed as `tern check` analyses it;
- every link resolves: files of the skill, and ids on the published documentation's pages;
- every diagnostic code named exists, and `references/diagnostics.md` covers them all.

So a change to the engine that makes a skill wrong fails the tests, as it does for the documentation.
