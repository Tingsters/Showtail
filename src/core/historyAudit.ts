import { existsSync, statSync } from 'node:fs';
import { HistoryStore, type HistorySelection } from './history.ts';
import { isSyntheticPrompt } from './syntheticPrompt.ts';

export interface SourceCoverage {
  sessionId: string;
  parentNativeSessionId?: string;
  status: 'reconciled' | 'partial' | 'unavailable' | 'unchecked';
  prompts?: number;
  matched?: number;
  missing?: number;
  warningCodes: string[];
  readAt?: string;
}
export interface HistoryCoverage {
  status: 'reconciled' | 'partial' | 'unchecked';
  meaning: string;
  from?: string;
  to?: string;
  sources: SourceCoverage[];
}

/** Stored evidence only. Auditing never imports or changes the capture epoch. */
export function auditHistory(store: HistoryStore, selection: HistorySelection) {
  const records = store.records(selection);
  const work = records.filter((r) => r.kind !== 'audit');
  const sessions = new Set(work.map((r) => r.sessionId));
  const reads = new Map(store.sourceReads().map((r) => [r.sessionId, r]));
  const sources: SourceCoverage[] = store
    .sessions()
    .filter((s) => sessions.has(s.id))
    .map((s) => {
      const receipt = reads.get(s.id);
      const available = !!s.transcriptPath && existsSync(s.transcriptPath);
      const st = available ? statSync(s.transcriptPath!) : undefined;
      const changed =
        !!st &&
        receipt?.sourceSize !== undefined &&
        (st.size !== receipt.sourceSize || st.mtimeMs !== receipt.sourceMtime);
      const unverified = work.some(
        (r) => r.sessionId === s.id && r.provenance?.legacyIntegrity === 'unverified',
      );
      return {
        sessionId: s.id,
        ...(s.parentNativeSessionId
          ? { parentNativeSessionId: s.parentNativeSessionId }
          : {}),
        status:
          s.transcriptPath && !available
            ? 'unavailable'
            : changed || unverified
              ? 'partial'
              : (receipt?.status ?? 'unchecked'),
        prompts: receipt?.prompts,
        matched: receipt?.matched,
        missing: receipt?.missing,
        warningCodes: [
          ...new Set<string>([
            ...(receipt?.warningCodes ?? []),
            ...(!available && s.transcriptPath ? ['SOURCE_UNAVAILABLE'] : []),
            ...(changed ? ['SOURCE_CHANGED_SINCE_READ'] : []),
            ...(unverified ? ['LEGACY_INTEGRITY_UNVERIFIED'] : []),
          ]),
        ],
        readAt: receipt?.readAt,
      };
    });
  const prompts = work.filter((r) => r.kind === 'prompt');
  const groups = new Set(
    prompts
      .filter((r) => r.origin === 'human' || !isSyntheticPrompt(r.text ?? ''))
      .map((r) => r.turnId ?? r.id),
  );
  const coverage: HistoryCoverage = {
    status:
      sources.length && sources.every((s) => s.status === 'reconciled')
        ? 'reconciled'
        : sources.some((s) => s.status !== 'unchecked')
          ? 'partial'
          : 'unchecked',
    meaning:
      'Compared with available local sources only; this does not prove that every past interaction was captured.',
    from: work[0]?.ts,
    to: work.at(-1)?.ts,
    sources,
  };
  return {
    selection,
    coverage,
    quality: {
      conversations: sessions.size,
      auditOnlyContainers: new Set(
        records.filter((r) => !sessions.has(r.sessionId)).map((r) => r.sessionId),
      ).size,
      harnessPrompts: prompts.filter(
        (r) => r.origin !== 'human' && isSyntheticPrompt(r.text ?? ''),
      ).length,
      unanchoredRecords: work.filter(
        (r) => r.kind !== 'prompt' && (!r.turnId || !groups.has(r.turnId)),
      ).length,
      records: records.length,
      unverifiedLegacyRecords: records.filter(
        (r) => r.provenance?.legacyIntegrity === 'unverified',
      ).length,
      capturedEdits: work.filter((r) => r.kind === 'edit').length,
    },
  };
}
