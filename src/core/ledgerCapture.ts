/**
 * Capture a normalized {@link HookTranscript} into a ledger session — the shared
 * primitive behind both live Stop reconcile (commands/hook.ts) and the offline
 * `import … --auto` paths. Records are deduped by `sourceId` so re-running over an
 * append-only transcript is idempotent.
 *
 * Extracted from commands/hook.ts so the import commands can route folderless work
 * to the ledger/inbox the same way the live hook does, instead of dumping it into a
 * catch-all trail.
 */
import { resolve } from 'node:path';
import {
  appendLedgerRecord,
  effectiveLedgerPath,
  readLedgerRecords,
  readLedgerSession,
  setLedgerTurnProjectMetadata,
  setLedgerTurn,
  type LedgerProjectAttachment,
  type LedgerProjectControlInput,
  type LedgerRecord,
  type LedgerSession,
} from './ledger.ts';
import type { EditedFile } from './hookInput.ts';
import type { DiscoveredPlanFile, HookTranscript } from '../plugins/types.ts';
import type { Tool } from '../types.ts';

/** Showtail's own bookkeeping dir — always skipped, regardless of caller. */
const SHOWTAIL_DIR_RE = /(^|[\\/])\.showtail([\\/]|$)/;

export interface CaptureToLedgerOptions {
  /**
   * Capture every prompt regardless of timestamp. The live hook drops prompts
   * older than the session start (a resumed transcript's backlog), but an offline
   * `import` deliberately back-fills an already-finished conversation whose prompts
   * predate the just-created ledger session — so it must opt out of that guard or
   * everything is skipped as backlog.
   */
  backfill?: boolean;
  /**
   * Predicate marking a file as a tool's own bookkeeping (never recorded). Injected
   * (not imported) so this core module doesn't pull in the plugin registry — which
   * would close an import cycle with the command-layer plugins. The live hook passes
   * its registry-aware `isInternalPath`; the import path relies on the default
   * (only `.showtail`), as Antigravity's transcript carries no per-file diff edits.
   */
  isInternalPath?: (path: string) => boolean;
  /**
   * Read the session's records (injectable for tests, and to re-read fresh mid-
   * reconcile). Defaults to {@link readLedgerRecords}.
   */
  readRecords?: (id: string) => LedgerRecord[];
  /**
   * Retain transcript edits that name a file but provide no diff. Report catch-up
   * uses this so a missed edit still participates in whole-session routing.
   */
  capturePathOnlyEdits?: boolean;
  /**
   * Explicit reconnect boundary for automatic transcript recovery. Unseen
   * content before this time, or without a timestamp, is ignored. Prompts that
   * were already captured may still provide linkage context for later content.
   */
  automaticCaptureSince?: string;
  /**
   * Recheck a caller-owned capture window immediately before every ledger write.
   * Automatic callers use this to stop a replay if consent changes mid-batch;
   * manual imports omit it and retain their historical behavior.
   */
  continueCapture?: () => boolean;
}

/** Whether timestamped content falls inside the current automatic-capture window. */
export function automaticCaptureTimestampAllowed(
  timestamp: string | undefined,
  automaticCaptureSince: string | undefined,
): boolean {
  if (!automaticCaptureSince) return true;
  if (!timestamp) return false;
  const cutoff = Date.parse(automaticCaptureSince);
  const observed = Date.parse(timestamp);
  return Number.isFinite(cutoff) && Number.isFinite(observed) && observed >= cutoff;
}

