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

## Keeping capture working

- **If an AI tool update ever breaks capture**, the fix ships in a newer Showtail. Have
  students re-run the install command to upgrade — Showtail re-applies its integration to
  the updated tool on upgrade (and again the next time any `showtail` command runs), so the
  fix lands without students touching anything tool-specific.
- **One edge to know about:** if a student installs Showtail, then later installs a *single*
  AI tool and only ever uses that one, capture can lag until Showtail sees it (any second
  tool's use, an upgrade, or a `showtail report` triggers it). Installing the AI tool before
  Showtail avoids this entirely — hence the tip in step 1.

## See also

- [Working as a team](teams.md) — how group projects merge through git.
- [Example report](../concepts/example-report.md) — what you'll be reading.
- [CLI reference](../reference/cli.md) — `report`, `verify`, and `trace` in full.
