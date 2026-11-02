# Showtail for VS Code

Capture supported GitHub Copilot Chat and Antigravity IDE conversations and saved
files into one private Showtail home (`~/.showtail`, or absolute `SHOWTAIL_HOME`).
Projects are views of that history. The extension does not install project
instructions, create project storage, or change Git configuration.

Install the Showtail CLI and run `showtail setup`, then install this extension.
Use `@showtail /report`, `/open_report`, `/status`, or `/verify` to select a project
view. Reports open from Showtail's central `reports/` directory; moving a project
does not move or invalidate its reports. The project-control tool checks identities
and storage paths before opening a report.

Capture requires a trusted workspace. `showtail.binaryPath` is machine/user scoped.
`showtail setup --off` pauses capture; `showtail disconnect copilot` or
`showtail disconnect antigravity-ide` stops the corresponding integration.
Existing history is retained. Private reports stay private; share only reviewed,
sanitized exports from `showtail submit`.

For development: `bun install`, `bun test`, `bun run typecheck`, `bun run build`.
