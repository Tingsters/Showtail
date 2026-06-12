<p align="center">
  <img src="assets/showtail-logo.png?v=2" alt="Showtail logo — a Cavalier King Charles Spaniel beside the word Showtail, with a dotted trail of prompt, edit, code, and document icons" width="520">
</p>

# Showtail

**Show your work.** Showtail helps students capture the *story* of how they built a
project — the prompts they used, the AI suggestions they accepted or rejected, the files
they created, the decisions they made, the tests they ran, and what they actually learned —
into a simple, local, reviewable trail an educator can read.

It writes everything to a plain `.showtail/` folder in your project. No accounts, no cloud,
no telemetry. Just files you (and your teacher) can open and understand.

```bash
showtail init
showtail start
showtail log --type prompt   --text "How should I structure this parser?"
showtail log --type decision --text "I chose the simpler regex approach after testing edge cases."
showtail artifact add src/parser.ts
showtail report
```

---

## What Showtail is

- A **"show your work" tool** for coursework and projects.
- A way to **document your process honestly**: prompts, decisions, sources, reflections.
- A **local, file-based trail** that's easy to commit to git and easy for a human to review.
- **Provenance for learning** — proof of *how* you worked and *what you understood*.

## What Showtail is **not**

- ❌ **Not** an AI detector. It never tries to guess whether something was AI-generated.
- ❌ **Not** surveillance. It only records what you choose to log.
- ❌ **Not** a cloud service. Nothing leaves your machine; there are no external API calls.
- ❌ **Not** a grading tool. It produces a report; humans do the judging.

Using AI is allowed in many classrooms — what matters is showing your process. Showtail is
built around that positive idea.

---

## Installation

### Option 1 — One-line install (no runtime required)

These scripts download a standalone `showtail` binary from the latest GitHub Release. You do
**not** need Node, Bun, or anything else installed.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
```

### Option 2 — With Bun

If you already use [Bun](https://bun.sh):

```bash
git clone https://github.com/Tingsters/Showtail.git
cd Showtail
bun install
bun run src/cli.ts --help
# build your own standalone binary:
bun run build      # -> dist/showtail
```

### Option 3 — From source

Clone the repo and run the CLI directly with Bun (`bun run src/cli.ts <command>`), or build a
binary with `bun run build` and put `dist/showtail` on your `PATH`.

---

## Quickstart

```bash
# 1. Set up Showtail in your project (creates the .showtail/ folder)
showtail init --project "Week 5 Parser"

# 2. Start a work session
showtail start

# 3. Log what you do as you go
showtail log --type prompt     --text "How do I structure this parser?"
showtail log --type ai_output  --text "Accepted the AI's tokenizer outline, rewrote the loop myself."
showtail log --type human_edit --text "Refactored the tokenizer by hand." --files src/parser.ts
showtail log --type decision   --text "Chose regex over a hand-written scanner after testing edge cases."
showtail log --type source     --text "Used class notes from week 3."
showtail log --type test       --text "Added edge-case tests; all passing."
showtail log --type reflection --text "I now understand how the tokenizer turns text into tokens."

# 4. Record snapshots of important files (stores a SHA-256 hash + git commit)
showtail artifact add src/parser.ts

# 5. See the full trail for a file
showtail trace src/parser.ts

# 6. Generate a report for your educator
showtail report                 # Markdown in .showtail/reports/
showtail report --format json   # machine-readable version

