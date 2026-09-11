---
hide:
  - navigation
  - toc
---

<div class="st-hero" markdown>

![Showtail logo: a Cavalier King Charles Spaniel beside the word Showtail, with a dotted trail of prompt, edit, code, and document icons](assets/showtail-logo.png){ width="420" }

# Show your work.

<p class="st-tagline" markdown>
Showtail keeps a clear record of how you built a project with AI — the prompts
you sent and the files you changed — captured **automatically**, then kept in a
plain project-local `.showtail/` trail once its project is clear. No accounts,
no cloud, no telemetry.
</p>

[Get started](getting-started/installation.md){ .md-button .md-button--primary }
[View on GitHub](https://github.com/Tingsters/Showtail){ .md-button }

</div>

---

## Why Showtail

<div class="grid cards" markdown>

-   :material-record-circle-outline:{ .lg .middle } __Automatic capture__

    ---

    Your prompts and the files your AI tool edits are recorded as you work.
    The trail builds itself — nothing to remember.

-   :material-lock-outline:{ .lg .middle } __Local &amp; private__

    ---

    Resolved work lives in your project's `.showtail/`; unresolved work waits in
    a machine-local inbox. No Showtail cloud service, telemetry, or automatic upload.

-   :material-tools:{ .lg .middle } __Works across your tools__

    ---

    Claude Code, OpenAI Codex, GitHub Copilot, ChatGPT, and Google Gemini all
    feed into one coherent, cross-tool timeline.

-   :material-account-group-outline:{ .lg .middle } __Team-aware__

    ---

    On a group project each student gets their own folder under one shared
    `.showtail/`, so trails merge through git without conflicts.

-   :material-file-document-outline:{ .lg .middle } __Plain, reviewable files__

    ---

    JSON and Markdown you can open in any editor and commit with the rest of
    your work. `showtail report` renders a readable summary.

-   :material-school-outline:{ .lg .middle } __Built for classrooms__

    ---

    A structured way to demonstrate genuine understanding. Not an AI detector,
    not surveillance, not a grading tool.

</div>

---

## Integrations at a glance

<p class="st-badges" markdown>
**Claude Code** ✅ &middot; **OpenAI Codex** ✅ &middot; **GitHub Copilot** 🚧 &middot; **ChatGPT / Gemini** ✅ _(import)_
</p>

[See the full capability matrix →](integrations/index.md)

---

## Install, then just work

```bash
# Install (below) — tracking is on and detected supported tools are connected.
# ...just work — your prompts and edits are captured automatically...
showtail report    # when you're done: generate the report for your educator
```

There is **no setup command**. Installing turns tracking on and connects the AI tools it
finds; the first meaningful prompt creates the project's `.showtail/` trail. Nothing to
remember for the normal flow. Any writable folder can be a project, including
HOME and temporary folders. A HOME trail applies only to work launched exactly there and
is never inherited by child folders; stronger workspace or edit evidence reroutes work to
the nested project it actually belongs to.

[Read the full quickstart →](getting-started/quickstart.md)

---

## Code signing policy

Showtail is preparing its Windows executable for SignPath Foundation code
signing. Current releases are unsigned unless their release notes explicitly say
otherwise. See the [Code signing policy](code-signing-policy.md) for status,
scope, team roles, privacy, and verification instructions.
