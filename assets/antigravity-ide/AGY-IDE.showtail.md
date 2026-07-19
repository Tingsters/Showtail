# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — the prompts they sent and the files that
changed as you worked together. It is the **student's** record of **their own** work. It is
**not** AI-detection, and **not** a log of what you (the assistant) did.

It is meant to be **hands-free**: when capture hooks are on, the trail builds itself while the
student works. Everything is stored locally under `.showtail/`. Never send it anywhere.

## Check the capture mode first

Run this once at the start and follow what it says:

```bash
showtail status --json
```

- **`"hooksActive": true`** — Antigravity IDE hooks already record every student prompt and
  snapshot every file you edit. **Do nothing else** — just help the student with their work.
  Don't log anything yourself; you'd only create duplicates.
- **`"hooksActive": false`** — nothing is recording automatically. As you work, capture the
  basics yourself, **in the student's voice** (their request, not your narration):
  - log the student's request before you act on it:
    `showtail log --type prompt --text "<what the student actually asked>" --tool antigravity-ide`
  - snapshot each file you create or change: `showtail artifact <path> --tool antigravity-ide`

  (Better: suggest the student turn hooks on so this is automatic. The IDE reads its hooks once
  at startup, so they must **restart Antigravity IDE** after `showtail connect antigravity-ide`.)

Tracking is automatic — it turns on when the student installs Showtail: a
trail is created on first use and sessions open and close on their own. If a project somehow has
no `.showtail/` folder, run `showtail ensure` — it initializes at the right place (the git repo
root, or the working folder) and opens a session. It is safe to run anytime.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of what you did.
- **Hands-free first.** When hooks are on, let capture happen automatically — don't add noise.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

When the student asks to **"generate a report"**, **"show my work"**, or **"wrap up"** (or the
work block is clearly done), run it **for** them — don't make them switch to the command line:
`showtail report` (the report for the educator) and `showtail verify` (checks the trail is
complete and consistent). Then point them at the generated file.
