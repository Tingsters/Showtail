# Quickstart

The whole flow is **install, then work**. Installing turns tracking on for you, your
prompts and edits are captured automatically, and you finish by generating a report.

```bash
# 1. Install (see Installation). That's it — tracking is now on.
# 2. ...just work — your prompts and the files your tool edits are captured for you...
showtail report    # 3. when you're done: generate the report for your educator
```

**There is no setup command to run.** Installing Showtail turns on automatic tracking,
connects the AI tools it finds, and pre-wires integrations that are safe to configure before
their host tool exists. If you install another AI tool later, Showtail connects it during a
later Showtail sweep; install the AI tool first or run `showtail connect <tool>` before its
first session when first-turn capture matters. The first
meaningful prompt in a project **initializes it for you** — the `.showtail/` folder is
created at the best project root Showtail can identify. Merely opening an AI session or
receiving an isolated editor event creates nothing. Each time a tool is auto-connected,
Showtail prints a short privacy note telling you what it wired up and how to disconnect that
tool. `showtail setup --off` separately disables automatic creation of new project trails.

## If your AI tool starts in your home folder

That is safe. Your home folder can be a real project when you work there deliberately, and
so can a temporary folder. A `.showtail/` created exactly in HOME applies only to work
launched there — child folders never inherit it.

If the first prompt starts from HOME but a workspace or later edit identifies an assignment
below it, Showtail reroutes the complete session to that child project. It removes the
automatically created HOME fallback only if the trail is still pristine; anything changed,
committed, reported, or used by other work is preserved.

Showtail also respects projects nested inside broader folders. A nested Git repository or
a folder with its own project file (for example `package.json`, `pyproject.toml`, or
`Cargo.toml`) is not absorbed by a `.showtail/` higher up. If one AI session genuinely
edits files in more than one project, Showtail does not guess: it removes the session from
either project trail and leaves the complete session in `showtail inbox` for you to place.

## Wiring up one project by hand

Tracking is on everywhere already, so you normally don't need this. But if you'd rather set
up a single project explicitly — or name it, declare a non-code folder (like a book) as a
project, or pull moved work back in — use `track`:

```bash
# 1. Set up Showtail in this project and name it. This creates the .showtail/ folder.
showtail track --project "Week 5 Parser"

# 2. Connect a specific AI tool by hand (optional — auto-connect already did this).
showtail connect claude         # or: codex, copilot
```

`track [path]` works at any exact path, including HOME and temporary folders. The hidden,
advanced `showtail ensure` command is also explicit and idempotent: it resolves the same
project root, creates the trail if needed, and opens a session. Integrations may call it,
but ordinary work does not require it.

To stop creating new project trails automatically, run `showtail setup --off`; connected
tools and existing trails keep capturing. To stop a tool's capture, run
`showtail disconnect <tool>`.

## While you work

Your prompts and the files your tool edits are captured for you. Check where you
are at any time:

```bash
showtail status                 # current session, event count, connected tools
showtail sessions               # list your work sessions  (--all for the whole team)
showtail trace src/parser.ts    # the full trail for one file
```

`status` is a read-only probe and succeeds before a trail exists. In JSON mode it reports
the candidate root and evidence, global setup/inbox state, and — with `--tool <tool>` —
whether that integration's capture is `automatic`, `manual`, or `disconnected`.

## If you move your project

Moving or renaming the whole project folder is fine — the hidden `.showtail/` trail
travels with it, and `report` recognizes the trail at its new path. Everything captured
is also kept in a machine-local ledger.

Students sometimes move only the visible project files and leave `.showtail/` behind.
That is recoverable too. Run either command at the new location:

```bash
showtail report <new folder>    # recover exact matches, then generate the report
showtail track <new folder>     # recover exact matches without generating a report
```

Showtail matches on what your files *contain*, not only where they used to be. An exact
content hash or captured Git commit can relocate the work automatically even when the
old `.showtail/` folder still exists. If the original files still exist, Showtail treats
the new files as a possible copy and leaves the old trail alone. A similarity-only match,
a session spanning multiple projects, or a move that cannot safely map every edited path
is also left for review instead of being filed on a guess. Use `showtail inbox` to inspect
waiting work, then confirm an intended move with
`showtail move <id> --to <new folder>`.

## Generate a report

```bash
showtail report                 # HTML + Markdown; team + per-student for 2+ contributors
showtail report ../other-project # target a project without changing directories
showtail report --format md     # Markdown only
showtail report --format json   # Machine-readable JSON
showtail report --team          # just the combined team report
showtail report --author <slug> # just one student's report
```

If the target already has a trail, `report` claims unambiguous pending work before
rendering. If no trail exists but path evidence or exact content lineage proves captured
work belongs there, the same command creates `.showtail/`, places the work, and generates
the report. It creates nothing when there is no matching captured work (exit `4`). A
similarity-only relocation or work spanning multiple projects stops for review (exit `2`);
the complete session remains where it is instead of being filed on a guess.

## Before you submit

```bash
showtail verify                 # integrity checks on your trail
```

If an AI agent runs these controls for you, it should identify the project you mean and pass its
absolute path instead of relying on the agent terminal's current folder:

```bash
showtail status "<absolute-project-path>" --json --tool <tool>
showtail report "<absolute-project-path>" --json --no-open
showtail verify "<absolute-project-path>" --json
```

The JSON `root` confirms which existing project Showtail selected (`candidateRoot` identifies an
untracked target before its trail exists), and `reportPath` identifies the report the agent should
give you. The pathless `showtail status --json --tool <tool>` command used at agent startup remains
a capture-mode probe, not a project report request.

Sessions open and close on their own — there's nothing to end by hand. Commit
`.showtail/` with your work so your educator can review it.

!!! tip "Not using a tool with hooks?"
    ChatGPT and Gemini can't run commands on your machine, so they are
    **import-based** — you bring a shared conversation into the trail after the
    fact. See [ChatGPT](../integrations/chatgpt.md) and
    [Google Gemini](../integrations/gemini.md). You can also
    [back-fill an earlier Claude Code session](../integrations/claude-code.md#importing-an-existing-session).

## Next steps

- [Integrations](../integrations/index.md) — per-tool setup and the capability matrix.
- [How it works](../concepts/how-it-works.md) — the event model behind the trail.
- [For educators](../educators/classroom-workflow.md) — running this in a class.
- [CLI reference](../reference/cli.md) — every command and flag.
