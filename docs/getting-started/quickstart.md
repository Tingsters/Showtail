# Quickstart

The whole flow is **connect once, then work**. After a one-time setup, your
prompts and edits are captured automatically and you finish by generating a
report.

```bash
showtail setup     # one-time: connect your AI tools and turn on automatic tracking
# ...just work — your prompts and the files your tool edits are captured for you...
showtail report    # generate the report for your educator
```

`showtail setup` is the fastest start: it connects the AI tools it finds and
turns on automatic tracking for every project. Once a tool is connected,
**Showtail initializes a project for you the first time you work in it** — the
`.showtail/` folder is created on the spot, so there is no separate init step to
remember.

## Wiring up one project by hand

Prefer to set up a single project explicitly instead of turning on tracking
everywhere? Use `track` and `connect`:

```bash
# 1. Set up Showtail in your project. This creates the .showtail/ folder.
showtail track --project "Week 5 Parser"

# 2. Connect your AI tool so capture is automatic (one time).
showtail connect claude         # or: codex, copilot
```

`showtail track` is the **manual** path. If you already ran `showtail setup`,
tracking is on everywhere and you can skip both steps.

## While you work

Your prompts and the files your tool edits are captured for you. Check where you
are at any time:

```bash
showtail status                 # current session, event count, connected tools
showtail sessions               # list your work sessions  (--all for the whole team)
showtail trace src/parser.ts    # the full trail for one file
```

## Generate a report

```bash
showtail report                 # HTML + Markdown in .showtail/reports/ (team + per-student)
showtail report --format md     # Markdown only
showtail report --format json   # Machine-readable JSON
showtail report --team          # just the combined team report
showtail report --author <slug> # just one student's report
```

## Before you submit

```bash
showtail verify                 # integrity checks on your trail
showtail end                    # close the current session
```

Commit `.showtail/` with your work so your educator can review it.

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
