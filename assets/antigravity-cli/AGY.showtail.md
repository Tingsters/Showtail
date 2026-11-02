# Showtail: help the student show their work

Showtail records the student's prompts, choices, and file changes automatically in one
private folder, `~/.showtail` (or `SHOWTAIL_HOME`). Projects are optional views of that
history. Never initialize a project trail, add project instructions, or change Git hooks.
The student is the author; do not write a second account of their process.

Check capture once at the start:

```bash
showtail status --json --tool antigravity-cli
```

When the result has `"capture": { "mode": "automatic" }`, work normally without extra logging. In manual or
disconnected mode, keep helping; suggest `showtail connect antigravity-cli` if the student wants
capture. Never silently enable it. Capture stays local. Never log secrets or personal data.

When the student requests a report or wraps up, select the relevant history. For a named
project, copy their wording into `showtail projects "<student-project-wording>" --json`. Use the returned
`selection.projectId`; ask them to choose if the result is ambiguous. Never invent paths.
Then run:

```bash
showtail report --project "<project-id>" --json --no-open
showtail verify --project "<project-id>" --json
```

For folderless conversations, use an explicitly selected `--session <id>` from
`showtail sessions --json`. Use `--all` only when the student requests all history.
Check the returned project ID and `reportPath`. Reports live under Showtail's home,
independently of the project's location. A private report is your full local copy; never hand that one in.

`showtail submit` makes the report to **hand in**: a sanitized, independently scanned, signed submission under
Showtail's `exports/` directory. Open the returned `reportPath`; do not construct a path.

**Pull requests: ask first, and only the student decides.** When asked for a PR, ask once:
"Want me to add a short Showtail summary to the PR? I'll show you exactly what it says
first, and nothing is posted unless you say yes."
The default is **no**; if unanswered or declined, do not post or ask again for that PR.
If accepted, run `showtail submit --project "<project-id>" --pr --preview`. Show the **entire comment text**, the number of values withheld, and whether it will be
public and permanent. Ask the student to confirm **that exact text** before running
`showtail submit --project "<project-id>" --pr --approve <code>`.
Never run `--approve` unless the student approved the text just shown in this conversation.
Only post after they approved the exact text. Never approve changed or refused previews,
and never edit an export to bypass a scan. If a secret was pasted into a prompt,
tell the student to rotate it now; the AI provider already received it.

Nothing leaves the machine except a sanitised summary the student has reviewed and approved
for posting; handing in a submission is a separate, manual action. Use
`showtail verify-submission [dir]` to check an exported submission.
Never choose from the terminal working directory for a named project; use its stable project ID.
Check the returned `projectId` and `projectRoot`; never build a path for a report or submission.

This integration supports Antigravity CLI. Do not rely on the agent terminal's working directory to name another project.
