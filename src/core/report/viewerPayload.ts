import type { Event, ReportData, Turn } from '../../types.ts';
import {
  longTurnThreshold,
  modelLabel,
  summarizeToolRun,
  toolLabel,
  turnModels,
  turnSignals,
  turnTimeline,
} from './data.ts';
import { projectReport } from './projection.ts';
import { resolveAiMode, type ReportRenderOptions } from './markdown.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG, splitPlanText } from '../plans.ts';
import { isNonBlockingDecisionText } from '../decisions.ts';
import { ViewerTextStoreBuilder } from './viewerCodec.ts';
import type {
  ViewerIndex,
  ViewerItem,
  ViewerPlan,
  ViewerSession,
  ViewerTurn,
  ViewerUsageStats,
} from './viewerTypes.ts';

const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 180);
const nativeKey = (id: string) =>
  id.replace(/:(?:use|result|snapshot|approved|text:\d+)$/, '');

/** Missing recap fields stay unknown; a captured zero is a reported measurement. */
export function buildViewerUsage(
  turns: Pick<Turn, 'recap'>[],
  fallback?: ReportData['summary']['stats'],
): ViewerUsageStats {
  const fields = [
    'durationMs',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ] as const;
  const metricCounts = Object.fromEntries(
    fields.map((key) => [key, 0]),
  ) as ViewerUsageStats['metricCounts'];
  const totals = Object.fromEntries(fields.map((key) => [key, 0])) as Record<
    (typeof fields)[number],
    number
  >;
  const recaps = turns.flatMap((turn) => (turn.recap ? [turn.recap] : []));
  const reported = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const recap of recaps)
    for (const key of fields)
      if (reported(recap[key])) {
        metricCounts[key]++;
        totals[key] += recap[key]!;
      }
  const value = (
    key: (typeof fields)[number],
    aggregate: keyof NonNullable<typeof fallback>,
  ) =>
    metricCounts[key]
      ? totals[key]
      : !recaps.length && reported(fallback?.[aggregate])
        ? fallback![aggregate]
        : null;
  return {
    totalDurationMs: value('durationMs', 'totalDurationMs'),
    totalInputTokens: value('inputTokens', 'totalInputTokens'),
    totalOutputTokens: value('outputTokens', 'totalOutputTokens'),
    totalCacheReadTokens: value('cacheReadTokens', 'totalCacheReadTokens'),
    totalCacheCreationTokens: value('cacheCreationTokens', 'totalCacheCreationTokens'),
    turnCount: turns.length,
    recapCount: recaps.length,
    durationCount: metricCounts.durationMs,
    tokenCount: recaps.filter((recap) =>
      fields.slice(1).some((key) => reported(recap[key])),
    ).length,
    metricCounts,
  };
}

function nativeText(event: Record<string, unknown>): string {
  if (typeof event.text === 'string') return event.text;
  if (typeof event.plan === 'string') return event.plan;
  const channels: string[] = [];
  if (typeof event.stdout === 'string' && event.stdout) channels.push(event.stdout);
  if (typeof event.stderr === 'string' && event.stderr)
    channels.push('Stderr:\n' + event.stderr);
  if (typeof event.exitCode === 'number') channels.push('Exit code: ' + event.exitCode);
  if (channels.length) return channels.join('\n\n');
  if (typeof event.content === 'string') return event.content;
  return JSON.stringify(event.content ?? event.input ?? event, null, 2);
}

