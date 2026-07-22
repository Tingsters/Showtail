/**
 * A "user"-role message that is actually tooling/harness-injected chrome — never
 * something the student typed — so it must not be recorded or shown as a prompt.
 *
 * Covers slash-command wrappers (`<command-name>`, `<local-command-stdout>`, …),
 * hook echoes, and — the reason this exists — harness envelopes that arrive as
 * user-role turns: `<task-notification>` (background-subagent results, often many
 * KB) and `<system-reminder>` (injected context). Left unfiltered, these get
 * captured as prompts and render as giant "prompt" blocks in the report.
 *
 * Anchored at the start (after leading whitespace) so a genuine prompt that merely
 * quotes or mentions one of these later is unaffected — dropping a real prompt is
 * far worse than keeping a stray line.
 */
const SYNTHETIC_PROMPT_RE =
  /^<(task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|command-stdout|command-stderr|user-prompt-submit-hook|session-start-hook)\b/;

export function isSyntheticPrompt(text: string): boolean {
  return SYNTHETIC_PROMPT_RE.test(text.trimStart());
}
