# Working as a team

Showtail supports group projects out of the box. Everyone shares one
`.showtail/` folder, but each student's trail is written into their own
`authors/<slug>/` folder, so two people working on different branches never
collide — their trails **merge through git with no conflicts**.

- **Identity is automatic.** The first time you work in a project, Showtail
  figures out who you are from `gh auth`, then `git config user.email`, falling
  back to a one-time prompt. Your work lands in `authors/<your-slug>/`.
- **Reporting is per-student and combined.** With two or more contributors,
  `showtail report` writes a combined **team** report plus one report per contributor.
  A solo project gets one author report. Narrow or override the output with
  `showtail report --team` or `showtail report --author <slug>`; a team report opens
  with a **Contributors** section.
- **Sessions stay yours by default.** `showtail sessions` lists your own
  sessions; add `--all` to see every contributor's.

Solo? Nothing changes — you are simply the only author, and the default output is
your report without a redundant team copy.

## See also

- [Data layout](../concepts/data-layout.md) — the `authors/<slug>/` split that makes conflict-free merges work.
- [Classroom workflow](classroom-workflow.md) — the end-to-end teacher/student flow.
