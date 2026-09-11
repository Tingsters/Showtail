# Configuration

Showtail's project settings live in `.showtail/config.json`. The file is created
automatically with the project trail on the first meaningful prompt, by `track`
or `ensure`, or by `report` when matching captured work exists. It is shared
(committed) across the team. Machine-local state — the active session and author —
lives separately in
`.showtail/state.json`, which is git-ignored. See
[Data layout](../concepts/data-layout.md) for the full file tree.

Machine-wide preferences live in `~/.showtail-cli/config.json` and are never
committed with a project. This includes the automatic-tracking state, report-open
preference, and cached update-check state. Use
`showtail update --auto-check off` or `showtail update --auto-check on` instead of
editing the update preference by hand. `SHOWTAIL_DISABLE_UPDATE_CHECK=1` overrides
the preference for one process or managed environment.

## `config.json`

```json
{
  "version": 5,
  "project": "Week 5 Parser",
  "createdAt": "2026-09-10T18:42:00.000Z",
  "trailId": "trl_k3f9x2",
  "anchor": "/abs/path/to/project",
  "anchorKind": "git",
  "initialization": {
    "mode": "automatic",
    "evidence": "git",
    "ledgerSessionId": "led_f8d2m1"
  },
  "settings": {
    "git": true,
    "captureAiOutput": true,
    "captureCode": true,
    "captureToolCalls": true,
    "idleTimeoutMinutes": 60,
    "redact": { "enabled": true, "secrets": true, "pii": true }
  }
}
```

| Key | Meaning |
| --- | ------- |
| `version` | Showtail config schema version (currently `5`). Older trails remain readable and are upgraded when Showtail needs to write current metadata. |
| `project` | Optional project name shown in report titles. Set with `showtail track --project <name>`. |
| `createdAt` | ISO timestamp recording when the project trail was created. |
| `trailId` | Stable id identifying this trail wherever it lives. It travels with the folder, so a [moved project](cli.md#moving-a-project) is recognized rather than treated as deleted. Never changes; don't edit it. |
| `anchor` | Absolute path the trail is rooted at, for reference only — nothing resolves the project through it, and it is refreshed automatically if the folder moves. |
| `anchorKind` | Evidence that chose the root: `git`, `marker`, `workspace`, `edit`, `cwd`, or `explicit`. |
| `initialization` | How the trail was created (`automatic`, `report`, `track`, or `ensure`), the routing evidence, and—only for an automatic fallback—the ledger session that created it. Showtail uses this provenance when deciding whether a superseded pristine fallback can be removed safely. |
| `settings.git` | Try to capture the git commit hash on each event. |
| `settings.captureAiOutput` | Capture AI text responses (Stop hook / imports). Default on. |
| `settings.captureCode` | Capture AI-suggested code/diffs alongside edits. Default on. |
| `settings.captureToolCalls` | Capture non-edit tool calls (Bash, Read, Grep, ...) and their results. Default on. |
| `settings.idleTimeoutMinutes` | Minutes of inactivity after which an open session auto-closes (stamped at its last event). Defaults to 60. |
| `settings.redact` | Sensitive-data redaction settings — see below. |

## Redaction

Showtail makes a best-effort pass to scrub secrets and personal data from
captured text **before it is written to disk**. It is a safety net, not a
guarantee — still keep secrets out of your prompts. Tune it under
`settings.redact` in `config.json`:

```json
"redact": {
  "enabled": true,
  "secrets": true,
  "pii": true,
  "custom": ["MY-INTERNAL-[A-Z0-9]{8}"],
  "allow": ["sk-EXAMPLE-tutorial-key"]
}
```

| Key | Meaning |
| --- | ------- |
| `enabled` | Master switch. Default on. |
| `secrets` | Redact provider keys, private keys, tokens, connection strings, passwords. Default on. |
| `pii` | Redact email / phone / credit-card / SSN. Default on. |
| `custom` | Extra regex sources (strings) to also redact. |
| `allow` | Literal substrings that must never be redacted (e.g. tutorial sample keys). |

The report notes how many items were scrubbed. See
[Privacy &amp; redaction](../concepts/privacy.md) for the principles behind this.

## Per-tool capture settings

Each integration manages its own connection state outside `config.json`:

- **Claude Code / Codex hooks** are written into the tool's own settings
  (`.claude/settings.json`, Codex `config.toml`). Codex only fires hooks when
  `features.hooks = true`; `showtail connect codex` offers to set it. Turn
  capture off per tool with `showtail disconnect <tool>`.
- **Managed instruction blocks** (`AGENTS.md`, `.github/copilot-instructions.md`,
  the Claude skill) carry a fingerprint. Showtail refreshes a block you haven't
  touched and leaves an edited one alone; `showtail status` flags when an update
  is available, and `showtail connect <tool> --force` takes the latest.
- Install with `--no-hooks` to add only the instructions/skill, with no
  automatic hooks.

See the [integration guides](../integrations/index.md) for the specifics of each
tool.