/** Build an index of identities and bounded text references, never highlighted DOM. */
export function buildViewerPayload(data: ReportData, options?: ReportRenderOptions) {
  const projected = projectReport(data);
  const view = projected.data;
  const mode = resolveAiMode(options);
  const texts = new ViewerTextStoreBuilder();
  const items: Record<string, ViewerItem> = Object.create(null);
  const aliases = { ...projected.aliases };
  const owners = new Map<string, ViewerTurn>();
  const planCandidates: Array<{ event: Event; turn: ViewerTurn; item: ViewerItem }> = [];
  const longTurnMs = longTurnThreshold(view.turns);
  const addText = (text: string | undefined) =>
    text === undefined ? undefined : texts.add(text);

  function buildTurn(turn: Turn, unlinked = false): ViewerTurn {
    const result: ViewerTurn = {
      id: turn.prompt.id,
      sessionId: turn.sessionId,
      sourceId: turn.prompt.sourceId,
      actorSlug: turn.actorSlug,
      ...(turn.recap
        ? {
            recap: Object.fromEntries(
              Object.entries(turn.recap).filter(([key]) => key !== 'text'),
            ) as Omit<Event, 'text'>,
          }
        : {}),
      ...(turn.recap?.text && mode !== 'off'
        ? { recapRef: texts.add(turn.recap.text) }
        : {}),
      signals: turnSignals(turn),
      toolSummary: summarizeToolRun(turn.toolCalls),
      longTurn: longTurnMs !== undefined && (turn.recap?.durationMs ?? 0) >= longTurnMs,
      timestamp: turn.prompt.timestamp,
      preview: unlinked
        ? 'Captured work without a linked prompt'
        : preview(turn.prompt.text),
      ...(!unlinked ? { promptRef: texts.add(turn.prompt.text) } : {}),
      tool: toolLabel(turn.tool),
      models: turnModels(turn).map(modelLabel),
      author:
        view.contributors.find((c) => c.slug === turn.actorSlug)?.name ?? turn.actorSlug,
      itemIds: [],
      files: [],
      ...(unlinked ? { unlinked: true } : {}),
    };
    const nativeItems = new Map<string, ViewerItem>();
    const nativeVariants = new Map<string, string>();
    const bodies = new Map<string, string>();
    const put = (item: ViewerItem, body?: string) => {
      // IDs are stable report/record identities. Only an actual alias may merge.
      if (items[item.id])
        item.id = `${turn.prompt.id}:${item.id}:${result.itemIds.length}`;
      item.turnId = result.id;
      items[item.id] = item;
      result.itemIds.push(item.id);
      owners.set(item.id, result);
      if (body !== undefined) bodies.set(item.id, body);
      if (item.sourceId && !nativeItems.has(nativeKey(item.sourceId)))
        nativeItems.set(nativeKey(item.sourceId), item);
      if (item.path && !result.files.includes(item.path)) result.files.push(item.path);
      return item;
    };
    const eventItem = (event: Event, kind: ViewerItem['kind'], title: string) => {
      const plan = kind === 'plan' ? splitPlanText(event.text) : undefined;
      const item = put(
        {
          id: event.id,
          kind,
          title,
          preview: preview(event.text),
          timestamp: event.timestamp,
          sourceId: event.sourceId,
          isError: event.isError,
          tags: event.tags,
          ...(kind === 'decision'
            ? { nonBlocking: isNonBlockingDecisionText(event.text) }
            : {}),
          ...(plan
            ? {
                planStatus: event.tags?.includes(PLAN_APPROVED_TAG)
                  ? 'approved'
                  : event.tags?.includes(PLAN_REVISED_TAG)
                    ? 'revised'
                    : 'none',
                feedback: plan.feedback,
                ...(plan.plan !== event.text ? { rawRefs: [texts.add(event.text)] } : {}),
              }
            : {}),
        },
        plan?.plan ?? event.text,
      );
      if (plan) planCandidates.push({ event, turn: result, item });
      return item;
    };
    for (const part of turnTimeline(turn)) {
      if (part.kind === 'ai') {
        if (mode !== 'off') eventItem(part.event, 'ai', 'AI response');
      } else if (part.kind === 'tool_call') {
        eventItem(part.event, 'tool', part.event.toolName ?? 'Tool');
      } else if (part.kind === 'decision') {
        eventItem(part.event, 'decision', 'Decision');
      } else if (part.kind === 'plan') {
        eventItem(part.event, 'plan', 'Plan');
      } else {
        const change = part.change;
        const revisions = change.revisions?.length
          ? change.revisions
          : [
              {
                recordId: `revision:${turn.prompt.id}:${result.itemIds.length}`,
                timestamp: change.timestamp,
                diff: change.diff,
                sha256: undefined,
              },
            ];
        for (const revision of revisions) {
          put(
            {
              id: revision.recordId,
              recordId: revision.recordId,
              kind: 'revision',
              title: change.path,
              path: change.path,
              preview: `${change.path} · captured revision`,
              timestamp: revision.timestamp,
              sha256: revision.sha256,
              linkPath: change.linkPath,
              capturedOnly: change.capturedOnly,
            },
            revision.diff,
          );
        }
      }
    }
    // Keep native input/result fields that the human display projection omits.
    // Link them to the same call when possible, rather than adding another call.
    for (const event of turn.events ?? []) {
      if (event.type === 'assistant_text' && mode === 'off') continue;
      if (
        event.type === 'user_text' &&
        event.origin !== 'agent' &&
        event.sourceId === (turn.prompt.sourceId ?? turn.prompt.id) &&
        event.text === turn.prompt.text
      )
        continue;
      const raw = event as unknown as Record<string, unknown>;
      const source =
        event.sourceId ?? (typeof raw.toolUseId === 'string' ? raw.toolUseId : undefined);
      const existing = source ? nativeItems.get(nativeKey(source)) : undefined;
      const variantKey = `${event.type}:${source ?? event.sequence}`;
      const semantic = JSON.stringify(
        Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'sequence')),
      );
      const conflicting =
        nativeVariants.has(variantKey) && nativeVariants.get(variantKey) !== semantic;
      nativeVariants.set(variantKey, semantic);
      if (existing) {
        (existing.nativeEvents ??= []).push({
          sourceId: event.sourceId,
          type: event.type,
          sequence: event.sequence,
          timestamp: event.timestamp,
        });
        if (
          !conflicting &&
          existing.kind === 'plan' &&
          event.type.startsWith('plan_') &&
          (typeof raw.plan !== 'string' ||
            splitPlanText(bodies.get(existing.id) ?? '').plan === raw.plan)
        ) {
          (existing.rawRefs ??= []).push(texts.add(JSON.stringify(event, null, 2)));
          aliases[`native:${turn.prompt.id}:${event.sequence}`] = existing.id;
          continue;
        }
        if (
          !conflicting &&
          existing.kind === 'tool' &&
          (event.type === 'tool_use' || event.type === 'tool_result')
        ) {
          const previous = bodies.get(existing.id) ?? '';
          const rawRef = texts.add(JSON.stringify(event, null, 2));
          if (!(existing.rawRefs ??= []).includes(rawRef)) existing.rawRefs.push(rawRef);
          if (event.type === 'tool_result') {
            const output = nativeText(raw);
            if (output && !previous.includes(output))
              existing.resultRef = texts.add(output);
          }
          if (
            raw.isError === true ||
            (typeof raw.exitCode === 'number' && raw.exitCode !== 0)
          )
            existing.isError = true;
          aliases[`native:${turn.prompt.id}:${event.sequence}`] = existing.id;
          continue;
        }
        const displayed = bodies.get(existing.id);
        if (!conflicting && typeof raw.text === 'string' && displayed === raw.text) {
          (existing.rawRefs ??= []).push(texts.add(JSON.stringify(event, null, 2)));
          aliases[`native:${turn.prompt.id}:${event.sequence}`] = existing.id;
          continue;
        }
        if (!conflicting && typeof raw.plan === 'string' && displayed === raw.plan)
          continue;
      }
      const text = nativeText(raw);
      const kind: ViewerItem['kind'] =
        event.type === 'assistant_text'
          ? 'ai'
          : event.type === 'tool_use' || event.type === 'tool_result'
            ? 'tool'
            : event.type.startsWith('plan_')
              ? 'plan'
              : 'note';
      put(
        {
          id: `native:${turn.prompt.id}:${event.sequence}`,
          kind,
          title:
            typeof raw.toolName === 'string'
              ? raw.toolName
              : event.type === 'user_text' && event.origin === 'agent'
                ? 'Agent input'
                : event.type.replace(/_/g, ' '),
          preview: preview(text),
          timestamp: event.timestamp ?? result.timestamp,
          sourceId: source,
          isError: raw.isError === true,
          rawRefs: [texts.add(JSON.stringify(event, null, 2))],
          ...(event.type.startsWith('plan_') ||
          (event.type === 'user_text' && event.origin !== 'agent' && !unlinked)
            ? { nativeOnly: true }
            : {}),
        },
        text,
      );
    }
    if (turn.recap?.text && mode !== 'off') eventItem(turn.recap, 'note', 'Recap');
    for (const [id, body] of bodies) items[id]!.textRef = texts.add(body);
    const tools = result.itemIds
      .map((id) => items[id]!)
      .filter((item) => item.kind === 'tool' && !item.nativeOnly);
    result.toolSummary = summarizeToolRun(
      tools.map((item) => ({
        id: item.id,
        type: 'tool_call',
        text: '',
        timestamp: item.timestamp,
        actorSlug: turn.actorSlug,
        toolName: item.title,
        isError: item.isError,
      })),
    );
    result.signals!.failedTools = result.toolSummary.failed;
    result.itemIds.sort((a, b) => items[a]!.timestamp.localeCompare(items[b]!.timestamp));
    return result;
  }
  const turns = view.turns.map((turn) => buildTurn(turn));
  const unlinked = (view.unattributedWork ?? []).map((work, index) =>
    buildTurn(
      {
        ...work,
        prompt: {
          id: `unlinked:${work.sessionId}:${index}`,
          type: 'prompt',
          text: '',
          timestamp:
            work.events[0]?.timestamp ??
            work.codeChanges[0]?.timestamp ??
            view.generatedAt,
          actorSlug: work.actorSlug,
        },
      },
      true,
    ),
  );
  // The cross-cutting index is based on captured display plans, not provider
  // snapshots/approval bookkeeping that may describe the same proposal again.
  const displayAliases = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(projected.aliases)) {
    const values = displayAliases.get(canonical) ?? [];
    values.push(alias);
    displayAliases.set(canonical, values);
  }
  const planTitle = (text: string) =>
    preview(
      (text.split('\n').find((line) => line.trim()) ?? 'Plan').replace(/^#+\s*/, ''),
    );
  const planKey = (
    tool: string,
    actor: string,
    timestamp: string,
    status: string,
    text: string,
    feedback?: string,
  ) => JSON.stringify([tool, actor, timestamp, status, text, feedback ?? null]);
  const represented = new Map<string, number>();
  const plans: ViewerPlan[] = planCandidates.map(({ event, turn, item }) => {
    const clean = splitPlanText(event.text);
    const status = item.planStatus ?? 'none';
    const sourceAliases = displayAliases.get(item.id) ?? [];
    const key = planKey(
      turn.tool,
      event.actorSlug,
      event.timestamp,
      status,
      clean.plan,
      clean.feedback,
    );
    represented.set(key, (represented.get(key) ?? 0) + 1 + sourceAliases.length);
    item.title = planTitle(clean.plan);
    return {
      ...item,
      kind: 'plan',
      status,
      title: item.title,
      preview: preview(clean.plan),
      textRef: texts.add(clean.plan),
      feedback: clean.feedback,
      tool: turn.tool,
      author: turn.author,
      actorSlug: event.actorSlug,
      planPath: event.planPath,
      turnId: turn.id,
      sessionId: turn.sessionId,
      itemId: item.id,
      capturedRecords: 1 + sourceAliases.length,
      aliases: sourceAliases,
    };
  });
  for (const [ordinal, plan] of view.plans.entries()) {
    const key = planKey(
      toolLabel(plan.tool),
      plan.actorSlug,
      plan.timestamp,
      plan.status,
      plan.text,
      plan.feedback,
    );
    const remaining = represented.get(key) ?? 0;
    if (remaining) {
      represented.set(key, remaining - 1);
      continue;
    }
    // Older JSON has no identity on a top-level-only plan. Preserve every such
    // entry with a stable report-local identity; equal text is not dedupe proof.
    plans.push({
      id: `report-plan:${ordinal}`,
      kind: 'plan',
      status: plan.status,
      planStatus: plan.status,
      title: planTitle(plan.text),
      preview: preview(plan.text),
      timestamp: plan.timestamp,
      textRef: texts.add(plan.text),
      feedback: plan.feedback,
      tool: toolLabel(plan.tool),
      actorSlug: plan.actorSlug,
      author:
        view.contributors.find((person) => person.slug === plan.actorSlug)?.name ??
        plan.actorSlug,
      planPath: plan.planPath,
      capturedRecords: 1,
      aliases: [],
    });
  }
  plans.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id),
  );
  for (const observation of view.fileObservations ?? [])
    if (observation.editId && items[observation.editId])
      (items[observation.editId]!.evidence ??= []).push({ ...observation });
  const observations = (view.fileObservations ?? [])
    .filter((observation) => !observation.editId)
    .map((observation): ViewerItem => {
      const item: ViewerItem = {
        id: observation.recordId,
        kind: 'observation',
        title: observation.path,
        path: observation.path,
        timestamp: observation.observedAt,
        preview:
          observation.basis === 'workspace-delta'
            ? 'Observed workspace diff · author unverified'
            : 'Observed file state',
        sha256: observation.sha256,
        basis: observation.basis,
        toolCallId: observation.toolCallId,
        toolOutcome: observation.toolOutcome,
        textRef: addText(
          observation.diff ??
            (observation.sha256 ? `SHA-256: ${observation.sha256}` : 'File observation'),
        ),
      };
      items[item.id] = item;
      const target = observation.toolCallId
        ? owners.get(aliases[observation.toolCallId] ?? observation.toolCallId)
        : undefined;
      if (target) {
        item.turnId = target.id;
        target.itemIds.push(item.id);
        if (!target.files.includes(observation.path)) target.files.push(observation.path);
      }
      return item;
    });
  const assigned = new Set<string>();
  for (const turn of [...turns, ...unlinked]) {
    const rows = turn.itemIds.map((id) => items[id]!);
    turn.itemCount = rows.length;
    turn.revisionCount = rows.filter((item) => item.kind === 'revision').length;
    turn.itemsRef = texts.add(JSON.stringify(rows));
    for (const id of turn.itemIds) assigned.add(id);
    turn.itemIds = [];
  }
  const standalone: Record<string, ViewerItem> = Object.create(null);
  for (const item of observations) if (!assigned.has(item.id)) standalone[item.id] = item;
  for (const plan of plans) if (!plan.turnId) standalone[plan.id] = plan;
  const sourceTurns = new Map(
    [...view.turns, ...(view.unattributedWork ?? [])].map((turn) => [
      turn.sessionId,
      [] as Pick<Turn, 'recap'>[],
    ]),
  );
  for (const turn of view.turns) sourceTurns.get(turn.sessionId)!.push(turn);
  const allTurns = [...turns, ...unlinked];
  const sessions: ViewerSession[] = [...new Set(allTurns.map((turn) => turn.sessionId))]
    .map((id) => {
      const rows = allTurns.filter((turn) => turn.sessionId === id);
      const linked = rows.filter((turn) => !turn.unlinked);
      const times = rows.flatMap((turn) => [
        turn.timestamp,
        ...(turn.recap?.timestamp ? [turn.recap.timestamp] : []),
      ]);
      for (const [itemId, owner] of owners)
        if (owner.sessionId === id) times.push(items[itemId]!.timestamp);
      times.sort();
      const first = linked[0] ?? rows[0]!;
      return {
        id,
        label: `${first.tool} · ${(times[0] ?? '').slice(0, 10)} · ${first.preview.slice(0, 90)}`,
        from: times[0] ?? view.generatedAt,
        to: times[times.length - 1] ?? view.generatedAt,
        tool: [...new Set(rows.map((turn) => turn.tool))].join(', '),
        authors: [...new Set(rows.map((turn) => turn.author))],
        models: [...new Set(rows.flatMap((turn) => turn.models))],
        turnIds: linked.map((turn) => turn.id),
        unlinkedIds: rows.filter((turn) => turn.unlinked).map((turn) => turn.id),
        promptCount: linked.length,
        revisionCount: rows.reduce((count, turn) => count + (turn.revisionCount ?? 0), 0),
        fileCount: new Set(
          Object.values(items)
            .filter(
              (item) => item.kind === 'revision' && owners.get(item.id)?.sessionId === id,
            )
            .map((item) => item.path),
        ).size,
        planCount: plans.filter((plan) => plan.sessionId === id).length,
        decisionCount: rows.reduce(
          (count, turn) => count + (turn.signals?.decisions ?? 0),
          0,
        ),
        failedTools: rows.reduce(
          (count, turn) => count + (turn.toolSummary?.failed ?? 0),
          0,
        ),
        stats: buildViewerUsage(sourceTurns.get(id) ?? []),
      };
    })
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) || left.id.localeCompare(right.id),
    );
  const encoded = texts.finish();
  const index: ViewerIndex = {
    viewerPayloadVersion: 1,
    title: view.displayName,
    generatedAt: view.generatedAt,
    aiMode: mode,
    summary: view.summary,
    coverage: view.coverage,
    contributors: view.contributors,
    tools: view.tools.map((tool) => ({ ...tool, label: toolLabel(tool.tool) })),
    models: view.models.map((model) => ({ ...model, label: modelLabel(model.model) })),
    authorship: view.authorship,
    plans,
    sessions,
    usage: buildViewerUsage(view.turns, view.summary.stats),
    toolTimeline: view.toolTimeline,
    redactionCount: view.redactionCount,
    scope: view.scope,
    uniqueFileCount: new Set(
      Object.values(items)
        .filter((item) => item.kind === 'revision')
        .map((item) => item.path),
    ).size,
    turns,
    unlinked,
    observations,
    items: standalone,
    aliases,
    textStore: encoded.store,
  };
  return { index, blocks: encoded.blocks, projection: projected };
}
