# GitHub Copilot integration

Showtail can also capture **GitHub Copilot** work and, once its project is clear,
route it into the same project-local `.showtail/` trail. That means a student can
move between Claude Code and Copilot while the educator sees one coherent story.

**You normally don't have to do anything.** When you install Showtail and it finds VS Code,
it installs the Showtail VS Code extension for you. The installer reports a pending or
failed installation instead of claiming capture is active when the extension is absent.
Stop Copilot capture anytime with `showtail disconnect copilot`; Showtail uses the VS Code
CLI to remove the extension. The bare command also records a durable machine-wide stop, so
capture remains off even if native removal fails and the extension stays installed; the
warning then tells you how to finish removing that dormant component. Reload open VS Code
windows after disconnecting or updating Showtail so an older extension process is unloaded.

If you ever need to install the extension by hand (e.g. VS Code's `code` command isn't
available for the auto-install to use):

```bash
code --install-extension Tingsters.showtail
```

You can also download the `.vsix` from the GitHub Releases page.

When you open a project in VS Code, the extension watches Copilot and saved-file
activity immediately. Showtail creates the project-local trail when the first
meaningful prompt identifies that project, and the extension keeps the Copilot
instructions current once the trail exists.

You can also set this up explicitly:

```bash
showtail connect copilot
```

!!! note "Requirements"
    - The `showtail` CLI on your `PATH` (or set `showtail.binaryPath`). Install
      from the [Showtail releases](https://github.com/Tingsters/Showtail/releases).
    - Open the folder you are working in. No `track` or initialization command is
      required; `showtail track` remains an optional boundary/name/repair override.

## How Copilot capture works

Copilot is more closed than Claude Code, so the integration works a little
differently:

- **Use native Copilot as usual.** This includes agent mode, inline suggestions,
  and chat.
- **Native Copilot Chat is captured.** VS Code writes every native chat session to
  disk (`…/workspaceStorage/<hash>/chatSessions/<id>.jsonl`; no-folder windows use
  `…/globalStorage/emptyWindowChatSessions/<id>.jsonl`). The extension watches those
  files and sends each turn — your prompt, Copilot's reply, and the files it edited —
  through Showtail's machine-local ledger, tagged `github-copilot`. Stable session/request
  IDs, explicit attachments, edit URIs, and Showtail's own control-result marker let the
  ledger bind individual turns to a stable trail ID.
  A chat with **no folder open** is routed by its edited files. If those files identify
  one project, Showtail can create its local trail automatically; if the work has no
  single clear project, the complete session waits in your **inbox** instead of being
  dumped into a machine-wide catch-all. You can also back-fill past chats anytime with
  `showtail import copilot`.
- **Unplaced chats wait in the inbox.** Run `showtail inbox` to see captured Copilot
  work that isn't sitting in a project — either not tied to one yet, spanning multiple
  projects, or in a folder that has since moved — then place it with
  `showtail move <id> --to <path>`. Use `showtail track <folder>` only when you want to
  declare a custom boundary, name/repair the trail, or recover moved-file work.
  (See the inbox commands and [Moving a project](../reference/cli.md#moving-a-project)
  in the CLI reference.)
- **File edits are captured automatically.** When a folder is open, the extension sends
  every saved-file snapshot through the same ledger-first path, so a save cannot write an
  escaping `../` artifact into the wrong project. Once routing is unambiguous, the snapshot
  records the *resulting code*, not how it was produced — so code written by hand, pasted,
  or accepted from an inline suggestion all look the same in the trail.
- **`@showtail` is the Showtail control surface in chat.** It is not a coding
  agent. Use it to run Showtail commands such as `@showtail /report`, `/verify`,
  `/status`, and `/trace <file>`.

When you ask for a project control, native Copilot uses Showtail's local
`showtail_project_control` tool. The tool resolves your wording against validated trail metadata,
then invokes `status`, `report`, or `verify` by trail ID and checks both the returned identity and
root. If copied trail IDs require an explicit path to disambiguate them, that selected physical
root remains the command selector. The tool never treats Copilot's terminal cwd or the open
workspace as the answer. If metadata does not identify one project, Showtail presents a local
confirmation or picker instead of guessing.

The compact tool result carries a one-use claim that the transcript watcher associates with the
exact native request. Follow-ups such as "open the report" reuse the validated result rather than
generating the report a second time.

VS Code 1.95 does not expose the current request's attachment references to a language-model tool
before that tool runs. Showtail therefore does not guess by timestamp or inspect private editor
databases. Explicit attachments are still captured from the native transcript and can validate
routing and later same-chat controls once VS Code writes the turn; pre-execution controls use the
student's selector, a prior Showtail claim, or local confirmation.

Native Copilot Chat is **not** exposed to third-party extensions through the VS
Code API — that part is a real Copilot privacy boundary. But the chat is persisted
to disk as plain JSON, so Showtail reads the on-disk session files instead of the
(unavailable) live API. Your native-chat prompts and Copilot's replies enter the
local ledger, live as you work and via `import copilot`, then appear in the project
trail after unambiguous placement.

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
    - A multi-root (`.code-workspace`) session is captured but stays inbox-only. Showtail
      does not guess between its roots or write cross-project `../` paths; place the complete
      session explicitly when it belongs in one project.

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
