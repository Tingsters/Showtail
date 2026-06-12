---
applyTo: "**"
---

# Showtail provenance (agent mode)

This project records a "show your work" trail with [Showtail](https://github.com/Tingsters/Showtail).
As you work, record the student's **judgment moments** in the **student's own voice** using the
`showtail` CLI, always tagging the tool with `--tool github-copilot`:

- decisions the student made (and why), reflections (what they understood), sources they used,
  tests they ran. Link files with `--files path`.
- If the student's request did not come through `@showtail`, also log it so it isn't lost:
  `showtail log --type prompt --text "<their request>" --tool github-copilot`.

Do **not** narrate your own actions or fabricate reflections — ask the student in their words.
File edits are snapshotted automatically by the Showtail VS Code extension. Offer
`showtail report` and `showtail verify` when a work block ends. Never log secrets.
