# OpenAI Codex integration

If you work with [Codex](https://developers.openai.com/codex), Showtail can
capture that work into the same `.showtail/` trail. Codex is similar to Claude
Code because it has lifecycle hooks and reads project instructions from
`AGENTS.md`, so the setup is similar:

```bash
# In your project. Writes ./AGENTS.md and ./.codex/hooks.json, then offers to enable hooks.
showtail connect codex --project

# Or install for all projects.
showtail connect codex --user

# Instructions only, no hooks. AGENTS.md then captures manually.
showtail connect codex --project --no-hooks
```

What this gives you:

- **Instructions in `AGENTS.md`.** Showtail adds a fingerprinted, managed block
  that keeps the trail tidy. Your own text in `AGENTS.md` is never touched.
- **Codex-tagged events.** Your prompts, edits (with diffs), replies, decisions,
  and plans are captured with the `codex` tag — the same as Claude Code.
- **Auto-capture hooks**, enabled by default unless you pass `--no-hooks`.

| When | Showtail does this |
| ---- | ------------------ |
| You submit a prompt | Logs it as a `prompt` event |
| Codex edits a file with `apply_patch` | Snapshots that file as an `artifact`, with the patch as its diff |
| Codex replies | Logs the reply as an `ai_output` event |
| Codex asks you to choose (`request_user_input`) | Logs your pick as a `decision` event |
| Codex builds a plan (`update_plan`) | Logs it as a `plan` event (a to-do checklist; no approval badge) |
| A session starts | Ensures a work session exists |

## Enabling Codex hooks

Codex only fires lifecycle hooks when `features.hooks = true` is set in its
`config.toml`. During `showtail connect codex`, Showtail asks before turning that
setting on. The default answer is yes.

Showtail edits `config.toml` carefully. It sets only this key and leaves your
other settings alone:

```toml
[features]
hooks = true
```

Useful commands:

```bash
showtail connect codex --project --yes  # Enable hooks without prompting
showtail status                          # Check instructions and auto-capture state
showtail disconnect codex                # Remove the AGENTS.md block and hooks
```

`showtail disconnect codex` leaves `config.toml` alone.

## Notes on Codex edits

Codex applies file changes through its `apply_patch` tool. Showtail parses those
patches and snapshots the touched files.

If Codex changes files by running raw shell commands, such as `sed`, those edits
are not visible to the hook and are not auto-snapshotted. Record them manually
when you want them in the trail:

```bash
showtail artifact <file> --tool codex
```

As with the other integrations, everything stays local. There is no telemetry
and no external calls.

The instructions block is yours to customize. If you edit inside the Showtail
markers, Showtail will not overwrite your changes (and `showtail status` flags
that an update is available). Run `showtail connect codex --force` to take the
latest managed version.
