---
applyTo: "**"
---

# Showtail provenance (VS Code agent mode)

Work normally. The Showtail VS Code extension automatically imports native Copilot Chat
prompts and replies and snapshots saved files. During routine work, never run manual
prompt-logging or artifact-snapshot commands, never ask for per-message recording
permission, and never invoke hooks intended for the standalone Copilot CLI. Those actions
would duplicate capture or assign the wrong tool label.

Only run project controls when the student explicitly asks. Use the
`showtail_project_control` tool, pass the requested action, and copy the student's project
wording into `selector`; never manufacture an absolute path. For a follow-up that does not name
a new project, reuse the prior claim with report, open-report, status, or verify. If the student
does name a project, pass that wording as `selector` and do not reuse a prior claim. If the tool
is unavailable, resolve with `showtail projects "<student-project-wording>" --json` and use only
the selected trail ID with `showtail report|verify|status --project <trail-id>`. Keep everything
local and never record secrets.
