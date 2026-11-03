# Integrations

Showtail works with many AI coding tools. Tools with lifecycle hooks (Claude
Code, Codex) capture your prompts and edits **live** as you work; hosted chat
apps (ChatGPT, Gemini) are **import-based** — you bring a shared conversation
into the trail after the fact. Whichever you use, every event joins one personal history in `~/.showtail`, with optional project views.

Pick your tool below, or scan the capability matrix to see exactly what each
integration can do today.

## Integration capability matrix

Showtail works with many AI coding tools, and support depth varies by tool. This table shows what each integration can do today — support is checked with recorded provider fixtures and central-store tests. Live host behavior can vary by version.

<!-- showtail:start sha=b5ccb70ac449 -->
| Capability | Claude Code | OpenAI Codex | ChatGPT | Copilot (VS Code) | Copilot CLI | Copilot Desktop | Antigravity CLI | Antigravity IDE | Google Gemini | Zed | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| **Live-capture hooks** | ✅ | ✅ | ⛔ | 🚧 | 🚧 | 🗺️ | ✅ | 🚧 | ⛔ | ⛔ | Callback configuration is contract-tested. Actual delivery depends on host version, mode and hook trust; live acceptance receipts record observed behavior. Editors watch native history; Zed has no hooks. |
| **Auto prompt capture** | ✅ | ✅ | ⛔ | 🚧 | 🚧 | 🗺️ | 🚧 | 🚧 | ⛔ | ⛔ | Native-history parsing and replay are contract-tested. Missing callbacks catch up through sync/report; a live-host claim requires a provider-version-specific acceptance receipt. |
| **Auto file/edit capture** | ✅ | 🚧 | ⛔ | 🚧 | 🚧 | 🗺️ | ✅ | 🚧 | ⛔ | ⛔ | Applied edits come from native history. Timestamped file observations supplement incomplete sources; ordinary editor saves are excluded. Coverage depends on persisted provider evidence and is checked by live acceptance runs. |
| **Auto AI-reply capture** | ✅ | ✅ | ⛔ | 🚧 | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ⛔ | ⛔ | Needs the tool’s stop-hook plus a readable transcript; planned wherever both exist. |
| **Decision capture** | ✅ | ✅ | ⛔ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ⛔ | ⛔ | Available questions and answers are recovered from native transcripts. Recorded contract coverage is separate from live-session coverage; absent provider evidence is not invented. |
| **Plan capture** | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | 🗺️ | ⛔ | ⛔ | Native plan content is recovered where the provider persists it and is rendered inside the central report. Recorded parser coverage does not imply that a live session exercised plan mode. |
| **Session import / backfill** | ✅ | ✅ | ✅ | 🗺️ | 🗺️ | 🗺️ | 🗺️ | ✅ | ✅ | 🗺️ | Planned wherever the tool writes a readable transcript (Zed: only via manual Markdown export). |
| **On-request reporting skill** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Uses native skill discovery where available; never adds standing project rules. |
| **Reporting skill updates** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Detected via a managed-block fingerprint in each tool’s instructions/skill file. |
| **User-level setup** | ✅ | ✅ | ⛔ | ✅ | ✅ | 🗺️ | ✅ | ✅ | ⛔ | 🗺️ | Setup installs user-level callbacks or an editor extension; project folders stay unchanged. Installation does not certify live capture. |
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

    Native history collection with silent observer hooks and a deferred reporting skill.

    [:octicons-arrow-right-24: Set up Codex](codex.md)

-   __GitHub Copilot__

    ---

    VS Code extension: native history watching and on-request report commands.

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
