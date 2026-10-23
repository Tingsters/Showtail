/** Shared, provider-neutral data types for agent traces. */

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
