# Showtail for VS Code (GitHub Copilot)

Capture your **GitHub Copilot** prompts and edits into a local Showtail "show your work"
trail — the same `.showtail/` trail the [Showtail CLI](https://github.com/Tingsters/Showtail)
and the Claude Code integration use, so a professor can follow your whole project across both
tools.

## What it does

- **Snapshots files on save** as artifacts (tagged `github-copilot`) — automatic, no action
  needed, no matter which tool made the change.
- **`@showtail` — a Showtail control surface in chat** (not a coding agent). Record a prompt
  verbatim with `@showtail <your question>`, or drive Showtail without leaving the editor:
  `@showtail /report`, `/verify`, `/status`, `/trace <file>`.
- **Commands**: `Showtail: Generate Report`, `Showtail: Status`.

Code with **native Copilot** as usual — `.github/copilot-instructions.md` (written by
`showtail copilot install`) teaches it to log your prompt, decisions, and reflections in your
voice, and the extension captures every save. Use `@showtail` for the Showtail commands.

## Requirements

- The `showtail` CLI on your PATH (or set `showtail.binaryPath`). Install from the
  [Showtail releases](https://github.com/Tingsters/Showtail/releases).
- A project initialized with `showtail init`.

## Honest limitations

- Prompts typed into **native** Copilot Chat (not `@showtail`) cannot be captured by any
  third-party extension — that's a Copilot privacy boundary. Your **edits are still captured
  on save**, so the work history is never lost.
- There is no VS Code event for accepting an inline (ghost-text) completion, so inline
  completions are captured as part of the next file save, not individually.

## Develop / build

```bash
bun install        # or npm install
bun run build      # esbuild -> dist/extension.js
bun run typecheck
bun run package    # vsce package -> showtail-<version>.vsix
```

Load it with **Run > Start Debugging** (Extension Development Host), or install the VSIX with
`code --install-extension showtail-<version>.vsix`.
