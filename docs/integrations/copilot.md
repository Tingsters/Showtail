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
    - A project initialized with `showtail init` (or any project where Showtail
      tracking is already on).

## How Copilot capture works

Copilot is more closed than Claude Code, so the integration works a little
differently:

- **Use native Copilot as usual.** This includes agent mode, inline suggestions,
  and chat. The `.github/copilot-instructions.md` file teaches Copilot to log
  your prompts through the Showtail CLI (Copilot has no capture hooks, so prompts
  are recorded this way).
- **File edits are captured automatically.** The VS Code extension snapshots
  every file you save as an artifact tagged `github-copilot`.
- **`@showtail` is the Showtail control surface in chat.** It is not a coding
  agent. Use it to record a prompt verbatim with `@showtail <your question>`, or
  to run Showtail commands such as `@showtail /report`, `/verify`, `/status`, and
  `/trace <file>`.
- **For hands-on file edits, use native Copilot.** Saved edits are captured
  regardless.

Copilot does not expose prompts typed into native chat to third parties. That is
a Copilot privacy boundary, not a Showtail limitation. The instructions ask
Copilot to log your prompt, and `@showtail` captures it verbatim when you ask
through it. Either way, edits are captured on save, so the work history is not
lost.

!!! warning "Honest limitations"
    - Prompts typed into **native** Copilot Chat (not `@showtail`) cannot be
      captured by any third-party extension — that's a Copilot privacy boundary.
      Your **edits are still captured on save**, so the work history is never lost.
    - There is no VS Code event for accepting an inline (ghost-text) completion,
      so inline completions are captured as part of the next file save, not
      individually.

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
