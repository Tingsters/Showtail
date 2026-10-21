<p align="center">
  <img src="assets/showtail-logo.png?v=2" alt="Showtail logo: a Cavalier King Charles Spaniel beside the word Showtail, with a dotted trail of prompt, edit, code, and document icons" width="520">
</p>

# Showtail

**Show your work.** Showtail keeps a clear record of how you built a project with AI: the prompts you sent and the files you changed along the way. It captures this **automatically** as you work, so the trail builds itself.

Showtail writes resolved work to a plain `.showtail/` folder inside your project; work that does not yet have one clear project waits in a machine-local inbox. There are no accounts, no cloud service, and no telemetry. It is just local files, and they stay **private**: `.showtail/` ignores itself in git so a plain `git add .` can never publish your prompts, and what you hand in is a separate, sanitised report from `showtail submit`. Interactive commands may make a quiet, daily request for public GitHub release metadata so Showtail can mention an available update; no trail or project data is sent, and the check can be disabled.

```bash
# Install (below), then just work — your prompts and edits are captured automatically.
showtail submit    # when you're done: a sanitised report to hand in (secrets removed, then re-checked)
```

**There is no setup step.** Installing turns tracking on and connects the AI tools it can
find, so a student can start working immediately. Just open the folder for your assignment
and work: the first meaningful prompt
creates that project's `.showtail/` trail. Plain folders, temporary folders, and your home
folder can all be projects. A trail created exactly in your home folder applies only there;
it is never inherited by child folders. Showtail identifies projects by their stable trail ID;
paths are revalidated hints that may change when a project moves. Actual edits, explicit file
attachments, and confirmed selections can bind a chat to that identity, while a stale editor
workspace alone cannot. Prefer to wire up one project by hand, or disable automatic creation of new
project trails? See
[`showtail track`](https://tingsters.github.io/Showtail/getting-started/quickstart/#wiring-up-one-project-by-hand)
and `showtail setup --off`.

## 📚 Documentation

**Full documentation: [tingsters.github.io/Showtail](https://tingsters.github.io/Showtail/)**

- [Getting started](https://tingsters.github.io/Showtail/getting-started/installation/) — install and capture your first trail
- [Integrations](https://tingsters.github.io/Showtail/integrations/) — Claude Code, Codex, Copilot, ChatGPT, Gemini
- [How it works](https://tingsters.github.io/Showtail/concepts/how-it-works/) — the event model and data layout
- [CLI reference](https://tingsters.github.io/Showtail/reference/cli/) — every command and flag
- [Privacy & redaction](https://tingsters.github.io/Showtail/concepts/privacy/) — what's captured, what's scrubbed
- [Sharing your work safely](https://tingsters.github.io/Showtail/concepts/sharing/) — `submit`, pull-request summaries, and what is checked
- [For educators](https://tingsters.github.io/Showtail/educators/classroom-workflow/) — running this in a class

## What Showtail is

- A **show your work tool** for coursework and projects — your prompts and edits, captured automatically as you work with AI.
- A **local, private, file-based trail** and a sanitised report that is safe to share.
- **Team-aware**: each student gets their own folder under `.showtail/`; a course repo can opt in to committing it (`settings.commitTrail`) so trails merge through git without conflicts.

It is **not** an AI detector, **not** surveillance, **not** a cloud service, and **not** a grading tool — it produces a report so people can review the work, not judge it. [Read more →](https://tingsters.github.io/Showtail/concepts/how-it-works/)

## Integrations at a glance

**Claude Code** ✅ · **OpenAI Codex** ✅ · **GitHub Copilot** 🚧 · **ChatGPT / Gemini** ✅ _(import)_

Tools with hooks capture live as you work; hosted chat apps import from a shared conversation. [Full capability matrix →](https://tingsters.github.io/Showtail/integrations/)

## Installation

One-line install of a standalone binary — no runtime required:

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
```

The installer adds Showtail to your user `PATH` and enables local capture by
configuring detected AI tools. Review all system changes and opt-out/removal
instructions on the [Installation](https://tingsters.github.io/Showtail/getting-started/installation/)
and [Uninstallation](https://tingsters.github.io/Showtail/getting-started/uninstallation/)
pages before running it.

Prefer Bun or building from source? See [Installation](https://tingsters.github.io/Showtail/getting-started/installation/).

## Updating

After installing a release, future updates are one command:

```bash
showtail update
```

Showtail checks for a newer stable GitHub release, verifies its SHA-256 digest,
and replaces the standalone binary without touching your trails. Use
`showtail update --check` to check without installing, or
`showtail update --auto-check off` to disable the quiet update reminders.
From-source checkouts are never overwritten; pull and rebuild those with Bun.

## Contributing

Showtail is built with TypeScript on [Bun](https://bun.sh). See [Contributing & development](https://tingsters.github.io/Showtail/contributing/) for build and test commands and how to work on the docs site.

## Code signing policy

Showtail is preparing Windows releases for SignPath Foundation code signing.
Current releases are unsigned unless their release notes explicitly say
otherwise. See the [Code signing policy](https://tingsters.github.io/Showtail/code-signing-policy/)
for the signed-artifact scope, team roles, privacy statement, verification steps,
and enrollment status.

## License

[Apache-2.0](./LICENSE)

Standalone releases include other Open Source components; see
[Third-party notices](./THIRD_PARTY_NOTICES.md).
