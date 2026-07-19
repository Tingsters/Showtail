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
import { labelForModel, labelForTool } from '../../plugins/registry.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG, splitPlanText } from '../plans.ts';
import { readAllArtifacts } from '../artifacts.ts';
import { authorPaths, readConfig, readSessions, type ShowtailPaths } from '../storage.ts';
import { readJournal } from '../journal.ts';
import { authorSlugs, readAllAuthors } from '../authors.ts';
import { readAllEventsWithSession, type EventWithSession } from '../events.ts';
import { readObject } from '../objects.ts';
import { diffEntitiesDetailed, hasEntityChanges } from '../entities.ts';
import type { EntityChanges, EntitySig } from '../../types.ts';

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
  /**
   * Pre-read artifacts to use instead of reading from disk here. Lets the caller
   * enrich them first (e.g. `recoverEntities` fills missing entity data) while
   * keeping `buildReportData` synchronous. Filtered by `authorSlug` like the
   * internal read.
   */
  artifacts?: Artifact[];
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
  const artifacts = (scope.artifacts ?? readAllArtifacts(paths)).filter(
    (a) => !onlySlug || a.actorSlug === onlySlug,
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
      plans: events.filter((e) => e.type === 'plan').length,
    },
    contributors,
    tools,
    models,
    toolTimeline: buildToolBlocks(sorted),
    turns: buildTurns(withSession, artifacts, paths),
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
): Turn[] {
  const prompts = withSession
    .filter((x) => x.event.type === 'prompt')
    .sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));

  const turns: Turn[] = prompts.map(({ event }) => ({
    prompt: event,
    aiOutputs: [],
    codeChanges: [],
    decisions: [],
    plans: [],
    tool: toolOf(event),
    actorSlug: event.actorSlug,
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

  const entityChangesById = computeEntityDeltas(artifacts);

  for (const a of artifacts) {
    const turn =
      (a.turnId ? turnByPrompt.get(a.turnId) : undefined) ??
      fallback(a.timestamp, a.actorSlug ?? '', a.sessionId ?? '');
    if (!turn) continue;
    const diff = a.diffHash ? (readObject(paths, a.diffHash) ?? undefined) : undefined;
    // De-dupe one file per turn: a host can produce two artifacts for the same
    // edit — a live snapshot (file hash, no diff) and a transcript-reconciled
    // import (diff, no hash; e.g. Codex `apply_patch`) — and an agent may edit a
    // file more than once per turn. Collapse them so the file shows once,
    // preferring the entry that carries a diff and the latest real entity delta.
    const incomingEntities = entityChangesById.get(a.id);
    const existing = turn.codeChanges.find((c) => c.path === a.path);
    if (existing) {
      if (!existing.diff && diff) {
        existing.diff = diff;
        existing.diffLines = a.diffLines;
      }
      if (!existing.tool && a.tool) existing.tool = a.tool as Tool;
      if (!existing.linkPath && a.linkPath) existing.linkPath = a.linkPath;
      // Adopt a later snapshot's entity delta: the first artifact for a path is
      // often its creation (no prior state → no delta), while a subsequent edit
      // in the same turn is what actually changed functions/classes.
      if (hasEntityChanges(incomingEntities)) existing.entityChanges = incomingEntities;
      continue;
    }
    turn.codeChanges.push({
      path: a.path,
      linkPath: a.linkPath,
      diff,
      diffLines: a.diffLines,
      entityChanges: incomingEntities,
      tool: a.tool as Tool | undefined,
      timestamp: a.timestamp,
    });
  }

  return turns;
}

/**
 * Compute each artifact's entity-level delta versus the previous snapshot of the
 * same file. Walking every author's snapshots for a path in timestamp order means
 * a delta reflects the file's real history — even across teammates editing it —
 * and the first snapshot of a path (no prior state) yields no delta. Keyed by
 * artifact id so `buildTurns` can attach it without re-sorting.
 */
function computeEntityDeltas(
  artifacts: Artifact[],
): Map<string, EntityChanges | undefined> {
  const byTime = [...artifacts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const prevByPath = new Map<string, EntitySig[] | undefined>();
  const out = new Map<string, EntityChanges | undefined>();
  for (const a of byTime) {
    const prev = prevByPath.get(a.path);
    out.set(a.id, diffEntitiesDetailed(prev, a.entities));
    prevByPath.set(a.path, a.entities);
  }
  return out;
}

/** One rendered item inside a turn, tagged for the renderer. */
export type TurnItem =
  | { kind: 'ai'; event: Event }
  | { kind: 'decision'; event: Event }
  | { kind: 'plan'; event: Event }
  | { kind: 'code'; change: TurnCodeChange };

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
