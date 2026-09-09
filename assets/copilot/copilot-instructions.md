# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to keep a local,
reviewable trail of the student's prompts, AI replies, and changed files. It is the
student's record of their own work, not AI detection and not a narration of what the
assistant did. Everything stays under `.showtail/`; never send it anywhere.

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

When the student explicitly asks to generate a report, show their work, verify the trail,
or check status, you may run `showtail report`, `showtail verify`, or `showtail status` for
them. The same controls are available through `@showtail`. Never record secrets.
