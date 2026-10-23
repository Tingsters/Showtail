# @showtail/agent-traces

Shared building blocks for tools that read the session logs AI coding agents
already write to disk. Used by [Showtail](https://github.com/Tingsters/Showtail)
and Tracetoon.

- `paths/hostHome`: each agent's home folder, honoring its override variable
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_HOME`, ...).
- `privacy/*`: secret and personal-data redaction, sensitive-path rules.
- `git/git`: safe git wrappers.
- `util/*`, `prompts/synthetic`: parsing helpers and injected-prompt detection.

Transcript readers for each agent are being moved here next.

Apache-2.0.