/**
 * Mirror a tool transcript's CONVERSATION (AI replies, decisions, plans) into the
 * ledger, attributing each to the prompt record it followed — so a folderless /
 * inbox session carries its whole thread into `reattach`, not just prompts + edits.
 * Idempotent: dedups by the transcript's per-message `sourceId` against records
 * already in the session, so it is safe to run on every Stop (and on every
 * post-edit for hosts that only fire that). This is the ledger half of making the
 * repo a pure projection.
 *
 * A prompt has two writers: the live `user-prompt` hook and this reconcile's
 * back-fill. For a turn the live hook always fires first, but in a *separate*
 * process — so its append can land after we snapshot the records below. Before
 * back-filling we therefore re-read fresh (via `opts.readRecords`, injectable for
 * tests) and retry the match, so a raced live prompt is matched, not duplicated.
 */
export function captureTranscriptToLedger(
  session: LedgerSession,
  transcript: HookTranscript,
  tool: Tool,
  planFiles: DiscoveredPlanFile[] = [],
  opts: CaptureToLedgerOptions = {},
): boolean {
  const readRecords = opts.readRecords ?? readLedgerRecords;
  const isInternalPath = opts.isInternalPath ?? ((p: string) => SHOWTAIL_DIR_RE.test(p));
  const continueCapture = opts.continueCapture ?? (() => true);
  // The canonical on-disk plan file for this session, if the tool wrote one
  // (Antigravity overwrites a single plan.md per update, so the last wins). Every
  // plan record links to it instead of materializing the transcript's plan text.
  // On-disk plan files have no trustworthy creation timestamp. Across a resume
  // boundary, use only the eligible transcript plan text rather than attaching
  // file content that may have been written while capture was stopped.
  const planFile = opts.automaticCaptureSince
    ? undefined
    : planFiles
        .filter((f) => !f.nativeSessionId || f.nativeSessionId === transcript.sessionId)
        .at(-1);
  const seen = new Set<string>();
  const seenConversation = new Set<string>();
  const promptBySourceId = new Map<string, string>();
  const promptByText = new Map<string, string[]>();
  const promptById = new Map<string, LedgerRecord>();
  // Fold records into the dedup indexes, skipping any already folded in (so a
  // mid-reconcile re-read only adds records that newly appeared on disk).
  const indexedIds = new Set<string>();
  const ingest = (records: LedgerRecord[]): void => {
    for (const r of records) {
      if (indexedIds.has(r.id)) continue;
      indexedIds.add(r.id);
      if (r.sourceId) seen.add(r.sourceId);
      if (r.kind === 'conversation_event' && r.sourceId) seenConversation.add(r.sourceId);
      if (r.kind !== 'prompt') continue;
      promptById.set(r.id, r);
      if (r.sourceId) promptBySourceId.set(r.sourceId, r.id);
      if (r.text !== undefined) {
        const q = promptByText.get(r.text) ?? [];
        q.push(r.id);
        promptByText.set(r.text, q);
      }
    }
  };
  ingest(readRecords(session.id));
  const initialPersistedTurnKey = session.currentTurnKey;

  // A reconnect starts a new automatic-capture window. Do not implicitly attach
  // the first recovered child record to whatever turn happened to be current
  // before capture stopped; an already-recorded prompt must appear in the
  // transcript and be matched explicitly to provide cross-boundary context.
  let currentTurnKey = opts.automaticCaptureSince ? undefined : session.currentTurnKey;
  let lastPromptKey = currentTurnKey;
  let sawUserBoundary = false;
  let sawInitialTurnBoundary = false;
  let lastBoundaryMayReplaceInitial = initialPersistedTurnKey === undefined;
  const boundaryMayReplaceInitial = (
    promptKey: string | undefined,
    timestamp: string | undefined,
  ): boolean => {
    if (!initialPersistedTurnKey || promptKey === initialPersistedTurnKey) return true;
    if (sawInitialTurnBoundary) return true;

    const initialPrompt = promptById.get(initialPersistedTurnKey);
    if (!initialPrompt) return false;
    const boundaryTimestamp = promptKey ? promptById.get(promptKey)?.ts : timestamp;
    if (!boundaryTimestamp) return false;
    const initialTime = Date.parse(initialPrompt.ts);
    const boundaryTime = Date.parse(boundaryTimestamp);
    return (
      Number.isFinite(initialTime) &&
      Number.isFinite(boundaryTime) &&
      boundaryTime > initialTime
    );
  };
  for (const msg of transcript.messages) {
    const inAutomaticWindow = automaticCaptureTimestampAllowed(
      msg.timestamp,
      opts.automaticCaptureSince,
    );
    if (msg.role === 'user') {
      sawUserBoundary = true;
      let recId =
        promptBySourceId.get(msg.sourceId) ?? promptByText.get(msg.text)?.shift();
      if (!recId) {
        // Snapshot says missing — but the live hook for this turn may have appended
        // it after we read (see the function header). Re-read fresh and retry before
        // concluding it's missing, so we match the live record instead of duplicating.
        ingest(readRecords(session.id));
        recId = promptBySourceId.get(msg.sourceId) ?? promptByText.get(msg.text)?.shift();
      }
      if (!recId) {
        // Genuinely uncaptured (e.g. a plan-mode turn the live hook never logged) —
        // back-fill only when it's in-window (at/after this session started), so a
        // resumed transcript isn't replayed. An explicit `backfill` import wants the
        // whole already-finished conversation regardless of its timestamps.
        if (
          !inAutomaticWindow ||
          (!opts.backfill && (!msg.timestamp || msg.timestamp < session.startedAt))
        ) {
          lastBoundaryMayReplaceInitial = boundaryMayReplaceInitial(
            undefined,
            msg.timestamp,
          );
          currentTurnKey = undefined;
          lastPromptKey = undefined;
          continue;
        }
        if (!continueCapture()) return false;
        const rec = appendLedgerRecord(session.id, {
          kind: 'prompt',
          tool,
          text: msg.text,
          ts: msg.timestamp,
          sourceId: msg.sourceId,
        });
        recId = rec.id;
        indexedIds.add(rec.id);
        promptById.set(rec.id, rec);
        promptBySourceId.set(msg.sourceId, rec.id);
        seen.add(msg.sourceId);
      }
      lastBoundaryMayReplaceInitial = boundaryMayReplaceInitial(recId, msg.timestamp);
      if (recId === initialPersistedTurnKey) sawInitialTurnBoundary = true;
      currentTurnKey = recId;
      lastPromptKey = recId;
      promptBySourceId.set(msg.sourceId, recId);
      if (tool === 'github-copilot' && inAutomaticWindow) {
        const routed = msg as typeof msg & {
          requestId?: string;
          attachments?: LedgerProjectAttachment[];
          projectControl?: LedgerProjectControlInput;
        };
        if (
          routed.requestId &&
          ((routed.attachments?.length ?? 0) > 0 || routed.projectControl)
        ) {
          if (!continueCapture()) return false;
          setLedgerTurnProjectMetadata(session.id, recId, {
            nativeRequestId: routed.requestId,
            attachments: routed.attachments,
            controlTarget: routed.projectControl,
            observedAt: msg.timestamp,
            continueCapture,
          });
        }
      }
    } else if (!inAutomaticWindow) {
      continue;
    } else if (
      msg.role === 'assistant' ||
      msg.role === 'decision' ||
      msg.role === 'plan' ||
      msg.role === 'tool_call' ||
      msg.role === 'recap'
    ) {
      if (!currentTurnKey || seen.has(msg.sourceId)) continue;
      const kind = msg.role === 'assistant' ? 'ai_output' : msg.role;
      if (!continueCapture()) return false;
      appendLedgerRecord(session.id, {
        kind,
        tool,
        text: msg.text,
        ts: msg.timestamp,
        turnKey: currentTurnKey,
        sourceId: msg.sourceId,
        approved: msg.role === 'plan' ? msg.approved : undefined,
        planFileContent: msg.role === 'plan' ? planFile?.content : undefined,
        planFileSourceId: msg.role === 'plan' ? planFile?.sourceId : undefined,
        toolName: msg.role === 'tool_call' ? msg.toolName : undefined,
        isError: msg.role === 'tool_call' ? msg.isError : undefined,
        durationMs: msg.role === 'recap' ? msg.durationMs : undefined,
        gitBranch: msg.role === 'recap' ? msg.gitBranch : undefined,
        inputTokens: msg.role === 'recap' ? msg.inputTokens : undefined,
        outputTokens: msg.role === 'recap' ? msg.outputTokens : undefined,
        cacheReadTokens: msg.role === 'recap' ? msg.cacheReadTokens : undefined,
        cacheCreationTokens: msg.role === 'recap' ? msg.cacheCreationTokens : undefined,
      });
      seen.add(msg.sourceId);
    } else if (msg.role === 'edit') {
      // A post-cutoff edit must belong to an eligible prompt. Otherwise an
      // unseen disabled-period prompt could smuggle its child edit across the
      // reconnect boundary as an unlinked ledger record.
      if (opts.automaticCaptureSince && !currentTurnKey) continue;
      // Per-file clean diffs recovered from the transcript (Codex apply_patch /
      // deletions) — or, during report catch-up, path-only edits whose live hook
      // was missed. Deduped by `<sourceId>#<file>`, keyed to the open turn.
      const edits: EditedFile[] =
        msg.edits && msg.edits.length > 0
          ? msg.edits
          : opts.capturePathOnlyEdits
            ? (msg.files ?? []).map((file) => ({ file }))
            : [];
      for (const e of edits) {
        if ((!e.diff && !opts.capturePathOnlyEdits) || isInternalPath(e.file)) continue;
        const editSourceId = `${msg.sourceId}#${e.file}`;
        if (seen.has(editSourceId)) continue;
        if (!continueCapture()) return false;
        appendLedgerRecord(session.id, {
          kind: 'edit',
          tool,
          file: resolve(
            typeof session.cwd === 'string'
              ? effectiveLedgerPath(session, session.cwd)
              : process.cwd(),
            e.file,
          ),
          diff: e.diff,
          turnKey: currentTurnKey,
          sourceId: editSourceId,
          ts: msg.timestamp,
        });
        seen.add(editSourceId);
      }
    }
  }

  // The structured stream is stored independently from the human-readable
  // messages above. This keeps report fidelity without changing educator-facing
  // event counts or rendering.
  let conversationTurnKey: string | undefined;
  for (const event of transcript.events ?? []) {
    if (event.type === 'user_text') {
      conversationTurnKey = promptBySourceId.get(event.sourceId);
    }
    if (!automaticCaptureTimestampAllowed(event.timestamp, opts.automaticCaptureSince)) {
      continue;
    }
    if (!conversationTurnKey) continue;
    const sourceId = `conversation:${event.sourceId}`;
    if (seenConversation.has(sourceId)) continue;
    if (!continueCapture()) return false;
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool,
      ts: event.timestamp,
      turnKey: conversationTurnKey,
      sourceId,
      conversationEvent: event,
    });
    seenConversation.add(sourceId);
  }
  if (opts.automaticCaptureSince && sawUserBoundary) {
    const persistedTurnKey = readLedgerSession(session.id)?.currentTurnKey;
    // Do not overwrite a newer live prompt that the host transcript has not
    // flushed yet, whether it was current at entry or raced this pass.
    if (
      persistedTurnKey === initialPersistedTurnKey &&
      lastBoundaryMayReplaceInitial &&
      lastPromptKey !== persistedTurnKey
    ) {
      if (!continueCapture()) return false;
      setLedgerTurn(session.id, lastPromptKey);
    }
  } else if (lastPromptKey && lastPromptKey !== session.currentTurnKey) {
    if (!continueCapture()) return false;
    setLedgerTurn(session.id, lastPromptKey);
  }
  return continueCapture();
}
