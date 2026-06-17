/**
 * Shared types for Showtail.
 *
 * These are deliberately plain and JSON-friendly so the files written under
 * `.showtail/` stay simple for an educator (or a student) to open and read.
 */

/** The kinds of events a student can record in their work trail. */
export const EVENT_TYPES = [
  'prompt', // a prompt the student gave to an AI tool
  'ai_output', // an AI response the student accepted or rejected
  'human_edit', // a change the student made by hand
  'decision', // a choice the student made and why
  'reflection', // what the student learned / understands
  'source', // an outside source they used (notes, docs, a friend)
  'test', // a test or validation step they ran
  'artifact', // a file they created or changed (usually auto-logged)
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Who created an event. The MVP only records the student. */
export type Actor = 'student';

/**
 * Which tool the work flowed through when an event was recorded. This is what
 * lets a single trail span Claude Code and GitHub Copilot and lets a professor
 * follow a student switching between them. Kept as a plain string union so new
 * tools can be added without breaking older trails.
 */
export const TOOLS = [
  'claude-code',
  'github-copilot',
  'chatgpt',
  'google-gemini',
  'codex',
  'cli',
] as const;
export type Tool = (typeof TOOLS)[number];

/** Human-friendly label for a tool (falls back to the raw value). */
export const TOOL_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'github-copilot': 'GitHub Copilot',
  chatgpt: 'ChatGPT',
  'google-gemini': 'Google Gemini',
  codex: 'OpenAI Codex',
  cli: 'CLI',
};

/** A single recorded event in a work session. One JSONL line = one Event. */
export interface Event {
  /** Short unique id, e.g. "evt_lqz3k8_a1b2". */
  id: string;
  /** ISO-8601 timestamp, e.g. "2026-06-12T14:03:00.000Z". */
  timestamp: string;
  /** What kind of event this is. */
  type: EventType;
  /** The human-readable content (the prompt, the decision, the reflection...). */
  text: string;
  /** Optional files this event relates to (repo-relative paths). */
  files?: string[];
  /** Optional freeform tags for grouping/filtering. */
  tags?: string[];
  /** Git commit hash at the time of the event, if the project is a git repo. */
  gitCommit?: string;
  /** Which tool the work flowed through (claude-code, github-copilot, chatgpt, cli). */
  tool?: Tool;
  /** Stable id from an external source (e.g. a ChatGPT message id) for idempotent imports. */
  sourceId?: string;
  /** Groups events written by a single import run, so one paste can be undone as a batch. */
  batchId?: string;
  /**
   * Links this event to the prompt that opened its "turn" (one exchange). A turn is
   * a prompt plus the AI outputs and edits it produced; the report groups by this.
   * Absent on older trails — the report falls back to timestamp adjacency.
   */
  turnId?: string;
  /** Who recorded it. Always "student" in the MVP. */
  actor: Actor;
}

/** A recorded snapshot of a file (its hash at a point in time). */
export interface Artifact {
  /** Short unique id, e.g. "art_lqz3k8_a1b2". */
  id: string;
  /** Repo-relative path to the file. */
  path: string;
  /** SHA-256 hash of the file contents at capture time. */
  sha256: string;
  /** ISO-8601 timestamp of capture. */
  timestamp: string;
  /** Git commit hash at capture time, if available. */
  gitCommit?: string;
  /** The session this artifact was captured in, if any. */
  sessionId?: string;
  /** Which tool the work flowed through when this snapshot was taken. */
  tool?: Tool;
  /** Related event ids the student chose to link. */
  eventIds?: string[];
  /** The prompt's turn this edit belongs to (see {@link Event.turnId}). */
  turnId?: string;
  /**
   * Object-store address of the AI-suggested code/diff that produced this snapshot,
   * if captured. The diff text itself lives in `.showtail/objects/`, not inline.
   */
  diffHash?: string;
  /** Number of changed lines in the captured diff (for a quick "~N lines" stat). */
  diffLines?: number;
}

