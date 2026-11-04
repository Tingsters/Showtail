/** Independent semantic oracle; never imports or launches a browser. */
import { createHash } from 'node:crypto';
import {
  decodeViewerHtml,
  type DecodedViewerHtml,
} from '../../src/core/report/viewerCodec.ts';
import type {
  ViewerIndex,
  ViewerItem,
  ViewerTurn,
  ViewerUsageStats,
} from '../../src/core/report/viewerTypes.ts';
import type { ReportData } from '../../src/types.ts';
import { labelForTool } from '../../src/plugins/registry.ts';

export interface ReportCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

const canonical = (text: string) => text.replace(/\r\n?/g, '\n').trim();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

/** Count captured zero values; absence is represented separately from zero. */
export function expectedUsage(
  turns: Pick<ReportData['turns'][number], 'recap'>[],
): ViewerUsageStats {
  const fields = [
    'durationMs',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ] as const;
  const metricCounts = Object.fromEntries(
    fields.map((field) => [
      field,
      turns.filter((turn) => typeof turn.recap?.[field] === 'number').length,
    ]),
  );
  return {
    ...Object.fromEntries(
      fields.map((field) => {
        const values = turns.flatMap((turn) =>
          typeof turn.recap?.[field] === 'number' ? [turn.recap[field]!] : [],
        );
        return [
          `total${field[0]!.toUpperCase()}${field.slice(1)}`,
          values.length ? values.reduce((sum, value) => sum + value, 0) : null,
        ];
      }),
    ),
    turnCount: turns.length,
    recapCount: turns.filter((turn) => turn.recap).length,
    durationCount: metricCounts.durationMs,
    tokenCount: turns.filter((turn) =>
      fields.slice(1).some((field) => typeof turn.recap?.[field] === 'number'),
    ).length,
    metricCounts,
  } as ViewerUsageStats;
}

/** Intentionally independent of the product's payload builder and browser loader. */
export function expandForAcceptance(decoded: DecodedViewerHtml): ViewerIndex {
  const index = structuredClone(decoded.index) as unknown as ViewerIndex;
  for (const turn of [...index.turns, ...index.unlinked]) {
    const itemsRef = (turn as ViewerTurn & { itemsRef?: string }).itemsRef;
    if (!itemsRef) continue;
    const items = decoded.structuredTexts.get(itemsRef);
    if (!Array.isArray(items))
      throw new Error('Missing independently decoded turn items');
    turn.itemIds = [];
    for (const item of items as ViewerItem[]) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.kind !== 'string' ||
        (item.textRef && !decoded.texts.has(item.textRef))
      )
        throw new Error('Malformed independently decoded turn item');
      if (index.items[item.id] && !same(index.items[item.id], item))
        throw new Error('Conflicting viewer item identity');
      index.items[item.id] = item;
      turn.itemIds.push(item.id);
    }
  }
  return index;
}

