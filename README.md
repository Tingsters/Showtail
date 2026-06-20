<p align="center">
  <img src="assets/showtail-logo.png?v=2" alt="Showtail logo: a Cavalier King Charles Spaniel beside the word Showtail, with a dotted trail of prompt, edit, code, and document icons" width="520">
</p>

# Showtail

**Show your work.** Showtail keeps a clear record of how you built a project with AI: the prompts you sent and the files you changed along the way. It captures this **automatically** as you work, so the trail builds itself.

Showtail writes that record to a plain `.showtail/` folder inside your project. There are no accounts, no cloud service, and no telemetry. It is just local files that you and your educator can open, review, and commit with the rest of your work.

```bash
showtail init                 # set up Showtail in your project
showtail connect claude       # turn on automatic capture for your AI tool
# ...now just work — your prompts and edits are captured automatically...
showtail report               # generate the report for your educator
```

---

## What Showtail is

- A **show your work tool** for coursework and projects.
- A **hands-free** way to document your process: your prompts and edits are captured automatically as you work with AI.
- A **local, file-based trail** that is easy to commit to git and easy for a human to review.
- **Evidence of your process**, showing how you worked with AI to build the project.

## What Showtail is not

- **Not an AI detector.** Showtail does not try to guess whether work was AI-generated.
- **Not surveillance.** It only records your prompts and file edits while a capture integration is enabled — nothing else.
- **Not a cloud service.** Nothing leaves your machine, and there are no external API calls.
- **Not a grading tool.** It produces a report so people can review the work. It does not judge the work itself.

Many classrooms allow AI tools. Showtail is built around a simple idea: using AI is easier to evaluate when students can show their process.

---

## Installation

### Option 1: One-line install, no runtime required

These scripts download a standalone `showtail` binary from the latest GitHub Release. You do not need Node, Bun, or any other runtime installed.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
```

### Option 2: Install with Bun

If you already use [Bun](https://bun.sh), you can run Showtail from source:

```bash
git clone https://github.com/Tingsters/Showtail.git
cd Showtail
bun install
bun run src/cli.ts --help
```

To build your own standalone binary:

```bash
bun run build
```

The binary is written to `dist/showtail`.

### Option 3: Build from source

Clone the repository, install dependencies with Bun, and either run the CLI directly or build a standalone binary:

```bash
git clone https://github.com/Tingsters/Showtail.git
cd Showtail
bun install

# Run the CLI directly
bun run src/cli.ts <command>

# Or build a binary
bun run build
```

Put `dist/showtail` on your `PATH` if you want to run it as `showtail` from anywhere.

---

## Quickstart

```bash
# 1. Set up Showtail in your project. This creates the .showtail/ folder.
showtail init --project "Week 5 Parser"

# 2. Connect your AI tool so capture is automatic (one time).
showtail connect claude         # or: copilot, codex

# 3. Just work. Your prompts and the files your tool edits are captured for you.
#    Check where you are any time:
showtail status                 # current session, event count, connected tools
showtail sessions               # list every session
showtail trace src/parser.ts    # the full trail for one file

# 4. Generate a report for your educator.
showtail report                 # HTML and Markdown in .showtail/reports/
showtail report --format md     # Markdown only
showtail report --format json   # Machine-readable JSON

# 5. Check the trail before you submit, then close the session.
showtail verify
showtail end
```

That's the whole flow — connect once, then work. (Not using a tool with hooks, e.g. ChatGPT?
See [the integrations below](#claude-code-integration) for importing a conversation.)

---

## Event types

Showtail records three kinds of event, all captured automatically while you work:

| Type | What it is |
| ---- | ---------- |
| `prompt` | A prompt you sent to an AI tool |
| `ai_output` | An AI response |
| `artifact` | A file you created or changed |

Every event records:

- `id`
- ISO `timestamp`
- `type`
- `text`
- optional `files`
- the current git commit hash, if your project is a git repository
- `actor: "student"`

---

## Claude Code integration

If you work with [Claude Code](https://claude.com/claude-code), Showtail can help build the trail for you. Install the bundled skill, which includes auto-capture hooks by default:

```bash
# In your project. Creates ./.claude/skills/showtail/ and ./.claude/settings.json.
showtail connect claude --project

# Or install for all projects.
showtail connect claude --user

