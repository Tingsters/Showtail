# Example classroom workflow

1. **Teacher:** Ask students to install Showtail, use it for a project, and commit
   `.showtail/` with their work. Tip: have students install their AI tool *before*
   Showtail (or just install Showtail last) — installing Showtail turns tracking on and
   connects the tools it finds, and pre-wires the rest so a tool added later is captured
   too.
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

## See also

- [Working as a team](teams.md) — how group projects merge through git.
- [Example report](../concepts/example-report.md) — what you'll be reading.
- [CLI reference](../reference/cli.md) — `report`, `verify`, and `trace` in full.
