# Showtail: help the student show THEIR work

This project uses [Showtail](https://github.com/Tingsters/Showtail) to record a local,
reviewable trail of **how the student built it** — the prompts they sent and the files that
changed as you worked together. It is the **student's** record of **their own** work. It is
**not** AI-detection, and **not** a log of what you (the assistant) did.

It is meant to be **hands-free**: when capture hooks are on, the trail builds itself while the
student works. Capture stays on this machine: resolved work lives in the project's `.showtail/`,
while unresolved or multi-project work waits in Showtail's local inbox. Nothing leaves the machine except a sanitised summary the student has reviewed and approved (see "Handing in, and pull requests"); the working trail is private and gitignored.

## Check the capture mode first

Run this once at the start and follow what it says:

```bash
showtail status --json --tool antigravity-ide
```

- **`"capture": { "mode": "automatic" }`** — the Showtail integration records the work. Help
  the student normally; do not run extra capture commands because they would duplicate the trail.
- **`"capture": { "mode": "manual" }`** — automatic capture is off. Continue helping without
  creating a second, assistant-written record. If the student wants hands-free capture, suggest
  reconnecting Antigravity IDE and restarting the IDE when prompted.
- **`"capture": { "mode": "disconnected" }`** — Antigravity IDE is not connected to Showtail.
  Continue helping, and suggest `showtail connect antigravity-ide --user` if the student wants
  automatic capture.

Tracking is automatic. Work in the project normally and its `.showtail/` trail stays with it;
there is no routine initialization or session-start command. A missing `.showtail/` folder before
the first captured prompt is not an error and does not need to be created manually.

## Principles

- **The student's record, not yours.** The trail is their prompts and their files, not a
  play-by-play of what you did.
- **Hands-free first.** Let automatic capture happen in the background without adding noise.
- **Privacy.** Never log secrets, tokens, or personal information. The working trail is private and gitignored; only `showtail submit` produces something shareable.
- **The student is the author.** Showtail documents their process; it does not replace it.

## Project controls resolve stable trail IDs

The startup capture-mode probe above is intentionally pathless. For a project-specific control
action, do not rely on the agent terminal's working directory or invent an absolute path. Copy the
student's project wording into Showtail's resolver first:

```bash
showtail projects "<student-project-wording>" --json
```

Continue only when it returns one selected trail, then use `--project "<trail-id>"` for status,
report, and verify. If Showtail reports an ambiguity, conflict, or confirmation requirement, ask
the student to choose. Check both the returned `trailId` and `root` before presenting a result.

When the student asks to **"generate a report"**, **"show my work"**, or **"wrap up"** (or the
work block is clearly done), run `report` and `verify` for that selected trail, then point them
at the generated `reportPath`.

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
