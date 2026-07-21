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

_AI response:_

Start by splitting the file on newlines, then parse each row into fields.

_Suggested code — [`src/parser.ts`](../../src/parser.ts) (~6 line(s)):_

```diff
+export function parse(csv: string): string[][] {
+  return csv
+    .split("\n")
+    .filter((line) => line.length > 0)
+    .map((line) => line.split(","));
+}
```

## Authorship statement

> I recorded this trail while working on "Demo Project". It shows the prompts I used and the
> files I built along the way. I worked through Claude Code and GitHub Copilot, and this trail
> records each. The work and understanding represented here are my own.
````

The report foregrounds the student's work: the prompt, the decisions they made,
and the files they built. An AI reply that directly introduces a change (like the
one above) reads inline as the reason for it; the rest of the AI's step-by-step
narration is folded into a collapsed **"🤖 N AI messages"** group per exchange, so
it's there when you want it without burying the work. In the HTML report a **"Show
AI process"** toggle expands every group at once; `showtail report --ai full`
(or `--no-ai`) sets that default for the generated file.

On a group project, the combined **team** report adds a **Contributors** section
listing each student and how much they contributed, and the timeline shows who
did what. If any secrets or personal details were scrubbed before storage, the
report notes how many.
