# GitHub Copilot integration

For VS Code, run `showtail connect copilot` or install the extension:

```bash
code --install-extension Tingsters.showtail
```

The extension observes native Copilot Chat sessions, sending supported
records to Showtail's central history. It never creates `.github` instructions,
project data directories, ignore entries, or Git hooks. Trust the workspace to
allow capture; the CLI binary path is a machine/user setting.

Use `@showtail /report`, `/status`, `/verify`, or the project-control tool to select
a project view. The extension validates the project ID and the returned report
path under Showtail's home. Moving a project does not move its stored reports.
Folderless conversations can still be recorded; select their sessions in the CLI.

The participant handles review commands only and never calls a model itself.
Unrelated manual saves are not recorded as AI edits.

For the standalone Copilot CLI, run `showtail connect copilot-cli`. A reporting skill
and hooks live under `~/.copilot` (or `COPILOT_HOME`), outside repositories.
`showtail disconnect copilot-cli` stops that tool; `showtail disconnect copilot`
stops VS Code capture. `showtail setup --off` pauses every tool.

Import existing sessions with `showtail import copilot --list` or
`showtail import copilot-cli --list`, followed by the chosen session ID.
See [privacy](../concepts/privacy.md) for redaction and consent boundaries.
See [passive capture](../concepts/passive-capture.md) for callback limits and catch-up.
