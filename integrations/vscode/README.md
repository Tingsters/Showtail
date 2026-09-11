# Showtail for VS Code (GitHub Copilot)

Capture your **GitHub Copilot** prompts and edits into a local Showtail "show your work"
trail — the same `.showtail/` trail the [Showtail CLI](https://github.com/Tingsters/Showtail)
and the Claude Code integration use, so a professor can follow your whole project across both
tools.

## What it does

- **Starts watching immediately without changing the folder on open.** The first meaningful
  prompt creates the project-local `.showtail/` trail; a save or activation by itself does not.
  Once the trail exists, the extension installs and refreshes the Copilot instructions. It only
  overwrites text Showtail wrote, keeps blocks you edit, and respects a later
  `showtail disconnect copilot`, even if the extension cannot be physically removed and remains
  installed but dormant. Reload open editor windows after disconnecting or updating Showtail so
  a previously loaded extension process is replaced.
- **Captures native Copilot Chat** — VS Code writes every native chat session to disk
  (`…/workspaceStorage/<hash>/chatSessions/<uuid>.json`); the extension watches those files and
  imports each turn (your prompt, Copilot's reply, the files it edited) through Showtail's local
  ledger, tagged `github-copilot`. Back-fill past chats anytime with `showtail import copilot`.
- **Captures files on save through the same ledger-first flow** — automatic and project-local,
  including edits made outside chat. A save waits safely in the local inbox until prompt or
  workspace evidence identifies its project.
- **Routes the whole session, not whichever folder is listed first.** Single-project work lands
  with that project. Work spanning multiple roots remains inbox-only until you place it, so no
  report contains paths escaping its project.
- **Recovers from folder changes.** Moving the whole project carries `.showtail/` with it. If
  you move only the visible files and leave that hidden folder behind, `@showtail /report` or
  **Showtail: Generate Report** can recover an exact content or Git-history match into the active
  project even while the old trail still exists. Existing originals are treated as a possible
  copy; similarity-only, multi-project, and unsafe path-mapping cases stop for review instead
  of being moved.
- **`@showtail` — a Showtail control surface in chat** (not a coding agent). Drive Showtail
  without leaving the editor: `@showtail /report`, `/open_report`, `/verify`, `/status`,
  `/trace <file>`. You can name a project naturally or supply its exact path or trail ID.
  Showtail resolves that wording against its local, validated project catalog and runs the
  command by stable trail ID. When two live folders carry a copied trail ID, an explicitly chosen
  path stays pinned to that physical folder. If the evidence is not unique, the extension asks you
  to choose locally instead of trusting the open workspace. `/open_report` reuses the previously
  validated report when possible rather than generating it again.
- **Native Copilot project-control tool.** Report, open, status, and verify requests can use the
  same resolver directly from normal Copilot chat. Model-authored paths are semantic hints only;
  an authoritative path or trail ID requires a local confirmation unless it came from a trusted
  prior Showtail claim.
- **Commands**: `Showtail: Generate Report`, `Showtail: Open Report`, `Showtail: Status`,
  `Showtail: Verify Trail`.

Code with **native Copilot** as usual — your chat turns and your saved edits are both captured,
no setup command needed. Use `@showtail` for the Showtail commands.

## Requirements

- The `showtail` CLI on your PATH (or set `showtail.binaryPath`). Install from the
  [Showtail releases](https://github.com/Tingsters/Showtail/releases).

You do not need to initialize each project. The report command can claim matching work, recover
an exact file-only move, and create the local trail when the active project has captured work in
the ledger. If Showtail asks for relocation review, inspect `showtail inbox` and confirm the
intended session with `showtail move <session-id> --to <project>`.

If a report succeeds while some captured ranges still cannot be assigned safely, the report is
kept and the chat response lists those ranges, their reason and candidate projects. Use
`showtail inbox` to place them; Showtail does not silently attach them to the open workspace.

## Honest limitations

- Native Copilot Chat isn't exposed to third-party extensions through the VS Code API (a real
  Copilot privacy boundary), so the extension reads it from VS Code's **on-disk** chat-session
  files instead. A turn therefore lands a moment **after** it completes (when VS Code flushes
  the file), not keystroke-by-keystroke.
- VS Code 1.95 does not give a language-model tool the current request's attachment references
  before invocation. Showtail never timestamp-guesses or scans private editor databases to fill
  that gap. Attachments still become routing evidence after the native transcript is written and
  can support later controls in the same chat.
- There is no VS Code event for accepting an inline (ghost-text) completion, so inline
  completions are captured as part of the next file save, not individually.
- A conversation that genuinely touches more than one project is kept in `showtail inbox`; the
  extension deliberately does not split or guess ownership for one AI session.
- A copied file, a similarity-only relocation match, or any other uncertain move needs explicit
  confirmation; the extension will not silently take work away from another project trail.

## Develop / build

```bash
bun install        # or npm install
bun run build      # esbuild -> dist/extension.js
bun run typecheck
bun run package    # vsce package -> showtail-<version>.vsix
```

Load it with **Run > Start Debugging** (Extension Development Host), or install the VSIX with
`code --install-extension showtail-<version>.vsix`.
