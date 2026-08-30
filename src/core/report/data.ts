import { basename } from 'node:path';
import type {
  Artifact,
  Contributor,
  Event,
  ModelUsage,
  ReportData,
  ReportPlan,
  Tool,
  ToolBlock,
  ToolUsage,
  Turn,
  TurnCodeChange,
} from '../../types.ts';
import type { ConversationEvent } from '../../types.ts';
import { labelForModel, labelForTool } from '../../plugins/registry.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG, splitPlanText } from '../plans.ts';
import { readAllArtifacts } from '../artifacts.ts';
import { authorPaths, readConfig, readSessions, type ShowtailPaths } from '../storage.ts';
import { readJournal } from '../journal.ts';
import { authorSlugs, readAllAuthors } from '../authors.ts';
import { readAllEventsWithSession, type EventWithSession } from '../events.ts';
import { readObject } from '../objects.ts';
import { isSyntheticPrompt } from '../syntheticPrompt.ts';
import {
  readAllConversationEventsWithSession,
  type ConversationEventWithSession,
} from '../conversationEvents.ts';

/** The tool an event flowed through (defaults to "cli" for older/manual events). */
export function toolOf(event: Event): Tool {
  return (event.tool as Tool) ?? 'cli';
}

export function toolLabel(tool: Tool): string {
  return labelForTool(tool);
}

export function modelLabel(model: string): string {
  return labelForModel(model);
}

/**
 * The distinct models used within one turn — from its AI replies, falling back
 * to the prompt (live-hook tools that only capture prompts stamp the model
 * there). In first-seen order; normally exactly one, empty when no model was
 * captured. Used for the per-turn model badge / meta line.
 */
export function turnModels(turn: Turn): string[] {
  const out: string[] = [];
  const add = (m?: string) => {
    if (m && !out.includes(m)) out.push(m);
  };
  for (const e of turn.aiOutputs) add(e.model);
  add(turn.prompt.model);
  return out;
}

/**
 * Whether to attribute each exchange to its author: only on the combined team
 * report (no scope) with more than one contributor. Shared by both renderers.
 */
export function shouldShowAuthor(data: ReportData): boolean {
  return data.scope === null && data.contributors.length > 1;
}

/** A lookup from author slug to display name, for attributing turns. */
export function nameBySlugMap(contributors: Contributor[]): Map<string, string> {
  return new Map(contributors.map((c) => [c.slug, c.name]));
}

/** Options controlling the scope of a generated report. */
export interface ReportScope {
  /** Limit the report to a single author (per-student report). Omit for the team report. */
  authorSlug?: string;
  /** Override the descriptive name in the title for this report (beats config.project). */
  title?: string;
}

/**
 * Build the structured report data from everything recorded in the project.
 * With no `authorSlug`, this is the combined *team* report spanning every
 * contributor; with one, it's that single student's report.
 */
