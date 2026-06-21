/**
 * Shared types for Showtail.
 *
 * These are deliberately plain and JSON-friendly so the files written under
 * `.showtail/` stay simple for an educator (or a student) to open and read.
 */

/**
 * The kinds of events in a work trail. Showtail captures these automatically —
 * a student's prompts and the files their AI tool changes — so the trail builds
 * itself while they work.
 */
export const EVENT_TYPES = [
  'prompt', // a prompt the student gave to an AI tool
  'ai_output', // an AI response
  'artifact', // a file that was created or changed (usually auto-logged)
  'decision', // a choice the student made when the AI paused to ask (AskUserQuestion)
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Who created an event, as a denormalized author slug (the folder key under
 * `authors/<slug>/`). The full identity (email, display name, GitHub login)
 * lives in that folder's `author.json`; carrying only the slug on each record
 * keeps journal lines small and never bakes in a name that could later change.
 */
export type ActorSlug = string;

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
  /** The human-readable content (the prompt text, the AI's reply...). */
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
  /** Which author recorded it (folder slug under `authors/<slug>/`). */
  actorSlug: ActorSlug;
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
  /** Which author captured it (folder slug). Filled when read for a report. */
  actorSlug?: ActorSlug;
  /** Which tool the work flowed through when this snapshot was taken. */
  tool?: Tool;
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
  /** Optional short label the student gave the session. */
  label?: string;
  /** Which tool opened this session, if known. */
  tool?: Tool;
  /**
   * The Claude Code `session_id` this Showtail session mirrors, 1:1, if known.
   * Lets concurrent/resumed Claude sessions each keep their own trail instead of
   * sharing the single global `currentSessionId` pointer.
   */
  claudeSessionId?: string;
  /** ISO-8601 timestamp the session was closed with `showtail end`, if it was. */
  endedAt?: string;
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
  /**
   * Absolute path this trail was anchored at when created (git repo root or the
   * working dir). Informational — `findRoot` still drives resolution — but lets
   * `status`/`verify` explain why the folder lives where it does. Absent on
   * trails created before anchoring was recorded.
   */
  anchor?: string;
  /** Whether {@link anchor} was chosen from the git repo root or the working dir. */
  anchorKind?: 'git' | 'cwd';
  settings: {
    /** Whether to try to capture git commit hashes. */
    git: boolean;
    /** Capture AI text responses (Stop hook / imports). Default on. */
    captureAiOutput?: boolean;
    /** Capture AI-suggested code/diffs alongside edits. Default on. */
    captureCode?: boolean;
    /**
     * Minutes of inactivity after which an open session is automatically closed
     * (stamped at its last event). Defaults to 60 when absent.
     */
    idleTimeoutMinutes?: number;
    /** Sensitive-data redaction settings (default on). */
    redact?: RedactConfig;
  };
}

/** Tracks which session new `log` events flow into, and the open turn. */
export interface State {
  currentSessionId: string | null;
  /**
   * The active author on *this machine* — the folder under `authors/<slug>/`
   * that local captures write into. Resolved once (gh → git → prompt) and
   * cached; `state.json` is gitignored, so this never travels between students.
   */
  currentAuthorSlug?: string;
  /**
   * The prompt event id that opened the current turn, if any. Used by the CLI
   * and as the fallback turn pointer when a hook payload carries no
   * `session_id` (older transcripts, manual `showtail log`, Codex).
   */
  currentPromptId?: string | null;
  /**
   * The open turn per Claude Code `session_id`, so edits from concurrent
   * sessions attach to the right prompt instead of a single global turn.
   */
  turnByClaudeSession?: Record<string, string>;
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

/** One student's contribution totals, shown on the combined team report. */
export interface Contributor {
  /** Folder slug under `authors/<slug>/`. */
  slug: string;
  /** Display name (from `author.json`), falling back to the slug. */
  name: string;
  email?: string;
  githubLogin?: string;
  events: number;
  artifacts: number;
}

/** The structured (JSON) form of a generated report. */
export interface ReportData {
  /** The *configured* project name (from `config.project`), or null if unset. */
  project: string | null;
  /**
   * The descriptive subject shown in the report title, always present. Resolved
   * as: an explicit `--title` override → `config.project` → the repo/folder name.
   */
  displayName: string;
  generatedAt: string;
  /**
   * The single author this report is scoped to, or null for the combined team
   * report that spans every contributor.
   */
  scope: { slug: string; name: string } | null;
  summary: {
    sessions: number;
    events: number;
    artifacts: number;
    /** How many `decision` events (AskUserQuestion choices) the student made. */
    decisions: number;
  };
  /** Everyone who contributed to the trail (one entry for a single-author report). */
  contributors: Contributor[];
  /** Per-tool event totals. */
  tools: ToolUsage[];
  /** Chronological blocks of tool usage; boundaries are tool switches. */
  toolTimeline: ToolBlock[];
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
  /** Decisions the student made mid-exchange (the AI paused to ask). */
  decisions: Event[];
  tool: Tool;
  /** Which author this exchange belongs to — used to attribute/color turns. */
  actorSlug: ActorSlug;
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
  /** Which author recorded it. Optional on read (defaults to the folder slug). */
  actorSlug?: ActorSlug;
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
}
