# Claude Code integration

If you work with [Claude Code](https://claude.com/claude-code), Showtail can help
build the trail for you. Install the bundled skill, which includes auto-capture
hooks by default:

```bash
# In your project. Creates ./.claude/skills/showtail/ and ./.claude/settings.json.
showtail connect claude --project

# Or install for all projects.
showtail connect claude --user

# Install the skill without changing settings. Capture is then manual.
showtail connect claude --project --no-hooks
```

What this gives you:

- **A Showtail skill** that helps Claude keep the trail tidy and offers to
  generate the report when you finish.
- **Hooks**, enabled by default, that capture your prompts and file edits
  automatically.

| When | Showtail does this |
| ---- | ------------------ |
| You submit a prompt | Logs it as a `prompt` event |
| Claude edits or writes a file | Snapshots that file as an `artifact` |
| Claude runs a Bash command, reads a file, searches, etc. | Logs it (and its result) as a `tool_call` event |
| A backgrounded command or a subagent Claude started finishes | Logs how it finished (completed, failed, or stopped) as a `tool_call` event |
| Claude pauses to ask you to choose between options | Logs your choice as a `decision` |
| Claude shows an end-of-turn recap | Logs it, plus the turn's duration and token usage, as a `recap` event |
| A session starts | Ensures a work session exists |

Tool-call capture can be turned off per project with
`settings.captureToolCalls: false` in `.showtail/config.json` (see
[Configuration](../reference/configuration.md)) if you'd rather keep the report
focused on prompts, replies, and edits.

### Catching the end of a session

Claude Code writes its transcript *asynchronously* — its own docs describe
`transcript_path` as "written asynchronously, may lag current turn" — and it
appends each turn's recap a few minutes after the turn ends, once you've stepped
away. Both land after the hooks for that turn have already run. Mid-session this
sorts itself out (the next turn's hook re-reads the whole transcript), but the
**last** exchange of a session has no later hook to catch it.

So Showtail re-reads the transcript at the points that matter: when a session
ends or resumes, and once more when you run `showtail report`. That last sweep
is what guarantees your report includes the final exchange and its recap no
matter when you closed Claude Code. It only ever adds what was missing, so
running `showtail report` repeatedly changes nothing. Pass `--no-sync` to skip
it and report strictly what was already captured.

If you install with `--no-hooks`, the skill can still check `showtail status --json`
and log prompts and file snapshots itself. That mode is model-driven rather than
guaranteed, but it still gives you a useful trail.

At the end of your work session, run:

```bash
showtail report
```

The report gives your educator a readable view of what happened.

## Install through the Claude Code plugin

You can also install Showtail through the Claude Code plugin marketplace:

```text
/plugin marketplace add Tingsters/Showtail
/plugin install showtail
```

The plugin includes the same skill and hooks.

## Privacy with Claude Code hooks

When hooks are active, every prompt you submit and every file Claude edits is
logged locally to `.showtail/`. That is the purpose of Showtail, but it is worth
keeping a few habits in mind:

- Nothing is sent anywhere. There are no external calls and no telemetry.
- The trail may be committed to your repository, so do not put secrets in
  prompts while capture is on.
- Review your trail anytime with `showtail report`.
- Turn capture off with `showtail disconnect claude`. Add `--user` if you
  installed at user scope.
- To install the skill without hooks, use `showtail connect claude --no-hooks`.
  The skill can still capture prompts itself, but it will not add hooks to
  `settings.json`.

## Importing an existing session

If you enabled Showtail partway through a session — or only afterwards — you do
not have to lose the earlier work. Claude Code writes a full transcript of every
session to disk (under `~/.claude/projects/…`), and Showtail can back-fill your
trail from it so it reads as if capture had been on from the start. This is
**local** like everything else: nothing is fetched, and because the transcript
records who said what, there is no guessing about what you wrote versus what
Claude produced.

Run it with no arguments to pick from this project's sessions:

```bash
showtail import claude
```

This opens an interactive picker. Each session shows how long ago it ran, its
prompt and edit counts, a rough duration, its first and last prompt, and whether
it is already in your trail — so the right one is easy to spot:

```text
Claude Code sessions for this project (3):

  1. 2h ago    8 prompt(s), 5 edit(s), ~25 min
     first: rework the claude code import so it is easier to pick sessions
     last:  add tests for the picker
     id: cc010626-49c0-4bef-a72f-2c1a0a4a172e

  2. yesterday    3 prompt(s), 0 edit(s), ~4 min  [imported]
     first: fix the timestamp parsing bug
     id: a019ec8b-df56-4e6b-9176-13bae0c42a86

Pick sessions to import [e.g. 1,3 or 'all', q to quit]:
```

Pick one or several — `1`, a list like `1,3`, a range `1-2`, or `all`. The whole
selection is imported as a single batch, so one `showtail import undo` reverses
it.

Options:

- `<session-id>` — import a specific session by its id (or just the start of it), skipping the picker.
- `--list` — print the same list without prompting, then import by id.
- `--no-responses` — import only your prompts. Claude's replies are imported by default.
- `--file <path>` — import a specific transcript `.jsonl` by path. Useful offline, or for a transcript stored elsewhere.
- `-s, --session <id>` — import into a specific Showtail session.

The command is also available as `showtail import claude-code`.

Your prompts become `prompt` events, Claude's replies become `ai_output`, each
file Claude edited becomes an `artifact`, and Claude's tool calls (Bash, Read,
Grep, ...) become `tool_call` events (imported alongside replies — both are
skipped with `--no-responses`) — all tagged `claude-code` and stamped with their
original times, so they interleave correctly with the rest of your trail. Each
turn's recap and duration/token stats, when present, import as a `recap` event
regardless of `--no-responses` (they're the turn's own stats, not AI-authored
content). Re-importing is safe: messages already in your trail are skipped
(that is what the `[imported]` marker means), and you can undo a whole batch in
one step:

```bash
showtail import undo
```

In a script or non-interactive shell there is nothing to pick from, so the
command imports the most recent session for the project.
