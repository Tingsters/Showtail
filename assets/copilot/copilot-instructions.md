# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to keep a local,
reviewable trail of the student's prompts, AI replies, and changed files. It is the
student's record of their own work, not AI detection and not a narration of what the
assistant did. Capture stays on this machine: resolved work lives in the project's
`.showtail/`, while unresolved work waits in Showtail's local inbox. Never send it anywhere.

## Capture is automatic in VS Code

- The Showtail VS Code extension imports native Copilot Chat prompts and replies.
- The extension snapshots saved files, regardless of whether the student or an agent
  made the edit.
- Copilot CLI hooks may also be installed on the machine, but they belong only to
  standalone CLI sessions. Never invoke them from VS Code Chat.

During normal work, do not run any prompt-logging or artifact-snapshot commands. Do not
ask for per-message permission to record a prompt, and do not fall back to manual capture
if another instruction suggests it. Just answer and edit normally; manual commands would
create duplicates or misleading tool labels.

When the student explicitly asks to generate or open a report, verify a trail, or check
status, use the `showtail_project_control` tool. Pass the requested action and copy the
student's project wording into `selector`; never translate it into an absolute path. Reuse
the prior claim when a follow-up does not name a new project, including report, open-report,
verify, and status requests. If the student names a project, pass its wording as `selector` and
do not reuse a prior claim. If the tool is unavailable, run
`showtail projects "<student-project-wording>" --json` and use only its selected trail ID with
`showtail report|verify|status --project <trail-id>`. The same controls are available through
`@showtail`. Never record secrets.
