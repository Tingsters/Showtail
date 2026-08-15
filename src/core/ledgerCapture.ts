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
  readLedgerRecords,
  setLedgerTurn,
  type LedgerRecord,
  type LedgerSession,
} from './ledger.ts';
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
): void {
  const readRecords = opts.readRecords ?? readLedgerRecords;
  const isInternalPath = opts.isInternalPath ?? ((p: string) => SHOWTAIL_DIR_RE.test(p));
  // The canonical on-disk plan file for this session, if the tool wrote one
  // (Antigravity overwrites a single plan.md per update, so the last wins). Every
  // plan record links to it instead of materializing the transcript's plan text.
  const planFile = planFiles
    .filter((f) => !f.nativeSessionId || f.nativeSessionId === transcript.sessionId)
    .at(-1);
  const seen = new Set<string>();
  const promptBySourceId = new Map<string, string>();
  const promptByText = new Map<string, string[]>();
  // Fold records into the dedup indexes, skipping any already folded in (so a
  // mid-reconcile re-read only adds records that newly appeared on disk).
  const indexedIds = new Set<string>();
  const ingest = (records: LedgerRecord[]): void => {
    for (const r of records) {
      if (indexedIds.has(r.id)) continue;
      indexedIds.add(r.id);
      if (r.sourceId) seen.add(r.sourceId);
      if (r.kind !== 'prompt') continue;
      if (r.sourceId) promptBySourceId.set(r.sourceId, r.id);
      if (r.text !== undefined) {
        const q = promptByText.get(r.text) ?? [];
        q.push(r.id);
        promptByText.set(r.text, q);
      }
    }
  };
  ingest(readRecords(session.id));

  let currentTurnKey = session.currentTurnKey;
  let lastPromptKey = currentTurnKey;
  for (const msg of transcript.messages) {
    if (msg.role === 'user') {
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
        if (!opts.backfill && (!msg.timestamp || msg.timestamp < session.startedAt)) {
          currentTurnKey = undefined;
          continue;
        }
        const rec = appendLedgerRecord(session.id, {
          kind: 'prompt',
          tool,
          text: msg.text,
          ts: msg.timestamp,
          sourceId: msg.sourceId,
        });
        recId = rec.id;
        indexedIds.add(rec.id);
        promptBySourceId.set(msg.sourceId, rec.id);
        seen.add(msg.sourceId);
      }
      currentTurnKey = recId;
      lastPromptKey = recId;
    } else if (
      msg.role === 'assistant' ||
      msg.role === 'decision' ||
      msg.role === 'plan' ||
      msg.role === 'tool_call' ||
      msg.role === 'recap'
    ) {
      if (!currentTurnKey || seen.has(msg.sourceId)) continue;
      const kind = msg.role === 'assistant' ? 'ai_output' : msg.role;
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
      // Per-file clean diffs recovered from the transcript (Codex apply_patch /
      // deletions) — the reliable diff source when the live payload had the file
      // but not the diff. Deduped by `<sourceId>#<file>`, keyed to the open turn.
      for (const e of msg.edits ?? []) {
        if (!e.diff || isInternalPath(e.file)) continue;
        const editSourceId = `${msg.sourceId}#${e.file}`;
        if (seen.has(editSourceId)) continue;
        appendLedgerRecord(session.id, {
          kind: 'edit',
          tool,
          file: resolve(session.cwd ?? process.cwd(), e.file),
          diff: e.diff,
          turnKey: currentTurnKey,
          sourceId: editSourceId,
          ts: msg.timestamp,
        });
        seen.add(editSourceId);
      }
    }
  }
  if (lastPromptKey && lastPromptKey !== session.currentTurnKey) {
    setLedgerTurn(session.id, lastPromptKey);
  }
}
