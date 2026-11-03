/** Consent-bounded, native-source ingestion shared by reports and observers. */
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getPlugin, migrationPlugins } from '../plugins/registry.ts';
import type { HookTranscript, MigrationTranscriptCandidate } from '../plugins/types.ts';
import { parseClaudeTranscript } from './claudeCode.ts';
import { dataHome } from './dataHome.ts';
import { readGlobalConfig, toolCaptureEnabledAt } from './globalConfig.ts';
import { HistoryStore, digest } from './history.ts';
import { automaticCaptureEnabled, captureTranscript } from './historyCapture.ts';
import { readClaudeSource } from './nativeSourceCursor.ts';
import type { Observation } from './passiveObserver.ts';

const READER_VERSION = 1;
export async function syncHistory(
  store: HistoryStore,
  options: { tool?: string; observation?: Observation; cutoff?: string } = {},
) {
  const cutoff = options.cutoff ?? new Date().toISOString();
  const selectedTool = options.tool ? getPlugin(options.tool)?.id : undefined;
  if (options.tool && !selectedTool) throw new Error('UNKNOWN_CAPTURE_TOOL');
  let imported = 0,
    sources = 0,
    skipped = 0;
  const issues: { tool: string; code: string }[] = [];
  const observations: { nativeSessionId: string; sessionId: string; files: string[] }[] =
    [];
  for (const plugin of migrationPlugins()) {
    if (selectedTool && plugin.id !== selectedTool) continue;
    if (!automaticCaptureEnabled(plugin.id)) continue;
    const sourceStart = sources;
    const cfg = readGlobalConfig();
    const enabledAt = toolCaptureEnabledAt(plugin.cliName);
    if (!enabledAt && !options.observation) {
      try {
        const legacy = plugin.connect?.status();
        if (!legacy?.hooksActive && !legacy?.captureActive) continue;
      } catch {
        issues.push({ tool: plugin.id, code: 'CAPTURE_CONFIGURATION_UNAVAILABLE' });
        continue;
      }
    }
    const epoch = cfg.captureResumedAt ?? cfg.captureSince;
    const since = [enabledAt, cfg.captureSince, cfg.captureResumedAt]
      .filter((v): v is string => !!v)
      .sort()
      .at(-1);
    if (!since) {
      issues.push({ tool: plugin.id, code: 'CONSENT_CUTOFF_MISSING' });
      continue;
    }
    const consent = () => {
      const current = readGlobalConfig();
      return (
        automaticCaptureEnabled(plugin.id) &&
        enabledAt === toolCaptureEnabledAt(plugin.cliName) &&
        epoch === (current.captureResumedAt ?? current.captureSince)
      );
    };
    let candidates: MigrationTranscriptCandidate[];
    try {
      candidates = plugin.migration.discover();
      const o = options.observation;
      if (!o && plugin.migration.discoverNative) {
        try {
          for (const candidate of await plugin.migration.discoverNative()) {
            if (
              !candidates.some((c) => c.providerSessionId === candidate.providerSessionId)
            )
              candidates.push(candidate);
          }
        } catch {
          issues.push({ tool: plugin.id, code: 'NATIVE_HISTORY_API_UNAVAILABLE' });
        }
      }
      if (o?.transcriptPath && !candidates.some((c) => c.path === o.transcriptPath))
        candidates.push({
          path: o.transcriptPath,
          providerSessionId:
            o.nativeSessionId ?? `transcript:${digest(o.transcriptPath)}`,
          cwd: o.cwd ?? undefined,
          mtimeMs: 0,
        });
      if (
        o?.tool === 'codex' &&
        o.nativeSessionId &&
        !candidates.some((c) => c.providerSessionId === o.nativeSessionId)
      )
        candidates.push({
          path: '',
          providerSessionId: o.nativeSessionId,
          cwd: o.cwd ?? undefined,
          mtimeMs: 0,
        });
      if (o && (o.transcriptPath || o.nativeSessionId))
        candidates = candidates.filter(
          (c) =>
            c.path === o.transcriptPath ||
            c.providerSessionId === o.nativeSessionId ||
            (plugin.id === 'claude-code' &&
              !!o.nativeSessionId &&
              c.providerSessionId.startsWith(`${o.nativeSessionId}:agent:`)),
        );
    } catch {
      issues.push({ tool: plugin.id, code: 'SOURCE_DISCOVERY_FAILED' });
      continue;
    }
    for (const candidate of candidates) {
      if (!consent()) break;
      try {
        const st = candidate.path ? statSync(candidate.path) : undefined;
        if (
          (st?.mtimeMs ?? candidate.mtimeMs ?? Infinity) < Date.parse(since) &&
          (st?.mtimeMs ?? candidate.mtimeMs) !== 0
        )
          continue;
        const key = `source-cursor:${plugin.id}:${digest(candidate.path || candidate.providerSessionId)}`;
        // Cursor commits only after reconciliation. A changed/rotated source is
        // safely replayed through the reader: cross-line tool results and
        // compaction cannot be normalized correctly from a contextless tail.
        const fingerprint = JSON.stringify({
          version: READER_VERSION,
          size: st?.size,
          mtime: st?.mtimeMs,
          ino: st?.ino,
          since,
        });
        if (st && store.meta(key) === fingerprint) {
          skipped++;
          continue;
        }
        const tailKey = `${key}:tail`;
        const tail =
          plugin.id === 'claude-code' &&
          candidate.path &&
          !/[\\/]subagents[\\/]/.test(candidate.path)
            ? readClaudeSource(candidate.path, store.meta(tailKey))
            : undefined;
        const transcript: HookTranscript = tail
          ? parseClaudeTranscript(tail.content, candidate.cwd ?? dataHome(), {
              includeOutsideEdits: true,
            })
          : await plugin.migration.read(candidate, candidate.cwd ?? dataHome());
        if (!transcript.messages.length && !transcript.events?.length)
          issues.push({ tool: plugin.id, code: 'SOURCE_EMPTY_OR_UNSUPPORTED' });
        if (transcript.warnings?.length)
          issues.push({ tool: plugin.id, code: 'SOURCE_PARTIAL' });
        const cutoffMs = Date.parse(cutoff);
        const beyondCutoff =
          transcript.messages.some(
            (m) => Date.parse(m.submittedAt ?? m.timestamp ?? '') > cutoffMs,
          ) || transcript.events?.some((e) => Date.parse(e.timestamp ?? '') > cutoffMs);
        transcript.messages = transcript.messages.filter(
          (m) => !m.timestamp || Date.parse(m.timestamp) <= cutoffMs,
        );
        transcript.events = transcript.events?.filter(
          (e) => !e.timestamp || Date.parse(e.timestamp) <= cutoffMs,
        );
        for (const plan of plugin.migration.planFiles?.(candidate) ?? []) {
          const p = statSync(plan.absPath);
          if (p.mtimeMs >= Date.parse(since) && p.mtimeMs <= Date.parse(cutoff))
            transcript.messages.push({
              role: 'plan',
              text: plan.content,
              sourceId: plan.sourceId,
              timestamp: p.mtime.toISOString(),
            });
        }
        if (!consent()) break;
        // Do not manufacture empty sessions for pre-consent or source-less work.
        if (
          !transcript.messages.some(
            (m) =>
              Date.parse(m.submittedAt ?? m.timestamp ?? '') >= Date.parse(since) &&
              Date.parse(m.submittedAt ?? m.timestamp ?? '') <= cutoffMs,
          )
        ) {
          skipped++;
          continue;
        }
        const session = store.ensureSession({
          tool: plugin.id,
          nativeSessionId: transcript.sessionId ?? candidate.providerSessionId,
          cwd: candidate.cwd ?? null,
          workspacePaths: options.observation?.workspacePaths,
          transcriptPath: candidate.path || undefined,
          automaticSince: since,
          startedAt: transcript.messages.find((m) => (m.timestamp ?? '') >= since)
            ?.timestamp,
        });
        imported += captureTranscript(store, session, transcript, {
          since,
          continueCapture: consent,
        });
        if (options.observation) {
          const eventAt = Date.parse(options.observation.observedAt);
          const files = transcript.messages.flatMap((m) => {
            if (
              m.role !== 'edit' ||
              !m.timestamp ||
              Date.parse(m.timestamp) < Date.parse(since) ||
              Math.abs(Date.parse(m.timestamp) - eventAt) > 30_000
            )
              return [];
            return (m.edits?.map((e) => e.file) ?? m.files ?? []).flatMap((file) =>
              isAbsolute(file)
                ? [file]
                : candidate.cwd
                  ? [resolve(candidate.cwd, file)]
                  : [],
            );
          });
          observations.push({
            nativeSessionId: session.nativeSessionId,
            sessionId: session.id,
            files: [...new Set(files)],
          });
        }
        const after = candidate.path ? statSync(candidate.path) : undefined;
        if (
          consent() &&
          !beyondCutoff &&
          !transcript.warnings?.length &&
          st &&
          after &&
          st.size === after.size &&
          st.mtimeMs === after.mtimeMs
        ) {
          store.setMeta(key, fingerprint);
          if (tail) store.setMeta(tailKey, tail.checkpoint);
        }
        sources++;
      } catch {
        issues.push({ tool: plugin.id, code: 'SOURCE_READ_FAILED' });
      }
    }
    if (options.observation && !candidates.length)
      issues.push({ tool: plugin.id, code: 'NATIVE_SESSION_NOT_PERSISTED' });
    if (consent()) {
      const key = `capture-health:${plugin.id}`;
      let previous: { lastIngestedAt?: string } = {};
      try {
        previous = JSON.parse(store.meta(key) ?? '{}');
      } catch {}
      store.setMeta(
        key,
        JSON.stringify({
          lastCheckedAt: new Date().toISOString(),
          lastIngestedAt:
            sources > sourceStart
              ? new Date().toISOString()
              : (previous.lastIngestedAt ?? null),
          issues: issues.filter((i) => i.tool === plugin.id),
        }),
      );
    }
  }
  return { imported, sources, skipped, cutoff, issues, observations };
}