export function buildReportData(
  paths: ShowtailPaths,
  scope: ReportScope = {},
): ReportData {
  const config = readConfig(paths);
  const authors = readAllAuthors(paths);
  const nameBySlug = new Map(authors.map((a) => [a.slug, a.name]));

  // Pull everything, then narrow to the scoped author when one is requested.
  const onlySlug = scope.authorSlug;
  const withSession = readAllEventsWithSession(paths).filter(
    (x) => !onlySlug || x.actorSlug === onlySlug,
  );
  const events = withSession.map((x) => x.event);
  const artifacts = readAllArtifacts(paths).filter(
    (a) => !onlySlug || a.actorSlug === onlySlug,
  );
  const conversationEvents = readAllConversationEventsWithSession(paths).filter(
    (event) => !onlySlug || event.actorSlug === onlySlug,
  );

  const tools = buildToolUsage(events);
  const models = buildModelUsage(events);
  const sorted = sortByTime(events);

  const slugsInScope = onlySlug ? [onlySlug] : authorSlugs(paths);
  const contributors = buildContributors(
    slugsInScope,
    nameBySlug,
    withSession,
    artifacts,
  );

  // Count the actual session records (a session can exist before it has events).
  const sessionCount = slugsInScope.reduce(
    (n, slug) => n + readSessions(authorPaths(paths, slug)).length,
    0,
  );
  const scopeName = onlySlug ? (nameBySlug.get(onlySlug) ?? onlySlug) : null;

  // The descriptive subject for the title: an explicit override, else the
  // configured project name, else the repo/folder name — so a report is never
  // a bare "Showtail Report" even when no project name was ever set.
  const displayName = scope.title ?? config.project ?? basename(paths.root);

  // Built before the summary: session stats are derived from each turn's chosen
  // recap, so a turn that captured more than one never double-counts.
  const turns = buildTurns(withSession, artifacts, paths, conversationEvents);

  return {
    schemaVersion: 2,
    project: config.project ?? null,
    displayName,
    generatedAt: new Date().toISOString(),
    scope: onlySlug ? { slug: onlySlug, name: scopeName ?? onlySlug } : null,
    summary: {
      sessions: sessionCount,
      events: events.length,
      artifacts: artifacts.length,
      decisions: events.filter((e) => e.type === 'decision').length,
      plans: events.filter((e) => e.type === 'plan').length,
      stats: buildSessionStats(turns),
    },
    contributors,
    tools,
    models,
    toolTimeline: buildToolBlocks(sorted),
    turns,
    plans: buildReportPlans(sorted),
    redactionCount: countRedactions(paths, slugsInScope),
    authorship: buildAuthorshipStatement(displayName, contributors, scopeName),
  };
}

