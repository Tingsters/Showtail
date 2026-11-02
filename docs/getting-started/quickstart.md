# Quickstart

Install Showtail, then run `showtail setup` if using a source checkout. Connections are
user-level, so capture works across projects and folderless conversations.

Work normally with a connected AI tool. Check `showtail status --json --tool <tool>`
for its capture mode; do not manually log prompts while automatic capture is active.

```bash
showtail sessions
showtail report                 # current known project, otherwise choose a scope
showtail report --all            # intentionally review all history
showtail submit                 # sanitized, signed report to hand in
showtail home --open             # locate your reports and history
```

Everything is saved under `~/.showtail`, or `SHOWTAIL_HOME`. Project directories remain
untouched. `showtail setup --off` pauses automatic capture; `showtail disconnect <tool>`
stops one tool. History is retained.

For old versions, preview `showtail import legacy --from <old-location> --dry-run`
before importing. Include both the old machine ledger and selected project trails to
recover all work; duplicate projections are recognized by their provenance.
