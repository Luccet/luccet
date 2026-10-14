# Agent skills

Skills that teach coding agents (GitHub Copilot, Claude Code, Codex, Cursor and others) to work with Tern. Each folder is one skill in the [Agent Skills](https://agentskills.io/specification) format: a `SKILL.md` that the agent reads when a task matches its description, and reference files it reads when it needs more.

| Skill | What it teaches |
|---|---|
| [`tern-notes`](tern-notes/SKILL.md) | Writing, editing, checking and fixing notes: the first line, the syntax and the Markdown and LaTeX habits that do not carry over, vocabularies, `tern check` and every diagnostic, `tern mv`, publishing. |

## Installing a skill in your project

With the GitHub CLI, from the release of Tern your notes use:

```sh
gh skill install OzkrAC/tern tern-notes                        # Copilot, Codex, Cursor …: .agents/skills/
gh skill install OzkrAC/tern tern-notes --agent claude-code    # Claude Code
```

Or copy the folder into the directory your agent reads: `.github/skills/`, `.agents/skills/` or `.claude/skills/` in the project, or `~/.copilot/skills/`, `~/.agents/skills/` or `~/.claude/skills/` for all your projects. The agent then uses the skill when you ask it to write or fix a note; you can also name it, as in "use /tern-notes to …".

A skill describes the Tern of its release: install the one that matches the `tern.js` your notes load.
