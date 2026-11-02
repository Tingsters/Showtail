/** Audited derived corrections and explicit recovery from local provider history. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HistoryStore,
  canonical,
  containsPath,
  digest,
  historySettings,
  isUsableWorkspacePath,
  pathIdentity,
  workspaceRoot,
  repositoryIdentity,
  type HistoryRecord,
  type HistorySelection,
  type HistorySession,
} from './history.ts';
import { auditHistory } from './historyAudit.ts';
import { isSyntheticPrompt } from './syntheticPrompt.ts';
import { redact } from './redact.ts';
import { captureTranscript } from './historyCapture.ts';
import { migrationPlugins } from '../plugins/registry.ts';
import type { HookTranscript, MigrationTranscriptCandidate } from '../plugins/types.ts';

export interface RepairOptions {
  backfill?: boolean;
  authorMaps?: string[];
  includeTurns?: string[];
}
interface Overlay {
  previousPatch: string | null;
  id: string;
  patch: Partial<HistoryRecord>;
}
interface Binding {
  previousId?: string | null;
  sessionId: string;
  sourceId: string;
  recordId: string;
  ancestor: boolean;
}
interface Recovery {
  session: HistorySession;
  transcript: HookTranscript;
  fingerprint: string;
  sourceSize: number;
  sourceMtime: number;
  path: string;
  missing: number;
  ambiguous: number;
}
export interface RepairPlan {
  selection: HistorySelection;
  overlays: Overlay[];
  bindings: Binding[];
  authors: { source: string; target: string; name?: string }[];
  recoveries: Recovery[];
  includes: string[];
  memberships: { turnId: string; projectIds: string[] }[];
  warningCodes: string[];
  before: ReturnType<typeof auditHistory>;
}
const fileKey = (path: string) =>
  process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
const textKey = (s: string) =>
  redact(s, historySettings().redact).text.replace(/\s+/g, ' ').trim();

/** A worktree and its main checkout share this read-only Git identity. */
export const repositoryKey = repositoryIdentity;

export function backupHistory(store: HistoryStore): string {
  const dir = join(store.home, 'maintenance', 'repairs', randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'history-before.sqlite');
  // SQLite serializes a consistent snapshot, including committed WAL pages.
  writeFileSync(path, store.db.serialize(), { mode: 0o600 });
  return path;
}

