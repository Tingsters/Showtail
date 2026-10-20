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
while unresolved or multi-project work waits in Showtail's local inbox. Nothing leaves the machine except a sanitised summary the student has reviewed and approved (see "Handing in, and pull requests"); the working trail is private and gitignored.

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

## 5. Handing in, and pull requests

`showtail submit` makes the report to **hand in**: it removes secrets and personal data, re-checks
the result with an independent scan, and writes `showtail-submission/` (the student opens
`report.html`). A report made with the `report` command is the student's own full, **private**
copy — never hand that one in or attach it anywhere.

Resolve the project first, exactly as for `report` and `verify`
(`showtail projects "<student-project-wording>" --json`, and continue only when it selects one
trail). Then pass `--project "<trail-id>"` to every `submit` command below; never build a path
yourself or rely on the shell's working directory.

**Pull requests: ask first, and only the student decides.** When the student asks you to open or
create a pull request (or you have just opened one at their request), ask **once**:

> "Want me to add a short Showtail summary to the PR? I'll show you exactly what it says first, and
> nothing is posted unless you say yes."

- The default is **no**. If they decline, or don't answer, don't post anything and don't ask again
  for that pull request.
- If they say yes:
  1. Run `showtail submit --project "<trail-id>" --pr --preview`. Show the student the **entire
     comment text** it prints and how many values were withheld. If the repository is public, tell
     them the comment will be public and permanent.
  2. Ask them to confirm **that exact text**, and wait for an explicit yes.
  3. Only then run `showtail submit --project "<trail-id>" --pr --approve <code>`, using the code
     the preview printed.
- Never run `--approve` unless the student approved the text you just showed them, in this
  conversation. If the preview or the post is refused ("not submitting", "report changed"), tell
  them plainly what it said and stop. Don't work around it, and don't edit files in
  `showtail-submission/`.
- If the student says they pasted a key or password into a prompt, tell them to **rotate it now**:
  the AI provider already received it, whatever Showtail hides afterwards.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of your implementation steps.
- **Hands-free first.** Let automatic capture happen in the background without adding noise.
- **Privacy.** Never log secrets, tokens, or personal information. The working trail is private and gitignored; only `showtail submit` produces something shareable.
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
| `showtail submit --project "<trail-id>"` | Make the sanitised report to hand in (`showtail-submission/`) |
| `showtail submit --project "<trail-id>" --pr --preview` | Show the exact PR comment and its approval code; posts nothing |
| `showtail submit --project "<trail-id>" --pr --approve <code>` | Post exactly the previewed comment (only after the student approves it) |
| `showtail verify-submission [dir]` | Check a submission is unchanged since it was signed |
| `showtail trace <file>` | Show a file's provenance trail |

Tracking turns on automatically at install and each project initializes on first use, so there is
no routine `setup`/`start`/`end` command. `connect` is only for enabling or repairing a tool
integration. `showtail setup --off` disables automatic creation of new project trails but leaves
connected tools and existing trails active; use a bare `showtail disconnect <tool>` to stop that
tool everywhere. Scope flags intentionally perform only a narrower removal.
