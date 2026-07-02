# Example classroom workflow

1. **Teacher:** Ask students to use Showtail for a project and commit
   `.showtail/` with their work.
2. **Student:** Run `showtail setup` once (or `showtail init` then
   `showtail connect <tool>` per project) to turn on automatic capture.
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
