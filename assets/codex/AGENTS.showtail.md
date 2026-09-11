# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — the prompts they sent and the files that
changed as you worked together. It is the **student's** record of **their own** work. It is
**not** AI-detection, and **not** a log of what you (the assistant) did.

It is meant to be **hands-free**: when capture hooks are on, the trail builds itself while the
student works. Capture stays on this machine: resolved work lives in the project's `.showtail/`,
while unresolved or multi-project work waits in Showtail's local inbox. Never send it anywhere.

## Check the capture mode first

Run this once at the start and follow what it says:

```bash
showtail status --json --tool codex
```

- **`"capture": { "mode": "automatic" }`** — Codex hooks record the work. Help the student
  normally; do not run extra capture commands because they would duplicate the trail.
- **`"capture": { "mode": "manual" }`** — automatic capture is off. Continue helping without
  creating a second, assistant-written record. If the student wants hands-free capture, suggest
  reconnecting Codex without `--no-hooks`.
- **`"capture": { "mode": "disconnected" }`** — Codex is not connected to Showtail. Continue
  helping, and suggest `showtail connect codex --user` if the student wants automatic capture.

Tracking is automatic. Work in the project normally and its `.showtail/` trail stays with it;
there is no routine initialization or session-start command. A missing `.showtail/` folder before
the first captured prompt is not an error and does not need to be created manually.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of what you did.
- **Hands-free first.** Let automatic capture happen in the background without adding noise.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

## Project controls resolve stable trail IDs

The startup capture-mode probe above is intentionally pathless. For a project-specific control
action, do not rely on the agent terminal's working directory and do not invent an absolute path.
Copy the student's project wording into the local resolver first:

```bash
showtail projects "<student-project-wording>" --json
```

Continue only when it returns one selected trail. Use that stable ID for the requested controls:

```bash
showtail status --project "<trail-id>" --json --tool codex
showtail report --project "<trail-id>" --json --no-open
showtail verify --project "<trail-id>" --json
```

If Showtail reports an ambiguity, conflict, or confirmation requirement, ask the student to
choose instead of guessing. Check both the returned `trailId` and `root` before presenting a
result. Workspace folders, recency, and model-authored terminal paths are not project identity.

When the student asks to **"generate a report"**, **"show my work"**, or **"wrap up"** (or the
work block is clearly done), run `report` and `verify` for that selected trail, then point them
at the generated `reportPath`.
