/**
 * A best-effort diagnostic log of every hook invocation, written to
 * `.showtail/diag/hooks.jsonl`. This is **not** part of the student's trail: it
 * never appears in a report or in `verify`, and it's gitignored. Its only job is
 * to make capture anomalies debuggable after the fact.
 *
 * Each line records when a hook fired, which native (host-tool) session and
 * which Showtail session it resolved to, and what it did — sessions
 * created/closed, replies captured, prompts skipped as pre-window backlog. That
 * is exactly what's needed to reconstruct an intermittent session-lifecycle
 * race (a turn whose prompt lands in one session while its reply is reconciled
 * against another) the next time it happens.
 *
 * Everything here is wrapped so a diagnostic failure can never break a hook —
 * the capture path is already bulletproof and this must not weaken it. Set
 * `SHOWTAIL_HOOK_TRACE=0` to disable.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../types.ts';
import type { ShowtailPaths } from './storage.ts';

/** One recorded hook invocation. All fields past the first three are best-effort. */
export interface HookTrace {
  /** When the hook handler ran (ISO-8601). */
  ts: string;
  /** Which lifecycle hook fired (mirrors `HookEvent` in commands/hook.ts). */
  event: string;
  /** The tool whose hook fired. */
  tool: Tool;
  /** Host-tool (native) session id from the payload/transcript, when present. */
  nativeSessionId?: string;
  /** The Showtail session the hook resolved to (created or reused). */
  sessionId?: string;
  /** A fresh Showtail session was created for this native id (vs. reusing one). */
  createdSession?: boolean;
  /** `startedAt` of the resolved session — the boundary Stop uses for backlog. */
  sessionStartedAt?: string;
  /** user-prompt: the prompt's `promptSource` (typed/queued/suggestion_accepted/…). */
  promptSource?: string;
  /** user-prompt: the logged prompt event id (the turn it opened). */
  promptId?: string;
  /** post-edit: the turn the edits attached to. */
  turnId?: string;
  /** post-edit: how many files were snapshotted. */
  edits?: number;
  /**
   * post-edit: files recovered via the git backstop when structured parsing of
   * a Codex raw-shell edit found nothing (included in `edits`). >0 flags that
   * the fallback fired.
   */
  gitRecovered?: number;
  /** stop: AI replies captured. */
  replies?: number;
  /** stop: decisions captured. */
  decisions?: number;
  /** stop: plans captured. */
  plans?: number;
  /** stop: tool calls (Bash, Read, Grep, ...) captured. */
  toolCalls?: number;
  /** stop: end-of-turn recaps captured. */
  recaps?: number;
  /**
   * stop: transcript prompts dropped as pre-window backlog (older than the
   * resolved session's start). A Stop that captures 0 replies while skipping
   * backlog on a freshly-created session is the signature of the race.
   */
  backlogSkipped?: number;
  /**
   * stop: replies recovered onto a prompt in a *closed sibling* session of the
   * same native id — work the session-close race would otherwise have orphaned.
   * >0 means the cross-session recovery fired.
   */
  recoveredReplies?: number;
  /** Showtail session ids this hook closed (idle sweep or session-end). */
  closedSessions?: string[];
  /** Wall-clock duration of the hook handler, in milliseconds. */
  durationMs?: number;
  /** A thrown error's message, if the handler failed (still a silent no-op). */
  error?: string;
}

/** Rotate the trace once it passes this size, keeping a single prior file. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append one hook-trace line to `.showtail/diag/hooks.jsonl`. Best-effort and
 * silent: any failure (and the `SHOWTAIL_HOOK_TRACE=0` opt-out) is swallowed so
 * a hook is never disturbed by its own diagnostics.
 */
export function recordHookTrace(paths: ShowtailPaths, trace: HookTrace): void {
  if (process.env.SHOWTAIL_HOOK_TRACE === '0') return;
  try {
    const dir = join(paths.base, 'diag');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hooks.jsonl');
    try {
      if (statSync(file).size >= MAX_BYTES) {
        renameSync(file, join(dir, 'hooks.1.jsonl')); // keep one prior segment
      }
    } catch {
      // No file yet, or a concurrent rotate won the race — either is fine.
    }
    appendFileSync(file, JSON.stringify(trace) + '\n');
  } catch {
    // Diagnostics must never break a hook.
  }
}

/**
 * Opt-in raw-payload capture for debugging unknown host payload shapes (e.g.
 * pinning down how a given agent delivers `apply_patch` to a PostToolUse hook).
 * Off by default and gated behind `SHOWTAIL_DEBUG_PAYLOAD=1`; when on, appends
 * the parsed stdin payload (plus event/tool) to `.showtail/diag/payloads.jsonl`.
 * Like {@link recordHookTrace} it is best-effort and silent — never disturbs a
 * hook. Not part of the trail; safe to leave in.
 */
export function recordRawPayload(
  paths: ShowtailPaths,
  event: string,
  tool: Tool,
  payload: unknown,
): void {
  if (process.env.SHOWTAIL_DEBUG_PAYLOAD !== '1') return;
  try {
    const dir = join(paths.base, 'diag');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'payloads.jsonl');
    try {
      if (statSync(file).size >= MAX_BYTES) {
        renameSync(file, join(dir, 'payloads.1.jsonl'));
      }
    } catch {
      // No file yet, or a concurrent rotate won the race — either is fine.
    }
    appendFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), event, tool, payload }) + '\n',
    );
  } catch {
    // Diagnostics must never break a hook.
  }
}
