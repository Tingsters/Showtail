<p align="center">
  <img src="assets/showtail-logo.png?v=2" alt="Showtail logo: a Cavalier King Charles Spaniel beside the word Showtail, with a dotted trail of prompt, edit, code, and document icons" width="520">
</p>

# Showtail

**Show your work.** Showtail keeps a clear record of how you built a project with AI: the prompts you sent and the files you changed along the way. It captures this **automatically** as you work, so the trail builds itself.

Showtail writes that record to a plain `.showtail/` folder inside your project. There are no accounts, no cloud service, and no telemetry. It is just local files that you and your educator can open, review, and commit with the rest of your work.

```bash
# Install (below), then just work — your prompts and edits are captured automatically.
showtail report    # when you're done: generate the report for your educator
```

**There is no setup step.** Installing turns tracking on and connects your AI tools for
you — including ones you install later — so a student never has to run a command to get
started. Just install, work, and generate a report at the end. Prefer to wire up one
project by hand, or turn tracking off? See [`showtail track`](https://tingsters.github.io/Showtail/getting-started/quickstart/#wiring-up-one-project-by-hand)
and `showtail setup --off`.

## 📚 Documentation

**Full documentation: [tingsters.github.io/Showtail](https://tingsters.github.io/Showtail/)**

- [Getting started](https://tingsters.github.io/Showtail/getting-started/installation/) — install and capture your first trail
- [Integrations](https://tingsters.github.io/Showtail/integrations/) — Claude Code, Codex, Copilot, ChatGPT, Gemini
- [How it works](https://tingsters.github.io/Showtail/concepts/how-it-works/) — the event model and data layout
- [CLI reference](https://tingsters.github.io/Showtail/reference/cli/) — every command and flag
- [Privacy & redaction](https://tingsters.github.io/Showtail/concepts/privacy/) — what's captured, what's scrubbed
- [For educators](https://tingsters.github.io/Showtail/educators/classroom-workflow/) — running this in a class

## What Showtail is

- A **show your work tool** for coursework and projects — your prompts and edits, captured automatically as you work with AI.
- A **local, file-based trail** that is easy to commit to git and easy for a human to review.
- **Team-aware**: each student gets their own folder under one shared `.showtail/`, so trails merge through git without conflicts.

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

Prefer Bun or building from source? See [Installation](https://tingsters.github.io/Showtail/getting-started/installation/).

## Contributing

Showtail is built with TypeScript on [Bun](https://bun.sh). See [Contributing & development](https://tingsters.github.io/Showtail/contributing/) for build and test commands and how to work on the docs site.

## License

[Apache-2.0](./LICENSE)