function sortByTime(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * The report's top-level Plans index: every `plan` event, in time order, with
 * its approval status, revision feedback, and a link to the saved plan file.
 * The same plans also render inline in their turn; this is the at-a-glance list.
 * `events` is expected pre-sorted by time (the caller passes the sorted stream).
 */
export function buildReportPlans(events: Event[]): ReportPlan[] {
  const plans: ReportPlan[] = [];
  for (const event of events) {
    if (event.type !== 'plan') continue;
    const { feedback, plan } = splitPlanText(event.text);
    const status: ReportPlan['status'] = event.tags?.includes(PLAN_APPROVED_TAG)
      ? 'approved'
      : event.tags?.includes(PLAN_REVISED_TAG)
        ? 'revised'
        : 'none';
    plans.push({
      text: plan,
      status,
      feedback,
      planPath: event.planPath,
      tool: toolOf(event),
      timestamp: event.timestamp,
      actorSlug: event.actorSlug,
    });
  }
  return plans;
}

/** Per-author contribution totals for the contributors list. */
function buildContributors(
  slugs: string[],
  nameBySlug: Map<string, string>,
  withSession: EventWithSession[],
  artifacts: Artifact[],
): Contributor[] {
  const eventsBy = new Map<string, number>();
  for (const x of withSession) {
    eventsBy.set(x.actorSlug, (eventsBy.get(x.actorSlug) ?? 0) + 1);
  }
  const artifactsBy = new Map<string, number>();
  for (const a of artifacts) {
    const slug = a.actorSlug ?? '';
    artifactsBy.set(slug, (artifactsBy.get(slug) ?? 0) + 1);
  }
  return slugs
    .map((slug) => ({
      slug,
      name: nameBySlug.get(slug) ?? slug,
      events: eventsBy.get(slug) ?? 0,
      artifacts: artifactsBy.get(slug) ?? 0,
    }))
    .sort((a, b) => b.events - a.events || a.slug.localeCompare(b.slug));
}

/** Total number of secrets/PII Showtail scrubbed across the in-scope authors. */
function countRedactions(paths: ShowtailPaths, slugs: string[]): number {
  let total = 0;
  for (const slug of slugs) {
    for (const e of readJournal(authorPaths(paths, slug))) total += e.redacted ?? 0;
  }
  return total;
}

/**
 * Group the event stream into "turns": each prompt plus the AI text outputs and
 * code changes it produced. A turn is linked by `turnId` where present, and by
 * `(author, session)` timestamp adjacency otherwise — keying the fallback on the
 * author too so turns never bleed across students in the combined report.
 */
export function buildTurns(
  withSession: EventWithSession[],
  artifacts: Artifact[],
  paths: ShowtailPaths,
  conversationEvents: ConversationEventWithSession[] = [],
): Turn[] {
  // Only genuine student prompts open turns. Older trails captured harness-injected
  // user-role envelopes (`<task-notification>` subagent results, `<system-reminder>`)
  // as prompt events; skip them here so they don't render as giant "prompt" blocks.
  // Their trailing AI/edits fall back (below) to the previous real prompt's turn.
  const prompts = withSession
    .filter((x) => x.event.type === 'prompt' && !isSyntheticPrompt(x.event.text))
    .sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));

  const turns: Turn[] = prompts.map(({ event, sessionId }) => ({
    prompt: event,
    aiOutputs: [],
    codeChanges: [],
    decisions: [],
    plans: [],
    toolCalls: [],
    events: [],
    tool: toolOf(event),
    actorSlug: event.actorSlug,
    sessionId,
  }));
  const turnByPrompt = new Map<string, Turn>();
  prompts.forEach((p, i) => turnByPrompt.set(p.event.id, turns[i]!));

  // Per (author, session), the prompts' timestamps + turns in ascending order
  // (`prompts` is already sorted by timestamp, so each per-key list is too). This
  // lets `fallback` binary-search instead of rescanning every prompt per event.
  const promptsByKey = new Map<string, { ts: string; turn: Turn }[]>();
  prompts.forEach((p, i) => {
    const key = `${p.actorSlug}|${p.sessionId}`;
    const list = promptsByKey.get(key);
    const entry = { ts: p.event.timestamp, turn: turns[i]! };
    if (list) list.push(entry);
    else promptsByKey.set(key, [entry]);
  });

  // The latest prompt at-or-before `ts` by the same author in the same session
  // (rightmost entry with `ts <= target`, so equal timestamps keep last-wins).
  const fallback = (ts: string, slug: string, session: string): Turn | undefined => {
    const list = promptsByKey.get(`${slug}|${session}`);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.ts <= ts) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans >= 0 ? list[ans]!.turn : undefined;
  };

  for (const { event, sessionId, actorSlug } of withSession) {
    if (event.type !== 'ai_output') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, actorSlug, sessionId);
    if (turn) turn.aiOutputs.push(event);
  }

  // Decisions (AskUserQuestion choices) attach to the turn they happened within,
  // the same way replies do.
  for (const { event, sessionId, actorSlug } of withSession) {
    if (event.type !== 'decision') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, actorSlug, sessionId);
    if (turn) turn.decisions.push(event);
  }

  // Plans (ExitPlanMode) attach to their turn the same way.
  for (const { event, sessionId, actorSlug } of withSession) {
    if (event.type !== 'plan') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, actorSlug, sessionId);
    if (turn) turn.plans.push(event);
  }

  // Tool calls (Bash, Read, Grep, ...) attach to their turn the same way.
  for (const { event, sessionId, actorSlug } of withSession) {
    if (event.type !== 'tool_call') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, actorSlug, sessionId);
    if (turn) turn.toolCalls.push(event);
  }

  // Each turn's recap (its own end-of-turn stats/summary). A turn can capture
  // more than one: a Stop that lands before the host has written the turn's
  // recap records the duration alone, and the later catch-up read then records
  // the complete one under its own id. Choose deliberately rather than letting
  // journal order decide — see `betterRecap`.
  for (const { event, sessionId, actorSlug } of withSession) {
    if (event.type !== 'recap') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, actorSlug, sessionId);
    if (turn) turn.recap = betterRecap(turn.recap, event);
  }

  for (const a of artifacts) {
    const turn =
      (a.turnId ? turnByPrompt.get(a.turnId) : undefined) ??
      fallback(a.timestamp, a.actorSlug ?? '', a.sessionId ?? '');
    if (!turn) continue;
    const diff = a.diffHash ? (readObject(paths, a.diffHash) ?? undefined) : undefined;
    // De-dupe one file per turn: a host can produce two artifacts for the same
    // edit — a live snapshot (file hash, no diff) and a transcript-reconciled
    // import (diff, no hash; e.g. Codex `apply_patch`). Collapse them so the file
    // shows once, preferring the entry that carries a diff.
    const existing = turn.codeChanges.find((c) => c.path === a.path);
    if (existing) {
      if (!existing.diff && diff) {
        existing.diff = diff;
        existing.diffLines = a.diffLines;
      }
      if (!existing.tool && a.tool) existing.tool = a.tool as Tool;
      if (!existing.linkPath && a.linkPath) existing.linkPath = a.linkPath;
      continue;
    }
    turn.codeChanges.push({
      path: a.path,
      linkPath: a.linkPath,
      diff,
      diffLines: a.diffLines,
      tool: a.tool as Tool | undefined,
      timestamp: a.timestamp,
    });
  }

  for (const item of conversationEvents) {
    const turn =
      (item.turnId ? turnByPrompt.get(item.turnId) : undefined) ??
      fallback(item.event.timestamp ?? '', item.actorSlug, item.sessionId);
    if (turn) turn.events.push(item.event);
  }

  for (const turn of turns) {
    const captured =
      turn.events.length > 0 ? turn.events : synthesizeConversationEvents(turn);
    const events = captured.some((event) => event.type === 'user_text')
      ? captured
      : [
          {
            sequence: -1,
            type: 'user_text' as const,
            text: turn.prompt.text,
            timestamp: turn.prompt.timestamp,
            sourceId: turn.prompt.sourceId ?? turn.prompt.id,
          },
          ...captured,
        ];
    turn.events = [...events]
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          (left.timestamp ?? '').localeCompare(right.timestamp ?? '') ||
          (left.sourceId ?? '').localeCompare(right.sourceId ?? ''),
      )
      .map((event, sequence) => ({ ...event, sequence }));
  }

  return turns;
}

