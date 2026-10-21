# Example classroom workflow

1. **Teacher:** Ask students to install Showtail, use it for a project, and hand in the
   report `showtail submit` makes. (Their working trail stays private on their machine; see
   [Sharing your work safely](../concepts/sharing.md).) **Tip: have students install their AI tool *before*
   Showtail** (or just install Showtail last). Installing Showtail turns automatic project
   tracking on and connects the tools it finds. A later sweep can connect a tool installed
   afterward, but first-session capture is not guaranteed; run
   `showtail connect <tool>` before that session when first-turn capture matters.
2. **Student:** Install Showtail. For a successfully connected tool, that's it — there is no
   project setup command to run. To stop creating new project trails automatically, use
   `showtail setup --off`; to stop capture from a tool, use
   `showtail disconnect <tool>`.
3. **Student:** Work on the project as usual — prompts and edits are captured for
   you. Nothing sensitive is ever committed by accident: `.showtail/` ignores itself.
4. **Student:** When finished, run `showtail submit`. It removes secrets and personal data,
   checks the result a second time, and writes `showtail-submission/`. They hand in
   `report.html` the way they would any assignment (upload it to your LMS), or, on a
   group project, commit the `showtail-submission/` folder.
5. **Teacher:** Open `report.html`. It is an ordinary web page, so there is nothing to
   install. To check the file is unchanged since it was signed, run
   `showtail verify-submission <folder>` (this needs Showtail, and shows the file was not
   edited, not who made it).
6. **Teacher:** For a deeper review, see
   [Stronger checks](#stronger-checks-for-a-course-repo) below.

The goal is not to catch anyone. The goal is to make the process visible and
give students a structured way to demonstrate genuine understanding.

## Stronger checks for a course repo

The default keeps each student's raw trail on their own machine, which is what keeps
secrets out of git. If you want Showtail to verify the **trail itself** (its hash chain
and its history in git), set `"commitTrail": true` under `settings` in the assignment
template's `.showtail/config.json`. Then `.showtail/` is committed with the student's
work, `showtail verify` can use git history as an outside anchor, and the
[Showtail GitHub Action](verify-in-ci.md) works on every push.

Know the trade-off before you choose it: a committed trail is only as safe as capture-time
redaction, which is best-effort, so tell students plainly that their prompts become part of
the repository, and that a real key pasted into a prompt must be rotated. Without
`commitTrail`, the git-history check has nothing to read; use the Action's
[`mode: submission`](verify-in-ci.md#verifying-the-submission-instead) to verify the signed
submission instead.

## Which tools are covered

The installer attempts hands-off capture setup for these tools (including the VS Code and
Antigravity extensions when it finds those editors):

- **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI**
- **GitHub Copilot in VS Code** (via the auto-installed Showtail extension)
- **Antigravity** (CLI and IDE)

The installer reports integrations that are connected, pending, or failed instead of
claiming success for an extension it could not install. Students can confirm one tool with
`showtail status --tool <tool>` and retry it with `showtail connect <tool>`.

**Not yet covered** (they need their own integration — capture won't happen automatically):
**Cursor**, **Windsurf**, **JetBrains** IDEs, **Zed**, and similar. **ChatGPT** and **Gemini**
on the web are *import-based* — there are no hooks to install, so a student brings a shared
conversation in after the fact (see the integration guides). If your class uses one of the
uncovered tools, let us know.

**A few tools need one small, one-time step the first time the student uses them** (Showtail
can't do these for them — they're the tool's own gates):

- **OpenAI Codex** — approves ("trusts") Showtail's hooks the first time `codex` runs.
- **Antigravity IDE** — reload/reopen the IDE once so the just-installed extension activates.

After a successful connection and any host approval, capture is automatic. The project
itself needs no `init`, `track`, or `start` command: its trail is created by the first
meaningful prompt.

## Identity — students don't need to set up git first

Attribution is automatic and never blocks capture:

- If a student has git or GitHub set up (as they will to collaborate), their work is
  captured under their **real identity** from the start.
- If they have neither yet, Showtail captures under a **temporary computer-derived name**
  (e.g. `alice@alices-macbook.local`) so **nothing is ever lost**, and it lives in a normal
  committable folder — so it's included in whatever you collect (git, zip, upload).
- The moment a real identity appears — which happens automatically when they set
  `git config user.email` to commit/collaborate — Showtail **re-attributes the earlier work
  to their real identity** and drops the placeholder. Teammates only ever see real, per-student
  folders (they merge conflict-free).

## Keeping capture working

- **If an AI tool update ever breaks capture**, the fix ships in a newer Showtail. Have
  students re-run the install command to upgrade — Showtail re-applies its integration to
  the updated tool on a later sweep. Pending or failed refreshes remain retryable and are
  surfaced rather than recorded as successful; `showtail connect <tool>` retries directly.
- **`showtail` must be on PATH** for the AI tools to invoke it. The installer sets this up
  automatically (it adds the bin dir to the shell profile); students may need to open a new
  terminal once for it to take effect.

## See also

- [Verify submissions in CI](verify-in-ci.md) — the GitHub Action for assignment repos.
- [Working as a team](teams.md) — how group projects merge through git.
- [Example report](../concepts/example-report.md) — what you'll be reading.
- [CLI reference](../reference/cli.md) — `report`, `verify`, and `trace` in full.
