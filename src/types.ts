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
  'plan', // a plan the AI proposed in plan mode (ExitPlanMode), and its approval
  'tool_call', // a tool the AI invoked (Bash, Read, Grep, ...) and its result
  'recap', // the AI's end-of-turn recap, plus duration/token/branch stats
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
 * follow a student switching between them.
 *
 * Kept as a plain string (not an enum) on purpose: the set of integrations lives
 * in the plugin registry (`src/plugins/`), not here, so the core data model has
 * no knowledge of individual tools and old trails never break when tools change.
 * Known ids today: `claude-code`, `github-copilot`, `codex`, `chatgpt`,
 * `google-gemini`, and `cli` (manual logging). Use `labelForTool`
 * from the registry for a human-friendly name.
 */
export type Tool = string;

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
  /**
   * The AI model that produced this event (raw id as the tool reports it, e.g.
   * `claude-opus-4-8`, `gpt-5.5`, `Gemini 3.5 Flash`). Set on an `ai_output` when
   * the tool exposes a model, else on the `prompt` for tools that only capture
   * prompts. Prettified at render via `labelForModel`. Absent on older trails.
   */
  model?: string;
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
  /**
   * For a `plan` event: the trail-relative path (`plans/<id>.md`) of the saved,
   * browsable plan file the report links to. Set when the plan was materialized
   * (every captured plan is); absent on older trails.
   */
  planPath?: string;
  /** For a `tool_call` event: the tool's name (e.g. `Bash`, `Read`, `Grep`). */
  toolName?: string;
  /** For a `tool_call` event: whether the tool result was an error. */
  isError?: boolean;
  /** For a `recap` event: the turn's wall-clock duration, in milliseconds. */
  durationMs?: number;
  /** For a `recap` event: the git branch at the time the turn closed. */
  gitBranch?: string;
  /** For a `recap` event: input tokens used across the turn. */
  inputTokens?: number;
  /** For a `recap` event: output tokens used across the turn. */
  outputTokens?: number;
  /** For a `recap` event: cache-read tokens used across the turn. */
  cacheReadTokens?: number;
  /** For a `recap` event: cache-creation tokens used across the turn. */
  cacheCreationTokens?: number;
  /** Which author recorded it (folder slug under `authors/<slug>/`). */
  actorSlug: ActorSlug;
}

