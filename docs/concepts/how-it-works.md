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
