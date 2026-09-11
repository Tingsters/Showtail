/**
 * Capture a normalized {@link HookTranscript} into a ledger session — the shared
 * primitive behind both live Stop reconcile (commands/hook.ts) and the offline
 * `import … --auto` paths. Records are deduped by `sourceId`; a later completed
 * provider response appends an auditable superseding revision.
 *
 * Extracted from commands/hook.ts so the import commands can route folderless work
 * to the ledger/inbox the same way the live hook does, instead of dumping it into a
 * catch-all trail.
 */
import { resolve } from 'node:path';
import {
  appendLedgerRecord,
  effectiveLedgerRecords,
  effectiveLedgerPath,
  ensureLedgerSegments,
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

function copilotPromptRequestIdentity(
  sourceId: string,
): { nativeSessionId: string; nativeRequestId: string } | undefined {
  const parts = sourceId.split(':');
  if (parts.length < 4 || parts[0] !== 'copilot' || parts[1] !== 'user') {
    return undefined;
  }
  const nativeRequestId = parts.at(-1);
  const nativeSessionId = parts.slice(2, -1).join(':');
  return nativeRequestId && nativeSessionId
    ? { nativeSessionId, nativeRequestId }
    : undefined;
}

/**
 * Mirror a tool transcript's CONVERSATION (AI replies, decisions, plans) into the
 * ledger, attributing each to the prompt record it followed — so a folderless /
 * inbox session carries its whole thread into `reattach`, not just prompts + edits.
 * Idempotent: dedups by the transcript's per-message `sourceId`, except when a
 * completed response must supersede a partial draft or repair wrong-turn linkage.
 * It is safe to run on every Stop (and on every post-edit for hosts that only fire
 * that). This is the ledger half of making the repo a pure projection.
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
  const effectiveBySourceId = new Map<string, LedgerRecord>();
  const promptBySourceId = new Map<string, string>();
  const promptByText = new Map<string, string[]>();
  const promptByNativeRequestId = new Map<string, string[]>();
  const promptById = new Map<string, LedgerRecord>();
  const claimedPromptIds = new Set<string>();
  const addPromptCandidate = (index: Map<string, string[]>, key: string, id: string) => {
    const candidates = index.get(key) ?? [];
    if (!candidates.includes(id)) candidates.push(id);
    index.set(key, candidates);
  };
  // Fold records into the dedup indexes, skipping any already folded in (so a
  // mid-reconcile re-read only adds records that newly appeared on disk).
  const indexedIds = new Set<string>();
  const indexedRecords: LedgerRecord[] = [];
  const ingest = (records: LedgerRecord[]): void => {
    for (const r of records) {
      if (indexedIds.has(r.id)) continue;
      indexedIds.add(r.id);
      indexedRecords.push(r);
      if (r.kind !== 'prompt') continue;
      promptById.set(r.id, r);
      if (r.sourceId) promptBySourceId.set(r.sourceId, r.id);
      if (r.text !== undefined) {
        addPromptCandidate(promptByText, r.text, r.id);
      }
      const request = r.sourceId ? copilotPromptRequestIdentity(r.sourceId) : undefined;
      if (request?.nativeSessionId === session.nativeSessionId) {
        addPromptCandidate(promptByNativeRequestId, request.nativeRequestId, r.id);
      }
    }
    effectiveBySourceId.clear();
    for (const record of effectiveLedgerRecords(indexedRecords)) {
      if (record.sourceId) effectiveBySourceId.set(record.sourceId, record);
    }
  };
  ingest(readRecords(session.id));
  const persistedSession = readLedgerSession(session.id) ?? session;
  for (const segment of ensureLedgerSegments(persistedSession).segments) {
    if (segment.promptRecordId && segment.nativeRequestId) {
      addPromptCandidate(
        promptByNativeRequestId,
        segment.nativeRequestId,
        segment.promptRecordId,
      );
    }
  }
  const uniqueUnclaimed = (candidates: readonly string[] | undefined) => {
    const available = (candidates ?? []).filter((id) => !claimedPromptIds.has(id));
    return available.length === 1 ? available[0] : undefined;
  };
  const nativeRequestIdFor = (msg: HookTranscript['messages'][number]) => {
    if (tool !== 'github-copilot') return undefined;
    const explicit = msg.requestId?.trim();
    if (explicit) return explicit;
    const request = copilotPromptRequestIdentity(msg.sourceId);
    return request?.nativeSessionId === (transcript.sessionId ?? session.nativeSessionId)
      ? request.nativeRequestId
      : undefined;
  };
  const matchPrompt = (
    msg: HookTranscript['messages'][number],
    nativeRequestId: string | undefined,
  ): string | undefined => {
    const exact = promptBySourceId.get(msg.sourceId);
    if (exact && !claimedPromptIds.has(exact)) return exact;
    if (nativeRequestId) {
      return uniqueUnclaimed(promptByNativeRequestId.get(nativeRequestId));
    }
    return uniqueUnclaimed(promptByText.get(msg.text));
  };
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
      const nativeRequestId = nativeRequestIdFor(msg);
      let recId = matchPrompt(msg, nativeRequestId);
      if (!recId) {
        // Snapshot says missing — but the live hook for this turn may have appended
        // it after we read (see the function header). Re-read fresh and retry before
        // concluding it's missing, so we match the live record instead of duplicating.
        ingest(readRecords(session.id));
        recId = matchPrompt(msg, nativeRequestId);
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
        ingest([rec]);
      }
      claimedPromptIds.add(recId);
      lastBoundaryMayReplaceInitial = boundaryMayReplaceInitial(recId, msg.timestamp);
      if (recId === initialPersistedTurnKey) sawInitialTurnBoundary = true;
      currentTurnKey = recId;
      lastPromptKey = recId;
      promptBySourceId.set(msg.sourceId, recId);
      if (nativeRequestId) {
        addPromptCandidate(promptByNativeRequestId, nativeRequestId, recId);
      }
      if (tool === 'github-copilot' && nativeRequestId && inAutomaticWindow) {
        const routed = msg as typeof msg & {
          attachments?: LedgerProjectAttachment[];
          projectControl?: LedgerProjectControlInput;
        };
        if (!continueCapture()) return false;
        setLedgerTurnProjectMetadata(session.id, recId, {
          nativeRequestId,
          attachments: routed.attachments,
          controlTarget: routed.projectControl,
          observedAt: msg.timestamp,
          continueCapture,
        });
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
      if (!currentTurnKey) continue;
      const kind = msg.role === 'assistant' ? 'ai_output' : msg.role;
      const existing = effectiveBySourceId.get(msg.sourceId);
      if (existing && existing.kind !== kind) continue;
      const finalUpgrade =
        msg.role === 'assistant' &&
        msg.isFinal === true &&
        (existing?.transcriptFinal !== true || existing.text !== msg.text);
      const linkageCorrection =
        existing !== undefined && existing.turnKey !== currentTurnKey;
      if (existing && !finalUpgrade && !linkageCorrection) continue;
      if (!continueCapture()) return false;
      const appended = appendLedgerRecord(session.id, {
        kind,
        tool,
        text: msg.text,
        ts: msg.timestamp,
        turnKey: currentTurnKey,
        sourceId: msg.sourceId,
        supersedesRecordId: existing?.id,
        transcriptFinal: msg.role === 'assistant' ? msg.isFinal : undefined,
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
      ingest([appended]);
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
        const existing = effectiveBySourceId.get(editSourceId);
        if (existing && existing.kind !== 'edit') continue;
        if (existing && existing.turnKey === currentTurnKey) continue;
        if (!continueCapture()) return false;
        const appended = appendLedgerRecord(session.id, {
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
          supersedesRecordId: existing?.id,
          ts: msg.timestamp,
        });
        ingest([appended]);
      }
    }
  }

  // The structured stream is stored independently from the human-readable
  // messages above. This keeps report fidelity without changing educator-facing
  // event counts or rendering.
  const assistantFinalBySourceId = new Map(
    transcript.messages.flatMap((message) =>
      message.role === 'assistant' && message.isFinal !== undefined
        ? [[message.sourceId, message.isFinal] as const]
        : [],
    ),
  );
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
    const existing = effectiveBySourceId.get(sourceId);
    if (existing && existing.kind !== 'conversation_event') continue;
    const transcriptFinal = assistantFinalBySourceId.get(event.sourceId);
    const finalUpgrade =
      transcriptFinal === true &&
      (existing?.transcriptFinal !== true ||
        JSON.stringify(existing.conversationEvent) !== JSON.stringify(event));
    const linkageCorrection =
      existing !== undefined && existing.turnKey !== conversationTurnKey;
    if (existing && !finalUpgrade && !linkageCorrection) continue;
    if (!continueCapture()) return false;
    const appended = appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool,
      ts: event.timestamp,
      turnKey: conversationTurnKey,
      sourceId,
      conversationEvent: event,
      supersedesRecordId: existing?.id,
      transcriptFinal,
    });
    ingest([appended]);
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