/** Best-effort schema-v2 projection for a trail captured before structured events existed. */
function synthesizeConversationEvents(turn: Turn): ConversationEvent[] {
  const out: ConversationEvent[] = [
    {
      sequence: 0,
      type: 'user_text',
      text: turn.prompt.text,
      timestamp: turn.prompt.timestamp,
      sourceId: turn.prompt.sourceId ?? turn.prompt.id,
    },
  ];
  for (const item of turnTimeline(turn)) {
    if (item.kind === 'code') continue;
    const event = item.event;
    const sourceId = event.sourceId ?? event.id;
    if (item.kind === 'ai') {
      out.push({
        sequence: out.length,
        type: 'assistant_text',
        text: event.text,
        timestamp: event.timestamp,
        sourceId,
      });
    } else if (item.kind === 'decision') {
      out.push({
        sequence: out.length,
        type: 'tool_use',
        toolUseId: sourceId,
        toolName: 'AskUserQuestion',
        timestamp: event.timestamp,
        sourceId: `${sourceId}:use`,
      });
      out.push({
        sequence: out.length,
        type: 'tool_result',
        toolUseId: sourceId,
        content: event.text,
        timestamp: event.timestamp,
        sourceId: `${sourceId}:result`,
      });
    } else if (item.kind === 'plan') {
      const { plan } = splitPlanText(event.text);
      out.push({
        sequence: out.length,
        type: 'plan_snapshot',
        plan,
        timestamp: event.timestamp,
        sourceId: `${sourceId}:snapshot`,
      });
      if (event.tags?.includes(PLAN_APPROVED_TAG)) {
        out.push({
          sequence: out.length,
          type: 'plan_approved',
          timestamp: event.timestamp,
          sourceId: `${sourceId}:approved`,
        });
      }
    } else if (item.kind === 'tool_call') {
      out.push({
        sequence: out.length,
        type: 'tool_use',
        toolUseId: sourceId,
        toolName: event.toolName,
        timestamp: event.timestamp,
        sourceId: `${sourceId}:use`,
      });
      out.push({
        sequence: out.length,
        type: 'tool_result',
        toolUseId: sourceId,
        content: event.text,
        isError: event.isError,
        timestamp: event.timestamp,
        sourceId: `${sourceId}:result`,
      });
    }
  }
  return out;
}