/** Metadata about a single work session. */
export interface Session {
  /** Short unique id, e.g. "ses_lqz3k8_a1b2". */
  id: string;
  /** ISO-8601 timestamp the session started. */
  startedAt: string;
  /** Path to the session's JSONL file, relative to `.showtail/`. */
  file: string;
  /** Optional short label the student gave the session. */
  label?: string;
  /** Which tool opened this session, if known. */
  tool?: Tool;
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

/** The project-level configuration written at `init` time. */
export interface Config {
  /** Showtail config schema version. */
  version: number;
  /** Optional project name. */
  project?: string;
  /** ISO-8601 timestamp the project was initialized. */
  createdAt: string;
  settings: {
    /** Whether to try to capture git commit hashes. */
    git: boolean;
    /** Capture AI text responses (Stop hook / imports). Default on. */
    captureAiOutput?: boolean;
    /** Capture AI-suggested code/diffs alongside edits. Default on. */
    captureCode?: boolean;
    /** Sensitive-data redaction settings (default on). */
    redact?: RedactConfig;
  };
}

/** Tracks which session new `log` events flow into, and the open turn. */
export interface State {
  currentSessionId: string | null;
  /** The prompt event id that opened the current turn, if any. */
  currentPromptId?: string | null;
}

/** How many events were recorded through a given tool. */
export interface ToolUsage {
  tool: Tool;
  events: number;
}

/**
 * A contiguous block of activity through one tool. Consecutive same-tool events
 * collapse into one block, so the list of blocks reads as the student's path
 * through their tools — and each boundary is a switch a professor can follow.
 */
export interface ToolBlock {
  tool: Tool;
  from: string;
  to: string;
  count: number;
}

/** The structured (JSON) form of a generated report. */
export interface ReportData {
  project: string | null;
  generatedAt: string;
  summary: {
    sessions: number;
    events: number;
    artifacts: number;
  };
  /** Per-tool event totals. */
  tools: ToolUsage[];
  /** Chronological blocks of tool usage; boundaries are tool switches. */
  toolTimeline: ToolBlock[];
  timeline: TimelineEntry[];
  prompts: Event[];
  /** Events imported from ChatGPT, grouped so a student can review them in one place. */
  importedChatgpt: Event[];
  /** Events imported from Google Gemini, grouped so a student can review them in one place. */
  importedGemini: Event[];
  decisions: Event[];
  artifactsCreated: Artifact[];
  tests: Event[];
  reflections: Event[];
  sources: Event[];
  /** Prompt-and-AI exchanges, each rendered as a collapsible card. */
  turns: Turn[];
  /** How many secrets/PII Showtail scrubbed before storing (0 when none). */
  redactionCount: number;
  authorship: string;
}

/** One AI-suggested code change within a turn (diff text resolved for rendering). */
export interface TurnCodeChange {
  path: string;
  /** The suggested diff/new-content, resolved from the object store (if captured). */
  diff?: string;
  diffLines?: number;
  tool?: Tool;
  timestamp: string;
}

/**
 * One exchange: a prompt plus the AI text outputs and code changes it produced.
 * The unit a reviewer expands in the report.
 */
export interface Turn {
  prompt: Event;
  aiOutputs: Event[];
  codeChanges: TurnCodeChange[];
  tool: Tool;
}

/**
 * One line of the append-only journal — the on-disk metadata record for an
 * event or an artifact. Heavy content (prompt/response text, code diffs) is NOT
 * stored here; it lives in the content-addressed object store and is referenced
 * by hash (`refs`, `diffHash`). Kept as a superset of Event + Artifact fields so
 * a single journal can hold both and so reconstruction stays mechanical.
 */
export interface JournalEntry {
  /** Schema version of this entry, for upgrade-on-read. */
  v: number;
  /**
   * Which record this is: a logged "event" (prompt, ai_output, even an
   * artifact-type note) or an "artifact" file snapshot. Distinct from `type`
   * so an artifact-*type* event is not confused with a snapshot. Defaults to
   * "event" when absent.
   */
  kind?: 'event' | 'artifact';
  /** Event/Artifact id. */
  id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Event type, or "artifact" for a file snapshot. */
  type: EventType | 'artifact';
  tool?: Tool;
  /** Conversation/session id this entry belongs to. */
  conv?: string;
  /** Turn id (the prompt that opened the exchange). */
  turn?: string;
  /** Import batch id (retained so a specific import can be removed later). */
  batch?: string;
  actor?: Actor;
  // --- event content (referenced, not inlined) ---
  /** Object-store addresses for this entry's content (e.g. the event text). */
  refs?: string[];
  /** Short, human-glanceable preview of the content (still redacted). */
  textPreview?: string;
  /** Byte length of the full content. */
  bytes?: number;
  /** How many secrets/PII were scrubbed from this entry's content before storing. */
  redacted?: number;
  files?: string[];
  tags?: string[];
  gitCommit?: string;
  sourceId?: string;
  // --- artifact-specific ---
  path?: string;
  sha256?: string;
  diffHash?: string;
  diffLines?: number;
  eventIds?: string[];
}

/** One chronological entry combining sessions and their events. */
export interface TimelineEntry {
  timestamp: string;
  kind: 'session_start' | EventType;
  text: string;
  sessionId: string;
  /** Which tool the entry came through (undefined for session starts). */
  tool?: Tool;
}
