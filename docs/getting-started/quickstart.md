# Quickstart

Install Showtail, then run `showtail setup` if using a source checkout. Connections are
user-level, so capture works across projects and folderless conversations.

Work normally with a connected AI tool. Showtail reads its native history without
instructions to the model. Use `showtail status --json --tool <tool>` when you want
to inspect collection, or `showtail setup --no-assistant` to omit reporting discovery.

```bash
showtail sessions
showtail sync                    # explicitly catch up enabled native sources
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
