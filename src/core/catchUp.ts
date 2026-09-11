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
 * transcript-read failures are skipped. Routing changes are returned to the
 * caller so it can redirect or stop before reading a trail cleanup removed.
 */
import { existsSync } from 'node:fs';
import { CaptureInterruptedError } from './captureGuard.ts';
import { findTranscriptBySessionId, readTranscriptFile } from './claudeCode.ts';
import { captureTranscriptToLedger } from './ledgerCapture.ts';
import {
  allLedgerSessions,
  ensureLedgerSegments,
  knownTrailPath,
  ledgerSegmentSelector,
  listLedgerSegmentViews,
  markLedgerSegmentInbox,
  markLedgerSegmentPlaced,
  markInbox,
  readLedgerRecords,
  readLedgerSession,
  sessionProjectContext,
  setLedgerTranscriptPath,
  trailExistsAt,
  type LedgerSession,
} from './ledger.ts';
import { materializeLedgerSegment, materializeLedgerSession } from './materialize.ts';
import {
  clearOtherLedgerProjections,
  removeLedgerSegmentProjection,
} from './projectionRouting.ts';
import { toolCaptureEnabledAt, toolCaptureGloballyDisabled } from './globalConfig.ts';
import { getPluginById } from '../plugins/registry.ts';
import {
  readConfig,
  samePath,
  type AuthorPaths,
  type ProjectContext,
} from './storage.ts';

/** Tools whose transcripts this sweep knows how to locate and re-read. */
const SWEEPABLE_TOOLS = new Set(['claude-code']);

/** What a sweep recovered, for an optional one-line note to the student. */
export interface CatchUpResult {
  /** New events/artifacts folded into the trail (0 when everything was current). */
  projected: number;
  /** Ledger sessions that gained records or changed routing after a re-read. */
  sessions: number;
  /** Sessions whose complete evidence now resolves to a different single root. */
  reroutedSessions: Array<{ id: string; root: string }>;
  /** Sessions whose complete evidence spans more than one project. */
  pendingAmbiguous: Array<{ id: string; candidates: string[] }>;
  /** Independently routed turns whose destination differs from this report root. */
  reroutedRanges?: Array<{
    selector: string;
    sessionId: string;
    segmentId: string;
    root: string;
  }>;
  /** Atomic multi-root turns that remain unresolved in the inbox. */
  pendingAmbiguousRanges?: Array<{
    selector: string;
    sessionId: string;
    segmentId: string;
    candidates: string[];
  }>;
  /** Cleanup removed the trail whose report triggered this sweep. */
  activeTrailRemoved: boolean;
}

/** Whether transcript capture changed the project routing evidence itself. */
function sameRoutingContext(a: ProjectContext, b: ProjectContext): boolean {
  if (a.state === 'none' || b.state === 'none') return a.state === b.state;
  if (a.state === 'ambiguous' || b.state === 'ambiguous') {
    if (a.state !== 'ambiguous' || b.state !== 'ambiguous') return false;
    return (
      a.candidates.length === b.candidates.length &&
      a.candidates.every((candidate) =>
        b.candidates.some((other) => samePath(candidate, other)),
      )
    );
  }
  return samePath(a.root, b.root);
}

function targetMatchesReportRoot(
  target: { trailId: string; path: string },
  trailId: string,
  reportRoot: string,
): boolean {
  if (target.trailId !== trailId) return false;
  if (samePath(target.path, reportRoot)) return true;

  // A still-live target at another path is a copied-trail conflict, not a move.
  // Never let the shared trail id make a report in one copy sweep the other.
  if (trailExistsAt(target.path, trailId)) return false;

  // Preserve catch-up after a real move: the recorded path is gone and the
  // validated ledger location now names this report root.
  const known = knownTrailPath(trailId);
  return known !== undefined && samePath(known, reportRoot);
}

/**
 * Re-read the transcripts of every ledger session already placed into this
 * trail, folding anything new into it. Returns what was recovered.
 */
