import type {
  Artifact,
  Event,
  ReportData,
  Tool,
  ToolBlock,
  ToolUsage,
  Turn,
} from '../../types.ts';
import { TOOL_LABELS } from '../../types.ts';
import { readArtifacts } from '../artifacts.ts';
import { readAllEventsWithSession } from '../events.ts';
import { readObject } from '../objects.ts';
import { readConfig, readJournal, readSessions, type ShowtailPaths } from '../storage.ts';

/** The tool an event flowed through (defaults to "cli" for older/manual events). */
export function toolOf(event: Event): Tool {
  return (event.tool as Tool) ?? 'cli';
}

export function toolLabel(tool: Tool): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** One event paired with the id of the session it belongs to. */
type EventWithSession = { event: Event; sessionId: string };

/** Build the structured report data from everything recorded in the project. */
export function buildReportData(paths: ShowtailPaths): ReportData {
  const config = readConfig(paths);
  const sessions = readSessions(paths);
  const artifacts = readArtifacts(paths);
  const withSession = readAllEventsWithSession(paths);
  const events = withSession.map((x) => x.event);

  const tools = buildToolUsage(events);
  const sorted = sortByTime(events);

  return {
    project: config.project ?? null,
    generatedAt: new Date().toISOString(),
    summary: {
      sessions: sessions.length,
      events: events.length,
      artifacts: artifacts.length,
    },
    tools,
    toolTimeline: buildToolBlocks(sorted),
    turns: buildTurns(withSession, artifacts, paths),
    redactionCount: countRedactions(paths),
    authorship: buildAuthorshipStatement(config.project, tools),
  };
}

function sortByTime(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Total number of secrets/PII Showtail scrubbed across the whole trail. */
function countRedactions(paths: ShowtailPaths): number {
  let total = 0;
  for (const e of readJournal(paths)) total += e.redacted ?? 0;
  return total;
}

/**
 * Group the event stream into "turns": each prompt plus the AI text outputs and
 * code changes it produced. A turn is linked by `turnId` where present, and by
 * timestamp adjacency (within the same session) otherwise, so older trails still
 * group sensibly.
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
    tool: toolOf(event),
  }));
  const turnByPrompt = new Map<string, Turn>();
  prompts.forEach((p, i) => turnByPrompt.set(p.event.id, turns[i]!));

  // The latest prompt at-or-before `ts` in the same session (adjacency fallback).
  const fallback = (ts: string, session: string): Turn | undefined => {
    let best: Turn | undefined;
    let bestTs = '';
    for (const p of prompts) {
      if (p.sessionId !== session) continue;
      if (p.event.timestamp <= ts && p.event.timestamp >= bestTs) {
        best = turnByPrompt.get(p.event.id);
        bestTs = p.event.timestamp;
      }
    }
    return best;
  };

  for (const { event, sessionId } of withSession) {
    if (event.type !== 'ai_output') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, sessionId);
    if (turn) turn.aiOutputs.push(event);
  }

  for (const a of artifacts) {
    const turn =
      (a.turnId ? turnByPrompt.get(a.turnId) : undefined) ??
      fallback(a.timestamp, a.sessionId ?? '');
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

function buildAuthorshipStatement(
  project: string | undefined,
  tools: ToolUsage[],
): string {
  const name = project ? `"${project}"` : 'this project';
  const toolList =
    tools.length > 0
      ? ' I worked through ' +
        joinAnd(tools.map((t) => toolLabel(t.tool))) +
        ', and this trail records each.'
      : '';
  return (
    `I recorded this trail while working on ${name}. It shows the prompts I used ` +
    `and the files I built along the way.${toolList} The work and understanding ` +
    `represented here are my own.`
  );
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