# Install the skill without changing settings. Capture is then manual.
showtail connect claude --project --no-hooks
```

What this gives you:

- **A Showtail skill** that helps Claude keep the trail tidy and offers to generate the report when you finish.
- **Hooks**, enabled by default, that capture your prompts and file edits automatically.

| When | Showtail does this |
| ---- | ------------------ |
| You submit a prompt | Logs it as a `prompt` event |
| Claude edits or writes a file | Snapshots that file as an `artifact` |
| A session starts | Ensures a work session exists |

If you install with `--no-hooks`, the skill can still check `showtail status --json` and log prompts and file snapshots itself. That mode is model-driven rather than guaranteed, but it still gives you a useful trail.

At the end of your work session, run:

```bash
showtail report
```

The report gives your educator a readable view of what happened.

### Install through the Claude Code plugin

You can also install Showtail through the Claude Code plugin marketplace:

```text
/plugin marketplace add Tingsters/Showtail
/plugin install showtail
```

The plugin includes the same skill and hooks.

### Privacy with Claude Code hooks

When hooks are active, every prompt you submit and every file Claude edits is logged locally to `.showtail/`. That is the purpose of Showtail, but it is worth keeping a few habits in mind:

- Nothing is sent anywhere. There are no external calls and no telemetry.
- The trail may be committed to your repository, so do not put secrets in prompts while capture is on.
- Review your trail anytime with `showtail report`.
- Turn capture off with `showtail disconnect claude`. Add `--user` if you installed at user scope.
- To install the skill without hooks, use `showtail connect claude --no-hooks`. The skill can still capture prompts itself, but it will not add hooks to `settings.json`.

### Importing an existing Claude Code session

If you enabled Showtail partway through a session — or only afterwards — you do not have to lose the earlier work. Claude Code writes a full transcript of every session to disk (under `~/.claude/projects/…`), and Showtail can back-fill your trail from it so it reads as if capture had been on from the start. This is **local** like everything else: nothing is fetched, and because the transcript records who said what, there is no guessing about what you wrote versus what Claude produced.

Run it with no arguments to pick from this project's sessions:

```bash
showtail import claude
```

This opens an interactive picker. Each session shows how long ago it ran, its prompt and edit counts, a rough duration, its first and last prompt, and whether it is already in your trail — so the right one is easy to spot:

```text
Claude Code sessions for this project (3):

  1. 2h ago    8 prompt(s), 5 edit(s), ~25 min
     first: rework the claude code import so it is easier to pick sessions
     last:  add tests for the picker
     id: cc010626-49c0-4bef-a72f-2c1a0a4a172e

  2. yesterday    3 prompt(s), 0 edit(s), ~4 min  [imported]
     first: fix the timestamp parsing bug
     id: a019ec8b-df56-4e6b-9176-13bae0c42a86

