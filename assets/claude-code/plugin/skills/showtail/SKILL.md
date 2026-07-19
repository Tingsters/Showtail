---
name: showtail
description: Help a student show THEIR work with Showtail while pairing with Claude. Showtail captures the student's prompts and the files they change into a local trail, and generates the report. Use when working in a project that has a .showtail/ folder, or when the user mentions Showtail or wants to "show their work".
allowed-tools: Bash(showtail *)
---

# Showtail: help the student show THEIR work

[Showtail](https://github.com/Tingsters/Showtail) records a local, reviewable trail of **how
the student built their project** — the prompts they sent and the files that changed as you
worked together. It is the **student's** record of **their own** work, for an educator to
review. It is **not** a log of what you (Claude) did, and **not** AI-detection.

It is meant to be **hands-free**: when capture hooks are on, the trail builds itself while the
student works. Everything is stored locally under `.showtail/`. Never send it anywhere.

## 1. Make sure it's set up

Tracking is **automatic** — it turns on when the student installs Showtail (there is no setup
command to run). A trail is created for them the first time they use AI in a project, and sessions
open and close on their own. You usually don't have to do anything here.

- If a project somehow has no `.showtail/` folder, run `showtail ensure` — it initializes the
  trail at the right place (the git repo root, or the working folder) and opens a session. It is
  safe to run anytime.
- Not sure of the state? `showtail capabilities --json` reports whether tracking is on and what to
  do next, and never errors even in an untracked folder.

## 2. Check the capture mode

Run this once at the start and follow what it says:

```bash
showtail status --json
```

- **`"hooksActive": true`** — hooks already record every student prompt and every file edit
  automatically. **Do nothing else** — just help the student with their work. Don't log
  anything yourself; you'd only create duplicates.
- **`"hooksActive": false`** — nothing is recording automatically. As you work, capture the
  basics yourself, **in the student's voice** (their request, not your narration):
  - log the student's request at the start of each task:
    `showtail log --type prompt --text "<what the student actually asked>"`
  - snapshot each file you create or change: `showtail artifact <path>`

  (Better: suggest the student run `showtail connect claude` to turn hooks on, so this is
  automatic.)

## 3. Wrap up

When the student asks to **"generate a report"**, **"show my work"**, **"wrap up"**, or anything
similar, run it **for** them — don't make them switch to the command line:

```bash
showtail report      # the report for the educator (writes HTML + Markdown under .showtail/reports/)
showtail verify      # checks the trail is complete and consistent
```

Then point them at the generated file. You can also offer this proactively when a chunk of work
looks finished.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of your implementation steps.
- **Hands-free first.** When hooks are on, let capture happen automatically — don't add noise.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed
  to the student's repo.
- **The student is the author.** Showtail documents their process; it does not replace it.

## Command reference

| Command | What it does |
|---|---|
| `showtail ensure [--json]` | Make sure the project is initialized and a session is open (idempotent) |
| `showtail capabilities [--json]` | Report tracking state and what to do next (never errors) |
| `showtail status [--json]` | Current session + whether auto-capture hooks are active |
| `showtail sessions [--json]` | List your work sessions |
| `showtail report [--format json] [--json]` | Generate the report (`--json` prints the written paths) |
| `showtail verify` | Check the trail is valid and consistent |
| `showtail trace <file>` | Show a file's provenance trail |

Tracking turns on automatically at install and each project initializes on first use, so
there's no `setup`/`connect`/`start`/`end` to run. If a student wants to turn tracking off,
that's `showtail setup --off`.

Event types: `prompt`, `ai_output`, `artifact`, `decision` (the student's choice when you pause to
ask via AskUserQuestion) — all captured automatically when hooks are on.