# 7. Check everything is consistent before you submit
showtail verify
```

### Logging text without flags

If you omit `--text`, Showtail reads from standard input — handy for longer notes:

```bash
echo "I spent an hour debugging an off-by-one error in the scanner." | showtail log --type reflection
```

---

## Event types

Each `showtail log` records one event. The supported `--type` values are:

| Type          | Use it for…                                                |
| ------------- | ---------------------------------------------------------- |
| `prompt`      | A prompt you gave an AI tool                               |
| `ai_output`   | An AI response you accepted or rejected                    |
| `human_edit`  | A change you made by hand                                   |
| `decision`    | A choice you made, and why                                 |
| `reflection`  | What you learned / now understand                          |
| `source`      | An outside source (notes, docs, a classmate)               |
| `test`        | A test or validation step you ran                          |
| `artifact`    | A file you created or changed (usually logged for you)     |

Every event records an `id`, ISO `timestamp`, `type`, `text`, optional `files` and `tags`,
the current git commit hash (if your project is a git repo), and `actor: "student"`.

---

## Example classroom workflow

1. **Teacher** asks students to use Showtail for a project and to commit `.showtail/`.
2. **Student** runs `showtail init` and `showtail start` at the beginning.
3. As they work, the student logs prompts, decisions, sources, tests, and reflections, and
   records artifacts for key files.
4. Before submitting, the student runs `showtail report` and `showtail verify`, then commits
   everything (including `.showtail/`) to their repo.
5. **Teacher** opens `.showtail/reports/report-*.md` to review the trail, and can run
   `showtail verify` and `showtail trace <file>` to inspect any file's history.

The goal isn't to catch anyone — it's to make the *process* visible and to give students a
structured way to demonstrate genuine understanding.

---

## Example report

A generated `.showtail/reports/report-*.md` looks like this:

```markdown
# Showtail Report — Demo Project

_Generated 2026-06-12T15:02:30Z_

**Summary:** 1 session(s), 3 event(s), 1 artifact record(s).

## Project timeline

- `2026-06-12T15:02:29Z` **Session** — Started a work session
- `2026-06-12T15:02:29Z` **Prompt** — Help me plan the project
- `2026-06-12T15:02:29Z` **Decision** — I implemented the CLI first
- `2026-06-12T15:02:29Z` **Artifact** — Recorded artifact README.md (sha256 aee1535315)

## Major decisions

- I implemented the CLI first
  _(2026-06-12T15:02:29Z · files: README.md)_

## Artifacts created

- **README.md** — `aee1535315` (2026-06-12T15:02:29Z, commit `bd9ccb2835`)

## Authorship statement

> I recorded this trail while working on "Demo Project". It shows the prompts I used, the
> decisions I made, the sources I drew on, the tests I ran, and my own reflections. The work
> and understanding represented here are my own.
```

---

## Privacy notes

Showtail is **privacy-first by design**:

- **Everything is local.** All data lives in the `.showtail/` folder in your project.
- **No telemetry, no analytics, no external API calls.** Ever.
- **You control what's recorded.** Showtail only logs what you explicitly run.
- **The files are plain and inspectable** — JSON and JSONL you can open in any editor.

**On committing `.showtail/`:** Showtail is designed to be committed into your repo so your
educator can review it. The default `.gitignore` does **not** ignore `.showtail/`. Before you
commit, remember that your logged text (prompts, reflections, notes) becomes part of your
git history. Don't put passwords, private personal information, or anything you wouldn't want
shared into your log text. If a project is sensitive, you can add `.showtail/` to your
`.gitignore` and share reports another way.

---

## Data layout

```text
.showtail/
  config.json                # project settings (version, name, git on/off)
  state.json                 # which session new events go to
  sessions/
    index.json               # list of sessions
    <sessionId>.jsonl        # one JSON event per line
  artifacts/
    index.json               # append-only history of file snapshots (hashes)
  reports/
    report-<timestamp>.md    # generated reports
    report-<timestamp>.json
```

---

## Development

Built with TypeScript on the [Bun](https://bun.sh) runtime. Minimal dependencies
(`commander` for the CLI; hashing and git use the standard library).

```bash
bun install
bun test            # run the test suite
bun run typecheck   # tsc --noEmit
bun run dev -- --help
bun run build       # compile a standalone binary to dist/showtail
```

---

## Roadmap

Showtail's MVP is a local CLI, with a clean core that's meant to grow:

- **Claude Code skill** — let an AI coding agent log prompts/decisions/artifacts as you pair.
- **VS Code extension** — capture the trail inline while you edit.
- **GitHub Action** — verify a submission's trail automatically in CI.
- **Signed provenance records** — cryptographically signed events for stronger guarantees.
- **Educator dashboard** — review many students' trails at a glance.

---

## License

[Apache-2.0](./LICENSE)
