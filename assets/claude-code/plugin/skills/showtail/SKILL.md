---
name: showtail
description: Review local Showtail history or create, verify, and export a Showtail report when the user explicitly requests Showtail. Ordinary coding, commits, pull requests, and wrap-ups do not invoke this skill.
---

Resolve a named project with `showtail projects "<user wording>" --json`.
Use the returned `selection.projectId`; ask the user to choose if ambiguous.
Never infer another project's location from the terminal directory.
For a folderless conversation, select an explicit ID from `showtail sessions --json`.
Use `--all` only when requested.

Generate with `showtail report --project "<id>" --json --no-open`, then
`showtail verify --project "<id>" --json`. Use `--session` for a selected conversation.
Check the returned project ID and use the returned `reportPath`.
Status is available through `showtail status --json` when requested.

Reports are private local copies. For a submission or explicitly requested PR
summary, read [submission.md](submission.md) before using `showtail submit`.
