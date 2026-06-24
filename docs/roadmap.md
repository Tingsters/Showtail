# Roadmap

Showtail's MVP is a local CLI with a small core that can grow over time:

- Completed: **Claude Code skill + hooks** to capture your prompts and edits
  automatically while you pair. See [Claude Code integration](integrations/claude-code.md).
- Completed: **Claude Code session import** to back-fill your trail from a
  session's on-disk transcript. See [Importing an existing session](integrations/claude-code.md#importing-an-existing-session).
- Completed: **GitHub Copilot and VS Code extension** to capture Copilot prompts
  and saved edits in one cross-tool report. See [GitHub Copilot integration](integrations/copilot.md).
- Completed: **ChatGPT import** to bring selected conversations into the same
  trail. See [ChatGPT integration](integrations/chatgpt.md).
- Completed: **Google Gemini import** to bring conversations into the same trail
  from a share link or a paste. See [Google Gemini integration](integrations/gemini.md).
- Completed: **OpenAI Codex integration** to capture Codex prompts and edits
  through `AGENTS.md` and hooks. See [OpenAI Codex integration](integrations/codex.md).
- Completed: **Team trails** so several students share one `.showtail/`, merge
  their work through git conflict-free, and get a combined team report. See
  [Working as a team](educators/teams.md).
- Completed: **Automatic secret/PII redaction** that scrubs captured text before
  it is stored. See [Privacy &amp; redaction](concepts/privacy.md).
- Planned: **GitHub Action** to verify a submission's trail automatically in CI.
- Planned: **Signed provenance records** for stronger guarantees.
- Planned: **Educator dashboard** to review many students' trails at a glance.
