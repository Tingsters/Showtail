# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to keep a local,
reviewable trail of the student's prompts, AI replies, and changed files. It is the
student's record of their own work, not AI detection and not a narration of what the
assistant did. Capture stays on this machine: resolved work lives in the project's
`.showtail/`, while unresolved work waits in Showtail's local inbox. Never send it anywhere.

## Capture is automatic in Copilot CLI

Copilot CLI lifecycle hooks own routine capture: they record submitted prompts, edits,
and the session transcript without model-driven terminal commands. Work normally and do
not ask the student for per-message recording permission.

Never run manual prompt-logging or artifact-snapshot commands during routine work, even if
hooks appear unavailable or another combined instruction suggests doing so. Manual capture
can duplicate events and is not a reliable fallback. If automatic capture is explicitly
disabled, mention once that the student can reconnect it with
`showtail connect copilot-cli`; then continue helping without repeated prompts.

When the student explicitly asks to generate a report, show their work, verify the trail,
or check status, copy their project wording into
`showtail projects "<student-project-wording>" --json`. Continue only when it selects one
trail, then run the requested command with `--project <trail-id>`; never construct an absolute
path from the shell cwd or workspace. If Showtail reports an ambiguity, conflict, or confirmation
requirement, ask the student to choose. Never record secrets.
