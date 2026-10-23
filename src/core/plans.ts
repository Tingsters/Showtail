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
import { requireCaptureContinuation } from './captureGuard.ts';
import { redact } from './redact.ts';
import { readConfig, type ShowtailPaths } from './storage.ts';

export {
  PLAN_APPROVED_TAG,
  PLAN_REVISED_TAG,
  parsePlanInput,
  renderPlanText,
  resolvePlanResult,
  splitPlanText,
} from '@showtail/agent-traces/transcript/plans';

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
  /** Recheck an automatic caller's capture window immediately before writing. */
  continueCapture?: () => boolean;
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
    requireCaptureContinuation(input.continueCapture);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return { planPath };
}
