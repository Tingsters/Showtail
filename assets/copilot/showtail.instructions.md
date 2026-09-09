---
applyTo: "**"
---

# Showtail provenance (VS Code agent mode)

Work normally. The Showtail VS Code extension automatically imports native Copilot Chat
prompts and replies and snapshots saved files. During routine work, never run manual
prompt-logging or artifact-snapshot commands, never ask for per-message recording
permission, and never invoke hooks intended for the standalone Copilot CLI. Those actions
would duplicate capture or assign the wrong tool label.

Only run `showtail report`, `showtail verify`, or `showtail status` when the student
explicitly asks for that control action. Keep everything local and never record secrets.