export function inspectEmbeddedContent(
  data: ReportData,
  html: string,
  expectedPrompts: string[],
) {
  const decoded = decodeViewerHtml(html);
  if (!decoded) throw new Error('Expected the bounded standalone viewer payload');
  const index = expandForAcceptance(decoded);
  const checks: ReportCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  check(
    'report JSON preserves submitted prompt sequence',
    same(
      data.turns.map((t) => canonical(t.prompt.text)),
      expectedPrompts.map(canonical),
    ),
    `Expected ${expectedPrompts.length}; found ${data.turns.length} prompts.`,
  );
  check(
    'embedded payload preserves every human prompt identity and exact text',
    same(
      index.turns.map((t) => [t.id, decoded.texts.get(t.promptRef!)]),
      data.turns.map((t) => [t.prompt.id, t.prompt.text]),
    ),
    `${data.turns.length} complete prompts, including repeated text.`,
  );
  const expectedRevisions: string[] = [];
  const sourceRevisionIds = new Set<string>();
  for (const turn of [...data.turns, ...(data.unattributedWork ?? [])])
    for (const change of turn.codeChanges) {
      for (const revision of change.revisions?.length
        ? change.revisions
        : [{ diff: change.diff, sha256: undefined, recordId: undefined }]) {
        if (revision.recordId) sourceRevisionIds.add(revision.recordId);
        expectedRevisions.push(
          JSON.stringify([
            revision.recordId ?? null,
            change.path,
            revision.diff === undefined ? null : digest(revision.diff),
            revision.sha256 ?? null,
          ]),
        );
      }
    }
  const actualRevisions = Object.values(index.items)
    .filter((item) => item.kind === 'revision')
    .map((item) =>
      JSON.stringify([
        item.recordId?.startsWith('revision:') && !sourceRevisionIds.has(item.recordId)
          ? null
          : (item.recordId ?? null),
        item.path,
        item.textRef ? digest(decoded.texts.get(item.textRef)!) : null,
        item.sha256 ?? null,
      ]),
    );
  check(
    'embedded payload preserves every revision identity, path and full diff',
    same(expectedRevisions.sort(), actualRevisions.sort()),
    `${expectedRevisions.length} source revisions; ${actualRevisions.length} embedded revisions.`,
  );
  const expectedObservations = (data.fileObservations ?? []).filter(
    (item) => !item.editId,
  );
  check(
    'embedded payload preserves unverified file observations separately',
    expectedObservations.length === index.observations.length &&
      expectedObservations.every((source) => {
        const item = index.observations.find(
          (candidate) => candidate.id === source.recordId,
        );
        return (
          item?.kind === 'observation' &&
          item.path === source.path &&
          item.basis === source.basis &&
          item.sha256 === source.sha256 &&
          (!source.diff || decoded.texts.get(item.textRef!) === source.diff)
        );
      }),
    `${expectedObservations.length} observations.`,
  );
  check(
    'embedded payload keeps unlinked work outside human prompt count',
    index.unlinked.length === (data.unattributedWork ?? []).length,
  );
  if (data.plans.length || (index.plans?.length ?? 0)) {
    const plans = index.plans ?? [];
    const sourcePlans = [...data.plans];
    for (const turn of [...data.turns, ...(data.unattributedWork ?? [])])
      for (const event of turn.plans) {
        const prefix = '**You sent this back asking:** ',
          marker = '\n\n---\n\n';
        const boundary = event.text.startsWith(prefix)
          ? event.text.indexOf(marker, prefix.length)
          : -1;
        sourcePlans.push({
          text: boundary < 0 ? event.text : event.text.slice(boundary + marker.length),
          ...(boundary < 0
            ? {}
            : { feedback: event.text.slice(prefix.length, boundary) }),
          status: event.tags?.includes('plan-approved')
            ? 'approved'
            : event.tags?.includes('plan-revised')
              ? 'revised'
              : 'none',
          timestamp: event.timestamp,
          tool: turn.tool,
          actorSlug: turn.actorSlug,
        });
      }
    const matches = (
      source: ReportData['plans'][number],
      plan: NonNullable<ViewerIndex['plans']>[number],
    ) =>
      decoded.texts.get(plan.textRef!) === source.text &&
      plan.status === source.status &&
      (plan.feedback ?? undefined) === (source.feedback ?? undefined) &&
      plan.timestamp === source.timestamp &&
      plan.actorSlug === source.actorSlug &&
      plan.tool === labelForTool(source.tool);
    check(
      'embedded payload preserves every captured plan body, status and feedback including orphans',
      sourcePlans.every((source) => plans.some((plan) => matches(source, plan))) &&
        plans.every((plan) => sourcePlans.some((source) => matches(source, plan))),
      `${data.plans.length} source plan rows; ${plans.length} canonical plans.`,
    );
    const captured = [...data.turns, ...(data.unattributedWork ?? [])].flatMap((turn) =>
      turn.plans.map((event) => ({ event, sessionId: turn.sessionId, tool: turn.tool })),
    );
    const byId = new Map(captured.map((row) => [row.event.id, row]));
    check(
      'embedded plans retain display identities and justified capture aliases',
      captured.every((row) => {
        const represented = plans.find(
          (plan) =>
            plan.itemId === row.event.id ||
            plan.id === row.event.id ||
            plan.aliases.includes(row.event.id),
        );
        if (!represented) return false;
        if (represented.itemId === row.event.id || represented.id === row.event.id)
          return true;
        const canonical = byId.get(represented.itemId ?? represented.id);
        return Boolean(
          canonical &&
          row.event.sourceId &&
          row.event.sourceId === canonical.event.sourceId &&
          row.sessionId === canonical.sessionId &&
          row.tool === canonical.tool &&
          row.event.actorSlug === canonical.event.actorSlug,
        );
      }),
    );
  }
  const allTurns = [...data.turns, ...(data.unattributedWork ?? [])];
  const usage = {
    ...expectedUsage(data.turns),
    ...(!data.turns.some((turn) => turn.recap) && data.summary.stats
      ? data.summary.stats
      : {}),
  };
  check(
    'embedded usage distinguishes captured zero from unavailable statistics',
    index.usage !== undefined &&
      Object.entries(usage).every(([key, value]) =>
        same((index.usage as any)[key], value),
      ),
  );
  check(
    'embedded report overview retains capture context',
    index.redactionCount === data.redactionCount &&
      same(index.toolTimeline, data.toolTimeline) &&
      same(index.coverage, data.coverage),
  );
  if (index.sessions)
    check(
      'embedded sessions preserve conversation membership and usage',
      new Set(allTurns.map((turn) => turn.sessionId)).size === index.sessions.length &&
        index.sessions.every((session) => {
          const turns = data.turns.filter((turn) => turn.sessionId === session.id);
          const sourceIds = data.turns
            .filter((turn) => turn.sessionId === session.id)
            .map((turn) => turn.prompt.id)
            .sort();
          const stats = expectedUsage(turns);
          return (
            same([...session.turnIds].sort(), sourceIds) &&
            Object.entries(stats).every(([key, value]) =>
              same((session.stats as any)[key], value),
            )
          );
        }),
    );
  return { checks, decoded, index };
}
