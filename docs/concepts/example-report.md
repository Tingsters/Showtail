# Example report

A generated report looks like this. The HTML report is rendered from the
Markdown source:

````markdown
# Showtail Report — Demo Project

_Generated 2026-06-12T15:14:07Z_

**Summary:** 1 task(s), 1 file(s) changed · 1 session(s), 5 event(s), 1 artifact record(s).

## Tools used

- **Claude Code** — 4 event(s)
- **GitHub Copilot** — 1 event(s)

Tool timeline (each arrow is a switch):

- **Claude Code** · 2026-06-12T15:02:11Z → 2026-06-12T15:09:48Z · 4 event(s)
- **GitHub Copilot** · 2026-06-12T15:14:02Z · 1 event(s)

## Prompts & AI exchanges

**Prompt** · `2026-06-12T15:02:11Z` · `Claude Code`

Help me structure a CSV parser.

_Suggested code — [`src/parser.ts`](../../src/parser.ts) (~6 line(s)):_

```diff
+export function parse(csv: string): string[][] {
+  return csv
+    .split("\n")
+    .filter((line) => line.length > 0)
+    .map((line) => line.split(","));
+}
```

<details><summary>🤖 1 AI message(s)</summary>

_AI response:_

Start by splitting the file on newlines, then parse each row into fields.

</details>

## Authorship statement

> I recorded this trail while working on "Demo Project". It shows the prompts I used and the
> files I built along the way. I worked through Claude Code and GitHub Copilot, and this trail
> records each. The work and understanding represented here are my own.
````

The report foregrounds the student's work: the prompt, the decisions they made,
and the files they built read inline. **All** of the AI's prose — uniformly, on
every tool — folds into one collapsed **"🤖 N AI messages"** group per exchange, so
it's there when you want it without burying the work.

In the HTML report a small **toolbar** sits under this heading with three controls:
**Expand / Collapse all** (skim the prompt spine vs. read every exchange), an **AI
messages** switch (reveal every group at once), and a **Sort: Time | Session**
toggle — *Time* reads the exchanges in one chronological stream, *Session* groups
each AI conversation together (useful when several ran in parallel); clicking the
active mode again reverses the order. On the command line, `showtail report --ai
full` (or `--no-ai`) sets the AI default for the generated file.

On a group project, the combined **team** report adds a **Contributors** section
listing each student and how much they contributed, and the timeline shows who
did what. If any secrets or personal details were scrubbed before storage, the
report notes how many.

## Machine-readable conversation events

`showtail report --format json` writes schema version 2. It retains the same
summary fields used by the HTML and Markdown reports and adds an ordered `events`
array to every turn. The event stream is deliberately provider-neutral:

```json
{
  "schemaVersion": 2,
  "turns": [
    {
      "prompt": { "text": "Build the demo." },
      "events": [
        { "sequence": 0, "type": "user_text", "text": "Build the demo." },
        {
          "sequence": 1,
          "type": "tool_use",
          "toolUseId": "call-1",
          "toolName": "Bash",
          "input": { "command": "python3 main.py" }
        },
        {
          "sequence": 2,
          "type": "tool_result",
          "toolUseId": "call-1",
          "stdout": "ok\n",
          "stderr": "",
          "exitCode": 0
        }
      ]
    }
  ]
}
```

Supported event types are `user_text`, `assistant_text`, `tool_use`,
`tool_result`, `plan_snapshot`, and `plan_approved`. Tool inputs and results are
preserved as JSON when the host records them. Showtail does not infer missing
answers, approvals, output channels, or exit codes. Older trails receive a
best-effort event projection from their existing report data, so consumers can
read mixed old and new work without a separate report format.

Structured payloads follow the same capture settings and redaction rules as the
human report. They are stored in the content-addressed object store and covered
by the journal hash chain, but do not change educator-facing event counts.
