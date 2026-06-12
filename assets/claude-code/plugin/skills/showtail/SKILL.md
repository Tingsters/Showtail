---
name: showtail
description: Help a student show THEIR work with Showtail while pairing with Claude. Record the student's prompts, decisions, reflections, sources, tests, and artifacts into a local trail, and generate or verify the report. Use when working in a project that has a .showtail/ folder, or when the user mentions Showtail or wants to "show their work".
allowed-tools: Bash(showtail *)
---

# Showtail: help the student show THEIR work

[Showtail](https://github.com/Tingsters/Showtail) records a local, reviewable trail of **how
the student built their project** — their prompts, their decisions, their understanding, the
sources they used, the tests they ran, the files they changed. It is the **student's** record
of **their own** learning. It is **not** a log of what you (Claude) did, and **not**
AI-detection.

Everything is stored locally under `.showtail/`. Never send it anywhere.

## 0. Check the capture mode first

Run this once at the start and follow what it says:

```bash
showtail skill status
```

- **`auto-capture: ON`** — hooks already record every student prompt and every file edit
  automatically. **Do NOT log prompts or file snapshots yourself** (you'd duplicate them).
  Focus only on the judgment events in step 2.
- **`auto-capture: OFF`** — nothing is recording automatically. In addition to step 2, you
  must also:
  - log the student's request, **in their own words**, at the start of each task:
    `showtail log --type prompt --text "<what the student actually asked>"`
  - snapshot each file you create or change: `showtail artifact add <path>`

## 1. Make sure a session exists

- If there is no `.showtail/` folder yet, have the student run `showtail init` **inside their
  project folder** — not their home directory (initializing in `~` makes every folder look
  like one project).
- Then ensure a session: `showtail start`.

## 2. Record the trail — in the STUDENT'S voice

The report goes to an educator to show the **student's** thinking. Phrase every event the way
the **student** would say it, about what **they** decided, learned, or did. Do **not** narrate
your own implementation steps, and do **not** add meta-commentary about Showtail itself.

Log these only when they genuinely happen (don't pad):

- **decision** — a real choice the student made, and their reasoning:
  `showtail log --type decision --text "I used a dictionary so name lookups stay O(1)." --files src/store.py`
  (Not: "Created a project to demonstrate Showtail.")
- **reflection** — the student's understanding, in their words. When you explain something and
  they get it, or they articulate what they learned, capture it — **these matter most, don't
  skip them**: `showtail log --type reflection --text "I understand how recursion unwinds the call stack now."`
- **source** — outside material the student drew on:
  `showtail log --type source --text "Used the week 3 lecture notes on tokenizers."`
- **test** — validation the student ran and what it showed:
  `showtail log --type test --text "Ran the edge-case tests; the empty-input case failed until I added a guard." --files tests/test_greet.py`

## 3. Wrap up

Offer to run `showtail report` (the Markdown report for the educator) and `showtail verify`
(checks the trail is complete and consistent).

## Principles

- **The student's voice, not yours.** Capture their decisions and understanding, not a
  play-by-play of what you did.
- **Reflections are the point.** Actively capture what the student understands — a trail with
  no reflections fails its purpose.
- **Honesty over volume.** A short, truthful trail beats a padded one.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed
  to the student's repo.
- **The student is the author.** Showtail documents their process; it does not replace it.

## Command reference

| Command | What it does |
|---|---|
| `showtail skill status` | Report whether auto-capture hooks are active |
| `showtail init` | Create the `.showtail/` folder (run in the project folder) |
| `showtail start` | Begin a work session |
| `showtail log --type <type> --text "..." [--files a,b] [--tags x,y]` | Record one event |
| `showtail artifact add <file>` | Snapshot a file (SHA-256 + git commit) |
| `showtail trace <file>` | Show a file's provenance trail |
| `showtail report [--format json]` | Generate the report |
| `showtail verify` | Check the trail is valid and consistent |

Event types: `prompt`, `ai_output`, `human_edit`, `decision`, `reflection`, `source`, `test`,
`artifact`.