/** One rendered item inside a turn, tagged for the renderer. */
export type TurnItem =
  | { kind: 'ai'; event: Event }
  | { kind: 'decision'; event: Event }
  | { kind: 'plan'; event: Event }
  | { kind: 'code'; change: TurnCodeChange }
  | { kind: 'tool_call'; event: Event };

/**
 * A turn's AI replies, code changes, decisions, and plans merged into one
 * chronological sequence, so the report interleaves them as they happened instead
 * of grouping by type. Stable-sorted by timestamp; items sharing a timestamp (text
 * plus a tool call in one message) keep their insertion order — AI text, then
 * code, then decision/plan — so text reads before the tools it introduced.
 */
export function turnTimeline(turn: Turn): TurnItem[] {
  const dated: { at: string; item: TurnItem }[] = [
    ...turn.aiOutputs.map((event) => ({
      at: event.timestamp,
      item: { kind: 'ai', event } as TurnItem,
    })),
    ...turn.codeChanges.map((change) => ({
      at: change.timestamp,
      item: { kind: 'code', change } as TurnItem,
    })),
    ...turn.decisions.map((event) => ({
      at: event.timestamp,
      item: { kind: 'decision', event } as TurnItem,
    })),
    ...turn.plans.map((event) => ({
      at: event.timestamp,
      item: { kind: 'plan', event } as TurnItem,
    })),
    ...turn.toolCalls.map((event) => ({
      at: event.timestamp,
      item: { kind: 'tool_call', event } as TurnItem,
    })),
  ];
  dated.sort((a, b) => a.at.localeCompare(b.at));
  return dated.map((d) => d.item);
}

/**
 * A turn split into ordered segments for the reader-first layout. The turn stays a
 * single chronological stream: the student's work (code changes, decisions, plans)
 * renders inline in position, and each *run of consecutive AI messages* becomes one
 * collapsed pill **at the spot it occurred** — not bucketed at the end.
 *
 * This keeps chronology intact: expanding the pills (the page toggle / `--ai full`)
 * reconstructs the full "what happened and where" narrative — AI reasoning
 * interleaved with the edits/decisions/plans, in order — with every item shown
 * exactly once (work inline, AI in its pill), so nothing is duplicated.
 *
 * We deliberately do *not* guess which AI messages "matter": no such signal is
 * consistent across tools, and content heuristics match almost everything. Every AI
 * message is kept, just collapsed by default.
 */
export type TurnSegment =
  | { kind: 'work'; item: TurnItem } // a code | decision | plan item, rendered inline
  | { kind: 'ai'; events: Event[] } // a run of consecutive AI messages → one pill
  | { kind: 'tools'; events: Event[] }; // a run of consecutive tool calls → one group

export function turnSegments(turn: Turn): TurnSegment[] {
  const segments: TurnSegment[] = [];
  // Two accumulators, same shape: a run of consecutive AI messages and a run of
  // consecutive tool calls each collapse to a single segment. Anything else
  // (code, decision, plan) closes both — it is the work the run led up to.
  let ai: Event[] = [];
  let tools: Event[] = [];
  const flush = () => {
    if (ai.length > 0) {
      segments.push({ kind: 'ai', events: ai });
      ai = [];
    }
    if (tools.length > 0) {
      segments.push({ kind: 'tools', events: tools });
      tools = [];
    }
  };
  for (const item of turnTimeline(turn)) {
    if (item.kind === 'ai') {
      if (tools.length > 0) flush(); // the tools so far ran before this reply
      ai.push(item.event);
    } else if (item.kind === 'tool_call') {
      if (ai.length > 0) flush(); // the AI so far explains the calls that follow
      tools.push(item.event);
    } else {
      flush(); // the AI/tools so far led to this work item
      segments.push({ kind: 'work', item });
    }
  }
  flush();
  return segments;
}