export async function prepareRepair(
  store: HistoryStore,
  selection: HistorySelection,
  options: RepairOptions = {},
): Promise<RepairPlan> {
  const all = store.records();
  const byId = new Map(all.map((r) => [r.id, r]));
  const selected = store.records(selection);
  const scope = new Set(
    selected.filter((r) => r.kind !== 'audit').map((r) => r.sessionId),
  );
  const sessions = store.sessions();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const plan: RepairPlan = {
    selection,
    overlays: [],
    bindings: [],
    authors: [],
    recoveries: [],
    memberships: [],
    includes: options.includeTurns ?? [],
    warningCodes: [],
    before: auditHistory(store, selection),
  };
  plan.includes = plan.includes.filter(
    (id) => !selected.some((r) => (r.turnId ?? r.id) === id),
  );
  if (plan.includes.length && selection.kind !== 'project')
    throw new Error('INCLUDE_TURN_REQUIRES_PROJECT');
  for (const id of plan.includes)
    if (store.record(id)?.kind !== 'prompt') throw new Error('INCLUDE_TURN_NOT_A_PROMPT');
  for (const id of plan.includes) scope.add(store.record(id)!.sessionId);
  for (const value of options.authorMaps ?? []) {
    const split = value.indexOf('=');
    if (split < 1) throw new Error('AUTHOR_MAP_EXPECTED_SOURCE_EQUALS_TARGET');
    const source = value.slice(0, split),
      specified = value.slice(split + 1);
    const current = store.currentAuthor();
    const target = specified === 'current' ? current.id : specified;
    if (!store.query('SELECT 1 FROM authors WHERE id=?').get(source))
      throw new Error('AUTHOR_NOT_FOUND');
    if (
      specified !== 'current' &&
      !store.query('SELECT 1 FROM authors WHERE id=?').get(target)
    )
      throw new Error('AUTHOR_NOT_FOUND');
    if (store.effectiveAuthor(source) !== target)
      plan.authors.push({
        source,
        target,
        name: specified === 'current' ? current.name : undefined,
      });
  }
  const overlay = (id: string, patch: Partial<HistoryRecord>) => {
    const existing = byId.get(id);
    if (!existing) return;
    const changed = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) => canonical((existing as any)[key]) !== canonical(value),
      ),
    );
    if (!Object.keys(changed).length) return;
    const prior = plan.overlays.find((o) => o.id === id);
    if (prior) Object.assign(prior.patch, changed);
    else {
      const old = store.repairSchema
        ? (store.query('SELECT patch FROM record_overlays WHERE record_id=?').get(id) as {
            patch: string;
          } | null)
        : null;
      plan.overlays.push({
        previousPatch: old?.patch ?? null,
        id,
        patch: { ...(old ? JSON.parse(old.patch) : {}), ...changed },
      });
    }
  };
  // Old hooks admitted user-role harness envelopes. Keep their content as tooling
  // output and reconnect work only to a real prompt in the same native session.
  const previous = new Map<string, string>();
  const redirects = new Map<string, string>();
  for (const r of all) {
    if (r.kind !== 'prompt') continue;
    if (r.origin !== 'human' && isSyntheticPrompt(r.text ?? '')) {
      if (!scope.has(r.sessionId)) continue;
      const turn = previous.get(r.sessionId);
      overlay(r.id, {
        kind: 'tool_call',
        origin: 'harness',
        ...(turn ? { turnId: turn } : {}),
      });
      if (turn) redirects.set(r.turnId ?? r.id, turn);
    } else previous.set(r.sessionId, r.turnId ?? r.id);
  }
  for (const r of all)
    if (r.turnId && redirects.has(r.turnId))
      overlay(r.id, { turnId: redirects.get(r.turnId)! });
  restoreEnrichment(store, scope, overlay, plan.warningCodes, plan.bindings);
  plan.memberships = membershipChanges(
    store,
    scope,
    all.map((r) => ({ ...r, ...plan.overlays.find((o) => o.id === r.id)?.patch })),
  );
  if (!options.backfill) return finishPlan(store, plan);

  const selectedProject =
    selection.kind === 'project' ? store.resolveProject(selection.projectId) : undefined;
  const projectKeys = new Set(selectedProject?.roots.map(repositoryKey).filter(Boolean));
  const reads = new Map(store.sourceReads().map((r) => [r.sessionId, r]));
  const sourceIds = new Map<string, Set<string>>();
  const corroboratesAncestor = (record: HistoryRecord, sourceId: string) => {
    const path = sessionById.get(record.sessionId)?.transcriptPath;
    if (!path || !existsSync(path)) return false;
    if (!sourceIds.has(path)) {
      const ids = new Set<string>();
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'user' && frame.uuid) ids.add(frame.uuid);
          if (
            frame.payload?.type === 'item_completed' &&
            frame.payload.item?.type === 'UserMessage'
          )
            ids.add(frame.payload.item.id);
        } catch {
          /* malformed frame is not evidence */
        }
      }
      sourceIds.set(path, ids);
    }
    return sourceIds
      .get(path)!
      .has(sourceId.includes(':item:') ? sourceId.split(':item:').at(-1)! : sourceId);
  };
  const indexed = new Map<string, HistoryRecord[]>();
  for (const r of all) {
    if (!r.text || r.kind === 'audit') continue;
    const key = `${sessionById.get(r.sessionId)?.tool}\0${r.kind}\0${textKey(r.text)}`;
    const list = indexed.get(key) ?? [];
    list.push(r);
    indexed.set(key, list);
  }
  for (const plugin of migrationPlugins()) {
    let discovered: MigrationTranscriptCandidate[];
    try {
      discovered = plugin.migration.discover();
    } catch {
      plan.warningCodes.push('DISCOVERY_UNAVAILABLE');
      continue;
    }
    const candidates = new Map<
      string,
      { candidate: MigrationTranscriptCandidate; session?: HistorySession }
    >();
    for (const s of sessions.filter((s) => scope.has(s.id) && s.tool === plugin.id)) {
      const c = discovered.find((c) => c.providerSessionId === s.nativeSessionId);
      if (s.transcriptPath)
        candidates.set(s.nativeSessionId, {
          candidate: {
            path: s.transcriptPath,
            providerSessionId: s.nativeSessionId,
            mtimeMs: 0,
            cwd: s.cwd ?? undefined,
          },
          session: s,
        });
      else if (c) candidates.set(s.nativeSessionId, { candidate: c, session: s });
      else plan.warningCodes.push('SOURCE_UNAVAILABLE');
    }
    if (selectedProject)
      for (const c of discovered) {
        if (
          (c.cwd && selectedProject.roots.some((root) => containsPath(root, c.cwd!))) ||
          (c.cwd && projectKeys.size && projectKeys.has(repositoryKey(c.cwd)))
        ) {
          if (!candidates.has(c.providerSessionId))
            candidates.set(c.providerSessionId, {
              candidate: c,
              session: sessions.find(
                (s) => s.tool === plugin.id && s.nativeSessionId === c.providerSessionId,
              ),
            });
        }
      }
    for (const { candidate, session } of candidates.values()) {
      if (!existsSync(candidate.path)) {
        plan.warningCodes.push('SOURCE_UNAVAILABLE');
        continue;
      }
      const sourceStat = statSync(candidate.path);
      const fingerprint = digest(readFileSync(candidate.path, 'utf8'));
      if (
        session &&
        reads.get(session.id)?.fingerprint === fingerprint &&
        reads.get(session.id)?.readerVersion === 3 &&
        reads.get(session.id)?.sourceSize === sourceStat.size &&
        reads.get(session.id)?.sourceMtime === sourceStat.mtimeMs &&
        !reads.get(session.id)?.warningCodes?.includes('AMBIGUOUS_MATCH')
      )
        continue;
      let transcript: HookTranscript;
      try {
        transcript = await plugin.migration.read(
          candidate,
          candidate.cwd ?? selectedProject?.projectRoot ?? store.home,
        );
      } catch {
        plan.warningCodes.push('SOURCE_READ_FAILED');
        continue;
      }
      const target: HistorySession = session ?? {
        id: 'ses_' + digest(`${plugin.id}\0${candidate.providerSessionId}`).slice(0, 24),
        tool: plugin.id,
        nativeSessionId: candidate.providerSessionId,
        authorId: store.currentAuthor().id,
        cwd: candidate.cwd ?? null,
        workspacePaths: [],
        startedAt:
          transcript.messages.find((m) => m.timestamp)?.timestamp ??
          new Date().toISOString(),
        lastSeenAt: transcript.messages.at(-1)?.timestamp ?? new Date().toISOString(),
        transcriptPath: candidate.path,
      };
      let missing = 0,
        ambiguous = 0;
      const claimed = new Set<string>();
      const nativeEdits = new Map<string, HistoryRecord[]>();
      for (const r of all)
        if (r.kind === 'edit' && r.file && r.sessionId === target.id && r.sourceId) {
          const key = r.sourceId.split('#')[0] + '\0' + fileKey(r.file);
          const list = nativeEdits.get(key) ?? [];
          list.push(r);
          nativeEdits.set(key, list);
        }
      for (const message of transcript.messages) {
        if (message.role === 'edit')
          for (const edit of message.edits?.length
            ? message.edits
            : (message.files ?? []).map((file) => ({ file }))) {
            const file = resolve(candidate.cwd ?? target.cwd ?? store.home, edit.file);
            const sourceId = message.sourceId + '#' + file;
            if (session && store.bySource(session.id, sourceId)) continue;
            const key = message.sourceId + '\0' + fileKey(file);
            const matches = (nativeEdits.get(key) ?? []).filter(
              (r) =>
                !!message.timestamp &&
                Math.abs(
                  Date.parse(r.ts) - Date.parse(message.submittedAt ?? message.timestamp),
                ) <= 5000,
            );
            if (matches.length === 1)
              plan.bindings.push({
                sessionId: target.id,
                sourceId,
                recordId: matches[0]!.id,
                ancestor: false,
              });
          }

        if (
          message.role === 'user' &&
          message.origin !== 'human' &&
          isSyntheticPrompt(message.text)
        )
          continue;
        const kind = (
          {
            user: 'prompt',
            assistant: 'ai_output',
            decision: 'decision',
            plan: 'plan',
            recap: 'recap',
            tool_call: 'tool_call',
          } as Record<string, string>
        )[message.role];
        if (!kind) continue;
        const aliased = session
          ? store.bySource(session.id, message.sourceId)
          : undefined;
        if (
          aliased &&
          aliased.kind === kind &&
          textKey(aliased.text ?? '') === textKey(message.text)
        ) {
          claimed.add(aliased.id);
          if (message.context?.cwd && isUsableWorkspacePath(message.context.cwd))
            overlay(aliased.id, { context: { ...aliased.context, ...message.context } });
          continue;
        }
        let matches = (
          indexed.get(`${plugin.id}\0${kind}\0${textKey(message.text)}`) ?? []
        ).filter(
          (r) =>
            !claimed.has(r.id) &&
            !!message.timestamp &&
            Math.abs(
              Date.parse(message.submittedAt ?? message.timestamp) - Date.parse(r.ts),
            ) <= 5000 &&
            (r.sessionId === target.id ||
              (kind === 'prompt' && corroboratesAncestor(r, message.sourceId))),
        );
        const local = matches.filter((r) => r.sessionId === target.id);
        if (local.length) matches = local;
        if (
          kind === 'prompt' &&
          matches.length > 1 &&
          transcript.messages.filter(
            (m) =>
              m.role === 'user' &&
              textKey(m.text) === textKey(message.text) &&
              !!m.timestamp &&
              !!message.timestamp &&
              Math.abs(
                Date.parse(m.timestamp) -
                  Date.parse(message.submittedAt ?? message.timestamp),
              ) <= 5000,
          ).length === 1
        ) {
          matches.sort(
            (a, b) =>
              Math.abs(
                Date.parse(a.ts) -
                  Date.parse((message.submittedAt ?? message.timestamp)!),
              ) -
                Math.abs(
                  Date.parse(b.ts) -
                    Date.parse((message.submittedAt ?? message.timestamp)!),
                ) ||
              a.capturedAt.localeCompare(b.capturedAt) ||
              a.id.localeCompare(b.id),
          );
          const canonical = matches[0]!;
          for (const duplicate of matches.slice(1)) {
            overlay(duplicate.id, { duplicateOf: canonical.id });
            for (const child of all.filter(
              (r) => r.turnId === (duplicate.turnId ?? duplicate.id),
            ))
              if (child.id !== duplicate.id)
                overlay(child.id, { turnId: canonical.turnId ?? canonical.id });
          }
          matches = [canonical];
        }
        if (matches.length === 1) {
          const match = matches[0]!;
          claimed.add(match.id);
          plan.bindings.push({
            sessionId: target.id,
            sourceId: message.sourceId,
            recordId: match.id,
            ancestor: match.sessionId !== target.id,
          });
          if (message.origin === 'human') overlay(match.id, { origin: 'human' });
          if (message.context?.cwd && isUsableWorkspacePath(message.context.cwd))
            overlay(match.id, { context: { ...match.context, ...message.context } });
        } else if (kind === 'prompt') {
          missing++;
          if (matches.length > 1) ambiguous++;
        }
      }
      // With no native prompt recognized a successful read is still degraded.
      if (
        !transcript.messages.some((m) => m.role === 'user') &&
        transcript.messages.length
      )
        plan.warningCodes.push('NO_PROVIDER_PROMPTS');
      plan.recoveries.push({
        session: target,
        transcript,
        fingerprint,
        sourceSize: sourceStat.size,
        sourceMtime: sourceStat.mtimeMs,
        path: candidate.path,
        missing,
        ambiguous,
      });
    }
  }
  return finishPlan(store, plan);
}

