# Showtail for VS Code (GitHub Copilot)

Capture your **GitHub Copilot** prompts and edits into a local Showtail "show your work"
trail — the same `.showtail/` trail the [Showtail CLI](https://github.com/Tingsters/Showtail)
and the Claude Code integration use, so a professor can follow your whole project across both
tools.

## What it does

- **Sets up & keeps Copilot instructions current automatically** — the first time you open a
  project that has a `.showtail/` folder it writes `.github/copilot-instructions.md` for you,
  and on later opens it refreshes them. It only ever overwrites text Showtail wrote: blocks you
  edit are kept (you'll get a one-time "update available" nudge, never an overwrite), and it
  won't fight a later `showtail disconnect copilot`.
- **Captures native Copilot Chat** — VS Code writes every native chat session to disk
  (`…/workspaceStorage/<hash>/chatSessions/<uuid>.json`); the extension watches those files and
  imports each turn (your prompt, Copilot's reply, the files it edited), tagged `github-copilot`.
  Back-fill past chats anytime with `showtail import copilot`.
- **Snapshots files on save** as artifacts (tagged `github-copilot`) — automatic, no action
  needed, so edits made outside chat are captured too.
- **`@showtail` — a Showtail control surface in chat** (not a coding agent). Drive Showtail
  without leaving the editor: `@showtail /report`, `/verify`, `/status`, `/trace <file>`.
- **Commands**: `Showtail: Generate Report`, `Showtail: Status`.

Code with **native Copilot** as usual — your chat turns and your saved edits are both captured,
no special action needed. Use `@showtail` for the Showtail commands.

## Requirements

- The `showtail` CLI on your PATH (or set `showtail.binaryPath`). Install from the
  [Showtail releases](https://github.com/Tingsters/Showtail/releases).
- A project initialized with `showtail track`.

## Honest limitations

- Native Copilot Chat isn't exposed to third-party extensions through the VS Code API (a real
  Copilot privacy boundary), so the extension reads it from VS Code's **on-disk** chat-session
  files instead. A turn therefore lands a moment **after** it completes (when VS Code flushes
  the file), not keystroke-by-keystroke.
- There is no VS Code event for accepting an inline (ghost-text) completion, so inline
  completions are captured as part of the next file save, not individually.
- Multi-root (`.code-workspace`) windows aren't routed by folder yet; single-folder workspaces —
  the common case — are.

## Develop / build

```bash
bun install        # or npm install
bun run build      # esbuild -> dist/extension.js
bun run typecheck
bun run package    # vsce package -> showtail-<version>.vsix
```

Load it with **Run > Start Debugging** (Extension Development Host), or install the VSIX with
`code --install-extension showtail-<version>.vsix`.
