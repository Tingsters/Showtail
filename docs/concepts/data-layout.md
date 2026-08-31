# Data layout

Showtail stores work in two places: a **project trail** inside each project, and a
**machine-local ledger** outside every project.

## The project trail — `.showtail/`

Each student's writable files are partitioned into their own `authors/<slug>/`
folder, while the content store and project config are shared. That split is
what lets two students merge their trails through git without a conflict.

```text
.showtail/
  config.json                    # shared project settings (version, trailId, name, git, capture & redaction)
  state.json                     # machine-local: active session/author (git-ignored)
  authors/                       # one folder per student, keyed by a slug of their email
    <slug>/
      author.json                # that student's identity (name, email, github login)
      sessions/                  # their work sessions, one shard per machine
        <machineId>.json         # so one student on two machines never merge-conflicts
      journal/                   # their append-only log of events + file snapshots (JSONL segments)
        <machineId>/             # one shard per machine; each line carries `prev`, hash-chaining the shard
                                  # also carries append-only migration audits/metadata overlays
  objects/                       # shared, content-addressed store: prompt/response text & code diffs, deduped
  plans/                         # plan documents a tool wrote, materialized by id
  reports/                       # generated reports (git-ignored — regenerate with `showtail report`)
    report-team-<timestamp>.html       # combined team report (open in a browser)
    report-<slug>-<timestamp>.html     # one per student
    report-*-<timestamp>.md            # Markdown source each HTML is rendered from
    report-*-<timestamp>.json          # machine-readable JSON
  .gitattributes                 # marks the trail binary so EOL rewrites can't break content hashes
  .gitignore                     # ignores state.json and reports/
```

Every path recorded inside the trail is **relative to the project root**, and the
object store is addressed purely by content hash. Nothing here records where the
project sits on disk, which is why the whole folder can be moved, renamed, or
cloned onto another machine and still make sense.

## The machine-local ledger — `~/.showtail-cli/`

Every session is captured to a machine-local ledger *first*, before Showtail works
out which project it belongs to. The project trail is a **projection** of the
sessions the ledger has placed there.

```text
~/.showtail-cli/               # override with SHOWTAIL_HOME
  config.json                  # machine-wide settings, known project paths, upgrade state
  ledger/
    index.json                 # trailId → where that trail currently lives, and what's placed where
    sessions/<led_id>/
      session.json             # which tool, which folder, when
      records.jsonl            # the prompts, replies, and edits themselves
  migrations/
    <run-id>.json              # local progress/results for a bulk upgrade migration
```

This is what stops work being lost when there's no project to put it in — a chat
with no folder open, a scratch directory, a tool whose state lives in your home
folder. That work waits in [`showtail inbox`](../reference/cli.md#manage-the-inbox)
until it has a home.

Unlike the trail, the ledger records **absolute** paths, and it does not travel
with a project folder. So each trail also carries a stable `trailId` in its
`config.json`: the id is what identifies a project, not its path, which is how a
[moved project](../reference/cli.md#moving-a-project) is recognized at its new
location rather than being mistaken for a deleted one.

## Transcript migration records

`showtail migrate` never edits an older journal entry to add fields it did not
originally contain. It appends recovered events plus an `enrichment` audit entry.
That entry records the provider session id, a SHA-256 digest of the source
transcript, the Showtail session it matched, recovered counts, and metadata
overlays such as a missing model or provider source id. Report readers apply the
overlays in memory; the original line remains byte-for-byte intact.

The machine-local bulk manifest may contain project paths so an interrupted
upgrade can resume. The committed project audit deliberately omits absolute
transcript paths and never stores the source transcript itself.

## Identity

Identity is resolved automatically the first time you work in a project — from
`gh auth`, then your `git config user.email`, falling back to a one-time prompt —
and cached per machine.

## See also

- [Why the trail is hard to fake](how-it-works.md#why-the-trail-is-hard-to-fake) — the journal chain and content addressing.
- [Privacy &amp; redaction](privacy.md) — what gets scrubbed, and committing `.showtail/`.
- [Configuration](../reference/configuration.md) — every key in `config.json`.
- [Working as a team](../educators/teams.md) — how the `authors/<slug>/` split merges.