function finishPlan(store: HistoryStore, plan: RepairPlan): RepairPlan {
  for (const b of plan.bindings)
    b.previousId = store.bySource(b.sessionId, b.sourceId)?.id ?? null;
  return plan;
}

function restoreEnrichment(
  store: HistoryStore,
  scope: Set<string>,
  overlay: (id: string, patch: Partial<HistoryRecord>) => void,
  warnings: string[],
  bindings: Binding[],
) {
  const archive = join(
    store.home,
    'legacy-backups',
    'upgrade-0.21.0',
    'archive-map.json',
  );
  if (!existsSync(archive)) return;
  let mappings: { source: string; destinationRelative: string }[];
  try {
    mappings = JSON.parse(readFileSync(archive, 'utf8'));
  } catch {
    warnings.push('LEGACY_ARCHIVE_UNAVAILABLE');
    return;
  }
  for (const m of mappings) {
    const base = resolve(store.home, m.destinationRelative);
    if (!containsPath(store.home, base)) continue;
    const authors = join(base, 'authors');
    if (!existsSync(authors)) continue;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/^\d+\.log$/.test(entry.name)) continue;
        for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
          let e: any;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          for (const o of e.enrichment?.overlays ?? []) {
            const record = store.importRecord(
              `legacy-project:${m.source}`,
              o.targetEventId,
            );
            if (!record || !scope.has(record.sessionId)) continue;
            if (
              o.sourceId &&
              store.bySource(record.sessionId, o.sourceId)?.id !== record.id
            )
              bindings.push({
                sessionId: record.sessionId,
                sourceId: o.sourceId,
                recordId: record.id,
                ancestor: false,
              });
            const turn = o.turnId
              ? store.importRecord(`legacy-project:${m.source}`, o.turnId)
              : undefined;
            overlay(record.id, {
              ...(o.model ? { model: o.model } : {}),
              ...(turn ? { turnId: turn.turnId ?? turn.id } : {}),
            });
          }
        }
      }
    };
    walk(authors);
  }
}

