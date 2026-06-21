import { basename } from 'node:path';
import type {
  Artifact,
  Contributor,
  Event,
  ReportData,
  Tool,
  ToolBlock,
  ToolUsage,
  Turn,
  TurnCodeChange,
} from '../../types.ts';
import { TOOL_LABELS } from '../../types.ts';
import { readAllArtifacts } from '../artifacts.ts';
import {
  authorPaths,
  readConfig,
  readJournal,
  readSessions,
  type ShowtailPaths,
} from '../storage.ts';
import { authorSlugs, readAllAuthors } from '../authors.ts';
import { readAllEventsWithSession, type EventWithSession } from '../events.ts';
import { readObject } from '../objects.ts';

/** The tool an event flowed through (defaults to "cli" for older/manual events). */
export function toolOf(event: Event): Tool {
  return (event.tool as Tool) ?? 'cli';
}

export function toolLabel(tool: Tool): string {
  return TOOL_LABELS[tool] ?? tool;
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

  const tools = buildToolUsage(events);
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

  return {
    project: config.project ?? null,
    displayName,
    generatedAt: new Date().toISOString(),
    scope: onlySlug ? { slug: onlySlug, name: scopeName ?? onlySlug } : null,
    summary: {
      sessions: sessionCount,
      events: events.length,
      artifacts: artifacts.length,
      decisions: events.filter((e) => e.type === 'decision').length,
    },
    contributors,
    tools,
    toolTimeline: buildToolBlocks(sorted),
    turns: buildTurns(withSession, artifacts, paths),
    redactionCount: countRedactions(paths, slugsInScope),
    authorship: buildAuthorshipStatement(displayName, contributors, scopeName),
  };
}

function sortByTime(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
): Turn[] {
  const prompts = withSession
    .filter((x) => x.event.type === 'prompt')
    .sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));

  const turns: Turn[] = prompts.map(({ event }) => ({
    prompt: event,
    aiOutputs: [],
    codeChanges: [],
    decisions: [],
    tool: toolOf(event),
    actorSlug: event.actorSlug,
  }));
  const turnByPrompt = new Map<string, Turn>();
  prompts.forEach((p, i) => turnByPrompt.set(p.event.id, turns[i]!));

  // The latest prompt at-or-before `ts` by the same author in the same session.
  const fallback = (ts: string, slug: string, session: string): Turn | undefined => {
    let best: Turn | undefined;
    let bestTs = '';
    for (const p of prompts) {
      if (p.actorSlug !== slug || p.sessionId !== session) continue;
      if (p.event.timestamp <= ts && p.event.timestamp >= bestTs) {
        best = turnByPrompt.get(p.event.id);
        bestTs = p.event.timestamp;
      }
    }
    return best;
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

  for (const a of artifacts) {
    const turn =
      (a.turnId ? turnByPrompt.get(a.turnId) : undefined) ??
      fallback(a.timestamp, a.actorSlug ?? '', a.sessionId ?? '');
    if (!turn) continue;
    const diff = a.diffHash ? (readObject(paths, a.diffHash) ?? undefined) : undefined;
    turn.codeChanges.push({
      path: a.path,
      diff,
      diffLines: a.diffLines,
      tool: a.tool as Tool | undefined,
      timestamp: a.timestamp,
    });
  }

  return turns;
}

/** One rendered item inside a turn, tagged for the renderer. */
export type TurnItem =
  | { kind: 'ai'; event: Event }
  | { kind: 'decision'; event: Event }
  | { kind: 'code'; change: TurnCodeChange };

/**
 * A turn's AI replies, code changes, and decisions merged into one chronological
 * sequence, so the report interleaves them as they happened instead of grouping
 * by type. Stable-sorted by timestamp; items sharing a timestamp (text plus a
 * tool call in one message) keep their insertion order — AI text, then code,
 * then decision — so text reads before the tools it introduced.
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
  ];
  dated.sort((a, b) => a.at.localeCompare(b.at));
  return dated.map((d) => d.item);
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
