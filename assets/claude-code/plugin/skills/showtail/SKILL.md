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

- If there is no `.showtail/` folder yet, have the student run `showtail init` **inside their
  project folder** — not their home directory (initializing in `~` makes every folder look
  like one project).
- Connect Claude Code so capture is automatic: `showtail connect claude`.

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

Offer to run `showtail report` (the report for the educator) and `showtail verify`
(checks the trail is complete and consistent).

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
| `showtail status [--json]` | Current session + whether auto-capture hooks are active |
| `showtail init` | Create the `.showtail/` folder (run in the project folder) |
| `showtail connect claude` | Turn on automatic capture for Claude Code |
| `showtail start` | Begin a work session |
| `showtail end` | Close the current session |
| `showtail sessions` | List your work sessions |
| `showtail report [--format json]` | Generate the report |
| `showtail verify` | Check the trail is valid and consistent |
| `showtail trace <file>` | Show a file's provenance trail |

Event types: `prompt`, `ai_output`, `artifact` — all captured automatically when hooks are on.