/** Derive turn membership without letting scratch files replace repository focus. */
function membershipChanges(
  store: HistoryStore,
  sessionIds: Set<string>,
  sourceRecords = store.records(),
): { turnId: string; projectIds: string[] }[] {
  const views = store.projects();
  const gitCache = new Map<string, string | undefined>();
  const gitFor = (path: string) => {
    if (!gitCache.has(path)) gitCache.set(path, repositoryKey(path));
    return gitCache.get(path);
  };
  const gitViews = new Map<string, string[]>();
  for (const v of views)
    for (const root of v.roots) {
      const key = gitFor(root);
      if (key)
        gitViews.set(key, [...new Set([...(gitViews.get(key) ?? []), v.projectId])]);
    }
  const records = sourceRecords.filter((r) => sessionIds.has(r.sessionId));
  const sessions = new Map(store.sessions().map((s) => [s.id, s]));
  const groups = new Map<string, HistoryRecord[]>();
  for (const r of records) {
    const key = r.turnId ?? r.id;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const focus = new Map<string, string[]>();
  const changes: { turnId: string; projectIds: string[] }[] = [];
  for (const [turn, group] of groups) {
    const prompt = group.find((r) => r.kind === 'prompt');
    if (!prompt) continue;
    if (store.query('SELECT 1 FROM manual_turns WHERE turn_id=?').get(turn)) continue;
    const keys = new Set<string>();
    for (const r of group)
      if (r.kind === 'edit' && r.file && !r.unresolvedPath) {
        const key = gitFor(dirname(r.file));
        if (!key) continue;
        for (const id of gitViews.get(key) ?? []) keys.add(id);
      }
    let targets = [...keys];
    if (!targets.length) {
      const cwd = prompt.context?.cwd ?? sessions.get(prompt.sessionId)?.cwd;
      const view = cwd ? store.projectForPath(cwd) : undefined;
      targets =
        view && gitFor(view.projectRoot ?? '')
          ? [view.projectId]
          : (focus.get(prompt.sessionId) ?? []);
    }
    if (!targets.length) continue;
    focus.set(prompt.sessionId, targets);
    const old = (
      store
        .query(
          "SELECT project_id FROM turn_projects WHERE turn_id=? AND origin!='manual'",
        )
        .all(turn) as any[]
    ).map((r) => r.project_id);
    if (canonical([...new Set(old)].sort()) === canonical([...targets].sort())) continue;
    changes.push({ turnId: turn, projectIds: targets });
  }
  return changes;
}

export function repairPreview(plan: RepairPlan) {
  return {
    selection: plan.selection,
    changes: {
      recordOverlays: plan.overlays.length,
      sourceBindings: plan.bindings.length,
      authorMappings: plan.authors.length,
      sourceRecoveries: plan.recoveries.length,
      candidateMissingPrompts: plan.recoveries.reduce((n, r) => n + r.missing, 0),
      ambiguousMatches: plan.recoveries.reduce((n, r) => n + r.ambiguous, 0),
      includedTurns: plan.includes.length,
      projectMemberships: plan.memberships.length,
    },
    warningCodes: [...new Set(plan.warningCodes)],
    before: plan.before,
  };
}

export function applyRepair(store: HistoryStore, plan: RepairPlan) {
  const preview = repairPreview(plan);
  if (!Object.values(preview.changes).some((n) => n > 0))
    return {
      repairId: null,
      inserted: 0,
      changed: 0,
      alreadyApplied: true,
      after: auditHistory(store, plan.selection),
    };
  const operations = {
    selection: plan.selection,
    overlays: plan.overlays,
    bindings: plan.bindings,
    authors: plan.authors,
    memberships: plan.memberships,
    includes: plan.includes,
    recoveries: plan.recoveries.map((r) => [r.session.id, r.fingerprint]),
  };
  const id = 'repair_' + digest(canonical(operations)).slice(0, 32);
  if (store.query('SELECT 1 FROM repair_receipts WHERE id=?').get(id))
    return {
      repairId: id,
      inserted: 0,
      changed: 0,
      alreadyApplied: true,
      after: auditHistory(store, plan.selection),
    };
  let inserted = 0,
    changed = 0;
  store
    .transaction(() => {
      for (const b of plan.bindings)
        if ((store.bySource(b.sessionId, b.sourceId)?.id ?? null) !== b.previousId)
          throw new Error('REPAIR_SOURCE_CHANGED: prepare a fresh repair.');
      for (const o of plan.overlays) {
        const row = store
          .query('SELECT patch FROM record_overlays WHERE record_id=?')
          .get(o.id) as { patch: string } | null;
        if ((row?.patch ?? null) !== o.previousPatch)
          throw new Error('REPAIR_VIEW_CHANGED: prepare a fresh repair.');
      }
      store
        .query('INSERT INTO repair_receipts VALUES (?,?,?)')
        .run(id, new Date().toISOString(), canonical({ preview, operations }));
      for (const a of plan.authors) {
        if (a.name)
          store
            .query('INSERT INTO authors VALUES (?,?) ON CONFLICT(id) DO NOTHING')
            .run(a.target, a.name);
        store.mapAuthor(a.source, a.target, id);
        changed++;
      }
      for (const o of plan.overlays) {
        store.overlayRecord(o.id, o.patch, id);
        changed++;
      }
      for (const recovery of plan.recoveries)
        store.ensureSession({
          tool: recovery.session.tool,
          nativeSessionId: recovery.session.nativeSessionId,
          cwd: recovery.session.cwd,
          startedAt: recovery.session.startedAt,
          transcriptPath: recovery.path,
        });
      for (const b of plan.bindings) {
        if (b.ancestor)
          store
            .query(
              'INSERT INTO ancestor_aliases VALUES (?,?,?,?) ON CONFLICT(session_id,source_id) DO UPDATE SET record_id=excluded.record_id,repair_id=excluded.repair_id',
            )
            .run(b.sessionId, b.sourceId, b.recordId, id);
        else store.alias(b.sessionId, b.sourceId, b.recordId);
        changed++;
      }
      const affected = new Set(
        store
          .records(plan.selection)
          .filter((r) => r.kind !== 'audit')
          .map((r) => r.sessionId),
      );
      for (const recovery of plan.recoveries) {
        affected.add(recovery.session.id);
        if (!recovery.ambiguous)
          inserted += captureTranscript(
            store,
            store.session(recovery.session.id)!,
            recovery.transcript,
          );
        const prompts = recovery.transcript.messages.filter(
          (m) =>
            m.role === 'user' && (m.origin === 'human' || !isSyntheticPrompt(m.text)),
        );
        const matched = prompts.filter(
          (m) => !!store.bySource(recovery.session.id, m.sourceId),
        ).length;
        store.noteSourceRead(recovery.session.id, {
          sourceSize: recovery.sourceSize,
          sourceMtime: recovery.sourceMtime,
          readerVersion: 3,
          fingerprint: recovery.fingerprint,
          status:
            matched === prompts.length && prompts.length && !recovery.ambiguous
              ? 'reconciled'
              : 'partial',
          prompts: prompts.length,
          matched,
          missing: prompts.length - matched,
          warningCodes: [
            ...(recovery.transcript.warnings?.length ? ['PROVIDER_FALLBACK'] : []),
            ...(recovery.ambiguous ? ['AMBIGUOUS_MATCH'] : []),
            ...(!prompts.length ? ['NO_PROVIDER_PROMPTS'] : []),
          ],
          readAt: new Date().toISOString(),
        });
      }
      for (const m of membershipChanges(store, affected)) {
        store
          .query("DELETE FROM turn_projects WHERE turn_id=? AND origin!='manual'")
          .run(m.turnId);
        for (const projectId of m.projectIds)
          store
            .query("INSERT OR IGNORE INTO turn_projects VALUES (?,?,'repair')")
            .run(m.turnId, projectId);
        changed++;
      }
      if (plan.selection.kind === 'project')
        for (const turn of plan.includes) {
          const existing = store
            .records(plan.selection)
            .some((r) => (r.turnId ?? r.id) === turn);
          if (!existing) {
            const prior = store
              .query(
                "SELECT DISTINCT p.project_id FROM turn_projects p WHERE p.turn_id=? AND (p.origin='manual' OR NOT EXISTS(SELECT 1 FROM manual_turns m WHERE m.turn_id=p.turn_id))",
              )
              .all(turn) as { project_id: string }[];
            store.assign(turn, [
              ...new Set([...prior.map((p) => p.project_id), plan.selection.projectId]),
            ]);
            changed++;
          }
        }
    })
    .immediate();
  const result = {
    repairId: id,
    inserted,
    changed,
    alreadyApplied: false,
    after: auditHistory(store, plan.selection),
  };
  const dir = join(store.home, 'maintenance', 'repairs', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  return result;
}
