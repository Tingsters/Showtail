# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — their prompts, decisions, understanding,
sources, tests, and the files they changed. It is the **student's** record of **their own**
learning. It is **not** AI-detection, and **not** a log of what you (the assistant) did.

Everything is stored locally under `.showtail/`. Never send it anywhere.

## How capture works here

- The **Showtail VS Code extension** automatically snapshots every file that is saved, so the
  edit history is recorded no matter how a change was made.
- Prompts are captured **when the student asks through `@showtail`** in chat. Encourage the
  student to ask via `@showtail` so their prompts become part of their trail.

## What you should do

When you help with this project, record the **judgment moments** in the **student's voice**,
using the `showtail` CLI (always tag the tool):

- A real choice the student made, and their reasoning:
  `showtail log --type decision --text "I used a dictionary so lookups stay O(1)." --files src/store.py --tool github-copilot`
- The student's understanding, in their words (capture these — they matter most):
  `showtail log --type reflection --text "I understand how the event loop schedules tasks now." --tool github-copilot`
- An outside source they used:
  `showtail log --type source --text "Used the week 3 notes on hashing." --tool github-copilot`
- A test/validation they ran and what it showed:
  `showtail log --type test --text "Ran the edge-case suite; empty input failed until I added a guard." --files tests/test_x.py --tool github-copilot`

If you are in agent mode and the student's prompt was not asked through `@showtail`, also log it
so it isn't lost:
`showtail log --type prompt --text "<the student's request, in their words>" --tool github-copilot`

## Principles

- **The student's voice, not yours.** Record their decisions and understanding, not a
  play-by-play of what you did. Do not fabricate reflections — ask the student in their words.
- **Honesty over volume.** A short, truthful trail beats a padded one.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

When the work block is done, offer to run `showtail report` (the report for the educator) and
`showtail verify` (checks the trail is consistent).
