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
export const TOOLS = ['claude-code', 'github-copilot', 'chatgpt', 'cli'] as const;
export type Tool = (typeof TOOLS)[number];

/** Human-friendly label for a tool (falls back to the raw value). */
export const TOOL_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'github-copilot': 'GitHub Copilot',
  chatgpt: 'ChatGPT',
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
  };
}

/** Tracks which session new `log` events flow into. */
export interface State {
  currentSessionId: string | null;
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
  decisions: Event[];
  artifactsCreated: Artifact[];
  tests: Event[];
  reflections: Event[];
  sources: Event[];
  authorship: string;
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
