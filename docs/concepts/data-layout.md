# Data layout

All Showtail-owned history and state live under `~/.showtail/` on every platform.
`SHOWTAIL_HOME` can select another absolute directory, including a `~/` prefix.
The location never depends on the current working directory.

```text
~/.showtail/
  history.sqlite          # sessions, records, hashed content, project views, import provenance
  history.sqlite-wal      # SQLite runtime sidecar, when WAL is supported
  history.sqlite-shm      # SQLite runtime sidecar
  config.json             # capture preferences and user-level connection state
  identity.json           # local identity
  signing-key.json        # submission-signing key; private
  capture-consent/         # per-tool capture switches and resume boundaries
  pending/                # redacted capture batches waiting for a database write
  reports/<id>/           # private HTML, Markdown, and JSON snapshots
  exports/<id>/           # sanitized reports and signed manifests
  logs/                   # capture issue categories; no raw payloads
```

`showtail home --open` opens this directory. Projects contain no Showtail files.
Tool registration entries and installed skills live in the host tools' user settings.
The executable and editor extension retain their normal installation locations.

Back up the entire folder while capture is stopped. Do not copy only the SQLite file
while writers are running: a WAL sidecar can contain committed work.
