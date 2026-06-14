# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — their prompts, decisions, understanding,
sources, tests, and the files they changed. It is the **student's** record of **their own**
learning. It is **not** AI-detection, and **not** a log of what you (the assistant) did.

Everything is stored locally under `.showtail/`. Never send it anywhere.

## Check the capture mode first

Run this once at the start and follow what it says:

```bash
showtail codex status
```

- **`auto-capture: ON`** — Codex hooks already record every student prompt and snapshot every
  file you edit with `apply_patch`. **Do NOT log prompts or run `showtail artifact add`
  yourself** (you'd duplicate them). Focus only on the judgment events below.
- **`auto-capture: OFF`** — nothing is recording automatically. In addition to the judgment
  events below, also:
  - log the student's request, **in their own words**, before you act on it:
    `showtail log --type prompt --text "<what the student actually asked>" --tool codex`
  - snapshot each file you create or change: `showtail artifact add <path> --tool codex`

If there is no `.showtail/` folder yet, have the student run `showtail init` **inside their
project folder**, then `showtail start` to open a session.

## Record the trail — in the STUDENT'S voice

Phrase every event the way the **student** would say it, about what **they** decided, learned,
or did. Always tag `--tool codex`. Log these only when they genuinely happen (don't pad):

- A real choice the student made, and their reasoning:
  `showtail log --type decision --text "I used a dictionary so lookups stay O(1)." --files src/store.py --tool codex`
- The student's understanding, in their words (capture these — they matter most):
  `showtail log --type reflection --text "I understand how the event loop schedules tasks now." --tool codex`
- An outside source they used:
  `showtail log --type source --text "Used the week 3 notes on hashing." --tool codex`
- A test/validation they ran and what it showed:
  `showtail log --type test --text "Ran the edge-case suite; empty input failed until I added a guard." --tool codex`

## Principles

- **The student's voice, not yours.** Record their decisions and understanding, not a
  play-by-play of what you did. Do not fabricate reflections — ask the student in their words.
- **Reflections are the point.** A trail with no reflections fails its purpose.
- **Honesty over volume.** A short, truthful trail beats a padded one.
- **Privacy.** Never log secrets, tokens, or personal information — the trail may be committed.
- **The student is the author.** Showtail documents their process; it does not replace it.

When the work block is done, offer to run `showtail report` (the report for the educator) and
`showtail verify` (checks the trail is complete and consistent).
