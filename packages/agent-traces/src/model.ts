/** Shared, provider-neutral data types for agent traces. */

import type { EditedFile } from './hooks/payload.ts';

/** JSON-compatible data preserved from a host tool's transcript. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * One visible, ordered event from an AI conversation. This is the provider-neutral
 * machine-readable stream exported in schema-v2 JSON reports; the existing
 * educator-facing Event model remains the human-readable projection.
 */
export interface ConversationEvent {
  sequence: number;
  timestamp?: string;
  type:
    | 'assistant_text'
    | 'user_text'
    | 'tool_use'
    | 'tool_result'
    | 'plan_snapshot'
    | 'plan_approved';
  /** Stable provider id used to dedupe repeated transcript reconciliation. */
  sourceId?: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: JsonValue;
  content?: JsonValue;
  isError?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  plan?: string;
}

/**
 * Controls automatic scrubbing of secrets and personal data from captured
 * content *before it is stored*. Best-effort safety net, not a guarantee.
 */
export interface RedactConfig {
  /** Master switch. Default on. */
  enabled?: boolean;
  /** Provider keys, private keys, tokens, connection strings, passwords. Default on. */
  secrets?: boolean;
  /** Email / phone / credit-card / SSN. Default on. */
  pii?: boolean;
  /** Extra regex sources (strings) to also redact. */
  custom?: string[];
  /** Literal substrings that must never be redacted (e.g. tutorial sample keys). */
  allow?: string[];
}

/** One message of a normalized transcript used for stop-time reconciliation. */
export interface HookTranscriptMessage {
  /** 'user' | 'assistant' | 'decision' | 'plan' | 'edit' | 'tool_call' | 'recap'. */
  role: string;
  text: string;
  timestamp?: string;
  sourceId: string;
  /** Native provider request id shared by every message in one prompt turn. */
  requestId?: string;
  /** True when the provider has persisted the completed response for this turn. */
  isFinal?: boolean;
  /** For a 'plan' message: whether the student approved it. */
  approved?: boolean;
  /** For an 'assistant' message: the model that produced it, if exposed (raw id). */
  model?: string;
  /**
   * For an 'edit' message: the per-file edits (clean diffs + deletions) recovered
   * from the host's transcript/rollout. The generic Stop reconcile imports these
   * as diff artifacts — the reliable diff source for hosts (Codex) whose live
   * hook payload carries the file but not the diff.
   */
  edits?: EditedFile[];
  /** For an edit whose provider retained only the touched paths. */
  files?: string[];
  /** For a 'tool_call' message: the tool's name (e.g. `Bash`, `Read`, `Grep`). */
  toolName?: string;
  /** For a 'tool_call' message: whether its result was an error. */
  isError?: boolean;
  /** For a 'recap' message: the turn's wall-clock duration, in milliseconds. */
  durationMs?: number;
  /** For a 'recap' message: the git branch at the time the turn closed. */
  gitBranch?: string;
  /** For a 'recap' message: input tokens used across the turn. */
  inputTokens?: number;
  /** For a 'recap' message: output tokens used across the turn. */
  outputTokens?: number;
  /** For a 'recap' message: cache-read tokens used across the turn. */
  cacheReadTokens?: number;
  /** For a 'recap' message: cache-creation tokens used across the turn. */
  cacheCreationTokens?: number;
}

/** A normalized raw transcript event with a stable provider id. */
export interface HookTranscriptEvent extends ConversationEvent {
  sourceId: string;
}

/** A normalized conversation transcript, in order. */
export interface HookTranscript {
  sessionId?: string;
  /**
   * Set for a transcript assembled from the hook payload alone (no provider history
   * to read): it has no prompt message to anchor on, so its messages attach to the
   * session's current turn — the prompt the live hook just recorded.
   */
  anchorToCurrentTurn?: boolean;
  /**
   * Plain-language notes about a degraded read (e.g. the provider's history API was
   * unavailable, so only the final reply was captured). Surfaced in the hook trace
   * so a capture gap is visible instead of silent.
   */
  warnings?: string[];
  messages: HookTranscriptMessage[];
  /** Lossless visible conversation events. Absent only for legacy/text-only adapters. */
  events?: HookTranscriptEvent[];
}

/**
 * A real on-disk plan file a tool wrote for the session (e.g. Antigravity's
 * `brain/<id>/plan.md`). The hook dispatcher materializes this into the trail
 * and links it from the report; the discovery of *where* a tool keeps its plan
 * files is the only tool-specific part, exactly like {@link HookAdapter.getTranscript}.
 */
export interface DiscoveredPlanFile {
  /** Absolute source path on disk (provenance only; never linked directly). */
  absPath: string;
  /** The plan markdown read from disk. */
  content: string;
  /** Stable id for the saved copy + dedup, e.g. `agy-plan:<conversationId>`. */
  sourceId: string;
  /** The tool's own session id this plan belongs to, for matching to a session. */
  nativeSessionId?: string;
}