Pick sessions to import [e.g. 1,3 or 'all', q to quit]:
```

Pick one or several — `1`, a list like `1,3`, a range `1-2`, or `all`. The whole selection is imported as a single batch, so one `showtail import undo` reverses it.

Options:

- `<session-id>` — import a specific session by its id (or just the start of it), skipping the picker.
- `--list` — print the same list without prompting, then import by id.
- `--no-responses` — import only your prompts. Claude's replies are imported by default.
- `--file <path>` — import a specific transcript `.jsonl` by path. Useful offline, or for a transcript stored elsewhere.
- `-s, --session <id>` — import into a specific Showtail session.

The command is also available as `showtail import claude-code`.

Your prompts become `prompt` events, Claude's replies become `ai_output`, and each file Claude edited becomes an `artifact` — all tagged `claude-code` and stamped with their original times, so they interleave correctly with the rest of your trail. Re-importing is safe: messages already in your trail are skipped (that is what the `[imported]` marker means), and you can undo a whole batch in one step:

```bash
showtail import undo
```

In a script or non-interactive shell there is nothing to pick from, so the command imports the most recent session for the project.

---

## GitHub Copilot integration

Showtail can also capture **GitHub Copilot** work into the same `.showtail/` trail. That means a student can move between Claude Code and Copilot while the educator sees one coherent story.

Install the VS Code extension:

```bash
code --install-extension Tingsters.showtail
```

You can also download the `.vsix` from the GitHub Releases page.

When you open a project in VS Code, the extension sets up the Copilot instructions automatically. It writes `.github/copilot-instructions.md` the first time it sees a `.showtail/` folder.

You can also set this up explicitly:

```bash
showtail connect copilot
```

### How Copilot capture works

Copilot is more closed than Claude Code, so the integration works a little differently:

- **Use native Copilot as usual.** This includes agent mode, inline suggestions, and chat. The `.github/copilot-instructions.md` file teaches Copilot to log your prompts through the Showtail CLI (Copilot has no capture hooks, so prompts are recorded this way).
- **File edits are captured automatically.** The VS Code extension snapshots every file you save as an artifact tagged `github-copilot`.
- **`@showtail` is the Showtail control surface in chat.** It is not a coding agent. Use it to record a prompt verbatim with `@showtail <your question>`, or to run Showtail commands such as `@showtail /report`, `/verify`, `/status`, and `/trace <file>`.
- **For hands-on file edits, use native Copilot.** Saved edits are captured regardless.

Copilot does not expose prompts typed into native chat to third parties. That is a Copilot privacy boundary, not a Showtail limitation. The instructions ask Copilot to log your prompt, and `@showtail` captures it verbatim when you ask through it. Either way, edits are captured on save, so the work history is not lost.

### Customizing Copilot instructions

The instruction files are yours to edit. Showtail only overwrites text that it wrote itself. Each Showtail-managed block carries a fingerprint, so on the next open:

- A block you have not changed is refreshed to the latest version.
- A block you have edited is left exactly as you wrote it.
- `showtail status` reports a customized Copilot block via its `updateAvailable` flag.
- If a newer managed block is available, Showtail gives you a one-time update notice.
- To take the latest managed block, run `showtail connect copilot --force`.

Add your own rules outside the Showtail markers. Those rules are always preserved. The cleanest option is to put your rules in your own `.github/instructions/your-rules.instructions.md` file. Copilot reads every instructions file, and Showtail never touches yours.

### Following a student across both tools

Every event records which tool it came through. `showtail report` includes a **Tools used** section with the switch sequence, and each timeline entry gets a tool badge.

```text
## Tools used
- GitHub Copilot: 3 event(s)
- Claude Code: 2 event(s)

Tool timeline, where each arrow is a switch:
- GitHub Copilot · 14:02 to 14:10 · 2 event(s)
- Claude Code · 14:10 to 14:18 · 2 event(s)
- GitHub Copilot · 14:25 · 1 event(s)
```

---

## OpenAI Codex integration

If you work with [Codex](https://developers.openai.com/codex), Showtail can capture that work into the same `.showtail/` trail. Codex is similar to Claude Code because it has lifecycle hooks and reads project instructions from `AGENTS.md`, so the setup is similar:

```bash
# In your project. Writes ./AGENTS.md and ./.codex/hooks.json, then offers to enable hooks.
showtail connect codex --project

# Or install for all projects.
showtail connect codex --user

