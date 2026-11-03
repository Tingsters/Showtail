/** Current file-state evidence is deliberately separate from applied native edits. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { HookTranscript } from '../plugins/types.ts';
import { HistoryStore, digest, historySettings, type HistorySession } from './history.ts';
import { internalCapturePath } from './historyCapture.ts';
import { isSensitivePath } from './sensitivePaths.ts';

export function captureNativeFileObservations(
  store: HistoryStore,
  session: HistorySession,
  candidates: HookTranscript['fileObservationCandidates'],
  options: { since: string; cutoff: string; continueCapture: () => boolean },
): number {
  if (historySettings().captureCode === false) return 0;
  let inserted = 0;
  for (const candidate of candidates ?? []) {
    const started = Date.parse(candidate.startedAt ?? '');
    const finished = Date.parse(candidate.timestamp ?? '');
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(finished) ||
      started < Date.parse(options.since) ||
      finished < started ||
      finished > Date.parse(options.cutoff)
    )
      continue;
    const call = store.bySource(session.id, candidate.sourceId);
    const turnId =
      call?.turnId ??
      store
        .records({ kind: 'all' }, { sessionId: session.id })
        .filter((record) => record.kind === 'prompt' && record.ts <= candidate.startedAt!)
        .at(-1)?.id;
    for (const file of candidate.files) {
      if (!options.continueCapture()) return inserted;
      const path = isAbsolute(file)
        ? file
        : session.cwd
          ? resolve(session.cwd, file)
          : undefined;
      if (!path || internalCapturePath(path, session.tool) || isSensitivePath(path))
        continue;
      if (candidate.basis === 'workspace-delta') {
        const sourceId = `${candidate.sourceId}:edits#${path}`;
        const previous = store.bySource(session.id, sourceId);
        if (
          previous?.kind === 'audit' &&
          previous.tags?.includes('observed-workspace-delta')
        )
          continue;
        const result = store.append(
          session.id,
          {
            kind: 'audit',
            file: path,
            diff: candidate.diff,
            deleted: candidate.deleted,
            ts: candidate.timestamp,
            turnId,
            sourceId,
            toolName: candidate.toolName,
            tags: ['observed-workspace-delta', `tool-outcome:${candidate.toolOutcome}`],
            provenance: { source: 'native-workspace-delta', id: candidate.sourceId },
          },
          { continueCapture: options.continueCapture },
        );
        if (result.inserted) inserted++;
        continue;
      }
      const sourceId = `shell-observation:${candidate.sourceId}:${digest(path)}`;
      if (store.bySource(session.id, sourceId)) continue;
      let observedAt: string;
      let sha256: string;
      try {
        const physical = realpathSync(path);
        if (internalCapturePath(physical, session.tool) || isSensitivePath(physical))
          continue;
        observedAt = new Date().toISOString();
        sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      } catch {
        // Missing/deleted files remain native tool attempts; no state is invented.
        continue;
      }
      if (!options.continueCapture()) return inserted;
      // Persistence failures must reach sync so it leaves the source cursor
      // uncommitted and retries. Only filesystem failures are best-effort.
      const result = store.append(
        session.id,
        {
          // A shell can fail after writing or succeed without taking a branch.
          // This is a timestamped observation, never an inferred applied edit.
          kind: 'audit',
          file: path,
          sha256,
          ts: observedAt,
          turnId,
          sourceId,
          toolName: candidate.toolName,
          tags: [
            'observed-file-state',
            'shell-write-attempt',
            `tool-outcome:${candidate.toolOutcome}`,
          ],
          provenance: {
            source: 'native-shell-write-observation',
            id: candidate.sourceId,
          },
        },
        { continueCapture: options.continueCapture },
      );
      if (result.inserted) inserted++;
    }
  }
  return inserted;
}
