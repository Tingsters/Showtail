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

- **`"hooksActive": true`** — Codex hooks already record every student prompt and snapshot every
  file you edit with `apply_patch`. **Do nothing else** — just help the student with their work.
  Don't log anything yourself; you'd only create duplicates.
- **`"hooksActive": false`** — nothing is recording automatically. As you work, capture the
  basics yourself, **in the student's voice** (their request, not your narration):
  - log the student's request before you act on it:
    `showtail log --type prompt --text "<what the student actually asked>" --tool codex`
  - snapshot each file you create or change: `showtail artifact <path> --tool codex`

  (Better: suggest the student turn hooks on so this is automatic.)

If there is no `.showtail/` folder yet, have the student run `showtail init` **inside their
project folder**, then `showtail start` to open a session.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of what you did.
- **Hands-free first.** When hooks are on, let capture happen automatically — don't add noise.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

When the work block is done, offer to run `showtail report` (the report for the educator) and
`showtail verify` (checks the trail is complete and consistent).
