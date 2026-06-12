---
applyTo: "**"
---

# Showtail provenance (agent mode)

This project records a "show your work" trail with [Showtail](https://github.com/Tingsters/Showtail).
Do the coding normally — you are the agent. As you work, record the student's **prompt** and
their **judgment moments** in the **student's own voice** using the `showtail` CLI, always
tagging `--tool github-copilot`:

- log **every** prompt the student sends you — including brainstorming, planning, and
  conceptual questions, not only code requests — in their own words:
  `showtail log --type prompt --text "<their message>" --tool github-copilot`
  (skip if they asked through `@showtail` — it's already logged);
- decisions they made (and why), reflections (what they understood), sources they used, tests
  they ran. Link files with `--files path`.

**Do NOT run `showtail artifact add`** — the Showtail VS Code extension already snapshots every
saved file, so running it yourself would double-record. Do not narrate your own actions or
fabricate reflections. Offer `showtail report` and `showtail verify` when a work block ends.
Never log secrets.
