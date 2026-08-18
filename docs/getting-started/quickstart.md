# Quickstart

The whole flow is **install, then work**. Installing turns tracking on for you, your
prompts and edits are captured automatically, and you finish by generating a report.

```bash
# 1. Install (see Installation). That's it — tracking is now on.
# 2. ...just work — your prompts and the files your tool edits are captured for you...
showtail report    # 3. when you're done: generate the report for your educator
```

**There is no setup command to run.** Installing Showtail turns on automatic tracking and
connects the AI tools it finds — plus it pre-wires the ones it supports, so a tool you
install *later* is captured too, and you never lose work to a tool it missed. The first
time you work in a project, **Showtail initializes it for you** — the `.showtail/` folder
is created on the spot. Each time a tool is auto-connected, Showtail prints a short privacy
note telling you what it wired up and how to turn it off (`showtail setup --off`).

## Wiring up one project by hand

Tracking is on everywhere already, so you normally don't need this. But if you'd rather set
up a single project explicitly — or name it, or declare a non-code folder (like a book) as a
project — use `track` and `connect`:

```bash
# 1. Set up Showtail in this project and name it. This creates the .showtail/ folder.
showtail track --project "Week 5 Parser"

# 2. Connect a specific AI tool by hand (optional — auto-connect already did this).
showtail connect claude         # or: codex, copilot
```

To turn automatic tracking off entirely, run `showtail setup --off`.

## While you work

Your prompts and the files your tool edits are captured for you. Check where you
are at any time:

```bash
showtail status                 # current session, event count, connected tools
showtail sessions               # list your work sessions  (--all for the whole team)
showtail trace src/parser.ts    # the full trail for one file
```

## If you move your project

Moving or renaming your project folder is fine — drag it somewhere else, or ask
your AI tool to move it. The trail lives inside the folder and travels with it, and
everything captured is also kept in a machine-local ledger.

If work does get separated from its folder, it waits in the inbox tagged
`[files moved or deleted]`. Pick it back up with:

```bash
showtail inbox                  # see anything waiting to be placed
showtail track <new folder>     # find that work by content and pull it in
```

Showtail matches on what your files *contain*, not where they used to be, so a move
doesn't break the trail. If it's confident it places the work for you; if it's only
fairly sure it will list the sessions and let you confirm with
`showtail move <id> --to .` — it will never file your work under the wrong project
on a guess.

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
```

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