/** A recorded snapshot of a file (its hash at a point in time). */
export interface Artifact {
  /** Short unique id, e.g. "art_lqz3k8_a1b2". */
  id: string;
  /** Repo-relative path to the file (the clean display path). */
  path: string;
  /**
   * The file's path relative to the trail root, when it differs from `path`
   * (e.g. a worktree edit whose display `path` is stripped to the repo-logical
   * form). Used to build a report link that actually resolves from `.showtail/`.
   */
  linkPath?: string;
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
   * The host tool's own session id this Showtail session mirrors, 1:1, if known
   * (e.g. a Claude Code or Gemini CLI `session_id`). Lets concurrent/resumed
   * tool sessions each keep their own trail instead of sharing the single global
   * `currentSessionId` pointer. Tool-neutral; older trails used `claudeSessionId`
   * and are normalized on read.
   */
  nativeSessionId?: string;
  /**
   * The machine that created this session. Sessions are sharded by machine
   * (`authors/<slug>/sessions/<machineId>.json`) so the *same* student working
   * from two machines never collides on one file — mirroring the journal. Absent
   * on legacy trails (the single `sessions.json`), which are still read.
   */
  machineId?: string;
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

/**
 * The audit record a *declared rewrite of the journal* leaves behind. Two
 * supported operations rewrite lines that were already written — `showtail
 * redact` (re-addresses stored objects, repoints and re-chains the entries) and
 * `showtail import undo` (drops a batch and re-chains) — and both, by
 * construction, leave no break for the chain check to notice.
 *
 * This marker is what keeps that from being silent: a dated, counted statement
 * that history was rewritten on purpose. `showtail verify` surfaces it next to
 * the chain result, and — the reason every rewriting operation must record one —
 * uses it to reconcile the rewrites git history shows. An undeclared rewrite is
 * reported; a declared one is explained.
 *
 * It deliberately holds no removed value, and no `--pattern` source either: a
 * student scrubbing `hunter2` would otherwise leak it right back by recording
 * the pattern they used.
 */
export interface RedactionRecord {
  /**
   * Which operation rewrote the journal. Absent on markers written before
   * `import undo` recorded one, which were all redaction passes — read a missing
   * value as `redact`.
   */
  reason?: 'redact' | 'import-undo' | 'migration-undo';
  /**
   * For a `redact` pass: `rescan` re-ran the configured rules, `pattern`
   * scrubbed one given regex. Absent for other reasons.
   */
  mode?: 'rescan' | 'pattern';
  /** How many journal entries were rewritten (for `import-undo`: removed). */
  entries: number;
  /** How many sensitive values were removed in total. */
  values: number;
  /** Which rule labels fired (e.g. `api-key`, `pattern`) — never their values. */
  labels: string[];
  /** How many stored objects were rewritten to a new address. */
  objects?: number;
  /** For `import-undo`: the import batch that was removed. */
  batch?: string;
}

/** Metadata recovered for an existing event without rewriting its journal line. */
export interface EventEnrichmentOverlay {
  /** The existing journal event this overlay augments. */
  targetEventId: string;
  /** Stable provider id used for future transcript deduplication. */
  sourceId?: string;
  /** Provider-reported model that produced the event. */
  model?: string;
  /** Exact prompt event that opened this event's turn. */
  turnId?: string;
}

/** How a provider transcript was matched to an existing Showtail session. */
export type MigrationMatchMethod =
  | 'native-session-id'
  | 'prompt-sequence'
  | 'user-confirmed'
  | 'explicit-file';

/** Append-only audit payload for one transcript enrichment pass. */
export interface EnrichmentRecord {
  version: 1;
  batchId: string;
  migratedAt: string;
  provider: Tool;
  providerSessionId: string;
  /** SHA-256 of the raw provider transcript; no local source path is committed. */
  transcriptSha256: string;
  showtailSessionId: string;
  matchMethod: MigrationMatchMethod;
  matchConfidence: 'exact' | 'high' | 'confirmed';
  added: Record<string, number>;
  overlaid: number;
  skipped: Record<string, number>;
  redacted: number;
  overlays?: EventEnrichmentOverlay[];
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
  /**
   * Stable, generated identifier for this trail (`trl_…`), minted at init and
   * never changed. Unlike {@link anchor} (a path, which moves), this survives the
   * repo being renamed or relocated, so the global ledger can recognize a moved
   * trail by id and flag a deleted one as "target missing". Absent on trails
   * created before trail ids existed — minted on first write (upgrade-on-read).
   */
  trailId?: string;
  settings: {
    /** Whether to try to capture git commit hashes. */
    git: boolean;
    /** Capture AI text responses (Stop hook / imports). Default on. */
    captureAiOutput?: boolean;
    /** Capture AI-suggested code/diffs alongside edits. Default on. */
    captureCode?: boolean;
    /** Capture non-edit tool calls (Bash, Read, Grep, ...) and their results. Default on. */
    captureToolCalls?: boolean;
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
   * and as the fallback turn pointer when a hook payload carries no native
   * session id (older transcripts, manual `showtail log`, Codex).
   */
  currentPromptId?: string | null;
  /**
   * The open turn per host-tool session id, so edits from concurrent sessions
   * attach to the right prompt instead of a single global turn. Tool-neutral;
   * older trails used `turnByClaudeSession` and are normalized on read.
   */
  turnByNativeSession?: Record<string, string>;
}

/** How many events were recorded through a given tool. */
export interface ToolUsage {
  tool: Tool;
  events: number;
}

/** How many AI responses used a given model (raw id; label computed at render). */
export interface ModelUsage {
  model: string;
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
  /** Structured JSON export contract. Existing summary fields remain backward compatible. */
  schemaVersion: 2;
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
    /** How many `plan` events (plan-mode plans the AI proposed) were captured. */
    plans: number;
    /**
     * Session-wide totals from captured `recap` events (turn duration + token
     * usage). Undefined when no `recap` events were captured, so the report
     * omits the section entirely rather than showing all-zero stats.
     */
    stats?: {
      totalDurationMs: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    };
  };
  /** Everyone who contributed to the trail (one entry for a single-author report). */
  contributors: Contributor[];
  /** Per-tool event totals. */
  tools: ToolUsage[];
  /** Per-model response totals (only models Showtail captured; empty when none). */
  models: ModelUsage[];
  /** Chronological blocks of tool usage; boundaries are tool switches. */
  toolTimeline: ToolBlock[];
  /** Prompt-and-AI exchanges, each rendered as a collapsible card. */
  turns: Turn[];
  /**
   * Every captured plan, as a first-class cross-cutting index (the report's
   * top-level "Plans" section). The same plans also appear inline in their turn;
   * this is the at-a-glance list with a link to each saved plan file.
   */
  plans: ReportPlan[];
  /** How many secrets/PII Showtail scrubbed before storing (0 when none). */
  redactionCount: number;
  authorship: string;
}

/** One plan in the report's top-level Plans index (resolved for rendering). */
export interface ReportPlan {
  /** The plan markdown (without the revision-feedback prefix). */
  text: string;
  /** Approval state: approved/revised for tools that resolve it, else 'none'. */
  status: 'approved' | 'revised' | 'none';
  /** The revision feedback the student sent back, when `status` is 'revised'. */
  feedback?: string;
  /** Trail-relative path (`plans/<id>.md`) of the saved plan file to link to. */
  planPath?: string;
  tool: Tool;
  timestamp: string;
  actorSlug: ActorSlug;
}

/** One AI-suggested code change within a turn (diff text resolved for rendering). */
export interface TurnCodeChange {
  path: string;
  /** Trail-root-relative path for the report link, when it differs from `path`. */
  linkPath?: string;
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
  /** Plans the AI proposed in plan mode (with their approval status). */
  plans: Event[];
  /** Tool calls (Bash, Read, Grep, ...) the AI made during the exchange. */
  toolCalls: Event[];
  /** The turn's end-of-turn recap + duration/token/branch stats, if captured. */
  recap?: Event;
  /** Ordered, provider-neutral conversation stream used by machine consumers. */
  events: ConversationEvent[];
  tool: Tool;
  /** Which author this exchange belongs to — used to attribute/color turns. */
  actorSlug: ActorSlug;
  /** The session (AI conversation) this prompt opened in — used to group by session. */
  sessionId: string;
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
   * artifact-type note), an "artifact" file snapshot, or a "redaction" audit
   * marker left by `showtail redact`, or a structured `conversation` event.
   * Distinct from `type` so an artifact-*type* event is not confused with a
   * snapshot. Defaults to "event" when absent.
   */
  kind?: 'event' | 'artifact' | 'conversation' | 'redaction' | 'enrichment';
  /** Event/Artifact id. */
  id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Event type, "artifact" for a file snapshot, or "redaction" for a marker. */
  type: EventType | 'artifact' | 'conversation' | 'redaction' | 'enrichment';
  tool?: Tool;
  /** Conversation/session id this entry belongs to. */
  conv?: string;
  /** Turn id (the prompt that opened the exchange). */
  turn?: string;
  /** Import batch id (retained so a specific import can be removed later). */
  batch?: string;
  /**
   * SHA-256 of the previous entry in this author+machine shard, chaining the log.
   * Each line therefore commits to every line before it, so an entry that is
   * edited, deleted, or spliced in after the fact breaks the chain at the next
   * line and `showtail verify` reports it. Chained per shard (never across one)
   * so two machines' segments still merge without conflict. Absent on the first
   * entry of a shard, and on trails written before chaining existed.
   */
  prev?: string;
  /** Which author recorded it. Optional on read (defaults to the folder slug). */
  actorSlug?: ActorSlug;
  // --- event content (referenced, not inlined) ---
  /** Object-store addresses for this entry's content (e.g. the event text). */
  refs?: string[];
  /** Short, human-glanceable preview of the content (still redacted). */
  textPreview?: string;
  /** Byte length of the full content. */
  bytes?: number;
  /**
   * How many secrets/PII were scrubbed from this entry's content — at capture
   * time, plus anything a later `showtail redact` pass removed.
   */
  redacted?: number;
  /** For a `redaction` marker (`kind: 'redaction'`): what that pass did. */
  redaction?: RedactionRecord;
  /** For an append-only transcript migration audit/metadata overlay. */
  enrichment?: EnrichmentRecord;
  files?: string[];
  tags?: string[];
  gitCommit?: string;
  sourceId?: string;
  /** Original provider ordering for a structured conversation event. */
  sequence?: number;
  /** The AI model that produced this event (raw id). See {@link Event.model}. */
  model?: string;
  /** For a `plan` event: trail-relative path of the saved plan file (`plans/<id>.md`). */
  planPath?: string;
  /** For a `tool_call` event: the tool's name. See {@link Event.toolName}. */
  toolName?: string;
  /** For a `tool_call` event: whether the tool result was an error. */
  isError?: boolean;
  /** For a `recap` event: the turn's wall-clock duration, in milliseconds. */
  durationMs?: number;
  /** For a `recap` event: the git branch at the time the turn closed. */
  gitBranch?: string;
  /** For a `recap` event: input tokens used across the turn. */
  inputTokens?: number;
  /** For a `recap` event: output tokens used across the turn. */
  outputTokens?: number;
  /** For a `recap` event: cache-read tokens used across the turn. */
  cacheReadTokens?: number;
  /** For a `recap` event: cache-creation tokens used across the turn. */
  cacheCreationTokens?: number;
  // --- artifact-specific ---
  path?: string;
  /** Trail-root-relative path for the report link, when it differs from `path`. */
  linkPath?: string;
  sha256?: string;
  diffHash?: string;
  diffLines?: number;
}
