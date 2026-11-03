import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { shellWritePaths } from '@showtail/agent-traces/hooks/shellWrites';
import type { Artifact, ConversationEvent, Event, ReportData } from '../types.ts';
import { dataPath } from './dataHome.ts';
import {
  HistoryStore,
  digest,
  isUsableWorkspacePath,
  type HistorySelection,
} from './history.ts';
import { auditHistory } from './historyAudit.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from './plans.ts';
import {
  buildAuthorshipStatement,
  buildModelUsage,
  buildReportPlans,
  buildSessionStats,
  buildToolBlocks,
  buildToolUsage,
  buildTurns,
} from './report/data.ts';
import { renderHtml } from './report/html.ts';
import { renderMarkdown, type ReportRenderOptions } from './report/markdown.ts';
import { scanResidual } from './sanitize.ts';
import { sanitizeReportData } from './shareReport.ts';
import { buildManifest, verifySubmission } from './submission.ts';
import { isSyntheticPrompt } from './syntheticPrompt.ts';

export interface HistoryReportOptions extends ReportRenderOptions {
  title?: string;
  author?: string;
}

/** Build the existing portable report model directly from the central store. */
export function buildHistoryReport(
  store: HistoryStore,
  selection: HistorySelection,
  options: HistoryReportOptions = {},
): ReportData {
  let records = store.records(selection);
  let observationRecords = store
    .records(selection, { includeSuperseded: true })
    .filter(
      (r) =>
        r.file &&
        ((r.tags?.includes('observed-file-state') && r.sha256) ||
          r.tags?.includes('observed-workspace-delta')),
    );
  // A selected reply/edit keeps its opening prompt and neighboring captured context.
  if (selection.since || selection.until) {
    const groups = new Set(records.map((r) => r.turnId ?? r.id));
    records = store.records({ kind: 'all' }).filter((r) => groups.has(r.turnId ?? r.id));
  }
  // Observing a file after a tool attempt is not evidence of an applied revision.
  records = records.filter(
    (r) =>
      !r.tags?.includes('observed-file-state') &&
      !r.tags?.includes('observed-workspace-delta'),
  );
  // Older capture rows remain immutable; report projection also classifies them
  // before an explicit historical repair has been applied.
  const sessions = new Map(store.sessions().map((s) => [s.id, s]));
  const shellInputs = new Map<string, { command: string; cwd?: string | null }>();
  for (const record of records) {
    const event = record.conversationEvent;
    const input = event?.input as { command?: unknown; cwd?: unknown } | undefined;
    if (
      event?.type === 'tool_use' &&
      ['Bash', 'PowerShell'].includes(event.toolName ?? '') &&
      event.toolUseId &&
      typeof input?.command === 'string'
    )
      shellInputs.set(`${record.sessionId}\0${event.toolUseId}`, {
        command: input.command,
        cwd:
          typeof input.cwd === 'string'
            ? input.cwd
            : ((record.turnId ? store.record(record.turnId)?.context?.cwd : undefined) ??
              sessions.get(record.sessionId)?.cwd),
      });
  }
  const unverifiedEditIds = new Set(
    observationRecords
      .filter((record) => record.tags?.includes('observed-workspace-delta'))
      .flatMap((record) => (record.supersedesId ? [record.supersedesId] : [])),
  );
  const pathKey = (path: string) =>
    process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  const previous = new Map<string, string>();
  const redirects = new Map<string, string>();
  records = records.map((r) => {
    const shellId =
      r.kind === 'edit' && sessions.get(r.sessionId)?.tool === 'claude-code'
        ? /^(.*):edits#/.exec(r.sourceId ?? '')?.[1]
        : undefined;
    const call = shellId ? shellInputs.get(`${r.sessionId}\0${shellId}`) : undefined;
    if (
      call &&
      r.file &&
      !shellWritePaths(call.command).some((path) => {
        const absolute = isAbsolute(path)
          ? path
          : call.cwd
            ? resolve(call.cwd, path)
            : undefined;
        return absolute && pathKey(absolute) === pathKey(r.file!);
      })
    ) {
      const projected = {
        ...r,
        kind: 'audit' as const,
        sha256: undefined,
        duplicateOf: undefined,
        tags: [...(r.tags ?? []), 'observed-workspace-delta'],
        provenance: { source: 'native-workspace-delta', id: shellId! },
      };
      observationRecords.push(projected);
      unverifiedEditIds.add(r.id);
      return projected;
    }
    if (sessions.get(r.sessionId)?.parentNativeSessionId) {
      if (r.kind === 'prompt')
        return {
          ...r,
          kind: 'tool_call' as const,
          origin: 'agent' as const,
          toolName: 'Agent input',
        };
      if (r.conversationEvent?.type === 'user_text')
        return {
          ...r,
          conversationEvent: { ...r.conversationEvent, origin: 'agent' as const },
        };
    }
    if (r.kind !== 'prompt') return { ...r };
    if (r.origin !== 'human' && isSyntheticPrompt(r.text ?? '')) {
      const turn = previous.get(r.sessionId);
      if (turn) redirects.set(r.turnId ?? r.id, turn);
      return {
        ...r,
        kind: 'tool_call' as const,
        origin: 'harness' as const,
        turnId: turn,
      };
    }
    previous.set(r.sessionId, r.turnId ?? r.id);
    return { ...r };
  });
  for (const r of records)
    if (r.turnId && redirects.has(r.turnId)) r.turnId = redirects.get(r.turnId);
  observationRecords = observationRecords.filter(
    (record) => !record.duplicateOf || !unverifiedEditIds.has(record.duplicateOf),
  );
  if (options.author) {
    records = records.filter(
      (r) => sessions.get(r.sessionId)?.authorId === options.author,
    );
    observationRecords = observationRecords.filter(
      (r) => sessions.get(r.sessionId)?.authorId === options.author,
    );
  }
  const project =
    selection.kind === 'project' ? store.resolveProject(selection.projectId) : undefined;
  // Reports use captured names; they never probe old disks, network shares, or source files.
  const labelKey = (path: string) =>
    process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  const roots = store.projects().flatMap((view) =>
    view.roots.map((root) => ({
      root,
      key: labelKey(root),
      name: view.displayName,
      selected: view.projectId === project?.projectId,
    })),
  );
  roots.sort(
    (a, b) => Number(b.selected) - Number(a.selected) || b.key.length - a.key.length,
  );
  const files = [
    ...new Set(
      [...records, ...observationRecords].flatMap((r) => (r.file ? [r.file] : [])),
    ),
  ];
  const info = new Map(
    files.map((file) => {
      if (!isUsableWorkspacePath(file))
        return [file, { label: 'Unresolved provider file', name: 'Files' }] as const;
      const key = labelKey(file);
      const root = roots.find(
        (r) => key === r.key || key.startsWith(r.key.endsWith(sep) ? r.key : r.key + sep),
      );
      return [
        file,
        {
          label: root ? relative(root.root, file).replace(/\\/g, '/') : basename(file),
          name: root?.name ?? 'Files',
        },
      ] as const;
    }),
  );
  const counts = new Map<string, number>();
  for (const value of info.values())
    counts.set(value.label, (counts.get(value.label) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const file of files) {
    const value = info.get(file)!;
    labels.set(
      file,
      counts.get(value.label)! > 1
        ? `${value.name}-${digest(file).slice(0, 8)}/${value.label}`
        : value.label,
    );
  }
  const fileLabel = (file: string): string => labels.get(file) ?? basename(file);
  const events: { event: Event; sessionId: string; actorSlug: string }[] = [];
  const artifacts: Artifact[] = [];
  const structured: {
    event: ConversationEvent;
    sessionId: string;
    actorSlug: string;
    turnId?: string;
    tool: string;
  }[] = [];
  const diffs = new Map<string, string>();
  let unresolvedIndex = 0;
  for (const record of records) {
    const session = sessions.get(record.sessionId)!;
    const actorSlug = session.authorId;
    if (record.kind === 'edit') {
      const ref = record.diff !== undefined ? digest(record.diff) : undefined;
      if (ref) diffs.set(ref, record.diff!);
      artifacts.push({
        id: record.id,
        path:
          record.unresolvedPath || (record.file && !isUsableWorkspacePath(record.file))
            ? `Unresolved provider file ${++unresolvedIndex}`
            : fileLabel(record.file ?? 'unknown-file'),
        sha256: record.sha256 ?? '',
        timestamp: record.ts,
        sessionId: record.sessionId,
        actorSlug,
        tool: session.tool,
        turnId: record.turnId,
        diffHash: ref,
        diffLines: record.diff?.split('\n').length,
      });
    } else if (record.kind === 'conversation_event' && record.conversationEvent) {
      structured.push({
        event: record.conversationEvent,
        sessionId: record.sessionId,
        actorSlug,
        turnId: record.turnId,
        tool: session.tool,
      });
    } else if (record.kind !== 'audit') {
      const {
        id,
        kind,
        text,
        ts,
        sourceId,
        turnId,
        model,
        toolName,
        isError,
        gitCommit,
        gitBranch,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      } = record;
      const event: Event = {
        id,
        type: kind as Event['type'],
        origin: record.origin,
        text: text ?? '',
        timestamp: ts,
        actorSlug,
        sourceId,
        turnId,
        tool: session.tool,
        model,
        toolName,
        isError,
        gitCommit,
        gitBranch,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        tags:
          record.tags ??
          (record.approved === true
            ? [PLAN_APPROVED_TAG]
            : record.approved === false
              ? [PLAN_REVISED_TAG]
              : undefined),
      };
      if (kind === 'prompt' && record.turnId && record.turnId !== id)
        event.id = record.turnId;
      events.push({ event, sessionId: record.sessionId, actorSlug });
    }
  }
  // Path-only and assistant-only providers must still produce a reviewable report.
  const prompts = new Set(
    events.filter((r) => r.event.type === 'prompt').map((r) => r.event.id),
  );
  for (const record of records) {
    if (record.kind === 'audit') continue;
    const group = record.turnId ?? `unanchored:${record.sessionId}`;
    if (!record.turnId) {
      const event = events.find((e) => e.event.id === record.id);
      if (event) event.event.turnId = group;
      const artifact = artifacts.find((a) => a.id === record.id);
      if (artifact) artifact.turnId = group;
      for (const item of structured)
        if (item.sessionId === record.sessionId && !item.turnId) item.turnId = group;
    }
    if (prompts.has(group)) continue;
    const session = sessions.get(record.sessionId)!;
    events.push({
      event: {
        id: group,
        type: 'prompt',
        text: 'Captured work without a linked prompt',
        timestamp: record.ts,
        actorSlug: session.authorId,
        tool: session.tool,
        tags: ['unattributed-work'],
      },
      sessionId: session.id,
      actorSlug: session.authorId,
    });
    prompts.add(group);
  }
  const built = buildTurns(events, artifacts, null, structured, (ref) => diffs.get(ref));
  const turns = built.filter((t) => !t.prompt.tags?.includes('unattributed-work'));
  const unattributedWork = built
    .filter((t) => t.prompt.tags?.includes('unattributed-work'))
    .map(({ prompt, ...work }) => ({
      ...work,
      events: work.events.filter(
        (e) =>
          !(e.type === 'user_text' && e.sourceId === prompt.id && e.text === prompt.text),
      ),
    }));
  for (const turn of [...turns, ...unattributedWork])
    for (const change of turn.codeChanges) change.capturedOnly = true;
  const actualEvents = events.filter((e) => !e.event.tags?.includes('unattributed-work'));
  const allEvents = actualEvents
    .map((e) => e.event)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const authorIds = [
    ...new Set(
      records
        .filter((r) => r.kind !== 'audit')
        .map((r) => sessions.get(r.sessionId)!.authorId),
    ),
  ];
  const contributors = authorIds.map((slug) => ({
    slug,
    name: store.authorName(slug),
    events: actualEvents.filter((e) => e.actorSlug === slug).length,
    artifacts: artifacts.filter((a) => a.actorSlug === slug).length,
  }));
  const displayName =
    options.title ??
    project?.displayName ??
    (selection.kind === 'sessions' ? 'Selected conversations' : 'My work');
  return {
    schemaVersion: 3,
    fileObservations: observationRecords.map((r) => ({
      recordId: r.id,
      ...(r.duplicateOf ? { editId: r.duplicateOf } : {}),
      ...(r.provenance?.source === 'native-shell-write-observation' ||
      r.provenance?.source === 'native-workspace-delta'
        ? {
            toolCallId: store.bySource(r.sessionId, r.provenance.id)?.id,
            basis: r.tags?.includes('observed-workspace-delta')
              ? ('workspace-delta' as const)
              : ('shell-write-attempt' as const),
            toolOutcome: r.tags?.includes('tool-outcome:failed')
              ? ('failed' as const)
              : ('succeeded' as const),
          }
        : { basis: 'native-edit' as const }),
      path: fileLabel(r.file!),
      ...(r.sha256 ? { sha256: r.sha256 } : {}),
      ...(r.diff ? { diff: r.diff } : {}),
      observedAt: r.ts,
    })),
    coverage: auditHistory(store, selection).coverage,
    unattributedWork,
    project: project?.displayName ?? null,
    displayName,
    generatedAt: new Date().toISOString(),
    scope: options.author
      ? { slug: options.author, name: store.authorName(options.author) }
      : null,
    summary: {
      sessions: new Set(records.filter((r) => r.kind !== 'audit').map((r) => r.sessionId))
        .size,
      events: actualEvents.length,
      artifacts: artifacts.length,
      fileGroups: [...turns, ...unattributedWork].reduce(
        (n, t) => n + t.codeChanges.length,
        0,
      ),
      decisions: allEvents.filter((e) => e.type === 'decision').length,
      plans: allEvents.filter((e) => e.type === 'plan').length,
      stats: buildSessionStats(turns),
    },
    contributors,
    tools: buildToolUsage(allEvents),
    models: buildModelUsage(allEvents),
    toolTimeline: buildToolBlocks(allEvents),
    turns,
    plans: buildReportPlans(allEvents),
    redactionCount: records.reduce((n, r) => n + r.redacted, 0),
    authorship: buildAuthorshipStatement(
      displayName,
      contributors,
      options.author ? store.authorName(options.author) : null,
    ),
  };
}

export function writeHistoryReport(
  store: HistoryStore,
  selection: HistorySelection,
  options: HistoryReportOptions = {},
): { reportPath: string; markdownPath: string; jsonPath: string; data: ReportData } {
  const data = buildHistoryReport(store, selection, options);
  const dir = dataPath('reports', randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reportPath = join(dir, 'report.html');
  const markdownPath = join(dir, 'report.md');
  const jsonPath = join(dir, 'report.json');
  writeFileSync(reportPath, renderHtml(data, options), { mode: 0o600 });
  writeFileSync(markdownPath, renderMarkdown(data, options), { mode: 0o600 });
  writeFileSync(jsonPath, JSON.stringify({ ...data, selection }, null, 2) + '\n', {
    mode: 0o600,
  });
  store.setMeta('lastReport', reportPath);
  return { reportPath, markdownPath, jsonPath, data };
}

export function exportHistory(
  store: HistoryStore,
  selection: HistorySelection,
  options: HistoryReportOptions = {},
): {
  exportId: string;
  dir: string;
  data: ReportData;
  manifest: ReturnType<typeof buildManifest>['manifest'];
} {
  const project =
    selection.kind === 'project' ? store.resolveProject(selection.projectId) : undefined;
  const result = sanitizeReportData(
    buildHistoryReport(store, selection, options),
    project?.projectRoot ?? undefined,
  );
  if (result.findings.length)
    throw new Error(
      'SUBMISSION_SCAN_BLOCKED: residual sensitive values found; no submission was written.',
    );
  const markdown = renderMarkdown(result.data, options);
  const html = renderHtml(result.data, options);
  if (
    scanResidual(markdown, { structural: true }).length ||
    scanResidual(html, { structural: true }).length
  )
    throw new Error(
      'SUBMISSION_SCAN_BLOCKED: rendered output failed the independent scan.',
    );
  const signed = buildManifest({
    html,
    markdown,
    scope: result.data.scope?.name ?? null,
    summary: { ...result.data.summary, turns: result.data.turns.length },
    withheld: { total: result.withheld, byLabel: result.byLabel },
    scanFindings: 0,
  });
  const exportId = `exp_${randomUUID()}`;
  const dir = dataPath('exports', exportId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries({
    'report.html': html,
    'report.md': markdown,
    'manifest.json': signed.manifestJson,
    'manifest.sig': signed.signature + '\n',
  }))
    writeFileSync(join(dir, name), content, { mode: 0o600 });
  const verified = verifySubmission(dir);
  if (!verified.ok)
    throw new Error('SUBMISSION_VERIFICATION_FAILED: ' + verified.problems.join(', '));
  store.setMeta('lastExport', dir);
  store.setMeta(`export:${exportId}:selection`, canonicalSelection(selection));
  return { exportId, dir, data: result.data, manifest: signed.manifest };
}
function canonicalSelection(selection: HistorySelection): string {
  return JSON.stringify(selection);
}
