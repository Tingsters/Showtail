/**
 * Projection (materialize): replay a ledger session's captured records into a
 * target repo's `.showtail/` trail. This is the boundary the ledger's absolute,
 * machine-local paths cross into a portable, repo-relative trail — every edit
 * path is re-relativized against the target root here, and content is re-stored
 * (and re-redacted) through the normal `logEvent`/`importEditArtifact` path so a
 * projection is byte-for-byte a normal capture.
 *
 * Idempotent: every projected record carries a stable `sourceId`; append-only
 * corrections get a revision suffix before their obsolete projection is removed
 * with an explicit repair marker. A retry, live-then-reattach, or double-fire
 * therefore writes nothing new. Per-turn batches also let routing remove a wrong
 * placement without touching neighboring work.
 *
 * Called both live (the hook projects into the resolved root as work happens) and
 * on demand (`showtail reattach` projects an inbox/misattributed session into the
 * repo the user picks).
 */
import {
  addArtifact,
  importEditArtifact,
  importEditStub,
  importedArtifactSourceIds,
} from './artifacts.ts';
import { CaptureInterruptedError } from './captureGuard.ts';
import {
  importedSourceIds,
  logEvent,
  readSessionEvents,
  removeCorrectedJournalEntriesBySourceIds,
} from './events.ts';
import {
  conversationEventEnabled,
  importedConversationSourceIds,
  logConversationEvent,
} from './conversationEvents.ts';
import { materializePlan, PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from './plans.ts';
import type { PathRebase } from './pathRebase.ts';
import { sessionForNativeSession } from './sessions.ts';
import { isAbsolute, resolve } from 'node:path';
import { isPathUnder, readConfig, toRepoRelative, type AuthorPaths } from './storage.ts';
import {
  effectiveLedgerSegmentPath,
  effectiveLedgerRecords,
  ensureLedgerSegments,
  ledgerRecordProjectionSourceId,
  readLedgerSegmentRecords,
  readLedgerRecords,
  supersededLedgerRecordIds,
  type LedgerRecord,
  type LedgerSegment,
  type LedgerSession,
} from './ledger.ts';

/** The deterministic batch id a session's projected records are tagged with. */
export function ledgerBatchId(sessionId: string): string {
  return `ledger:${sessionId}`;
}

/** The deterministic batch id for one independently routeable turn. */
export function ledgerSegmentBatchId(sessionId: string, segmentId: string): string {
  return `ledger:${sessionId}:${segmentId}`;
}

type CaptureWriteResult<T> = { completed: true; value: T } | { completed: false };

/** Convert the internal cancellation signal into materialization's incomplete result. */
async function attemptCaptureWrite<T>(
  write: () => T | Promise<T>,
): Promise<CaptureWriteResult<T>> {
  try {
    return { completed: true, value: await write() };
  } catch (error) {
    if (error instanceof CaptureInterruptedError) return { completed: false };
    throw error;
  }
}

/** What a projection did, both for callers and for the hook trace. */
export interface MaterializeResult {
  /** False when an automatic caller's capture window changed during replay. */
  completed: boolean;
  /** Total new records written (0 on a re-materialize). */
  projected: number;
  prompts: number;
  replies: number;
  decisions: number;
  plans: number;
  toolCalls: number;
  recaps: number;
  edits: number;
  /** Structured conversation events projected into the machine-readable stream. */
  conversationEvents: number;
  /**
   * Edits recorded as content-free stubs because no diff was captured and the file
   * couldn't be read at this root. Counted (not silently dropped) so callers can
   * tell the student their content is unrecoverable for those.
   */
  stubs: number;
  /**
   * The repo session projected into when completed. If capture stops before that
   * session is opened, this is the native/ledger id and must not be persisted by
   * the caller; automatic callers gate all follow-up work on {@link completed}.
   */
  sessionId: string;
  /** The most recent prompt event id projected (for the user-prompt hook trace). */
  lastPromptId?: string;
}

export interface MaterializeOptions {
  /**
   * Old-root → new-root mapping for a session whose files moved, from
   * `relocate.ts`. Without it a relocated edit's stale absolute path relativizes
   * into a `../../..` escape from the target root; with it the projected path is
   * the clean repo-relative one the trail format expects.
   */
  rebase?: PathRebase;
  /**
   * Recheck a caller-owned capture window immediately before every projection
   * write. Automatic callers provide it; manual reattach/import paths omit it.
   */
  continueCapture?: () => boolean;
}

/** A ledger edit cannot be represented safely inside the selected project. */
export class ProjectionOutsideRootError extends Error {
  constructor(
    readonly file: string,
    readonly root: string,
  ) {
    super(`Cannot project edit outside ${root}: ${file}`);
    this.name = 'ProjectionOutsideRootError';
  }
}

interface ProjectedEditPath {
  abs: string;
  path: string;
}

interface LedgerProjectionState {
  effectiveRecordIds: Set<string>;
  obsoleteSourceIds: Set<string>;
}

function ledgerProjectionState(session: LedgerSession): LedgerProjectionState {
  const records = readLedgerRecords(session.id);
  const superseded = supersededLedgerRecordIds(records);
  return {
    effectiveRecordIds: new Set(
      effectiveLedgerRecords(records).map((record) => record.id),
    ),
    obsoleteSourceIds: new Set(
      records
        .filter((record) => superseded.has(record.id))
        .map((record) => ledgerRecordProjectionSourceId(session.id, record)),
    ),
  };
}

function effectiveSegmentRecords(
  session: LedgerSession,
  records: LedgerRecord[],
): LedgerRecord[] {
  const { effectiveRecordIds } = ledgerProjectionState(session);
  return records.filter((record) => effectiveRecordIds.has(record.id));
}

/** Resolve and validate every edit before any part of the session is projected. */
function projectedEditPaths(
  segment: LedgerSegment,
  records: LedgerRecord[],
  root: string,
  rebase?: PathRebase,
): Map<string, ProjectedEditPath> {
  const projected = new Map<string, ProjectedEditPath>();
  for (const record of records) {
    if (record.kind !== 'edit' || !record.file) continue;
    const rebased = effectiveLedgerSegmentPath(segment, record.file, rebase);
    const abs = resolve(root, rebased);
    const path = toRepoRelative(root, abs);
    if (
      !isPathUnder(abs, root) ||
      path === '..' ||
      path.startsWith('../') ||
      isAbsolute(path)
    ) {
      throw new ProjectionOutsideRootError(abs, root);
    }
    projected.set(record.id, { abs, path });
  }
  return projected;
}

/** Assert that replaying this whole session cannot emit an escaping edit path. */
export function assertLedgerSessionContained(
  session: LedgerSession,
  root: string,
  rebase?: PathRebase,
): void {
  const state = ledgerProjectionState(session);
  for (const segment of ensureLedgerSegments(session).segments) {
    projectedEditPaths(
      segment,
      readLedgerSegmentRecords(session.id, segment).filter((record) =>
        state.effectiveRecordIds.has(record.id),
      ),
      root,
      rebase,
    );
  }
}

/** Assert that replaying one turn cannot emit an escaping edit path. */
export function assertLedgerSegmentContained(
  session: LedgerSession,
  segment: LedgerSegment,
  root: string,
  rebase?: PathRebase,
): void {
  projectedEditPaths(
    segment,
    effectiveSegmentRecords(session, readLedgerSegmentRecords(session.id, segment)),
    root,
    rebase,
  );
}

/**
 * Replay every record of `session` into `author`'s trail, returning a breakdown of
 * what was projected (all zero when nothing was new — e.g. a re-materialize). The
 * repo session is the one mirroring this session's native id, so projections of
 * the *same* logical session into two repos cross-link by a shared native id.
 */
async function materializeLedgerRecords(
  session: LedgerSession,
  segment: LedgerSegment,
  segmentRecords: LedgerRecord[],
  author: AuthorPaths,
  batchId: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const continueCapture = options.continueCapture ?? (() => true);
  const projectionState = ledgerProjectionState(session);
  const records = segmentRecords.filter((record) =>
    projectionState.effectiveRecordIds.has(record.id),
  );
  const editPaths = projectedEditPaths(
    segment,
    records,
    author.shared.root,
    options.rebase,
  );
  const out: MaterializeResult = {
    completed: false,
    projected: 0,
    prompts: 0,
    replies: 0,
    decisions: 0,
    plans: 0,
    toolCalls: 0,
    recaps: 0,
    edits: 0,
    conversationEvents: 0,
    stubs: 0,
    sessionId: session.nativeSessionId ?? session.id,
  };
  if (!continueCapture()) return out;
  const opened = await attemptCaptureWrite(() =>
    sessionForNativeSession(author, session.nativeSessionId ?? session.id, {
      tool: session.tool,
      continueCapture,
    }),
  );
  if (!opened.completed) return out;
  const repoSession = opened.value;
  out.sessionId = repoSession.id;
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
  // Tool calls obey the target project's own setting, same as the direct-write
  // reconcile path; recaps (turn stats) are captured regardless, like decisions/plans.
  const settings = readConfig(author.shared).settings;
  const captureTools = settings.captureToolCalls !== false;
  const seenConversation = importedConversationSourceIds(author);
  const conversationToolNames = new Map(
    records.flatMap((record) => {
      const event = record.conversationEvent;
      return event?.type === 'tool_use' && event.toolUseId && event.toolName
        ? [[event.toolUseId, event.toolName] as const]
        : [];
    }),
  );

  for (const rec of records) {
    const sourceId = ledgerRecordProjectionSourceId(session.id, rec);
    const effectiveTurnKey = rec.turnKey ?? segment.promptRecordId;
    const turnId = effectiveTurnKey ? turnMap.get(effectiveTurnKey) : undefined;

    if (rec.kind === 'prompt') {
      if (seen.has(sourceId)) {
        // Already projected (earlier call) — still record its turn so this call's
        // replies/edits attach to it.
        const existingId = projectedPromptBySourceId.get(sourceId);
        if (existingId) turnMap.set(rec.id, existingId);
        continue;
      }
      if (!continueCapture()) return out;
      const logged = await attemptCaptureWrite(() =>
        logEvent(author, {
          type: 'prompt',
          text: rec.text ?? '',
          tool: rec.tool,
          timestamp: rec.ts,
          gitCommit: rec.gitCommit,
          sourceId,
          sessionId: repoSession.id,
          batchId,
          continueCapture,
        }),
      );
      if (!logged.completed) return out;
      const { event } = logged.value;
      turnMap.set(rec.id, event.id);
      seen.add(sourceId);
      out.projected += 1;
      out.prompts += 1;
      out.lastPromptId = event.id;
    } else if (rec.kind === 'ai_output' || rec.kind === 'decision') {
      if (seen.has(sourceId)) continue;
      if (!continueCapture()) return out;
      const eventType = rec.kind;
      const logged = await attemptCaptureWrite(() =>
        logEvent(author, {
          type: eventType,
          text: rec.text ?? '',
          tool: rec.tool,
          timestamp: rec.ts,
          turnId,
          sourceId,
          sessionId: repoSession.id,
          batchId,
          continueCapture,
        }),
      );
      if (!logged.completed) return out;
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
      let planPath: string | undefined;
      if (rec.planFileContent) {
        if (!continueCapture()) return out;
        const materialized = await attemptCaptureWrite(() =>
          materializePlan(author.shared, {
            text: rec.planFileContent!,
            sourceId: rec.planFileSourceId ?? sourceId,
            continueCapture,
          }),
        );
        if (!materialized.completed) return out;
        planPath = materialized.value.planPath;
      }
      if (!continueCapture()) return out;
      const logged = await attemptCaptureWrite(() =>
        logEvent(author, {
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
          continueCapture,
        }),
      );
      if (!logged.completed) return out;
      seen.add(sourceId);
      out.projected += 1;
      out.plans += 1;
    } else if (rec.kind === 'tool_call') {
      if (!captureTools || seen.has(sourceId)) continue;
      if (!continueCapture()) return out;
      const logged = await attemptCaptureWrite(() =>
        logEvent(author, {
          type: 'tool_call',
          text: rec.text ?? '',
          tool: rec.tool,
          timestamp: rec.ts,
          turnId,
          sourceId,
          sessionId: repoSession.id,
          batchId,
          toolName: rec.toolName,
          isError: rec.isError,
          continueCapture,
        }),
      );
      if (!logged.completed) return out;
      seen.add(sourceId);
      out.projected += 1;
      out.toolCalls += 1;
    } else if (rec.kind === 'recap') {
      if (seen.has(sourceId)) continue;
      if (!continueCapture()) return out;
      const logged = await attemptCaptureWrite(() =>
        logEvent(author, {
          type: 'recap',
          text: rec.text ?? '',
          tool: rec.tool,
          timestamp: rec.ts,
          turnId,
          sourceId,
          sessionId: repoSession.id,
          batchId,
          durationMs: rec.durationMs,
          gitBranch: rec.gitBranch,
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheCreationTokens: rec.cacheCreationTokens,
          continueCapture,
        }),
      );
      if (!logged.completed) return out;
      seen.add(sourceId);
      out.projected += 1;
      out.recaps += 1;
    } else if (rec.kind === 'conversation_event') {
      if (!rec.conversationEvent || seenConversation.has(sourceId) || !turnId) continue;
      if (
        !conversationEventEnabled(rec.conversationEvent, conversationToolNames, settings)
      ) {
        continue;
      }
      if (!continueCapture()) return out;
      const logged = await attemptCaptureWrite(() =>
        logConversationEvent(author, {
          event: { ...rec.conversationEvent!, sourceId },
          tool: rec.tool,
          turnId,
          sessionId: repoSession.id,
          batchId,
          continueCapture,
        }),
      );
      if (!logged.completed) return out;
      seenConversation.add(sourceId);
      out.projected += 1;
      out.conversationEvents += 1;
    } else if (rec.kind === 'edit') {
      if (!rec.file || seenArtifacts.has(sourceId)) continue;
      const { abs, path } = editPaths.get(rec.id)!;
      if (rec.diff) {
        if (!continueCapture()) return out;
        const imported = await attemptCaptureWrite(() =>
          importEditArtifact(author, {
            path,
            diff: rec.diff!,
            tool: rec.tool,
            turnId,
            timestamp: rec.ts,
            sessionId: repoSession.id,
            sourceId,
            batchId,
            sha256: rec.sha256,
            gitCommit: rec.gitCommit,
            continueCapture,
          }),
        );
        if (!imported.completed) return out;
        if (imported.value) {
          seenArtifacts.add(sourceId);
          out.projected += 1;
          out.edits += 1;
        }
      } else {
        // No captured diff — snapshot the file if it still exists at this root.
        // (Best-effort: hash-deduped by addArtifact, so a re-materialize is safe.)
        let snapshotted = false;
        try {
          if (!continueCapture()) return out;
          const captured = await attemptCaptureWrite(() =>
            addArtifact(author, {
              filePath: abs,
              tool: rec.tool,
              turnId,
              sessionId: repoSession.id,
              sourceId,
              batchId,
              continueCapture,
            }),
          );
          if (!captured.completed) return out;
          const res = captured.value;
          if (!continueCapture()) return out;
          snapshotted = true;
          if (res.created) {
            out.projected += 1;
            out.edits += 1;
          }
        } catch {
          // Not readable at this root — the file moved away, was deleted, or never
          // travelled. Fall through to a stub.
        }
        if (!snapshotted) {
          // Record that this file changed rather than dropping the record on the
          // floor. The content is unrecoverable (nothing captured it, and the file
          // is gone), but the edit itself is real provenance and is counted so the
          // caller can say so out loud.
          if (!continueCapture()) return out;
          const imported = await attemptCaptureWrite(() =>
            importEditStub(author, {
              path,
              tool: rec.tool,
              turnId,
              timestamp: rec.ts,
              sessionId: repoSession.id,
              sourceId,
              batchId,
              sha256: rec.sha256,
              gitCommit: rec.gitCommit,
              continueCapture,
            }),
          );
          if (!imported.completed) return out;
          if (imported.value) {
            seenArtifacts.add(sourceId);
            out.projected += 1;
            out.edits += 1;
            out.stubs += 1;
          }
        }
      }
    }
  }

  // Keep the prior revision visible until every effective replacement is durable.
  // If capture stops before cleanup, a retry sees the new revision and only needs
  // to remove the obsolete entries; the trail is never left with neither version.
  if (projectionState.obsoleteSourceIds.size > 0) {
    if (!continueCapture()) return out;
    const removed = await attemptCaptureWrite(() =>
      removeCorrectedJournalEntriesBySourceIds(
        author,
        projectionState.obsoleteSourceIds,
        `ledger:${session.id}:capture-correction`,
      ),
    );
    if (!removed.completed) return out;
  }
  if (!continueCapture()) return out;
  out.completed = true;
  return out;
}

function emptyMaterializeResult(session: LedgerSession): MaterializeResult {
  return {
    completed: true,
    projected: 0,
    prompts: 0,
    replies: 0,
    decisions: 0,
    plans: 0,
    toolCalls: 0,
    recaps: 0,
    edits: 0,
    conversationEvents: 0,
    stubs: 0,
    sessionId: session.nativeSessionId ?? session.id,
  };
}

function addMaterializeResult(total: MaterializeResult, next: MaterializeResult): void {
  total.completed = total.completed && next.completed;
  total.projected += next.projected;
  total.prompts += next.prompts;
  total.replies += next.replies;
  total.decisions += next.decisions;
  total.plans += next.plans;
  total.toolCalls += next.toolCalls;
  total.recaps += next.recaps;
  total.edits += next.edits;
  total.conversationEvents += next.conversationEvents;
  total.stubs += next.stubs;
  total.sessionId = next.sessionId;
  if (next.lastPromptId) total.lastPromptId = next.lastPromptId;
}

/** Replay one independently routed prompt turn into a project trail. */
export async function materializeLedgerSegment(
  session: LedgerSession,
  segmentOrId: LedgerSegment | string,
  author: AuthorPaths,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const segmentId = typeof segmentOrId === 'string' ? segmentOrId : segmentOrId.id;
  const segment = ensureLedgerSegments(session).segments.find(
    (candidate) => candidate.id === segmentId,
  );
  if (!segment) return emptyMaterializeResult(session);
  const records = readLedgerSegmentRecords(session.id, segment);
  return materializeLedgerRecords(
    session,
    segment,
    records,
    author,
    ledgerSegmentBatchId(session.id, segment.id),
    options,
  );
}

/** Public command vocabulary alias. */
export const materializeLedgerRange = materializeLedgerSegment;

/**
 * Compatibility wrapper: validate the complete native session before replay,
 * then materialize each turn with its own removable batch.
 */
export async function materializeLedgerSession(
  session: LedgerSession,
  author: AuthorPaths,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const document = ensureLedgerSegments(session);
  for (const segment of document.segments) {
    assertLedgerSegmentContained(session, segment, author.shared.root, options.rebase);
  }
  const total = emptyMaterializeResult(session);
  for (const segment of document.segments) {
    const result = await materializeLedgerSegment(session, segment, author, options);
    addMaterializeResult(total, result);
    if (!result.completed) return total;
  }
  return total;
}
