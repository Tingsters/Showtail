# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — their prompts, decisions, understanding,
sources, tests, and the files they changed. It is the **student's** record of **their own**
learning. It is **not** AI-detection, and **not** a log of what you (the assistant) did.

Everything is stored locally under `.showtail/`. Never send it anywhere.

## How capture works here

- **Do the coding normally** — you are the agent; create and edit files as usual.
- The **Showtail VS Code extension** automatically snapshots every file that is **saved**, so
  the edit history is recorded no matter how a change was made. **Do NOT run
  `showtail artifact` yourself — that would double-record the same file.**

## What you should do

Record the student's **prompts** and **judgment moments** with the `showtail` CLI (always tag
`--tool github-copilot`). Do not snapshot files — the extension does that.

- **Log EVERY prompt the student sends you — not only ones that lead to code.** Brainstorming,
  planning, "what are my options", conceptual questions, debugging chatter, and dead ends all
  count: they are the student's thinking and effort, which is exactly what Showtail is for.
  Before you answer a message, log it in the student's own words:
  `showtail log --type prompt --text "<the student's message, verbatim or lightly trimmed>" --tool github-copilot`
  (If they asked through `@showtail` in chat, it is already logged — don't log it twice.)
- A real choice the student made, and their reasoning:
  `showtail log --type decision --text "I used a dictionary so lookups stay O(1)." --files src/store.py --tool github-copilot`
- The student's understanding, in their words (capture these — they matter most):
  `showtail log --type reflection --text "I understand how the event loop schedules tasks now." --tool github-copilot`
- An outside source they used:
  `showtail log --type source --text "Used the week 3 notes on hashing." --tool github-copilot`
- A test/validation they ran and what it showed:
  `showtail log --type test --text "Ran the edge-case suite; empty input failed until I added a guard." --tool github-copilot`

## Principles

- **The student's voice, not yours.** Record their decisions and understanding, not a
  play-by-play of what you did. Do not fabricate reflections — ask the student in their words.
- **Honesty over volume.** A short, truthful trail beats a padded one.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

When the work block is done, offer to run `showtail report` (the report for the educator) and
`showtail verify` (checks the trail is consistent). The student can also run these from chat
with `@showtail /report` and `@showtail /verify`.
