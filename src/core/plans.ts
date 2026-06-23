/**
 * Parsing of Claude Code plan-mode plans (`ExitPlanMode`).
 *
 * Unlike decisions, a plan needs no structured parsing: the full plan markdown
 * is carried directly in the `ExitPlanMode` tool_use `input.plan`. Its approval
 * (and, when sent back, the user's "what to change" feedback) comes from the
 * later `tool_result`, resolved in `parseClaudeTranscript`'s second pass.
 *
 * Plans are also *materialized* — saved as a browsable `plans/<id>.md` file — so
 * the report can link to "the plan file" regardless of whether the host tool
 * wrote one itself (Antigravity does; Claude Code and Codex keep it only in the
 * transcript). See {@link materializePlan}.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asString, prop } from './parse.ts';
import { redact } from './redact.ts';
import { readConfig, type ShowtailPaths } from './storage.ts';

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

// How a revised plan's feedback is prefixed onto the stored event text. Shared by
// renderPlanText (capture) and splitPlanText (render) so the two never drift.
const FEEDBACK_PREFIX = '**You sent this back asking:** ';
const FEEDBACK_SEP = '\n\n---\n\n';

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
  return `${FEEDBACK_PREFIX}${feedback}${FEEDBACK_SEP}${plan}`;
}

/**
 * Inverse of {@link renderPlanText}: separate a plan event's text into its
 * revision feedback (if any) and the plan markdown, so the report can show the
 * feedback on the collapsed summary and the plan in the body.
 */
export function splitPlanText(text: string): { feedback?: string; plan: string } {
  if (!text.startsWith(FEEDBACK_PREFIX)) return { plan: text };
  const rest = text.slice(FEEDBACK_PREFIX.length);
  const i = rest.indexOf(FEEDBACK_SEP);
  if (i < 0) return { plan: text }; // malformed; show as-is
  return { feedback: rest.slice(0, i), plan: rest.slice(i + FEEDBACK_SEP.length) };
}

// --- Materialization (saving a linkable plan file) ------------------------

/**
 * Cap on a saved plan file's size. Plans are prose, not data dumps; this keeps a
 * runaway "plan" from bloating the trail. Mirrors the artifact diff cap.
 */
export const MAX_PLAN_BYTES = 64 * 1024;

/** What {@link materializePlan} needs: the plan text and a stable id. */
export interface MaterializePlanInput {
  /** The plan markdown (from the host's plan file, or the transcript). */
  text: string;
  /** Stable id used for the filename + dedup (a plan tool_use id, `agy-plan:<id>`, …). */
  sourceId: string;
}

/** Where a materialized plan lives, as a trail-relative path for the report link. */
export interface MaterializedPlan {
  /** `plans/<id>.md` — relative to `.showtail/`, for {@link Event.planPath}. */
  planPath: string;
}

/** Turn a plan {@link MaterializePlanInput.sourceId} into a safe `.md` filename stem. */
function planFileStem(sourceId: string): string {
  const stem = sourceId.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '');
  return stem.length > 0 ? stem : 'plan';
}

/**
 * Save a plan as a browsable `plans/<id>.md` under `.showtail/` and return its
 * trail-relative path. The text is redacted (the host's own plan file on disk is
 * not) and capped before writing. Idempotent: a re-run with the same id and
 * content is a no-op; changed content overwrites (the transcript pass already
 * dedups on `sourceId`, so this is only reached for genuinely new plans).
 */
export function materializePlan(
  paths: ShowtailPaths,
  input: MaterializePlanInput,
): MaterializedPlan {
  const config = readConfig(paths);
  let { text } = redact(input.text, config.settings.redact);
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) {
    text = text.slice(0, MAX_PLAN_BYTES) + '\n\n… (plan truncated by Showtail)\n';
  }
  const file = join(paths.plansDir, `${planFileStem(input.sourceId)}.md`);
  const planPath = `plans/${planFileStem(input.sourceId)}.md`;
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return { planPath };
}