export async function catchUpFromTranscripts(
  author: AuthorPaths,
): Promise<CatchUpResult> {
  const result: CatchUpResult = {
    projected: 0,
    sessions: 0,
    reroutedSessions: [],
    pendingAmbiguous: [],
    reroutedRanges: [],
    pendingAmbiguousRanges: [],
    activeTrailRemoved: false,
  };
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
    const plugin = getPluginById(session.tool);
    // Report-time transcript reads are automatic capture too. A machine-wide
    // disconnect must not be bypassed by content the host appends after hooks
    // have stopped firing.
    const captureCliName = plugin?.connect ? plugin.cliName : undefined;
    if (captureCliName && toolCaptureGloballyDisabled(captureCliName)) continue;
    const automaticCaptureSince = captureCliName
      ? toolCaptureEnabledAt(captureCliName)
      : undefined;
    const continueAutomaticCapture = (): boolean =>
      !captureCliName ||
      (!toolCaptureGloballyDisabled(captureCliName) &&
        toolCaptureEnabledAt(captureCliName) === automaticCaptureSince);
    // Only sweep sessions already filed into *this* trail: an inbox session
    // hasn't been placed anywhere yet (that's `showtail inbox`'s job), and one
    // placed elsewhere belongs to a different project.
    if (
      !(session.targets ?? []).some((target) =>
        targetMatchesReportRoot(target, trailId, author.shared.root),
      )
    ) {
      continue;
    }

    try {
      const path = resolveTranscriptPath(session);
      if (!path) continue;
      const transcript = readTranscriptFile(path, author.shared.root, {
        includeOutsideEdits: true,
      });
      // The transcript read may race a disconnect followed by reconnect. A
      // boolean-only check would see capture enabled again and apply the stale
      // cutoff, so require the exact consent epoch we observed before the read.
      if (
        captureCliName &&
        (toolCaptureGloballyDisabled(captureCliName) ||
          toolCaptureEnabledAt(captureCliName) !== automaticCaptureSince)
      ) {
        continue;
      }
      if (!session.transcriptPath) {
        if (!continueAutomaticCapture()) continue;
        try {
          setLedgerTranscriptPath(session.id, path, continueAutomaticCapture);
        } catch (error) {
          if (error instanceof CaptureInterruptedError) continue;
          // Recording the path is an optimization; the sweep works without it.
        }
      }
      const before = readLedgerRecords(session.id).length;
      const captured = captureTranscriptToLedger(session, transcript, session.tool, [], {
        capturePathOnlyEdits: true,
        automaticCaptureSince,
        continueCapture: continueAutomaticCapture,
      });
      if (!captured) continue;
      const added = readLedgerRecords(session.id).length - before;
      const current = readLedgerSession(session.id) ?? session;
      const document = ensureLedgerSegments(current, {
        continueCapture: continueAutomaticCapture,
      });
      const views = listLedgerSegmentViews({
        includeHidden: true,
        sessionId: current.id,
      });
      let changed = added > 0;

      for (const view of views) {
        const segmentTargets = view.segment.targets ?? [];
        const targetsThisTrail = segmentTargets.some((target) =>
          targetMatchesReportRoot(target, trailId, author.shared.root),
        );
        const route = view.route;
        const routeMatchesCurrent =
          (route.state === 'tracked' || route.state === 'candidate') &&
          samePath(route.root, author.shared.root);
        if (route.state === 'ambiguous') {
          const unplacedCandidateForCurrent =
            segmentTargets.length === 0 &&
            route.candidates.some((candidate) => samePath(candidate, author.shared.root));
          if (!targetsThisTrail && !unplacedCandidateForCurrent) continue;
          if (targetsThisTrail) {
            await removeLedgerSegmentProjection(
              readLedgerSession(current.id) ?? current,
              view.segment,
              undefined,
              { continueCapture: continueAutomaticCapture },
            );
          }
          markLedgerSegmentInbox(current.id, view.segment.id, {
            continueCapture: continueAutomaticCapture,
            clearTargets: true,
          });
          const pending = {
            selector: ledgerSegmentSelector(current.id, view.segment.id),
            sessionId: current.id,
            segmentId: view.segment.id,
            candidates: route.candidates,
          };
          result.pendingAmbiguousRanges!.push(pending);
          changed = true;
          continue;
        }

        if (!targetsThisTrail && !routeMatchesCurrent) continue;

        if (
          (route.state === 'tracked' || route.state === 'candidate') &&
          !samePath(route.root, author.shared.root)
        ) {
          const rerouted = {
            selector: ledgerSegmentSelector(current.id, view.segment.id),
            sessionId: current.id,
            segmentId: view.segment.id,
            root: route.root,
          };
          result.reroutedRanges!.push(rerouted);
          changed = true;
          continue;
        }

        // A legacy edit-less first turn has no derivable route, but an existing
        // placement is still authoritative for appending its late reply/recap.
        if (!routeMatchesCurrent && !(route.state === 'none' && targetsThisTrail)) {
          continue;
        }

        // Project even when the transcript added nothing new: an earlier pass may
        // have captured a record into the ledger just before consent interrupted.
        const materialized = await materializeLedgerSegment(
          current,
          view.segment,
          author,
          { continueCapture: continueAutomaticCapture },
        );
        if (!materialized.completed) continue;
        result.projected += materialized.projected;
        changed ||= materialized.projected > 0;
        markLedgerSegmentPlaced(
          current.id,
          view.segment.id,
          trailId,
          author.shared.root,
          { continueCapture: continueAutomaticCapture },
        );
      }

      // Preserve the established whole-session handoff for a legacy one-turn
      // session. Multi-turn chats use the range arrays above so one project never
      // drags its neighbors along.
      if (document.segments.length === 1) {
        const only = views[0];
        if (only?.route.state === 'ambiguous') {
          result.pendingAmbiguous.push({
            id: current.id,
            candidates: only.route.candidates,
          });
        } else if (
          only &&
          (only.route.state === 'tracked' || only.route.state === 'candidate') &&
          !samePath(only.route.root, author.shared.root)
        ) {
          await clearOtherLedgerProjections(current, undefined, {
            continueCapture: continueAutomaticCapture,
          });
          markInbox(current.id, { continueCapture: continueAutomaticCapture });
          result.reroutedSessions.push({ id: current.id, root: only.route.root });
        }
      }

      if (changed) result.sessions += 1;
      if (!existsSync(author.shared.config)) {
        result.activeTrailRemoved = true;
        break;
      }
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
  return session.nativeSessionId
    ? findTranscriptBySessionId(session.nativeSessionId)
    : null;
}

/** This trail's stable id, or null when the config predates trail ids. */
function readConfigTrailId(author: AuthorPaths): string | undefined {
  try {
    return readConfig(author.shared).trailId;
  } catch {
    return undefined;
  }
}