/** One tool's share of a run, for the group's one-line summary. */
export interface ToolRunTally {
  name: string;
  count: number;
}

/** What a run of consecutive tool calls amounts to, for its collapsed header. */
export interface ToolRunSummary {
  total: number;
  /** Per-tool counts, busiest first (name ascending on ties, so it is stable). */
  byTool: ToolRunTally[];
  /** How many of the calls reported an error — surfaced so failures aren't buried. */
  failed: number;
}

/**
 * Summarize a run of tool calls (e.g. "23 tool calls · 12 Bash · 8 Read · 3
 * Grep"). Shared by both renderers so the HTML card and the Markdown export can
 * never disagree about what a run contained.
 */
export function summarizeToolRun(events: Event[]): ToolRunSummary {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const e of events) {
    const name = e.toolName ?? 'Tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (e.isError) failed += 1;
  }
  const byTool = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total: events.length, byTool, failed };
}

/**
 * What makes one turn worth opening, for the collapsed row's markers.
 *
 * The report's reader is an educator scanning far more turns than they can read,
 * so the row is a triage surface: it should stay quiet unless something happened
 * that rewards a closer look. These are the things that do — the student's own
 * judgement (a choice they made, a plan they sent back rather than waved
 * through) and friction they worked through. Deliberately *not* included is
 * anything measuring how much machinery ran: that says nothing about what the
 * student understood, and putting a number on every row is what drowns the rare
 * signals. A turn with no signals is a routine turn — that is the point.
 */
export interface TurnSignals {
  decisions: number;
  /** Plans the AI proposed that the student accepted (or that carry no verdict). */
  plansProposed: number;
  /** Plans the student sent back for revision — they pushed back on the AI. */
  plansRevised: number;
  failedTools: number;
}

export function turnSignals(turn: Turn): TurnSignals {
  let plansRevised = 0;
  let plansProposed = 0;
  for (const p of turn.plans) {
    if (p.tags?.includes(PLAN_REVISED_TAG)) plansRevised += 1;
    else plansProposed += 1;
  }
  return {
    decisions: turn.decisions.length,
    plansProposed,
    plansRevised,
    failedTools: turn.toolCalls.filter((t) => t.isError).length,
  };
}

/** True when a turn has anything worth flagging on its collapsed row. */
export function hasSignals(s: TurnSignals): boolean {
  return (
    s.decisions > 0 || s.plansProposed > 0 || s.plansRevised > 0 || s.failedTools > 0
  );
}

/**
 * The duration above which a turn is worth flagging as unusually long, or
 * undefined when nothing in this report qualifies.
 *
 * Relative to the report rather than a fixed cutoff: real sessions range from
 * seconds to nearly an hour (the sample this was tuned against had a 2m32s
 * median and a 52m maximum), so any absolute threshold either fires on half the
 * rows or never. Takes a high percentile so only the tail is marked, with an
 * absolute floor so a session where everything was quick flags nothing at all.
 */
export function longTurnThreshold(turns: Turn[]): number | undefined {
  const FLOOR_MS = 60_000; // never call anything under a minute "long"
  const PERCENTILE = 0.85; // the slowest ~15% of turns
  const durations = turns
    .map((t) => t.recap?.durationMs)
    .filter((d): d is number => typeof d === 'number' && d > 0)
    .sort((a, b) => a - b);
  if (durations.length < 4) return undefined; // too few to have a meaningful tail
  const cutoff = durations[Math.floor(durations.length * PERCENTILE)];
  if (cutoff === undefined) return undefined;
  return Math.max(cutoff, FLOOR_MS);
}

/** Distinct files touched across every turn (unique paths), for the summary line. */
export function filesChanged(turns: Turn[]): number {
  const seen = new Set<string>();
  for (const t of turns) for (const c of t.codeChanges) seen.add(c.path);
  return seen.size;
}

