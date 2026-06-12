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

/** The structured (JSON) form of a generated report. */
export interface ReportData {
  project: string | null;
  generatedAt: string;
  summary: {
    sessions: number;
    events: number;
    artifacts: number;
  };
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
}