# Instructions only, no hooks. AGENTS.md then captures manually.
showtail connect codex --project --no-hooks
```

What this gives you:

- **Instructions in `AGENTS.md`.** Showtail adds a fingerprinted, managed block that keeps the trail tidy. Your own text in `AGENTS.md` is never touched.
- **Codex-tagged events.** Your prompts and edits are captured with the `codex` tag.
- **Auto-capture hooks**, enabled by default unless you pass `--no-hooks`.

| When | Showtail does this |
| ---- | ------------------ |
| You submit a prompt | Logs it as a `prompt` event |
| Codex edits a file with `apply_patch` | Snapshots that file as an `artifact` |
| A session starts | Ensures a work session exists |

### Enabling Codex hooks

Codex only fires lifecycle hooks when `features.hooks = true` is set in its `config.toml`. During `showtail connect codex`, Showtail asks before turning that setting on. The default answer is yes.

Showtail edits `config.toml` carefully. It sets only this key and leaves your other settings alone:

```toml
[features]
hooks = true
```

Useful commands:

```bash
showtail connect codex --project --yes  # Enable hooks without prompting
showtail status                          # Check instructions and auto-capture state
showtail disconnect codex                # Remove the AGENTS.md block and hooks
```

`showtail disconnect codex` leaves `config.toml` alone.

### Notes on Codex edits

Codex applies file changes through its `apply_patch` tool. Showtail parses those patches and snapshots the touched files.

If Codex changes files by running raw shell commands, such as `sed`, those edits are not visible to the hook and are not auto-snapshotted. Record them manually when you want them in the trail:

```bash
showtail artifact <file> --tool codex
```

As with the other integrations, everything stays local. There is no telemetry and no external calls.

The instructions block is yours to customize. If you edit inside the Showtail markers, Showtail will not overwrite your changes (and `showtail status` flags that an update is available). Run `showtail connect codex --force` to take the latest managed version.

---

## ChatGPT integration

Students using ChatGPT can import selected conversations into the same trail. ChatGPT cannot run commands on your machine, so this integration is import-based.

In ChatGPT, click **Share** on a conversation, then run:

```bash
showtail import chatgpt https://chatgpt.com/share/<id>
```

Showtail fetches the shared page, logs your prompts as `prompt` events tagged `chatgpt`, and stamps each one with its original time. This keeps the timeline accurate even if you import at the end of a work session.

Example timeline:

```text
brainstormed in ChatGPT -> built with Copilot -> debugged in Claude Code
```

Options:

- `--no-responses` logs only your prompts. ChatGPT's answers are imported as `ai_output` by default.
- `--file <path>` imports from a saved share page or saved transcript instead of fetching the page. This is useful offline or if the share format changes.

Re-importing the same link is safe. Showtail skips messages it has already imported by message id.

### If the share link does not work

A share link may not work if your school blocks public links, you do not want to make the conversation public, or the fetch is blocked. In that case, paste the conversation instead:

```bash
showtail import chatgpt --paste
```

Then paste the conversation and press Ctrl-D. On Windows, press Ctrl-Z and Enter.

You can also import from a saved text file:

```bash
showtail import chatgpt --file my-chat.txt
```

You do not need to clean up the pasted text first. Showtail strips common ChatGPT interface text such as `Thought for 12s`, `Edit`, and attachment chips. It records your prompts and prints them back so you can skim them.

If something was imported by mistake, undo the whole import in one step:

```bash
showtail import undo
```

Because pasted text does not always identify who wrote each line, responses are only captured when the copy includes `You said:` and `ChatGPT said:` markers. Otherwise, Showtail records the pasted text as your prompts. Showtail never guesses based on writing style.

If the paste has no timestamps, add a date:

```bash
showtail import chatgpt --paste --date 2026-06-10
```

Imported prompts appear under **Imported from ChatGPT** in your report.

Share links are still the best option when you can use them, because they capture responses and exact times automatically.

Import is deliberate and per conversation. Showtail does not read your full ChatGPT history.

**Privacy:** a ChatGPT share link makes that conversation public on OpenAI's servers. Create the link, import it, then delete the link. The import itself stays local like everything else in Showtail.

---

## Google Gemini integration

Gemini conversations import into the same trail, the same way as ChatGPT — your **prompts** and
Gemini's **responses** become events tagged `google-gemini`, paired into exchange cards and
interleaved on the cross-tool timeline.

In Gemini, click **Share → Create public link**, then import it directly:

```bash
showtail import gemini https://gemini.google.com/share/<id>
# short share.gemini.google/<id> links work too
```

Showtail fetches the shared conversation, logs your **prompts** plus Gemini's **answers**, and
dedupes by Gemini's per-message ids so re-importing the same link adds nothing. Options:

- `--no-responses` — log only your prompts, not Gemini's answers (responses are imported by default).
- `--date 2026-06-10` — place the conversation on the timeline (Gemini shares carry no per-message
  timestamps, so without this they land at import time, in order).
- `-s, --session <id>` — import into a specific session.

### If the link doesn't work

As a backup — your school blocks the link, or you'd rather not make a chat public — **paste** the
conversation instead:

```bash
showtail import gemini --paste         # then paste the conversation and press Ctrl-D (Ctrl-Z↵ on Windows)
# or from a saved transcript file:
showtail import gemini --file my-chat.txt
```

A paste has no role labels, so **responses are only separated when the text includes `You said:` /
`Gemini said:` markers** — otherwise everything is recorded as your prompts (Showtail never guesses
from writing style). Showtail prints back what it recorded so you can **skim** it; undo the whole
batch with `showtail import undo`. The share link is the better path when you can use it — it
captures your prompts and Gemini's answers exactly.

**Privacy:** a Gemini share link makes that conversation **public** on Google's servers. Create it,
import it, then delete the link. The import itself stays local like everything else in Showtail.

---

## Example classroom workflow

1. **Teacher:** Ask students to use Showtail for a project and commit `.showtail/` with their work.
2. **Student:** Run `showtail init`, then `showtail connect <tool>` to turn on automatic capture.
3. **Student:** Work on the project as usual — prompts and edits are captured for you.
4. **Student:** Before submitting, run `showtail report` and `showtail verify`, then commit everything, including `.showtail/`.
5. **Teacher:** Open `.showtail/reports/report-*.html` in a browser to review the trail. The Markdown source sits beside it.
6. **Teacher:** Run `showtail verify` or `showtail trace <file>` when a deeper review is needed.

The goal is not to catch anyone. The goal is to make the process visible and give students a structured way to demonstrate genuine understanding.

---

## Example report

A generated report looks like this. The HTML report is rendered from the Markdown source:

````markdown
# Showtail Report — Demo Project

_Generated 2026-06-12T15:14:07Z_

**Summary:** 1 session(s), 5 event(s), 1 artifact record(s).

## Tools used

- **Claude Code** — 4 event(s)
- **GitHub Copilot** — 1 event(s)

Tool timeline (each arrow is a switch):

- **Claude Code** · 2026-06-12T15:02:11Z → 2026-06-12T15:09:48Z · 4 event(s)
- **GitHub Copilot** · 2026-06-12T15:14:02Z · 1 event(s)

## Prompts & AI exchanges

**Prompt** · `2026-06-12T15:02:11Z` · `Claude Code`

Help me structure a CSV parser.

_AI response:_

Start by splitting the file on newlines, then parse each row into fields.

_Suggested code — `src/parser.ts` (~6 line(s)):_

```diff
+export function parse(csv: string): string[][] {
+  return csv
+    .split("\n")
+    .filter((line) => line.length > 0)
+    .map((line) => line.split(","));
+}
```

## Authorship statement

> I recorded this trail while working on "Demo Project". It shows the prompts I used and the
> files I built along the way. I worked through Claude Code and GitHub Copilot, and this trail
> records each. The work and understanding represented here are my own.
````

---

## Privacy notes

Showtail is privacy-first by design:

- **Everything is local.** All data lives in the `.showtail/` folder in your project.
- **No telemetry, no analytics, no external API calls.** Ever.
- **You control what is recorded.** Showtail only logs what you explicitly run, unless you enable one of the optional capture integrations.
- **The files are plain and inspectable.** They are JSON and JSONL files that you can open in any editor.

### Committing `.showtail/`

Showtail is designed to be committed into your repository so your educator can review it. The default `.gitignore` does not ignore `.showtail/`.

Before you commit, remember that your captured prompts become part of your git history. Do not put passwords, private personal information, or anything you would not want shared into your prompts while capture is on.

If a project is sensitive, you can add `.showtail/` to your `.gitignore` and share reports another way.

---

## Data layout

```text
.showtail/
  config.json                # project settings: version, name, git on/off
  state.json                 # which session new events go to
  sessions/
    index.json               # list of sessions
    <sessionId>.jsonl        # one JSON event per line
  artifacts/
    index.json               # append-only history of file snapshots and hashes
  reports/
    report-<timestamp>.html  # generated report, open in a browser
    report-<timestamp>.md    # Markdown source the HTML is rendered from
    report-<timestamp>.json
