/**
 * A "user"-role message that is actually tooling/harness-injected chrome — never
 * something the student typed — so it must not be recorded or shown as a prompt.
 *
 * Covers two things:
 *  - Tag-wrapped envelopes that arrive as user-role turns: `<task-notification>`
 *    (background-subagent results, often many KB), `<system-reminder>` (injected
 *    context), and slash-command wrappers (`<command-name>`, `<local-command-…>`,
 *    hook echoes).
 *  - Claude Code's **context-compaction summary** — the "This session is being
 *    continued from a previous conversation…" recap the harness injects as a user
 *    turn when it compacts. The transcript flags it `isCompactSummary` (handled
 *    structurally in claudeCode.ts); the live-hook payload and already-recorded
 *    events carry only text, so we also match its stable Anthropic-authored leading
 *    sentence here. It's a redundant recap of turns already in the trail, so it's
 *    dropped, not shown.
 *
 * All patterns are anchored at the start (after leading whitespace) so a genuine
 * prompt that merely quotes or mentions one of these later is unaffected — dropping
 * a real prompt is far worse than keeping a stray line.
 */
const SYNTHETIC_PROMPT_RE =
  /^<(task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|command-stdout|command-stderr|user-prompt-submit-hook|session-start-hook)\b/;

const COMPACT_SUMMARY_RE =
  /^This session is being continued from a previous conversation that ran out of context/;

export function isSyntheticPrompt(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_PROMPT_RE.test(t) || COMPACT_SUMMARY_RE.test(t);
}
