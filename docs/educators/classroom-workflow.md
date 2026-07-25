# Example classroom workflow

1. **Teacher:** Ask students to install Showtail, use it for a project, and commit
   `.showtail/` with their work. **Tip: have students install their AI tool *before*
   Showtail** (or just install Showtail last). Installing Showtail turns tracking on and
   connects the tools it finds; if a student installs a tool *afterward*, it's connected
   automatically the next time they use any already-connected tool — so installing the AI
   tool first is the surest path.
2. **Student:** Install Showtail. That's it — tracking is on, no command to run. (To turn
   it off: `showtail setup --off`.)
3. **Student:** Work on the project as usual — prompts and edits are captured for
   you. On a group project, each teammate's trail lands in their own
   `authors/<slug>/` folder and merges through git without conflicts.
4. **Student:** Before submitting, run `showtail verify`, then commit everything,
   including `.showtail/`. (Reports are regenerable and git-ignored by default —
   no need to commit them.)
5. **Teacher:** Run `showtail report` to (re)generate the trail, then open
   `.showtail/reports/report-team-*.html` for the whole group, or a
   `report-<student>-*.html` for one student. The Markdown source sits beside
   each.
6. **Teacher:** Run `showtail verify` or `showtail trace <file>` when a deeper
   review is needed.

The goal is not to catch anyone. The goal is to make the process visible and
give students a structured way to demonstrate genuine understanding.

**Grading a whole class?** Put the [Showtail GitHub Action](verify-in-ci.md) in
your assignment template repo and step 6 happens by itself: every submission's
trail is verified on push, with a pass/fail summary in the Checks tab.

## Which tools are covered

Installing Showtail turns on capture automatically for these, hands-off (it installs the
VS Code / Antigravity extension for you when it finds those editors):

- **Claude Code**, **OpenAI Codex**, **Gemini CLI**, **GitHub Copilot CLI**
- **GitHub Copilot in VS Code** (via the auto-installed Showtail extension)
- **Antigravity** (CLI and IDE)

**Not yet covered** (they need their own integration — capture won't happen automatically):
**Cursor**, **Windsurf**, **JetBrains** IDEs, **Zed**, and similar. **ChatGPT** and **Gemini**
on the web are *import-based* — there are no hooks to install, so a student brings a shared
conversation in after the fact (see the integration guides). If your class uses one of the
uncovered tools, let us know.

**A few tools need one small, one-time step the first time the student uses them** (Showtail
can't do these for them — they're the tool's own gates):

- **OpenAI Codex** — approves ("trusts") Showtail's hooks the first time `codex` runs.
- **Gemini CLI** — the student signs in to Gemini and trusts the working directory (their
  normal Gemini setup).
- **Antigravity IDE** — reload/reopen the IDE once so the just-installed extension activates.

After that one step, capture is automatic. **No student ever needs to run a Showtail command
to start** — capture and identity are handled for them (see below).

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
  the updated tool on upgrade (and again the next time any `showtail` command runs), so the
  fix lands without students touching anything tool-specific.
- **`showtail` must be on PATH** for the AI tools to invoke it. The installer sets this up
  automatically (it adds the bin dir to the shell profile); students may need to open a new
  terminal once for it to take effect.

## See also

- [Verify submissions in CI](verify-in-ci.md) — the GitHub Action for assignment repos.
- [Working as a team](teams.md) — how group projects merge through git.
- [Example report](../concepts/example-report.md) — what you'll be reading.
- [CLI reference](../reference/cli.md) — `report`, `verify`, and `trace` in full.
