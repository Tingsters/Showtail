# Privacy &amp; redaction

Showtail is privacy-first by design:

- **Everything is local.** Resolved work lives in the project's `.showtail/`
  trail. Work that does not yet have one safe project destination waits in the
  machine-local ledger/inbox under `~/.showtail-cli/` (or `SHOWTAIL_HOME`).
- **No telemetry, analytics, or automatic upload of your trail.** Captured
  prompts, edits, reports, and project data are not sent to Showtail's
  maintainers or to a Showtail service.
- **Network access is narrow and documented.** Interactive commands may request
  public release metadata from GitHub at most once per day so Showtail can mention
  an available update. The request sends no trail, prompt, filename, project, or
  identity data; disable it with `showtail update --auto-check off` or
  `SHOWTAIL_DISABLE_UPDATE_CHECK=1`. The installers and `showtail update` download
  releases from GitHub; importing a ChatGPT or Gemini share link fetches that link;
  first-run identity discovery may invoke your authenticated GitHub CLI; and
  extension installation may contact the editor's marketplace when no bundled
  VSIX is available. These operations are not telemetry and do not upload a
  `.showtail/` trail.
- **You control what is recorded.** Installation enables supported capture
  integrations by default. Use `showtail setup --off` to stop automatic project
  creation, or `showtail disconnect <tool>` to stop a tool's capture integration.
- **Secrets are scrubbed before storage.** Showtail makes a best-effort pass to
  redact provider keys, tokens, passwords, and personal data (email, phone,
  card, SSN) from captured text *before* it is written, and the report notes how
  many it removed. It is a safety net, not a guarantee — still avoid putting
  secrets in prompts. Tune it under `settings.redact` in `config.json` (see
  [Configuration](../reference/configuration.md#redaction)). When it does miss
  something, `showtail redact` cleans it out after the fact — see
  [If something leaked anyway](#if-something-leaked-anyway).
- **The files are plain and inspectable.** They are JSON and JSONL files that
  you can open in any editor.

## Local project-selection metadata

To keep project controls from following a stale editor workspace, Showtail maintains a small
machine-local catalog keyed by each trail's generated ID. It contains known current/previous
paths, project/folder names, edit-backed ledger references, and local selection bindings. None of
this catalog is written into a project report or uploaded.

The VS Code integration reads only allowlisted fields from the local chat files it already
captures: native session/request IDs, explicitly attached file URIs, edit URIs, and Showtail's own
versioned tool-result marker. It does not inspect VS Code's `state.vscdb`, shell history,
recent-file database, or private Copilot SQLite stores. Automatically attached instructions,
workspace paths, generated titles, and recency cannot select a project by themselves.

Recorded file hashes may validate an already supplied move candidate, but Showtail does not scan
the machine for matching hashes or treat a hash as evidence of the student's current intent.

## If something leaked anyway

Write-time redaction is a safety net, and safety nets have holes: a credential in
a format the rules do not know yet goes into the content-addressed object store
and stays there. You should not have to delete `.showtail/` — and lose your whole
trail — because you pasted a key once. Use `showtail redact`.

```bash
# Preview: what would the current rules remove from everything already stored?
showtail redact --rescan --dry-run

# Apply the current rules (including any settings.redact.custom you added since).
showtail redact --rescan

# Scrub one specific thing you know leaked. This previews by default;
# --yes applies it.
showtail redact --pattern 'dop_v1_[0-9a-f]{32}'
showtail redact --pattern 'dop_v1_[0-9a-f]{32}' --yes
```

A pass rewrites the stored content, files it under its new address, repoints the
journal entry at it, and **deletes the object the secret lived in**. It uses the
same rule engine as capture, so a `settings.redact.custom` pattern you add today
applies retroactively to work captured last week.

### The pass is recorded, on purpose

Rewriting stored content changes the trail's history, and the journal's hash
chain is re-linked so the result still verifies. That is necessary — otherwise a
legitimate scrub would look exactly like tampering — but it would also make the
rewrite invisible. So every pass appends a dated **redaction marker** to the
journal: when it ran, how many entries it touched, how many values it removed,
and which rule labels fired. `showtail verify` prints it beside the chain result:

```text
PASS  journal chain is unbroken
        chain intact; 7 chained journal entries verified.
        1 recorded redaction pass (`showtail redact` removed stored content on
        purpose and re-linked the chain):
          2026-07-25T09:14:02.881Z — pattern: 1 entry rewritten, 1 value(s) removed (pattern).
```

The marker never stores a removed value — nor the `--pattern` you used, since a
pattern is often the secret itself.

`showtail import undo` records the same kind of marker (`reason: import-undo`),
for the same reason: it drops a batch of entries and re-links the chain, which
is also a rewrite. In a git repository these markers do more than disclose —
`verify` reconciles them against the rewrites git history shows, and reports any
rewrite no marker accounts for. See
[Why the trail is hard to fake](how-it-works.md#why-the-trail-is-hard-to-fake).

!!! warning "What the marker is and is not"
    It is an honest disclosure that history was rewritten, not cryptographic
    proof of *which* rewrites happened. The chain check only proves the journal
    is internally consistent, and anything that can write the folder can produce
    a consistent journal. What the marker never does is *excuse* a break: an edit
    made by hand still breaks the following entry's link, and `verify` still
    reports it as unexplained whether or not a marker sits next to it.

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

## External services

Showtail does not operate a cloud service. User-initiated features may interact
with services operated by third parties, subject to their privacy policies:

- [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  for installation, public release checks, updates, and optional identity lookup
  through GitHub CLI.
- [OpenAI](https://openai.com/policies/privacy-policy/) when you import a
  user-supplied ChatGPT shared conversation.
- [Google](https://policies.google.com/privacy) when you import a user-supplied
  Gemini shared conversation or install into Antigravity.
- [Microsoft](https://privacy.microsoft.com/privacystatement) when an editor
  contacts the Visual Studio Marketplace to install the Showtail extension.

Showtail reads local configuration and transcripts created by supported AI tools,
but it does not make model API requests on their behalf.
