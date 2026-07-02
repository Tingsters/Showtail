# GitHub Copilot integration

Showtail can also capture **GitHub Copilot** work into the same `.showtail/`
trail. That means a student can move between Claude Code and Copilot while the
educator sees one coherent story.

Install the VS Code extension:

```bash
code --install-extension Tingsters.showtail
```

You can also download the `.vsix` from the GitHub Releases page.

When you open a project in VS Code, the extension sets up the Copilot
instructions automatically. It writes `.github/copilot-instructions.md` the first
time it sees a `.showtail/` folder.

You can also set this up explicitly:

```bash
showtail connect copilot
```

!!! note "Requirements"
    - The `showtail` CLI on your `PATH` (or set `showtail.binaryPath`). Install
      from the [Showtail releases](https://github.com/Tingsters/Showtail/releases).
    - A project initialized with `showtail track` (or any project where Showtail
      tracking is already on).

## How Copilot capture works

Copilot is more closed than Claude Code, so the integration works a little
differently:

- **Use native Copilot as usual.** This includes agent mode, inline suggestions,
  and chat.
- **Native Copilot Chat is captured.** VS Code writes every native chat session to
  disk (`…/workspaceStorage/<hash>/chatSessions/<id>.jsonl`; no-folder windows use
  `…/globalStorage/emptyWindowChatSessions/<id>.jsonl`). The extension watches those
  files and imports each turn — your prompt, Copilot's reply, and the files it edited
  — tagged `github-copilot`. A chat in an open project lands in that project's trail.
  A chat with **no folder open** is routed by its edited files into the matching
  project; if its work doesn't belong to any tracked project, it's parked in your
  **inbox** (not dumped into a machine-wide catch-all). You can also back-fill past
  chats anytime with `showtail import copilot`.
- **Folderless chats wait in the inbox.** Run `showtail inbox` to see captured Copilot
  work that isn't tied to a project yet, then place it — `showtail track <folder>` to
  make a folder a project and pull its work in, or `showtail move <id> --to <path>` for
  one session. (See the inbox commands in the [CLI reference](../reference/cli.md).)
- **File edits are captured automatically.** When a folder is open, the extension also
  snapshots every file you save as an artifact, so edits made outside chat are never
  lost. These snapshots record the *resulting code*, not how it was produced — so code
  written by hand, pasted, or accepted from an inline suggestion all look the same in
  the trail.
- **`@showtail` is the Showtail control surface in chat.** It is not a coding
  agent. Use it to run Showtail commands such as `@showtail /report`, `/verify`,
  `/status`, and `/trace <file>`.

Native Copilot Chat is **not** exposed to third-party extensions through the VS
Code API — that part is a real Copilot privacy boundary. But the chat is persisted
to disk as plain JSON, so Showtail reads the on-disk session files instead of the
(unavailable) live API. The result is the same: your native-chat prompts and
Copilot's replies land in the trail, live as you work and via `import copilot`.

!!! warning "Honest limitations"
    - Native chat is read from VS Code's on-disk session files, so a turn lands in
      the trail a moment **after** it completes (when VS Code flushes the file), not
      keystroke-by-keystroke.
    - **Inline (ghost-text) completions aren't attributed.** VS Code exposes no event
      for accepting a Copilot inline suggestion, and Copilot saves no record of one — so
      the completed code is captured only as part of your next **file save**, as an
      ordinary edit. Showtail can't tell which characters came from a suggestion, so
      inline completions are never labeled as AI. (Copilot **Chat** — prompt + reply +
      edits — *is* attributed; and agentic tools like Claude Code / Codex capture their
      edits directly via hooks.)
    - Multi-root (`.code-workspace`) windows aren't routed by folder yet; single-
      folder workspaces — the common case — are.

## Back-filling past Copilot chats

Already chatted with Copilot before connecting Showtail? Import those sessions:

```bash
showtail import copilot            # pick this project's sessions interactively
showtail import copilot --list     # list them non-interactively
showtail import copilot <id>       # import one by its session id
```

Imports are idempotent — re-running (or the live watcher re-reading a file) only
adds what's new, deduped by a stable per-turn id. Undo a batch with
`showtail import undo`.

## Customizing Copilot instructions

The instruction files are yours to edit. Showtail only overwrites text that it
wrote itself. Each Showtail-managed block carries a fingerprint, so on the next
open:

- A block you have not changed is refreshed to the latest version.
- A block you have edited is left exactly as you wrote it.
- `showtail status` reports a customized Copilot block via its `updateAvailable` flag.
- If a newer managed block is available, Showtail gives you a one-time update notice.
- To take the latest managed block, run `showtail connect copilot --force`.

Add your own rules outside the Showtail markers. Those rules are always
preserved. The cleanest option is to put your rules in your own
`.github/instructions/your-rules.instructions.md` file. Copilot reads every
instructions file, and Showtail never touches yours.

## Following a student across both tools

Every event records which tool it came through. `showtail report` includes a
**Tools used** section with the switch sequence, and each timeline entry gets a
tool badge.

```text
## Tools used
- GitHub Copilot: 3 event(s)
- Claude Code: 2 event(s)

Tool timeline, where each arrow is a switch:
- GitHub Copilot · 14:02 to 14:10 · 2 event(s)
- Claude Code · 14:10 to 14:18 · 2 event(s)
- GitHub Copilot · 14:25 · 1 event(s)
```
