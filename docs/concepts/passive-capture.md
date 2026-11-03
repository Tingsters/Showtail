# Passive capture

Showtail reads native conversation history. The model does not check capture status,
log prompts, announce capture, offer PR summaries, or generate reports at wrap-up.
Normal coding sees only the small reporting-skill discovery description; the full
instructions load on request.

`showtail setup` registers user-level observer callbacks or an editor extension and
a small reporting skill. Use `--no-assistant` to omit the reporting skill while
keeping collection. `connect <tool> --assistant` enables discovery again.
The skill only applies when you request Showtail. It does not grant tool permissions.

## Collection

Hooks queue source identifiers and path hints, without prompt text or tool output.
A detached worker reads the native source, redacts captured content, and commits it
to the central ledger. The worker exits after draining; there is no resident process,
login service, or scheduled watcher. Editor integrations watch native history while
the editor is running. Showtail never resumes a model conversation to collect it.

| Source | Collection |
| --- | --- |
| Claude Code | Native JSONL, lifecycle notifications, and successful-edit observations |
| Codex | Read-only history API, including archived threads; local rollout fallback |
| Copilot CLI | Native events and supported lifecycle notifications |
| Copilot / Antigravity editors | Native transcript watchers with exact source paths |
| Antigravity CLI | Native transcripts, session-start and post-tool notifications |

Prompts, replies, tool calls/results, and available plans/decisions come from native
history. Hook text never becomes a second prompt source. Claude's persisted tool
results supply structured edit patches, workspace deltas, approved plan content and
answers.
Failed or unfinished Claude edit calls remain tool attempts, not applied edits.
Native Claude subagent files are collected with their parent session identity.
Delegated inputs are labeled as agent input and never become student prompt cards.

Claude's `bashEditDiff` can include changes made by another session in the same
workspace, even when the observed command only reads files. Showtail attributes a
Bash diff to that command only when its path matches a conservatively parsed
literal write target. Other persisted deltas remain separate **File observations**
with **unverified authorship**, rather than applied edits or revisions. Their
captured diff remains reviewable even if the file later disappears.
Matching a literal target associates the command's intent with the observed delta;
it cannot distinguish concurrent writers to that same path or prove a conditional
write executed. Structured file-edit results provide stronger attribution.

Where complete file state is unavailable, Showtail may read a file after a provider
edit. These hashes record the time of observation; they do not prove the exact
contents at the instant the tool finished. They neither duplicate the native edit
in the report nor turn unrelated manual saves into AI-authored work. Structured
reports expose these hashes and unverified workspace deltas as `fileObservations`.

Shell commands can change files before a later command fails. Where Bash or
PowerShell persisted no structured diff, Showtail uses literal write-path hints from
the native command and its completed result to observe current file hashes. Reports
show these separately as **File observations**, including the tool outcome and the
actual observation time. They do not count as applied revisions or prove that the
command changed the file. Quoted command examples, here-document bodies, unresolved
variables, sensitive paths and unfinished calls do not supply file observations.

Unchanged sources are skipped. Claude append cursors replay the open turn, falling
back to the whole source when earlier context is required. Sources with journal or
cross-record dependencies use safe full replay and stable native identifiers.

## Catch-up and limits

`showtail sync [--tool <tool>] --json` discovers eligible native history. Reports and
submissions synchronize before selecting their view, unless `--no-sync` is supplied.
Automatic collection respects consent and pause/reconnect cutoffs. Importing older
history remains an explicit operation. Status, audit and verification do not ingest.

Some host modes omit callbacks. Such work catches up at the next supported event,
editor startup, sync or report. Native history can be disabled, pruned, truncated or
unpersisted; Showtail does not change the host's persistence settings or ask the model
to fill gaps. Retain sources until collection has completed.

Status JSON version 3 separates `assistant` discovery from capture `mode` and
`transport`, and reports `lastIngestedAt`, queued work and issues. Modes are
`automatic`, `on-demand`, `paused` and `unavailable`. An installed callback describes
configuration; ingestion timestamps and coverage describe observed collection.
For Codex, `hooksConfigured` records installation while `hooksActive` also requires
the host to confirm its callbacks are enabled and trusted. Status uses the read-only
`hooks/list` API and never grants trust. Review required callbacks in Codex `/hooks`;
until review or host verification succeeds, native collection remains on-demand.

## Upgrading

Setup/connect retire identifiable Showtail instruction blocks and obsolete callbacks
in known host locations and registered legacy projects. Original files are backed up
under `maintenance/passive-capture/` in Showtail's home. Surrounding user rules, other
hooks, trust settings, history, corrections and exports are retained. Ambiguous
unmarked content is left in place for review. Git hooks are never changed.

Existing conversations retain instructions they already loaded. Start a new session
after upgrading to clear those instructions. The `@showtail` editor participant now
handles review commands only; it does not forward ordinary prompts to a model.
