/**
 * Projection (materialize): replay a ledger session's captured records into a
 * target repo's `.showtail/` trail. This is the boundary the ledger's absolute,
 * machine-local paths cross into a portable, repo-relative trail — every edit
 * path is re-relativized against the target root here, and content is re-stored
 * (and re-redacted) through the normal `logEvent`/`importEditArtifact` path so a
 * projection is byte-for-byte a normal capture.
 *
 * Idempotent: every projected record carries a stable `sourceId`
 * (`ledger:<session>:<record>`) and the batch id `ledger:<session>`, so a second
 * materialize (a retry, a live-then-reattach, or a double-fire) dedups against
 * what the repo already holds and writes nothing new. The batch id also lets
 * `reattach` cleanly remove a wrong placement with `removeEventsByBatch`.
 *
 * Called both live (the hook projects into the resolved root as work happens) and
 * on demand (`showtail reattach` projects an inbox/misattributed session into the
 * repo the user picks).
 */
import {
  addArtifact,
  importEditArtifact,
  importedArtifactSourceIds,
} from './artifacts.ts';
import { importedSourceIds, logEvent, readSessionEvents } from './events.ts';
import { materializePlan, PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from './plans.ts';
import { sessionForNativeSession } from './sessions.ts';
import { toRepoRelative, type AuthorPaths } from './storage.ts';
import { readLedgerRecords, type LedgerSession } from './ledger.ts';

/** The deterministic batch id a session's projected records are tagged with. */
export function ledgerBatchId(sessionId: string): string {
  return `ledger:${sessionId}`;
}

/** The stable per-record source id used for idempotent projection. */
function recordSourceId(sessionId: string, recordId: string): string {
  return `ledger:${sessionId}:${recordId}`;
}

/** What a projection did, both for callers and for the hook trace. */
export interface MaterializeResult {
  /** Total new records written (0 on a re-materialize). */
  projected: number;
  prompts: number;
  replies: number;
  decisions: number;
  plans: number;
  edits: number;
  /** The repo session the records were projected into. */
  sessionId: string;
  /** The most recent prompt event id projected (for the user-prompt hook trace). */
  lastPromptId?: string;
}

/**
 * Replay every record of `session` into `author`'s trail, returning a breakdown of
 * what was projected (all zero when nothing was new — e.g. a re-materialize). The
 * repo session is the one mirroring this session's native id, so projections of
 * the *same* logical session into two repos cross-link by a shared native id.
 */
export async function materializeLedgerSession(
  session: LedgerSession,
  author: AuthorPaths,
): Promise<MaterializeResult> {
  const repoSession = sessionForNativeSession(
    author,
    session.nativeSessionId ?? session.id,
    {
      tool: session.tool,
    },
  );
  const batchId = ledgerBatchId(session.id);
  const seen = importedSourceIds(author);
  const seenArtifacts = importedArtifactSourceIds(author);
  // Ledger record id → the repo prompt event id it became, so a reply/edit's
  // `turnKey` re-links to the right turn in the projection. Seeded from prompts
  // already projected in a PRIOR call (materialize runs per hook event), so a
  // reply/edit captured now still links to its earlier-written turn instead of
  // being orphaned.
  const turnMap = new Map<string, string>();
  const projectedPromptBySourceId = new Map<string, string>();
  for (const e of readSessionEvents(author, repoSession.id)) {
    if (e.type === 'prompt' && e.sourceId)
      projectedPromptBySourceId.set(e.sourceId, e.id);
  }
  const out: MaterializeResult = {
    projected: 0,
    prompts: 0,
    replies: 0,
    decisions: 0,
    plans: 0,
    edits: 0,
    sessionId: repoSession.id,
  };

  for (const rec of readLedgerRecords(session.id)) {
    const sourceId = rec.sourceId ?? recordSourceId(session.id, rec.id);
    const turnId = rec.turnKey ? turnMap.get(rec.turnKey) : undefined;

    if (rec.kind === 'prompt') {
      if (seen.has(sourceId)) {
        // Already projected (earlier call) — still record its turn so this call's
        // replies/edits attach to it.
        const existingId = projectedPromptBySourceId.get(sourceId);
        if (existingId) turnMap.set(rec.id, existingId);
        continue;
      }
      const { event } = await logEvent(author, {
        type: 'prompt',
        text: rec.text ?? '',
        tool: rec.tool,
        timestamp: rec.ts,
        gitCommit: rec.gitCommit,
        sourceId,
        sessionId: repoSession.id,
        batchId,
      });
      turnMap.set(rec.id, event.id);
      seen.add(sourceId);
      out.projected += 1;
      out.prompts += 1;
      out.lastPromptId = event.id;
    } else if (rec.kind === 'ai_output' || rec.kind === 'decision') {
      if (seen.has(sourceId)) continue;
      await logEvent(author, {
        type: rec.kind,
        text: rec.text ?? '',
        tool: rec.tool,
        timestamp: rec.ts,
        turnId,
        sourceId,
        sessionId: repoSession.id,
        batchId,
      });
      seen.add(sourceId);
      out.projected += 1;
      if (rec.kind === 'ai_output') out.replies += 1;
      else out.decisions += 1;
    } else if (rec.kind === 'plan') {
      if (seen.has(sourceId)) continue;
      const tags =
        rec.approved === true
          ? [PLAN_APPROVED_TAG]
          : rec.approved === false
            ? [PLAN_REVISED_TAG]
            : undefined;
      // When the tool wrote a real plan file, link it (materialized once, keyed by
      // its own id); otherwise `logEvent` materializes the plan's own text.
      const planPath = rec.planFileContent
        ? materializePlan(author.shared, {
            text: rec.planFileContent,
            sourceId: rec.planFileSourceId ?? sourceId,
          }).planPath
        : undefined;
      await logEvent(author, {
        type: 'plan',
        text: rec.text ?? '',
        tool: rec.tool,
        timestamp: rec.ts,
        turnId,
        sourceId,
        sessionId: repoSession.id,
        batchId,
        tags,
        planPath,
      });
      seen.add(sourceId);
      out.projected += 1;
      out.plans += 1;
    } else if (rec.kind === 'edit') {
      if (!rec.file || seenArtifacts.has(sourceId)) continue;
      const path = toRepoRelative(author.shared.root, rec.file);
      if (rec.diff) {
        const wrote = importEditArtifact(author, {
          path,
          diff: rec.diff,
          tool: rec.tool,
          turnId,
          timestamp: rec.ts,
          sessionId: repoSession.id,
          sourceId,
          batchId,
          sha256: rec.sha256,
          gitCommit: rec.gitCommit,
        });
        if (wrote) {
          seenArtifacts.add(sourceId);
          out.projected += 1;
          out.edits += 1;
        }
      } else {
        // No captured diff — snapshot the file if it still exists at this root.
        // (Best-effort: hash-deduped by addArtifact, so a re-materialize is safe.)
        try {
          const res = await addArtifact(author, {
            filePath: rec.file,
            tool: rec.tool,
            turnId,
            sessionId: repoSession.id,
          });
          if (res.created) {
            out.projected += 1;
            out.edits += 1;
          }
        } catch {
          // File isn't present at the target root — nothing to snapshot. Skip.
        }
      }
    }
  }

  return out;
}
