# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — the prompts they sent and the files that
changed as you worked together. It is the **student's** record of **their own** work. It is
**not** AI-detection, and **not** a log of what you (the assistant) did.

Everything is stored locally under `.showtail/`. Never send it anywhere.

## How capture works here

- **Do the coding normally** — you are the agent; create and edit files as usual.
- The **Showtail VS Code extension** automatically snapshots every file that is **saved**, so
  the edit history is recorded no matter how a change was made. **Do NOT run
  `showtail artifact` yourself — that would double-record the same file.**

## What you should do

Copilot has no automatic prompt-capture hooks, so record the student's **prompts** with the
`showtail` CLI (always tag `--tool github-copilot`). That's it — don't snapshot files (the
extension does that), and don't narrate your own work.

- **Log EVERY prompt the student sends you — not only ones that lead to code.** Brainstorming,
  planning, "what are my options", conceptual questions, debugging chatter, and dead ends all
  count: they are the student's thinking and effort, which is exactly what Showtail is for.
  Before you answer a message, log it in the student's own words:
  `showtail log --type prompt --text "<the student's message, verbatim or lightly trimmed>" --tool github-copilot`
  (If they asked through `@showtail` in chat, it is already logged — don't log it twice.)

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of what you did.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

When the work block is done, offer to run `showtail report` (the report for the educator) and
`showtail verify` (checks the trail is consistent). The student can also run these from chat
with `@showtail /report` and `@showtail /verify`.
