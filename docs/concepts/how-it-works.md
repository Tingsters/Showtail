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

**Git history, as an anchor from outside the folder.** The two mechanisms above
live entirely inside `.showtail/`, and anything that can write that folder can
make them agree with each other: edit a line, re-link the chain after it, and
the chain is intact again. So `verify` also checks something the student's
folder does not own. A journal segment is **append-only** — every write adds a
line and changes none — so across its whole history in git, every commit that
touches it should add lines and remove none. `git log --numstat` says exactly
that, and a re-chain (which rewrites every line after the edit) shows up as a
pile of removals. The same check reads the working tree, so a rewrite is caught
before it is even committed.

`showtail verify` checks all three, and reports a break as a failure.

**What is caught, and what is not.** The chain is unkeyed and local, so on its
own it detects an *unwitting* edit, not a determined one. Git is what changes
that — but only for a trail that is actually committed. Concretely, measured
against a real trail:

| | Detected? |
|---|---|
| Edit a stored prompt's text in `objects/` | ✅ address no longer matches |
| Edit a journal line and leave `prev` alone | ✅ chain break, `verify` exits 3 |
| Truncate entries off the end of a shard | ✅ once committed — git shows removed lines |
| Edit any entry, then re-chain everything after it | ✅ once committed — every rewritten line is a removal |
| Append a fabricated entry to the end | ❌ an append is what an honest capture looks like |
| Any of the above, in a trail never committed to git | ❌ nothing outside the folder to compare against |

`showtail redact` and `showtail import undo` legitimately rewrite journal lines,
and each records a dated marker in the journal saying so. `verify` reconciles the
rewrites git reports against those markers, and fails only on rewrites nothing
declares — reporting each with its commit SHA and date.

**Where the boundary is.** Being straight about this matters more than sounding
strong:

- **A forged append is still an append.** Nothing here distinguishes a real
  prompt from one that was invented and appended with a correctly computed
  `prev`. Committing as you work narrows the window — a prompt appended today
  cannot claim to be from last week's commit — but it does not close it.
- **No commits, no anchor.** A student who never commits `.showtail/`, or who
  commits it once at submission time, gets nothing from this check. `verify`
  says so rather than passing quietly, and so does the
  [GitHub Action](../educators/verify-in-ci.md) on a shallow checkout.
- **Local git history can itself be rewritten.** `git rebase`/`--amend` can
  reshape a local repo's past. The real anchor is the copy on the **remote**:
  history that has been pushed cannot be changed without a force-push, which is
  visible.
- **Anyone can delete the whole trail and start over.** No local file format
  prevents that — though in a committed repo, deleting it is itself in the log.

So: tamper-**evidence** that now extends past the folder it describes, not an
integrity guarantee. Signed provenance records, on the [roadmap](../roadmap.md),
are the stronger answer.

### What is *not* tampering

Editing your own source code after Showtail snapshotted it is normal work, not a
problem. `verify` reports it as information ("N file(s) edited since their last
snapshot — expected if you kept working") and still passes. Failure is reserved
for the trail itself being modified.
