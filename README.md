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
showtail report                 # HTML (+ Markdown source) in .showtail/reports/
showtail report --format md     # Markdown only
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

## Claude Code integration

If you pair with [Claude Code](https://claude.com/claude-code), Showtail can build your trail
for you. Install the bundled **skill** — auto-capture **hooks are included by default**:

```bash
# in your project (creates ./.claude/skills/showtail/ and ./.claude/settings.json)
showtail skill install --project

# or for all your projects:
showtail skill install --user

# skill only, no settings changes (the skill then captures manually):
showtail skill install --project --no-hooks
```

What you get:

- **A skill** that teaches Claude to record the trail *in the student's voice* — the
  decisions they made, what they understood (reflections), the sources and tests — and to
  start sessions and run `report`/`verify`. Claude loads it automatically in a Showtail
  project, or you can invoke it with `/showtail`.
- **Hooks** (on by default; `--no-hooks` to skip) that deterministically capture the rest:

  | When | Showtail does |
  | --- | --- |
  | You submit a prompt | logs it as a `prompt` event |
  | Claude edits/writes a file | snapshots that file as an `artifact` |
  | A session starts | ensures a work session exists |

  When hooks are skipped, the skill checks `showtail skill status` and logs prompts and file
  snapshots itself, so prompts are still captured (just model-driven rather than guaranteed).

Then just work. At the end, `showtail report` gives your educator the full picture.

### Install via the Claude Code plugin (alternative)

```text
/plugin marketplace add Tingsters/Showtail
/plugin install showtail
```

The plugin bundles the same skill and hooks.

### Privacy with hooks

⚠️ While hooks are active, **every prompt you submit and every file Claude edits is logged
locally** to `.showtail/`. This is the point — it's your "show your work" trail — but be aware:

- Nothing is ever sent anywhere; there are **no external calls** and no telemetry.
- The trail may be committed to your repo, so **don't put secrets in prompts** while capturing.
- Review anytime with `showtail report`; turn capture off with
  `showtail skill uninstall` (add `--user` if you installed at user scope).
- Auto-capture is **on by default**. To install the skill without touching any settings, use
  `showtail skill install --no-hooks` — the skill still captures prompts itself, but won't add
  hooks to your `settings.json`.

---

## GitHub Copilot integration

Showtail also captures **GitHub Copilot** work — into the *same* `.showtail/` trail, so a
student can switch between Claude Code and Copilot and the professor sees one coherent story.

```bash
# install the VS Code extension (one-click) that does the capturing:
code --install-extension Tingsters.showtail
#   (or grab the .vsix from the GitHub Releases page)
```

Open your project in VS Code and the extension **sets up the Copilot instructions
automatically** (it writes `.github/copilot-instructions.md` the first time it sees a
`.showtail/` folder). You can also do it explicitly — handy outside VS Code — with:

```bash
showtail copilot install
```

How capture works (Copilot is more closed than Claude Code, so the design differs):

- **Code with native Copilot as usual** (agent mode, inline, chat). The
  **`.github/copilot-instructions.md`** teaches Copilot to log your prompt, decisions, and
  reflections in your voice via the CLI — the analog of the Claude Code skill.
- **Edits are captured automatically** — the VS Code extension snapshots every file you save
  as an artifact (tagged `github-copilot`). This is the always-on backbone and needs no habit
  change.
- **`@showtail` is your Showtail control surface in chat** — not a coding agent. Use it to
  record a prompt verbatim (`@showtail <your question>`) and to drive Showtail without leaving
  the editor: `@showtail /report`, `/verify`, `/status`, `/trace <file>`. For hands-on file
  edits, use native Copilot — your saved edits are captured regardless.

> Copilot does not expose prompts typed into *native* chat to any third party — that's a
> privacy boundary of Copilot's, not a Showtail limitation. The instructions ask Copilot to log
> your prompt, and `@showtail` captures it verbatim when you ask through it; either way your
> **edits are always captured on save**, so the work history is never lost.

### Customizing the instructions

The instruction files are yours to edit — Showtail only ever overwrites the text **it wrote
itself**. Each Showtail-managed block carries a fingerprint, so on the next open:

- a block you **haven't touched** is auto-refreshed to the latest (it just stays current);
- a block you **have edited** is left exactly as you wrote it. `showtail copilot status` will
  say `customized`, and if a newer version shipped you'll get a one-time "update available"
  nudge — never an overwrite. Run `showtail copilot install --force` to take the latest.

Add your own rules **outside** the Showtail markers (always preserved) or, cleanest of all, in
your own `.github/instructions/your-rules.instructions.md` — Copilot reads every instructions
file, and Showtail never touches yours.

### Following a student across both tools

Every event records which `tool` it came through, so `showtail report` shows a **Tools used**
section with the exact switch sequence, and badges each timeline entry:

```text
## Tools used
- GitHub Copilot — 3 event(s)
- Claude Code — 2 event(s)

Tool timeline (each arrow is a switch):
- GitHub Copilot · 14:02 → 14:10 · 2 event(s)
- Claude Code · 14:10 → 14:18 · 2 event(s)
- GitHub Copilot · 14:25 · 1 event(s)
```

---

## OpenAI Codex integration

If you pair with [Codex](https://developers.openai.com/codex), Showtail captures that work
into the *same* `.showtail/` trail. Codex is close to Claude Code — it has lifecycle hooks and
reads project instructions from `AGENTS.md` — so the integration mirrors the Claude Code one:

```bash
# in your project (writes ./AGENTS.md + ./.codex/hooks.json, and offers to enable hooks)
showtail codex install --project

# or for all your projects:
showtail codex install --user

# instructions only, no hooks (AGENTS.md then captures manually):
showtail codex install --project --no-hooks
```

What you get:

- **Instructions in `AGENTS.md`** — a fingerprinted, Showtail-managed block (your own text in
  `AGENTS.md` is never touched) that teaches Codex to record the trail *in the student's voice*:
  decisions, reflections, sources, and tests, all tagged `codex`. Codex reads `AGENTS.md`
  automatically.
- **Auto-capture hooks** (on by default; `--no-hooks` to skip) in `.codex/hooks.json`:

  | When | Showtail does |
  | --- | --- |
  | You submit a prompt | logs it as a `prompt` event |
  | Codex edits a file (`apply_patch`) | snapshots that file as an `artifact` |
  | A session starts | ensures a work session exists |

### Enabling Codex hooks

Codex only fires lifecycle hooks when `features.hooks = true` is set in its `config.toml`. So
during `showtail codex install`, Showtail **asks before turning it on** (default Yes) and edits
`config.toml` surgically — it sets only that one key and never disturbs your other settings:

```toml
[features]
hooks = true
```

Pass `--yes` to enable it without the prompt (handy in scripts), or answer `n` and set it
yourself later. Check or change state anytime:

```bash
showtail codex status      # instructions + auto-capture state
showtail codex uninstall   # removes the AGENTS.md block and hooks (leaves config.toml alone)
```

> **Note on edits:** Codex applies file changes through its `apply_patch` tool, which Showtail
> parses to snapshot the touched files. Edits Codex makes by running raw `shell` commands
> (e.g. `sed`) aren't visible to the hook and won't be auto-snapshotted — record those with
> `showtail artifact add <file> --tool codex` if you want them in the trail. As with the other
> integrations, **everything stays local** — no telemetry, no external calls.

The instructions block is yours to customize: edit inside the Showtail markers and
`showtail codex status` will report `customized` and never overwrite your edits (run
`showtail codex install --force` to take the latest).

---

## ChatGPT integration

Students on a free/low ChatGPT tier can pull their conversations into the same trail. ChatGPT
can't run on your machine, so this is **import-based**: in ChatGPT, click **Share** on a
conversation, then:

```bash
showtail import chatgpt https://chatgpt.com/share/<id>
```

Showtail fetches the shared page, logs your **prompts** as `prompt` events tagged `chatgpt`, and
stamps each with its **original** time — so an end-of-session import still lands in the right
place on the cross-tool timeline (e.g. *brainstormed in ChatGPT → built with Copilot → debugged
in Claude Code*). Options:

- `--with-responses` — also log ChatGPT's answers (`ai_output`); off by default to keep the trail
  about your work.
- `--file <path>` — import from a saved share page **or** a saved transcript instead of fetching
  (handy offline, or if the share format changes).

Re-importing the same link is safe — already-imported messages are skipped (deduped by message
id).

### If the share link doesn't work

Sometimes a link won't do — your school blocks public share links, you'd rather not make a
conversation public, or the fetch is blocked. As a backup, **paste the conversation** instead:

```bash
showtail import chatgpt --paste        # then paste the conversation and press Ctrl-D (Ctrl-Z↵ on Windows)
# or from a file you saved:
showtail import chatgpt --file my-chat.txt
```

You don't need to clean anything up — paste the whole thing, buttons and all. Showtail strips
ChatGPT's interface bits (`Thought for 12s`, `Edit`, attachment chips) and records **your
prompts**. It then prints them back so you can **skim** that they're yours; if a stray line isn't,
undo the whole import in one step:

```bash
showtail import undo
```

Because raw paste can't always tell your words from ChatGPT's, **responses are only captured when
the copy includes `You said:` / `ChatGPT said:` markers** — otherwise everything is recorded as
your prompts (we never guess from writing style; Showtail is not an AI-detector). Add
`--date 2026-06-10` to place the conversation on the timeline, since a paste carries no timestamps.
Imported prompts appear under **"Imported from ChatGPT"** in your report. The share link is still
the best path when you can use it — it captures responses and exact times automatically.

Import is **deliberate and per-conversation by design** — you share or paste exactly the
conversations you choose. Showtail does not read your full ChatGPT history.

**Privacy:** a share link makes that conversation **public** on OpenAI's servers. Create it,
import it, then delete the link. The import itself stays local like everything else in Showtail.

---

## Example classroom workflow

1. **Teacher** asks students to use Showtail for a project and to commit `.showtail/`.
2. **Student** runs `showtail init` and `showtail start` at the beginning.
3. As they work, the student logs prompts, decisions, sources, tests, and reflections, and
   records artifacts for key files.
4. Before submitting, the student runs `showtail report` and `showtail verify`, then commits
   everything (including `.showtail/`) to their repo.
5. **Teacher** opens `.showtail/reports/report-*.html` in a browser to review the trail
   (the `.md` source sits alongside it), and can run `showtail verify` and
   `showtail trace <file>` to inspect any file's history.

The goal isn't to catch anyone — it's to make the *process* visible and to give students a
structured way to demonstrate genuine understanding.

---

## Example report

A generated report (the HTML is rendered from this Markdown source) looks like this:

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
    report-<timestamp>.html  # generated report (default; open in a browser)
    report-<timestamp>.md    # Markdown source the HTML is rendered from
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

- ✅ **Claude Code skill** — log prompts/decisions/artifacts as you pair (see
  [Claude Code integration](#claude-code-integration)).
- ✅ **GitHub Copilot + VS Code extension** — capture Copilot prompts and edits, with one
  cross-tool report (see [GitHub Copilot integration](#github-copilot-integration)).
- ✅ **ChatGPT** — import conversations from a share link into the same trail (see
  [ChatGPT integration](#chatgpt-integration)).
- ✅ **OpenAI Codex** — capture Codex prompts and edits via AGENTS.md + hooks, in the same
  cross-tool report (see [OpenAI Codex integration](#openai-codex-integration)).
- **GitHub Action** — verify a submission's trail automatically in CI.
- **Signed provenance records** — cryptographically signed events for stronger guarantees.
- **Educator dashboard** — review many students' trails at a glance.

---

## License

[Apache-2.0](./LICENSE)