/** Count events per tool, busiest first. */
function buildToolUsage(events: Event[]): ToolUsage[] {
  const counts = new Map<Tool, number>();
  for (const e of events) {
    const t = toolOf(e);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, events: count }))
    .sort((a, b) => b.events - a.events);
}

/** Count events per model (only those with a captured model), busiest first. */
function buildModelUsage(events: Event[]): ModelUsage[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.model) counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([model, count]) => ({ model, events: count }))
    .sort((a, b) => b.events - a.events);
}

/** A duration in milliseconds as a short human string (`"53s"`, `"1m 20s"`). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Which of two recaps for the same turn to show. A turn can capture several:
 * the host writes its transcript asynchronously and appends the end-of-turn
 * recap minutes after the last hook ran, so an early Stop can record the
 * duration alone before the complete recap exists. Prefer the one that actually
 * carries the recap text, then the longer duration (a later read sums every
 * Stop cycle in the turn, so the larger figure is the more complete one).
 */
function betterRecap(current: Event | undefined, candidate: Event): Event {
  if (!current) return candidate;
  const currentHasText = current.text.trim().length > 0;
  const candidateHasText = candidate.text.trim().length > 0;
  if (currentHasText !== candidateHasText) return candidateHasText ? candidate : current;
  return (candidate.durationMs ?? 0) > (current.durationMs ?? 0) ? candidate : current;
}

/**
 * Session-wide totals from each turn's chosen recap (duration + token usage).
 * Derived per turn, never by summing every `recap` event, so a turn that
 * captured a partial recap *and* its later complete one counts only once.
 * Undefined when no recap was captured, so the report omits the section
 * entirely rather than showing all-zero stats.
 */
function buildSessionStats(turns: Turn[]): ReportData['summary']['stats'] {
  const recaps = turns.map((t) => t.recap).filter((r): r is Event => r !== undefined);
  if (recaps.length === 0) return undefined;
  const stats = {
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
  for (const e of recaps) {
    stats.totalDurationMs += e.durationMs ?? 0;
    stats.totalInputTokens += e.inputTokens ?? 0;
    stats.totalOutputTokens += e.outputTokens ?? 0;
    stats.totalCacheReadTokens += e.cacheReadTokens ?? 0;
    stats.totalCacheCreationTokens += e.cacheCreationTokens ?? 0;
  }
  return stats;
}

/**
 * Collapse a time-ordered event stream into contiguous tool blocks. Each
 * boundary between blocks is a moment the student switched tools — which is
 * exactly what a professor needs to follow.
 */
export function buildToolBlocks(sortedEvents: Event[]): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  for (const e of sortedEvents) {
    const tool = toolOf(e);
    const last = blocks[blocks.length - 1];
    if (last && last.tool === tool) {
      last.to = e.timestamp;
      last.count += 1;
    } else {
      blocks.push({ tool, from: e.timestamp, to: e.timestamp, count: 1 });
    }
  }
  return blocks;
}

/**
 * The authorship statement. For a single-student report it's that student's
 * first-person attestation; for the combined team report it names every
 * contributor and attests the work is the team's own.
 */
function buildAuthorshipStatement(
  displayName: string,
  contributors: Contributor[],
  scopeName: string | null,
): string {
  const name = `"${displayName}"`;

  if (scopeName) {
    return (
      `I, ${scopeName}, recorded this trail while working on ${name}. It shows the ` +
      `prompts I used and the files I built along the way. The work and ` +
      `understanding represented here are my own.`
    );
  }

  const names = contributors.map((c) => c.name);
  if (names.length === 0) {
    return `This trail records the prompts and files produced while working on ${name}.`;
  }
  if (names.length === 1) {
    return (
      `${names[0]} recorded this trail while working on ${name}. The work and ` +
      `understanding represented here are their own.`
    );
  }
  return (
    `This trail was recorded by ${joinAnd(names)} while working together on ${name}. ` +
    `Each contributor's prompts and edits are attributed to them, and the work and ` +
    `understanding represented here are the team's own.`
  );
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
