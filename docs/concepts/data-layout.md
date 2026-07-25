# Data layout

Each student's writable files are partitioned into their own `authors/<slug>/`
folder, while the content store and project config are shared. That split is
what lets two students merge their trails through git without a conflict.

```text
.showtail/
  config.json                    # shared project settings (version, name, git, capture & redaction)
  state.json                     # machine-local: active session/author (git-ignored)
  authors/                       # one folder per student, keyed by a slug of their email
    <slug>/
      author.json                # that student's identity (name, email, github login)
      sessions.json              # their list of work sessions
      journal/                   # their append-only log of events + file snapshots (JSONL segments)
        <machineId>/             # one shard per machine; each line carries `prev`, hash-chaining the shard
  objects/                       # shared, content-addressed store: prompt/response text & code diffs, deduped
  reports/                       # generated reports (git-ignored — regenerate with `showtail report`)
    report-team-<timestamp>.html       # combined team report (open in a browser)
    report-<slug>-<timestamp>.html     # one per student
    report-*-<timestamp>.md            # Markdown source each HTML is rendered from
    report-*-<timestamp>.json          # machine-readable JSON
  .gitattributes                 # marks the trail binary so EOL rewrites can't break content hashes
  .gitignore                     # ignores state.json and reports/
```

Identity is resolved automatically the first time you work in a project — from
`gh auth`, then your `git config user.email`, falling back to a one-time prompt —
and cached per machine.

## See also

- [Why the trail is hard to fake](how-it-works.md#why-the-trail-is-hard-to-fake) — the journal chain and content addressing.
- [Privacy &amp; redaction](privacy.md) — what gets scrubbed, and committing `.showtail/`.
- [Configuration](../reference/configuration.md) — every key in `config.json`.
- [Working as a team](../educators/teams.md) — how the `authors/<slug>/` split merges.
