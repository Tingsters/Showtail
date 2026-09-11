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
student works. Capture stays on this machine: resolved work lives in the project's `.showtail/`,
while unresolved or multi-project work waits in Showtail's local inbox. Never send it anywhere.

## 1. Work normally

Tracking is **automatic** — it turns on when the student installs Showtail (there is no setup
command to run). A trail is created for them the first time they use AI in a project, and sessions
open and close on their own. A missing `.showtail/` folder before the first captured prompt is not
an error and does not need to be created manually.

## 2. Check the capture mode

Run this once at the start and follow what it says:

```bash
showtail status --json --tool claude
```

- **`"capture": { "mode": "automatic" }`** — Claude hooks record the work. Help the student
  normally; do not run extra capture commands because they would duplicate the trail.
- **`"capture": { "mode": "manual" }`** — automatic capture is off. Continue helping without
  creating a second, assistant-written record. If the student wants hands-free capture, suggest
  reconnecting Claude without `--no-hooks`.
- **`"capture": { "mode": "disconnected" }`** — Claude is not connected to Showtail. Continue
  helping, and suggest `showtail connect claude --user` if the student wants automatic capture.

## 3. Record genuine decisions only

Routine prompts and file changes belong to automatic capture. If a trail already exists and the
student explicitly makes a substantive choice whose reasoning would otherwise be lost, you may
record that one decision in the **student's voice**:

```bash
showtail log --type decision --text "<the student's actual choice and reasoning>" --tool claude-code
```

Do not invent decisions, interpretations, or reflections on the student's behalf.

## 4. Wrap up

When the student asks to **"generate a report"**, **"show my work"**, **"wrap up"**, or anything
similar, run it **for** them — don't make them switch to the command line. The startup
capture-mode probe above is intentionally pathless, but project-specific controls must not rely
on Claude's terminal working directory or a model-invented path. Copy the student's project
wording into the local resolver first:

```bash
showtail projects "<student-project-wording>" --json
```

Continue only when it returns one selected trail, then run `status`, `report`, and `verify` with
`--project "<trail-id>"`. If Showtail reports an ambiguity, conflict, or confirmation requirement,
ask the student to choose instead of guessing. Check both the returned `trailId` and `root` before
presenting the result. Then point the student at the generated `reportPath`. You can
also offer this proactively when a chunk of work looks finished.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of your implementation steps.
- **Hands-free first.** Let automatic capture happen in the background without adding noise.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed
  to the student's repo.
- **The student is the author.** Showtail documents their process; it does not replace it.

## Command reference

| Command | What it does |
|---|---|
| `showtail capabilities [--json]` | Report tracking state and what to do next (never errors) |
| `showtail status --json --tool claude` | Claude's current automatic/manual/disconnected capture mode |
| `showtail sessions [--json]` | List your work sessions |
| `showtail projects "<student-project-wording>" --json` | Resolve wording to one validated trail ID or request a choice |
| `showtail status --project "<trail-id>" --json --tool claude` | Inspect the selected trail's state and capture mode |
| `showtail report --project "<trail-id>" --json --no-open` | Generate the selected trail's report and print its path |
| `showtail verify --project "<trail-id>" --json` | Check the selected trail and returned identity |
| `showtail trace <file>` | Show a file's provenance trail |

Tracking turns on automatically at install and each project initializes on first use, so there is
no routine `setup`/`start`/`end` command. `connect` is only for enabling or repairing a tool
integration. `showtail setup --off` disables automatic creation of new project trails but leaves
connected tools and existing trails active; use a bare `showtail disconnect <tool>` to stop that
tool everywhere. Scope flags intentionally perform only a narrower removal.
