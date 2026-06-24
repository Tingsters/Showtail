# Privacy &amp; redaction

Showtail is privacy-first by design:

- **Everything is local.** All data lives in the `.showtail/` folder in your
  project.
- **No telemetry, no analytics, no external API calls.** Ever.
- **You control what is recorded.** Showtail only logs what you explicitly run,
  unless you enable one of the optional capture integrations.
- **Secrets are scrubbed before storage.** Showtail makes a best-effort pass to
  redact provider keys, tokens, passwords, and personal data (email, phone,
  card, SSN) from captured text *before* it is written, and the report notes how
  many it removed. It is a safety net, not a guarantee — still avoid putting
  secrets in prompts. Tune it under `settings.redact` in `config.json` (see
  [Configuration](../reference/configuration.md#redaction)).
- **The files are plain and inspectable.** They are JSON and JSONL files that
  you can open in any editor.

## Committing `.showtail/`

Showtail is designed to be committed into your repository so your educator can
review it. The project-root `.gitignore` does not ignore `.showtail/`.

Showtail writes its own `.showtail/.gitignore` that excludes only the
regenerable, machine-local bits — `state.json` and `reports/`. Everything else,
including every student's `authors/<slug>/` folder and the shared `objects/`
store, is committed, which is what lets teammates' trails merge through git.
(Reports are regenerated with `showtail report`, so they do not need to be
committed.)

Before you commit, remember that your captured prompts become part of your git
history. Redaction helps, but do not rely on it — keep passwords, private
personal information, and anything you would not want shared out of your prompts
while capture is on.

If a project is sensitive, you can add `.showtail/` to your project-root
`.gitignore` and share reports another way.
