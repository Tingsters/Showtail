# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to keep a local,
reviewable trail of the student's prompts, AI replies, and changed files. It is the
student's record of their own work, not AI detection and not a narration of what the
assistant did. Capture stays on this machine: resolved work lives in the project's
`.showtail/`, while unresolved work waits in Showtail's local inbox. Nothing leaves the machine except a sanitised summary the student has reviewed and approved (see "Handing in, and pull requests"); the working trail is private and gitignored.

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

## Handing in, and pull requests

`showtail submit` makes the report to **hand in**: it removes secrets and personal data, re-checks
the result with an independent scan, and writes `showtail-submission/` (the student opens
`report.html`). A report made with the `report` command is the student's own full, **private**
copy — never hand that one in or attach it anywhere.

Resolve the project first, exactly as for `report` and `verify`
(`showtail projects "<student-project-wording>" --json`, and continue only when it selects one
trail). Then pass `--project "<trail-id>"` to every `submit` command below; never build a path
yourself or rely on the shell's working directory.

**Pull requests: ask first, and only the student decides.** When the student asks you to open or
create a pull request (or you have just opened one at their request), ask **once**:

> "Want me to add a short Showtail summary to the PR? I'll show you exactly what it says first, and
> nothing is posted unless you say yes."

- The default is **no**. If they decline, or don't answer, don't post anything and don't ask again
  for that pull request.
- If they say yes:
  1. Run `showtail submit --project "<trail-id>" --pr --preview`. Show the student the **entire
     comment text** it prints and how many values were withheld. If the repository is public, tell
     them the comment will be public and permanent.
  2. Ask them to confirm **that exact text**, and wait for an explicit yes.
  3. Only then run `showtail submit --project "<trail-id>" --pr --approve <code>`, using the code
     the preview printed.
- Never run `--approve` unless the student approved the text you just showed them, in this
  conversation. If the preview or the post is refused ("not submitting", "report changed"), tell
  them plainly what it said and stop. Don't work around it, and don't edit files in
  `showtail-submission/`.
- If the student says they pasted a key or password into a prompt, tell them to **rotate it now**:
  the AI provider already received it, whatever Showtail hides afterwards.
