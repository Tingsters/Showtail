# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to keep a local,
reviewable trail of the student's prompts, AI replies, and changed files. It is the
student's record of their own work, not AI detection and not a narration of what the
assistant did. Everything stays under `.showtail/`; never send it anywhere.

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
or check status, you may run `showtail report`, `showtail verify`, or `showtail status` for
them. Never record secrets.
