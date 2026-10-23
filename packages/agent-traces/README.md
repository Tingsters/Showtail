# @showtail/agent-traces

Read the session logs that AI coding agents already keep on disk. Nothing to
install in the agent, no hooks: these functions only read existing files.
Used by [Showtail](https://github.com/Tingsters/Showtail) and Tracetoon.

| Module | What it reads or does |
|---|---|
| `claude/transcript` | `~/.claude/projects/<dir>/<session>.jsonl` (`CLAUDE_CONFIG_DIR`) |
| `codex/transcript`, `codex/appServer` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME`), or `codex app-server` when available |
| `antigravity/cliTranscript`, `ideTranscript`, `edits` | `~/.gemini/antigravity-{cli,ide}/brain/<id>/` (`ANTIGRAVITY_HOME`, `GEMINI_HOME`) |
| `copilot/cliTranscript` | `~/.copilot/session-state/<id>/events.jsonl` (`COPILOT_HOME`) |
| `privacy/*` | Secret and personal-data redaction, sensitive-path rules |
| `share/comment` | `neutralize`, `scanComment`, `approvalCode` for posting text publicly |
| `match/overlap` | Time-span and sequence matching with clock drift |
| `git/git`, `paths/*`, `util/*` | Safe git wrapper, path helpers, parsing helpers |

All readers output the same model (`model.ts`): `HookTranscript` with
`messages` (user, assistant, edit, plan, decision, tool_call, recap) and
lossless `events`.

```ts
import { claude } from '@showtail/agent-traces';
const [latest] = claude.findProjectTranscripts(process.cwd());
const t = latest && claude.readTranscriptFile(latest.path, process.cwd());
```

Requires Bun ≥ 1.1 (Node ≥ 22.6 with type stripping should work but is not yet
tested in CI). Apache-2.0.
