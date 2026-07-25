# Concepts &amp; events

Many classrooms allow AI tools. Showtail is built around a simple idea: using AI
is easier to evaluate when students can show their process.

## What Showtail is

- A **show your work tool** for coursework and projects.
- A **hands-free** way to document your process: your prompts and edits are
  captured automatically as you work with AI.
- A **local, file-based trail** that is easy to commit to git and easy for a
  human to review.
- **Evidence of your process**, showing how you worked with AI to build the
  project.
- **Team-aware.** On a group project, each student gets their own folder under
  one shared `.showtail/`, so trails merge through git without conflicts and the
  report can be per-student or a combined team view.

## What Showtail is not

- **Not an AI detector.** Showtail does not try to guess whether work was
  AI-generated.
- **Not surveillance.** It only records your prompts and file edits while a
  capture integration is enabled — nothing else.
- **Not a cloud service.** Nothing leaves your machine, and there are no
  external API calls.
- **Not a grading tool.** It produces a report so people can review the work. It
  does not judge the work itself.

## Event types

Showtail records four kinds of event, all captured automatically while you work:

| Type | What it is |
| ---- | ---------- |
| `prompt` | A prompt you sent to an AI tool |
| `ai_output` | An AI response |
| `artifact` | A file you created or changed |
| `decision` | A choice you made when the AI paused to ask you to pick between options |

Every event records:

- `id`
- ISO `timestamp`
- `type`
- `text`
- optional `files`
- the `tool` it came through (e.g. `claude-code`, `github-copilot`, `codex`, `chatgpt`, `google-gemini`)
- optional `tags`
- the current git commit hash, if your project is a git repository
- `actor: "student"`

Captured text is scrubbed for secrets and personal data before it is stored (see
[Privacy &amp; redaction](privacy.md)).

## Where it goes

Each event is appended to a local, file-based trail under `.showtail/`. See
[Data layout](data-layout.md) for the exact structure, and
[Example report](example-report.md) for what the rendered output looks like.

## Why the trail is hard to fake

The trail is plain text on your own machine, so nothing stops you from opening
it in an editor. What Showtail guarantees instead is that doing so **shows**.
Two mechanisms, both just SHA-256 — no keys, no server, nothing to set up:

**Content addressing.** The heavy content — your prompt text, the AI's replies,
captured diffs — isn't stored in the journal. It lives in `.showtail/objects/`
under a filename derived from a hash of the content itself
(`objects/ab/cdef…`), and the journal references it by that address. Edit the
stored text of a prompt and it no longer hashes to the name it's filed under.

**A hash chain over the journal.** Every journal line carries `prev`, the
SHA-256 of the line before it. Each entry therefore commits to every entry
before it: change one line, delete one, or splice one in, and the *next* line's
`prev` stops matching. The chain runs per author *and* per machine, matching how
segments are already sharded — that's what keeps two students' (or your own two
laptops') trails merging through git without conflicts.

`showtail verify` checks both, and reports a break as a failure.

**What the chain does and does not catch.** It is unkeyed, and every byte of it
lives in the student's own folder — so it detects an *unwitting* edit, not a
determined one. Concretely, measured against a real trail:

| | Detected? |
|---|---|
| Edit a stored prompt's text in `objects/` | ✅ address no longer matches |
| Edit a journal line and leave `prev` alone | ✅ chain break, `verify` exits 3 |
| Truncate entries off the end of a shard | ❌ the remaining chain is still valid |
| Append a fabricated entry with a recomputed `prev` | ❌ passes cleanly |
| Edit any entry, then re-chain everything after it | ❌ passes cleanly |

The last three need only a short script, and Showtail is open source — the
re-chaining helper ships in `src/core/journal.ts`. So this is tamper-**evidence**
against casual editing, not an integrity guarantee against someone who reads the
code. It raises fabricating a process from "edit a line" to "write a script,
knowingly" — worth having, and worth not overstating.

Closing the gap needs an anchor outside the folder. The practical one today is
git: commit `.showtail/` and push it as you work, and the remote's history is a
record the student cannot silently rewrite — verifying that on every push is
what running Showtail in CI is for. Signed provenance records, on the
[roadmap](../roadmap.md), are the stronger answer.
And of course anyone can delete the whole trail and start over — no local file
format prevents that.

### What is *not* tampering

Editing your own source code after Showtail snapshotted it is normal work, not a
problem. `verify` reports it as information ("N file(s) edited since their last
snapshot — expected if you kept working") and still passes. Failure is reserved
for the trail itself being modified.
