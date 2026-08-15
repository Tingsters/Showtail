/**
 * Catch-up sweep: re-read the host tools' own transcripts and fold in anything
 * the live hooks could not see.
 *
 * Why this exists — hooks alone cannot capture a complete session:
 *  - The transcript is written *asynchronously*. Claude Code documents
 *    `transcript_path` as "written asynchronously, may lag current turn", and in
 *    practice a turn's final assistant message can land in the file tens of
 *    milliseconds *after* the Stop hook has already read it. Mid-session this
 *    self-heals (the next turn's Stop re-reads the whole file), but the last
 *    turn of a session has no "next Stop" — so its closing message is lost.
 *  - The end-of-turn recap (`away_summary`) is appended *minutes* after the last
 *    hook has run, and no hook fires when it is produced. It can only ever be
 *    recovered by re-reading the transcript afterwards.
 *
 * So the trail is completed at the moment it's actually read: `showtail report`
 * runs this first. Idempotent by construction — it reuses the same
 * ledger-capture + projection path as the live hooks, which dedupe by
 * `sourceId`, so sweeping repeatedly adds nothing. Entirely best-effort: any
 * failure leaves the trail exactly as it was and is never surfaced as an error.
 */
import { findTranscriptBySessionId, readTranscriptFile } from './claudeCode.ts';
import { captureTranscriptToLedger } from './ledgerCapture.ts';
import {
  allLedgerSessions,
  readLedgerRecords,
  setLedgerTranscriptPath,
  type LedgerSession,
} from './ledger.ts';
import { materializeLedgerSession } from './materialize.ts';
import { readConfig, type AuthorPaths } from './storage.ts';

/** Tools whose transcripts this sweep knows how to locate and re-read. */
const SWEEPABLE_TOOLS = new Set(['claude-code']);

/** What a sweep recovered, for an optional one-line note to the student. */
export interface CatchUpResult {
  /** New events/artifacts folded into the trail (0 when everything was current). */
  projected: number;
  /** Ledger sessions whose transcripts were re-read. */
  sessions: number;
}

/**
 * Re-read the transcripts of every ledger session already placed into this
 * trail, folding anything new into it. Returns what was recovered.
 */
export async function catchUpFromTranscripts(
  author: AuthorPaths,
): Promise<CatchUpResult> {
  const result: CatchUpResult = { projected: 0, sessions: 0 };
  const trailId = readConfigTrailId(author);
  if (!trailId) return result;

  let sessions: LedgerSession[];
  try {
    sessions = allLedgerSessions();
  } catch {
    return result; // No ledger on this machine — nothing to sweep.
  }

  for (const session of sessions) {
    if (!SWEEPABLE_TOOLS.has(session.tool)) continue;
    // Only sweep sessions already filed into *this* trail: an inbox session
    // hasn't been placed anywhere yet (that's `showtail inbox`'s job), and one
    // placed elsewhere belongs to a different project.
    if (!(session.targets ?? []).some((t) => t.trailId === trailId)) continue;

    try {
      const path = resolveTranscriptPath(session);
      if (!path) continue;
      const transcript = readTranscriptFile(path, author.shared.root);
      const before = readLedgerRecords(session.id).length;
      captureTranscriptToLedger(session, transcript, session.tool);
      const added = readLedgerRecords(session.id).length - before;
      // Project even when the transcript added nothing new: an earlier run may
      // have captured records into the ledger that never reached the repo.
      const m = await materializeLedgerSession(session, author);
      result.projected += m.projected;
      if (added > 0 || m.projected > 0) result.sessions += 1;
    } catch {
      // A missing/unreadable/renamed transcript is normal (purged history, a
      // moved machine). Skip this session and keep sweeping the rest.
    }
  }

  return result;
}

/**
 * Where this session's transcript lives: the path a hook recorded, else located
 * by the tool's own session id. The lookup fallback covers sessions captured
 * before paths were recorded, and re-records what it finds so the next sweep is
 * a direct read.
 */
function resolveTranscriptPath(session: LedgerSession): string | null {
  if (session.transcriptPath) return session.transcriptPath;
  const found = session.nativeSessionId
    ? findTranscriptBySessionId(session.nativeSessionId)
    : null;
  if (found) {
    try {
      setLedgerTranscriptPath(session.id, found);
    } catch {
      // Recording the path is an optimization; the sweep works without it.
    }
  }
  return found;
}

/** This trail's stable id, or null when the config predates trail ids. */
function readConfigTrailId(author: AuthorPaths): string | undefined {
  try {
    return readConfig(author.shared).trailId;
  } catch {
    return undefined;
  }
}
