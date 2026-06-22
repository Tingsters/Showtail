/**
 * Parsing of Claude Code plan-mode plans (`ExitPlanMode`).
 *
 * Unlike decisions, a plan needs no structured parsing: the full plan markdown
 * is carried directly in the `ExitPlanMode` tool_use `input.plan`. Its approval
 * (and, when sent back, the user's "what to change" feedback) comes from the
 * later `tool_result`, resolved in `parseClaudeTranscript`'s second pass.
 */
import { asString, prop } from './parse.ts';

/** Tag a captured plan event carries to record whether it was approved. */
export const PLAN_APPROVED_TAG = 'plan-approved';
export const PLAN_REVISED_TAG = 'plan-revised';

/** The plan markdown from an `ExitPlanMode` tool_use input, or undefined if empty. */
export function parsePlanInput(input: unknown): string | undefined {
  const plan = asString(prop(input, 'plan'))?.trim();
  return plan ? plan : undefined;
}

/** Whether a plan was approved, plus the revision feedback when it was sent back. */
export function resolvePlanResult(blob: string | undefined): {
  approved: boolean;
  feedback?: string;
} {
  if (!blob) return { approved: false };
  if (blob.includes('approved your plan')) return { approved: true };
  // Rejected/revised: the user's feedback follows "the user said:".
  const marker = 'the user said:';
  const i = blob.indexOf(marker);
  const feedback = i >= 0 ? blob.slice(i + marker.length).trim() : '';
  return { approved: false, feedback: feedback || undefined };
}

/**
 * The event text for a plan: the plan markdown, prefixed with the revision
 * feedback when the plan was sent back (so the student's direction is logged and
 * shown in the report's plan block).
 */
export function renderPlanText(
  plan: string,
  approved: boolean,
  feedback?: string,
): string {
  if (approved || !feedback) return plan;
  return `**You sent this back asking:** ${feedback}\n\n---\n\n${plan}`;
}
