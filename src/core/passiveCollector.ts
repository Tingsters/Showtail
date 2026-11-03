/** Short-lived detached worker. It exits after draining; no polling service. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HistoryStore, digest } from './history.ts';
import { captureIssue, drainPending, internalCapturePath } from './historyCapture.ts';
import { syncHistory } from './historySync.ts';
import {
  launchCollector,
  observationConsent,
  observationCount,
  observerQueue,
  type Observation,
} from './passiveObserver.ts';

export async function collectObservations(): Promise<void> {
  const dir = observerQueue();
  if (!existsSync(dir)) return;
  const lock = join(dir, 'worker.lock');
  const owner = `${process.pid}`;
  try {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      try {
        process.kill(pid, 0);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
      unlinkSync(lock);
    }
    const fd = openSync(lock, 'wx', 0o600);
    writeFileSync(fd, owner);
    closeSync(fd);
  } catch {
    return;
  }
  const seen = new Set<string>();
  try {
    using store = new HistoryStore();
    drainPending(store);
    // A bounded settle pass handles transcripts flushed just after Stop without
    // keeping a watcher alive. New observations are picked up in the next pass.
    for (let pass = 0; pass < 3; pass++) {
      const names = readdirSync(dir).filter((n) => /^[\w-]+\.json$/.test(n));
      if (!names.length) break;
      for (const name of names) {
        seen.add(name);
        const file = join(dir, name);
        let o: Observation;
        try {
          o = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          captureIssue('OBSERVATION_INVALID', 'unknown');
          unlinkSync(file);
          continue;
        }
        if (
          o.version !== 1 ||
          !o.id ||
          !Array.isArray(o.files) ||
          !observationConsent(o)
        ) {
          unlinkSync(file);
          continue;
        }
        try {
          const result = await syncHistory(store, { tool: o.tool, observation: o });
          if (!observationConsent(o)) {
            unlinkSync(file);
            continue;
          }
          const groups = result.observations.length
            ? result.observations
            : o.nativeSessionId && o.files.length
              ? [
                  {
                    nativeSessionId: o.nativeSessionId,
                    sessionId: undefined,
                    files: o.files,
                  },
                ]
              : [];
          for (const group of groups) {
            const session = group.sessionId
              ? store.session(group.sessionId)!
              : store.ensureSession({
                  tool: o.tool,
                  nativeSessionId: group.nativeSessionId,
                  cwd: o.cwd,
                  workspacePaths: o.workspacePaths,
                  automaticSince: o.enabledAt ?? o.epoch,
                });
            const turn = store
              .records({ kind: 'all' }, { sessionId: session.id })
              .filter((r) => r.kind === 'prompt' && r.ts <= o.observedAt)
              .at(-1);
            for (const path of new Set([
              ...group.files,
              ...(group.nativeSessionId === o.nativeSessionId ||
              (o.transcriptPath &&
                /[\\/]subagents[\\/]/.test(o.transcriptPath) &&
                group.nativeSessionId.startsWith(`${o.nativeSessionId}:agent:`))
                ? o.files
                : []),
            ])) {
              if (internalCapturePath(path, o.tool)) continue;
              try {
                const observedAt = new Date().toISOString();
                const sha256 = createHash('sha256')
                  .update(readFileSync(path))
                  .digest('hex');
                const nativeEdit = store
                  .records({ kind: 'all' }, { sessionId: session.id })
                  .filter(
                    (r) =>
                      r.kind === 'edit' &&
                      r.file === path &&
                      !r.tags?.includes('observed-file-state') &&
                      r.ts <= o.observedAt,
                  )
                  .at(-1);
                store.append(
                  session.id,
                  {
                    kind: 'edit',
                    duplicateOf: nativeEdit?.id,
                    file: path,
                    sha256,
                    ts: observedAt,
                    turnId: turn?.id,
                    sourceId: `observation:${o.id}:${digest(path)}`,
                    tags: ['observed-file-state'],
                    provenance: { source: 'asynchronous-file-observation', id: o.id },
                  },
                  { continueCapture: () => observationConsent(o) },
                );
              } catch {
                /* Deleted or transient paths are represented by native results. */
              }
            }
          }
          if (o.event === 'session-end') {
            const session = store
              .sessions()
              .find((s) => s.tool === o.tool && s.nativeSessionId === o.nativeSessionId);
            if (session) store.endSession(session.id);
          }
          if (pass < 2 && (!result.sources || result.issues.length)) continue;
          unlinkSync(file);
        } catch {
          captureIssue('COLLECTION_FAILED', o.tool);
        }
      }
      if (pass < 2 && observationCount()) await Bun.sleep(150);
    }
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === owner) unlinkSync(lock);
    } catch {}
    if (readdirSync(dir).some((name) => /^[\w-]+\.json$/.test(name) && !seen.has(name)))
      launchCollector();
    // No unbounded retry loop on unreadable sources. The next host event or
    // explicit sync retries failed work, and status exposes the queue.
  }
}