```

---

## Development

Showtail is built with TypeScript on the [Bun](https://bun.sh) runtime. It has minimal dependencies: `commander` for the CLI, with hashing and git handled through the standard library.

```bash
bun install
bun test            # Run the test suite
bun run typecheck   # tsc --noEmit
bun run dev -- --help
bun run build       # Compile a standalone binary to dist/showtail
```

---

## Roadmap

Showtail's MVP is a local CLI with a small core that can grow over time:

- Completed: **Claude Code skill + hooks** to capture your prompts and edits automatically while you pair. See [Claude Code integration](#claude-code-integration).
- Completed: **Claude Code session import** to back-fill your trail from a session's on-disk transcript. See [Importing an existing Claude Code session](#importing-an-existing-claude-code-session).
- Completed: **GitHub Copilot and VS Code extension** to capture Copilot prompts and saved edits in one cross-tool report. See [GitHub Copilot integration](#github-copilot-integration).
- Completed: **ChatGPT import** to bring selected conversations into the same trail. See [ChatGPT integration](#chatgpt-integration).
- Completed: **Google Gemini import** to bring conversations into the same trail from a share link or a paste. See [Google Gemini integration](#google-gemini-integration).
- Completed: **OpenAI Codex integration** to capture Codex prompts and edits through `AGENTS.md` and hooks. See [OpenAI Codex integration](#openai-codex-integration).
- Planned: **GitHub Action** to verify a submission's trail automatically in CI.
- Planned: **Signed provenance records** for stronger guarantees.
- Planned: **Educator dashboard** to review many students' trails at a glance.

---

## License

[Apache-2.0](./LICENSE)
