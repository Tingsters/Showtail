# Integrations

Showtail works with many AI coding tools. Tools with lifecycle hooks (Claude
Code, Codex) capture your prompts and edits **live** as you work; hosted chat
apps (ChatGPT, Gemini) are **import-based** — you bring a shared conversation
into the trail after the fact. Whichever you use, every event joins one shared,
cross-tool timeline.

Pick your tool below, or scan the capability matrix to see exactly what each
integration can do today.

## Integration capability matrix

Showtail works with many AI coding tools, and support depth varies by tool. This table shows what each integration can do today — every ✅ is backed by an end-to-end test, so it genuinely works against the real tool.

<!-- showtail:start sha=a7cfb5220916 -->
| Capability | Claude Code | OpenAI Codex | ChatGPT | Copilot (VS Code) | Copilot CLI | Copilot Desktop | Antigravity CLI | Antigravity IDE | Google Gemini | Zed | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| **Live-capture hooks** | ✅ | ✅ | ⛔ | 🚧 | 🚧 | 🗺️ | ✅ | 🚧 | ⛔ | ⛔ | Live-certified for Claude Code, Codex, and Antigravity CLI. Copilot CLI fires no lifecycle hooks in headless `-p` mode, so it can’t be live-certified here; Copilot (VS Code) uses its extension; Zed has no hooks. |
| **Auto prompt capture** | ✅ | ✅ | ⛔ | 🚧 | 🚧 | 🗺️ | 🚧 | 🚧 | ⛔ | ⛔ | Live-certified for Claude Code + Codex; the CLI plugins are built but their live capture isn’t certified here. Copilot (VS Code) reads native chat prompts from the on-disk session JSON (contract-tested), not via hooks. |
| **Auto file/edit capture** | ✅ | 🚧 | ⛔ | 🚧 | 🚧 | 🗺️ | ✅ | 🚧 | ⛔ | ⛔ | Live-certified for Claude Code + Antigravity CLI. Codex captures edits in real interactive sessions — the edited file is snapshotted and its AI diff (plus deletions) is reconciled from the session rollout at Stop (contract-tested) — but the headless harness can’t certify a live Codex edit. Copilot CLI fires no hooks in headless mode; Copilot (VS Code) snapshots on save with no AI diff. |
| **Auto AI-reply capture** | ✅ | ✅ | ⛔ | 🚧 | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ⛔ | ⛔ | Needs the tool’s stop-hook plus a readable transcript; planned wherever both exist. |
| **Decision capture** | ✅ | ✅ | ⛔ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ⛔ | ⛔ | Reconciled from the tool’s transcript on the Stop hook, so — like AI-reply capture — it is certified by its contract test, not the headless live run. Planned wherever a tool has hooks + a transcript but no ask-the-user construct yet. |
| **Plan capture** | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | 🗺️ | ⛔ | ⛔ | Full for Claude Code, Codex, and Antigravity CLI. Antigravity links its real plan.md; Claude Code and Codex materialize the transcript plan into a browsable, linkable file (Codex writes no native plan file). Antigravity IDE writes implementation_plan.md but has no plugin yet. Reconciled on the Stop hook — certified by its contract test, not the headless live run (print mode never raises Stop). |
| **Session import / backfill** | ✅ | ✅ | ✅ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ✅ | ✅ | 🗺️ | Planned wherever the tool writes a readable transcript (Zed: only via manual Markdown export). |
| **Managed instructions** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Planned wherever the tool reads an instructions/rules file. |
| **Instruction update detection** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Detected via a managed-block fingerprint in each tool’s instructions/skill file. |
| **User + project install** | ✅ | ✅ | ⛔ | 🚧 | ✅ | 🗺️ | ✅ | 🚧 | ⛔ | 🗺️ | Copilot (VS Code) is project-scoped only (.github/). |
| **Host detection (setup)** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Hosted web apps have nothing local to detect. |
| **Connection status** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Needs a local footprint to inspect; web apps have none. |
| **Secret/PII redaction** | ✅ | ✅ | ✅ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ✅ | 🗺️ | Applies automatically once any capture or import path for the tool exists. |
| **Cross-tool timeline** | ✅ | ✅ | ✅ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ✅ | 🗺️ | Any captured or imported event from the tool joins the shared timeline. |
| **Marketplace/extension install** | ✅ | 🗺️ | ⛔ | ✅ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ⛔ | 🗺️ | Codex/Copilot CLI/Antigravity expose a marketplace; a Showtail installer just isn’t published there yet. |

**Key:** ✅ Full · 🚧 Partial · 🗺️ Planned · ⛔ Unsupported

✅ works end-to-end (verified) · 🚧 implemented with a gap · 🗺️ the tool supports it, not built yet · ⛔ the tool exposes no surface for it.
<!-- showtail:end -->

## Per-tool guides

<div class="grid cards" markdown>

-   __Claude Code__

    ---

    Skill + auto-capture hooks, plugin install, and session import/backfill.

    [:octicons-arrow-right-24: Set up Claude Code](claude-code.md)

-   __OpenAI Codex__

    ---

    `AGENTS.md` instructions + lifecycle hooks via `config.toml`.

    [:octicons-arrow-right-24: Set up Codex](codex.md)

-   __GitHub Copilot__

    ---

    VS Code extension: managed instructions, save-time edit snapshots, `@showtail`.

    [:octicons-arrow-right-24: Set up Copilot](copilot.md)

-   __ChatGPT__

    ---

    Import selected conversations from a share link, clipboard, or file.

    [:octicons-arrow-right-24: Import from ChatGPT](chatgpt.md)

-   __Google Gemini__

    ---

    Import conversations from a share link or a paste.

    [:octicons-arrow-right-24: Import from Gemini](gemini.md)

</div>
