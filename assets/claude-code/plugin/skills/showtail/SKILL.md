---
name: showtail
description: Capture your work trail with Showtail while pairing with Claude. Log decisions, reflections, sources, tests, and artifacts, and generate or verify the report. Use when working in a project that has a .showtail/ folder, or when the user mentions Showtail or wants to "show their work".
allowed-tools: Bash(showtail *)
---

# Showtail: show your work

[Showtail](https://github.com/Tingsters/Showtail) records a local, reviewable trail of **how**
a student built their project — the prompts they used, the decisions they made, the sources
they drew on, the tests they ran, the files they changed, and what they learned. It is a
positive "show your work" tool. It is **not** AI-detection and **not** surveillance.

Everything is stored locally under `.showtail/`. Never send it anywhere.

## Your job in a Showtail project

When you are helping in a project that has a `.showtail/` folder (or the user asks to start
showing their work), help build an honest provenance trail as you pair with the student.

**If hooks are installed**, prompts and file edits are already captured automatically — so
focus on the *judgment* events below rather than re-logging prompts or every edit.

### 1. Make sure a session is running

- If there is no `.showtail/` folder yet, tell the student they can run `showtail init` first.
- Otherwise ensure a session exists: `showtail start` (safe to run at the start of a work block).

### 2. Log the meaningful moments (use the student's own framing)

Run these as they genuinely happen — don't fabricate or pad the trail:

- A real design choice was made and you discussed trade-offs:
  `showtail log --type decision --text "Chose X over Y because ..." --files path/to/file`
- The student expresses understanding in their own words:
  `showtail log --type reflection --text "I now understand how ..."`
- An outside source was used (notes, docs, a classmate):
  `showtail log --type source --text "Used the week 3 lecture notes on tokenizers."`
- Tests or validation were run:
  `showtail log --type test --text "Added edge-case tests; all passing." --files tests/x.test.ts`

### 3. Snapshot notable files

When you create or substantially change an important file, record it:
`showtail artifact add path/to/file`

### 4. Wrap up

At the end of a work block, offer to:
- `showtail report` — generate the Markdown report for the educator
- `showtail verify` — confirm the trail is complete and consistent

## Principles

- **Honesty over volume.** A short, truthful trail beats a padded one. Capture decisions and
  understanding, not busywork.
- **Privacy.** Only log project-relevant content. Never log secrets, passwords, tokens, or
  private personal information — the trail may be committed to the student's repo.
- **Stay out of the way.** Logging is a quick side action; keep helping with the actual work.
- **The student is the author.** Showtail documents their process; it does not replace it.

## Command reference

| Command | What it does |
|---|---|
| `showtail init` | Create the `.showtail/` folder |
| `showtail start` | Begin a work session |
| `showtail log --type <type> --text "..." [--files a,b] [--tags x,y]` | Record one event |
| `showtail artifact add <file>` | Snapshot a file (SHA-256 + git commit) |
| `showtail trace <file>` | Show a file's provenance trail |
| `showtail report [--format json]` | Generate the report |
| `showtail verify` | Check the trail is valid and consistent |

Event types: `prompt`, `ai_output`, `human_edit`, `decision`, `reflection`, `source`, `test`,
`artifact`.
