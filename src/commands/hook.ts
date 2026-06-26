import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addArtifact,
  artifactsForPath,
  importEditArtifact,
  importedArtifactSourceIds,
} from '../core/artifacts.ts';
import { changedFiles, maybeCurrentCommit } from '../core/git.ts';
import { sha256OfFile } from '../core/hash.ts';
import { readObject } from '../core/objects.ts';
import { materializePlan, PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../core/plans.ts';
import { resolveActiveAuthorForHook } from '../core/authors.ts';
import {
  importedSourceIds,
  logEvent,
  readSessionEvents,
  sweepIdleSessions,
} from '../core/events.ts';
import {
  extractPrompt,
  extractSessionId,
  readHookPayload,
  type HookPayload,
} from '../core/hookInput.ts';
import { redact } from '../core/redact.ts';
import { asString, prop } from '../core/parse.ts';
import { autoInitEnabled } from '../core/globalConfig.ts';
import {
  closeSession,
  currentSession,
  sessionForNativeSession,
  startSession,
} from '../core/sessions.ts';
import {
  ensureTrailId,
  findRoot,
  isEligibleAnchor,
  migrateLegacySessions,
  pathsForRoot,
  readConfig,
  readSessions,
  readState,
  resolveAnchor,
  setTurnForNativeSession,
  turnForNativeSession,
  updateState,
  type AuthorPaths,
} from '../core/storage.ts';
import { ensureMachineId, readMachineIdentity } from '../core/identity.ts';
import {
  appendLedgerRecord,
  endLedgerSession,
  ensureLedgerSession,
  markInbox,
  markPlaced,
  readLedgerRecords,
  readLedgerSession,
  setLedgerTurn,
  type LedgerRecord,
  type LedgerSession,
} from '../core/ledger.ts';
import { materializeLedgerSession } from '../core/materialize.ts';
import { recordHookTrace, recordRawPayload, type HookTrace } from '../core/hookTrace.ts';
import { connectPlugins, getPluginById } from '../plugins/registry.ts';
import type {
  DiscoveredPlanFile,
  HookAdapter,
  HookTranscript,
  NormalizedHookEvent,
} from '../plugins/types.ts';
import { ensureInitialized } from './init.ts';
import type { Config, Tool } from '../types.ts';

export type HookEvent =
  | 'session-start'
  | 'user-prompt'
  | 'post-edit'
  | 'stop'
  | 'session-end';

/** Default minutes of inactivity before a session auto-closes. */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;

// How recently a git-changed file must have been modified to be attributed to
// the current Codex turn by the raw-shell git backstop. Wide enough to cover a
// slow command, narrow enough to skip files left dirty by earlier turns/manual
// edits. (See the git fallback in handlePostEdit.)
const GIT_FALLBACK_WINDOW_MS = 5 * 60_000;

export interface HookOptions {
  cwd?: string;
  /** Which tool fired the hook; the plugin's id (defaults to claude-code when omitted). */
  tool?: Tool;
}

/** Showtail's own bookkeeping dir — always skipped, independent of any tool. */
const SHOWTAIL_DIR_RE = /(^|[\\/])\.showtail([\\/]|$)/;

/**
 * Don't snapshot a tool's (or Showtail's) own bookkeeping files. Registry-driven:
 * each connect plugin declares the dirs to skip for its edits (`internalPaths`)
 * and any to force-capture (`includePaths`, e.g. `.claude/worktrees/` checkouts,
 * which hold real work). No tool name appears here.
 */
export function isInternalPath(p: string): boolean {
  // Force-includes win over any skip rule (real work inside an internal dir).
  for (const plugin of connectPlugins()) {
    if (plugin.connect.hooks?.includePaths?.some((re) => re.test(p))) return false;
  }
  if (SHOWTAIL_DIR_RE.test(p)) return true;
  for (const plugin of connectPlugins()) {
    if (plugin.connect.hooks?.internalPaths.some((re) => re.test(p))) return true;
  }
  return false;
}

/** The runtime hook adapter for a tool, if it declares one (import-only and unknown tools have none). */
function adapterFor(tool: Tool): HookAdapter | undefined {
  return getPluginById(tool)?.connect?.hooks;
}

/**
 * Sole-writer mode (the full inversion) — now the DEFAULT. For any session with a
 * native session id, the repo trail is a pure *projection* of the ledger: the hook
 * captures to the ledger, then `materialize`s into the resolved root, instead of
 * the live handlers writing the repo directly. Verified at full parity with the old
 * handlers across every plugin/capability (the whole suite passes either way).
 * The live handlers remain only as the fallback for events with no native id (they
 * can't be correlated in the ledger), and for session start/end lifecycle.
 * Escape hatch: `SHOWTAIL_LEDGER_WRITER=0` restores the legacy direct-write path.
 */
function ledgerWriterEnabled(): boolean {
  const v = process.env.SHOWTAIL_LEDGER_WRITER;
  return v !== '0' && v !== 'false';
}

/**
 * Antigravity hosts (the IDE and the `agy` CLI) read a JSON *decision* from each
 * hook's stdout (`{"decision":"allow"|"deny"|"ask"}`) and FAIL CLOSED — blocking
 * the tool/model — if a hook errors or prints non-JSON. Showtail hooks only
 * observe, so they must always print an "allow" and never break the host. Claude
 * Code / Codex don't read hook stdout this way, so the decision output is gated to
 * these tools.
 */
function isAntigravityHostTool(tool: Tool): boolean {
  return tool === 'antigravity-ide' || tool === 'antigravity-cli';
}

/**
 * Normalize a raw hook payload into a tool-agnostic event. With an adapter the
 * plugin owns the parsing; without one (manual `cli`, or an unknown tool) we
 * read only the common `prompt`/`session_id` fields and capture no edits.
 */
function parseEvent(
  adapter: HookAdapter | undefined,
  payload: HookPayload | null,
): NormalizedHookEvent {
  if (!payload) return { editedFiles: [] };
  if (adapter) return adapter.parse(payload);
  return {
    nativeSessionId: extractSessionId(payload),
    prompt: extractPrompt(payload) ?? undefined,
    editedFiles: [],
  };
}

/**
 * Mirror a hook event into the durable ledger: the student's prompts and the
 * files they changed, keyed to the tool session so they survive even when no
 * project root resolves. Edit paths are stored ABSOLUTE (resolved against the
 * payload cwd) so the materialize step can re-relativize them against whatever
 * repo the session is ultimately placed in. Conversational replies are NOT
 * mirrored here — for a placed session the existing Stop reconcile captures them
 * into the trail; the ledger holds the student's own work, which is what an
 * inbox/reattach needs to never drop.
 */
async function captureToLedger(
  session: LedgerSession,
  event: HookEvent,
  parsed: NormalizedHookEvent,
  cwd: string,
): Promise<void> {
  if (event === 'user-prompt') {
    if (!parsed.prompt) return;
    const rec = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: session.tool,
      text: parsed.prompt,
      // Captured live so a projection keeps the real commit (it back-dates events).
      gitCommit: await maybeCurrentCommit(cwd, true),
    });
    setLedgerTurn(session.id, rec.id);
    return;
  }
  if (event === 'post-edit') {
    const turnKey = readLedgerSession(session.id)?.currentTurnKey;
    const gitCommit = await maybeCurrentCommit(cwd, true);
    const add = async (
      file: string,
      diff: string | undefined,
      deleted: boolean,
    ): Promise<void> => {
      if (isInternalPath(file)) return;
      const abs = resolve(cwd, file);
      // Hash the file as it stands now (the live snapshot), so a projection keeps
      // the integrity hash without re-reading a file that may have moved.
      let sha256: string | undefined;
      if (!deleted) {
        try {
          sha256 = await sha256OfFile(abs);
        } catch {
          // File gone/unreadable — record the edit without a hash.
        }
      }
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: session.tool,
        file: abs,
        diff,
        deleted,
        turnKey,
        gitCommit,
        sha256,
      });
    };
    if (parsed.edits && parsed.edits.length > 0) {
      for (const e of parsed.edits) await add(e.file, e.diff, e.deleted === true);
    } else {
      for (const f of parsed.editedFiles) await add(f, parsed.suggestedDiff, false);
    }
    return;
  }
  if (event === 'session-end') {
    endLedgerSession(session.id);
  }
}

/**
 * Mirror a tool transcript's CONVERSATION (AI replies, decisions, plans) into the
 * ledger, attributing each to the prompt record it followed — so a folderless /
 * inbox session carries its whole thread into `reattach`, not just prompts + edits.
 * Edits are skipped here (captured live by post-edit). Idempotent: dedups by the
 * transcript's per-message `sourceId` against records already in the session, so
 * it is safe to run on every Stop (and on every post-edit for hosts that only fire
 * that). This is the ledger half of making the repo a pure projection.
 *
 * A prompt has two writers: the live `user-prompt` hook and this reconcile's
 * back-fill. For a turn the live hook always fires first, but in a *separate*
 * process — so its append can land after we snapshot the records below. Before
 * back-filling we therefore re-read fresh (via `readRecords`, injectable for
 * tests) and retry the match, so a raced live prompt is matched, not duplicated.
 */
export function captureTranscriptToLedger(
  session: LedgerSession,
  transcript: HookTranscript,
  tool: Tool,
  planFiles: DiscoveredPlanFile[] = [],
  readRecords: (id: string) => LedgerRecord[] = readLedgerRecords,
): void {
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
      let recId = promptBySourceId.get(msg.sourceId) ?? promptByText.get(msg.text)?.shift();
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
        // resumed transcript isn't replayed.
        if (!msg.timestamp || msg.timestamp < session.startedAt) {
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
      msg.role === 'plan'
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

/** Mark a ledger session unplaced without ever letting bookkeeping break the hook. */
function safeMarkInbox(sessionId: string): void {
  try {
    markInbox(sessionId);
  } catch {
    // Best-effort.
  }
}

/**
 * Handle one hook event (from any connected tool). This is intentionally
 * bulletproof: any problem (no project, malformed input, missing file, or no
 * resolvable student identity) results in a silent no-op with exit code 0, so a
 * student's session is never interrupted.
 */
export async function runHook(
  event: HookEvent,
  options: HookOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  // A diagnostic record of this invocation, filled in as we go and flushed in
  // `finally` to `.showtail/diag/hooks.jsonl` (best-effort, never part of the
  // trail). `paths` is hoisted so the flush can find where to write even when an
  // early return or a throw cuts the handler short.
  const trace: HookTrace = {
    ts: new Date().toISOString(),
    event,
    tool: options.tool ?? 'claude-code',
  };
  let paths: ReturnType<typeof pathsForRoot> | undefined;
  try {
    const payload = await readHookPayload();
    const cwd = payload?.cwd ?? options.cwd ?? process.cwd();
    const tool: Tool = options.tool ?? 'claude-code';
    trace.tool = tool;
    const parsed = parseEvent(adapterFor(tool), payload);
    trace.nativeSessionId = parsed.nativeSessionId;

    let root = findRoot(cwd);

    // Durable ledger capture — runs whenever tracking is active (a trail already
    // exists, or the user has opted into auto-init via `showtail setup`), and
    // BEFORE any project root is resolved. This is what stops a folderless,
    // scratch-workspace, or zero-edit session from being dropped: the student's
    // prompts and edited files land in the machine-local ledger first, to be
    // projected into a repo now (if a root resolves) or later (`showtail
    // reattach`). Bulletproof — any failure here must never break the hook.
    // Needs the tool's own session id to correlate this event's process with the
    // session's others; the global tools we care about all send one.
    const trackingActive = root != null || autoInitEnabled();
    let ledger: LedgerSession | undefined;
    if (trackingActive && parsed.nativeSessionId) {
      try {
        ledger = ensureLedgerSession({
          tool,
          nativeSessionId: parsed.nativeSessionId,
          machineId: readMachineIdentity()?.machineId,
          slug: readMachineIdentity()?.slug,
          cwd,
        });
        await captureToLedger(ledger, event, parsed, cwd);
        // Mirror the conversation into the ledger from the tool transcript on Stop
        // (or post-edit for hosts that only fire that), so an inbox session keeps
        // its replies/decisions/plans — discoverable by native id even with no root.
        const adapter = adapterFor(tool);
        if (
          (event === 'stop' || (event === 'post-edit' && adapter?.reconcileOnPostEdit)) &&
          adapter?.getTranscript
        ) {
          const transcript = adapter.getTranscript(payload, root ?? cwd);
          if (transcript) {
            let planFiles: DiscoveredPlanFile[] = [];
            try {
              planFiles = adapter.planFiles?.(payload, root ?? cwd) ?? [];
            } catch {
              planFiles = []; // Plan-file discovery is best-effort; never break capture.
            }
            captureTranscriptToLedger(ledger, transcript, tool, planFiles);
          }
        }
      } catch {
        ledger = undefined; // Ledger problems never disrupt the session.
      }
    }

    if (!root) {
      // Automatic tracking: silently start a trail on the first real activity in
      // an eligible project (git repo / dev folder), once the user has opted in
      // via `showtail setup`. Only a task start may create one — never a stray
      // edit/stop. `isEligibleAnchor` also refuses HOME, so a whole home dir is
      // never turned into one shared trail. When no eligible root resolves the
      // work is NOT dropped — it stays in the ledger inbox (`showtail inbox`).
      if (event !== 'session-start' && event !== 'user-prompt') {
        if (ledger) safeMarkInbox(ledger.id);
        return;
      }
      if (!autoInitEnabled()) return;
      const anchor = await resolveAnchor(cwd);
      if (!isEligibleAnchor(anchor)) {
        if (ledger) safeMarkInbox(ledger.id);
        return;
      }
      await ensureInitialized(anchor);
      root = anchor;
    }
    paths = pathsForRoot(root);
    // Opt-in (SHOWTAIL_DEBUG_PAYLOAD=1) raw-payload capture, for pinning down a
    // host's exact PostToolUse payload shape. No-op unless the flag is set.
    recordRawPayload(paths, event, tool, payload);
    if (!existsSync(paths.config)) return; // Not initialized.
    const config = readConfig(paths);

    // Record where this session was placed: its stable trailId and the trail's
    // current location. Minting the trailId here also upgrades an older trail
    // (config < v4) on first sight. A later move of the repo is recognized by
    // this id; a delete leaves the session reattributable from the ledger.
    if (ledger) {
      try {
        markPlaced(ledger.id, ensureTrailId(paths), paths.root);
      } catch {
        // Placement bookkeeping is best-effort; capture already succeeded.
      }
    }

    // Resolve who is writing this trail. Cache-only / git-config at worst — never
    // prompts or hits the network, so the hook stays fast and non-blocking. If
    // identity can't be settled silently, no-op rather than guess.
    const author = await resolveActiveAuthorForHook(paths, { cwd });
    if (!author) return;
    // One-time, idempotent: fold a legacy `sessions.json` into this machine's shard
    // so old sessions can be closed/swept. No-op once migrated.
    try {
      migrateLegacySessions(author);
    } catch {
      // Migration is best-effort; a capture must never break on it.
    }

    // On any live capture, first close this author's sessions that have gone idle
    // (stamped at their last event), so a finished task's session doesn't linger
    // open. Tool-agnostic fallback to the SessionEnd hook below.
    if (event === 'user-prompt' || event === 'post-edit') {
      const idleMin = config.settings.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
      const swept = sweepIdleSessions(author, idleMin * 60_000, Date.now());
      if (swept.length > 0) trace.closedSessions = swept;
    }

    // Sole-writer mode (the full inversion, opt-in): the work is already in the
    // ledger (captured above, replies included on Stop); project it into the repo
    // instead of writing the repo from the live handlers. Session start/end keep
    // their lifecycle handlers (the context note + deterministic close) below.
    if (
      ledgerWriterEnabled() &&
      ledger &&
      (event === 'user-prompt' || event === 'post-edit' || event === 'stop')
    ) {
      const m = await materializeLedgerSession(ledger, author);
      trace.sessionId = m.sessionId;
      if (event === 'user-prompt') {
        const promptSource = asString(prop(payload, 'promptSource'));
        if (promptSource) trace.promptSource = promptSource;
        if (m.lastPromptId) trace.promptId = m.lastPromptId;
        // Make this the CLI's current session, like the live handler does, so
        // `status`/`log` see it.
        updateState(author.shared, { currentSessionId: m.sessionId });
      }
      if (m.replies > 0) trace.replies = m.replies;
      if (m.decisions > 0) trace.decisions = m.decisions;
      if (m.plans > 0) trace.plans = m.plans;
      if (m.edits > 0) trace.edits = m.edits;
      return;
    }

    switch (event) {
      case 'session-start':
        return handleSessionStart(author, payload, tool, trace);
      case 'user-prompt':
        return await handleUserPrompt(author, payload, tool, trace);
      case 'post-edit':
        return await handlePostEdit(author, payload, tool, config, trace);
      case 'stop':
        return await handleStop(author, payload, tool, config, trace);
      case 'session-end':
        return handleSessionEnd(author, payload, tool, trace);
    }
  } catch (err) {
    // Swallow everything — a hook must never break the session. Note it in the
    // trace so a silently-failed hook is still visible to the diagnostics.
    trace.error = err instanceof Error ? err.message : String(err);
    return;
  } finally {
    trace.durationMs = Date.now() - startedAt;
    if (paths) recordHookTrace(paths, trace);
    // Antigravity reads a JSON decision from the hook's stdout and fails closed on
    // a missing/invalid one. Emit "allow" here in `finally` so it runs on EVERY
    // path — early no-op return, successful capture, or a swallowed error — and a
    // capture problem can never block the user's IDE/agent. Gated to Antigravity
    // hosts (see isAntigravityHostTool); other hosts ignore hook stdout.
    if (isAntigravityHostTool(trace.tool)) {
      process.stdout.write('{"decision":"allow"}\n');
    }
  }
}

function handleSessionStart(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  trace: HookTrace,
): void {
  // Bind this session to the tool's own session id when we have one, so a
  // resume/compact reuses the *same* trail instead of spawning a new session
  // each time. Without an id (older clients), fall back to the single current
  // session. Either way this becomes the CLI's "current" session.
  const nativeSessionId = parseEvent(adapterFor(tool), payload).nativeSessionId;
  // Whether an open session already mirrored this native id tells us if the
  // bind below creates a fresh session (a resume after the prior one closed) or
  // reuses one — the distinction that matters for the lifecycle race.
  const hadOpen = nativeSessionId
    ? readSessions(author).some(
        (s) => s.nativeSessionId === nativeSessionId && !s.endedAt,
      )
    : undefined;
  const session = nativeSessionId
    ? sessionForNativeSession(author, nativeSessionId, { tool })
    : (currentSession(author) ?? startSession(author));
  trace.nativeSessionId = nativeSessionId;
  trace.sessionId = session.id;
  trace.sessionStartedAt = session.startedAt;
  if (hadOpen === false) trace.createdSession = true;
  updateState(author.shared, { currentSessionId: session.id });
  // SessionStart stdout is injected into Claude's context — keep it to one line.
  // Antigravity hosts instead read stdout as a JSON decision (emitted in runHook's
  // `finally`), so suppress this human-readable note there to keep stdout valid JSON.
  if (!isAntigravityHostTool(tool)) {
    process.stdout.write(
      `Showtail is capturing this session's work trail (session ${session.id}). ` +
        `Your prompts and edits are captured automatically — just work as usual.\n`,
    );
  }
}

/**
 * On SessionEnd (the tool's session truly ending — quit, clear, logout), close
 * the bound session deterministically rather than waiting for the idle sweep.
 * Keyed to the session that mirrors this tool session id, else the global
 * current session. Stamps `endedAt` at the latest captured event (or now).
 */
function handleSessionEnd(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  trace: HookTrace,
): void {
  const nativeSessionId = parseEvent(adapterFor(tool), payload).nativeSessionId;
  trace.nativeSessionId = nativeSessionId;
  const sessions = readSessions(author);
  const session = nativeSessionId
    ? sessions.find((s) => s.nativeSessionId === nativeSessionId && !s.endedAt)
    : sessions.find((s) => s.id === readState(author.shared).currentSessionId);
  if (!session) return;
  trace.sessionId = session.id;
  trace.sessionStartedAt = session.startedAt;
  let lastTs = session.startedAt;
  for (const e of readSessionEvents(author, session.id)) {
    if (e.timestamp > lastTs) lastTs = e.timestamp;
  }
  const at = new Date().toISOString();
  closeSession(author, session.id, lastTs > at ? lastTs : at);
  trace.closedSessions = [...(trace.closedSessions ?? []), session.id];
}

async function handleUserPrompt(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  trace: HookTrace,
): Promise<void> {
  if (!payload) return;
  const ev = parseEvent(adapterFor(tool), payload);
  const text = ev.prompt;
  trace.nativeSessionId = ev.nativeSessionId;
  // The prompt's source (typed/queued/suggestion_accepted/…), when the payload
  // carries it — useful for spotting source-driven capture gaps after the fact.
  const promptSource = asString(prop(payload, 'promptSource'));
  if (promptSource) trace.promptSource = promptSource;
  if (!text) return;
  // Log the prompt into the session that owns this tool's session id (creating
  // it if the session-start hook never fired); without an id, the current
  // session is used (unchanged behavior).
  const nativeSessionId = ev.nativeSessionId;
  const sessionId = nativeSessionId
    ? sessionForNativeSession(author, nativeSessionId, { tool }).id
    : undefined;
  const { event, session } = await logEvent(author, {
    type: 'prompt',
    text,
    tool,
    sessionId,
  });
  trace.sessionId = session.id;
  trace.sessionStartedAt = session.startedAt;
  trace.promptId = event.id;
  // Open a new "turn": edits and AI output that follow link back to this prompt.
  // Track it per tool session so interleaved sessions don't share one turn.
  if (nativeSessionId) {
    updateState(author.shared, { currentSessionId: sessionId });
    setTurnForNativeSession(author.shared, nativeSessionId, event.id);
  } else {
    updateState(author.shared, { currentPromptId: event.id });
  }
  // Print nothing: this path must not add anything to the session's context.
}

/**
 * Reconstruct a deletion diff (the removed code as `- ` lines) for `repoPath`
 * from its most recent snapshot's stored diff in this trail — so a deleted file
 * renders like Claude's code removals. Returns undefined when there's no prior
 * in-trail content to show (then the deletion is recorded as nothing).
 */
function deletionDiff(author: AuthorPaths, repoPath: string): string | undefined {
  const history = artifactsForPath(author, repoPath);
  for (let i = history.length - 1; i >= 0; i--) {
    const ref = history[i]?.diffHash;
    if (!ref) continue;
    const prior = readObject(author.shared, ref);
    if (!prior) continue;
    const removed = prior
      .split('\n')
      .filter((l) => l.startsWith('+ '))
      .map((l) => '- ' + l.slice(2));
    if (removed.length > 0) return removed.join('\n');
  }
  return undefined;
}

async function handlePostEdit(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
  trace: HookTrace,
): Promise<void> {
  if (!payload) return;
  const ev = parseEvent(adapterFor(tool), payload);
  trace.nativeSessionId = ev.nativeSessionId;
  // Attach the edit to the open turn of *its* tool session when we can tell
  // which one fired; otherwise the global current turn (unchanged behavior).
  const turnId =
    (ev.nativeSessionId
      ? turnForNativeSession(author.shared, ev.nativeSessionId)
      : undefined) ??
    readState(author.shared).currentPromptId ??
    undefined;
  trace.turnId = turnId;
  const captureOff = config.settings.captureCode === false;
  let edits = 0;
  if (ev.edits && ev.edits.length > 0) {
    // Per-file edits with their own clean diffs (Codex apply_patch). Each file
    // renders only its own change, and a removed file renders as a deletion —
    // matching how Claude Code's edits look in the report.
    for (const e of ev.edits) {
      if (isInternalPath(e.file)) continue;
      if (e.deleted) {
        // Show the removed code as red `- ` lines, reconstructed from this
        // file's most recent snapshot in the trail (its prior content).
        const del = captureOff ? undefined : deletionDiff(author, e.file);
        if (
          del &&
          importEditArtifact(author, { path: e.file, diff: del, tool, turnId })
        ) {
          edits += 1;
        }
        continue;
      }
      try {
        await addArtifact(author, {
          filePath: e.file,
          tool,
          turnId,
          diff: captureOff ? undefined : e.diff,
        });
        edits += 1;
      } catch {
        // File may have been moved/deleted by now — skip it quietly.
      }
    }
  } else {
    // Legacy path: one captured diff applied to each edited file (Claude/Gemini).
    const diff = captureOff ? undefined : ev.suggestedDiff;
    for (const file of ev.editedFiles) {
      if (isInternalPath(file)) continue;
      try {
        await addArtifact(author, { filePath: file, tool, turnId, diff });
        edits += 1;
      } catch {
        // File may have been moved/deleted by now — skip it quietly.
      }
    }
  }
  trace.edits = edits;

  // Git backstop for hosts that edit via raw shell (declared by the plugin's
  // `recoverEditsFromGit`). Such tools can write files by running shell (e.g.
  // Codex's PowerShell `Set-Content`) where the path lives in a variable and
  // isn't in the payload. When structured parsing captured nothing, recover
  // recently-changed files from git. Gated on empty-parse so it never double-
  // captures; the recency window keeps it from sweeping up stale/manual changes
  // already dirty in the tree (the accepted trade-off for raw-shell coverage).
  if (
    edits === 0 &&
    adapterFor(tool)?.recoverEditsFromGit &&
    config.settings.git !== false
  ) {
    const cwd = payload.cwd ?? author.shared.root;
    const cutoff = Date.now() - GIT_FALLBACK_WINDOW_MS;
    let recovered = 0;
    for (const file of await changedFiles(cwd)) {
      if (isInternalPath(file)) continue;
      // `file` is repo-relative; resolve against the trail root (the same base
      // addArtifact uses) so the mtime check and the snapshot agree on one path.
      const abs = resolve(author.shared.root, file);
      try {
        if (statSync(abs).mtimeMs < cutoff) continue; // not touched this turn
        // A raw-shell write carries no diff in the payload — snapshot only.
        await addArtifact(author, { filePath: file, tool, turnId });
        recovered += 1;
      } catch {
        // Moved/deleted/unreadable since git saw it — skip quietly.
      }
    }
    if (recovered > 0) {
      edits += recovered;
      trace.edits = edits;
      trace.gitRecovered = recovered;
    }
  }

  // For hosts that never fire `Stop` (the Antigravity IDE only dispatches
  // `PostToolUse`), reconcile the transcript here too, so prompts/replies/plans
  // are still captured. Idempotent (dedup), so running it per tool step is safe.
  if (adapterFor(tool)?.reconcileOnPostEdit) {
    await reconcileFromAdapter(author, payload, tool, config, trace);
  }
}

/**
 * On Stop, the tool's adapter supplies a transcript (Claude Code reads its
 * `.jsonl`; tools without one return null and Stop is a no-op). We reconcile the
 * trail against that transcript — the complete, truthful record of the session —
 * walking it in order and attributing each assistant reply to the prompt it
 * actually followed, so every reply lands under the right turn no matter how many
 * prompts happened between Stops. Any prompt the student typed but that the live
 * `user-prompt` hook missed is back-filled here (never dropped).
 */
async function handleStop(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
  trace: HookTrace,
): Promise<void> {
  await reconcileFromAdapter(author, payload, tool, config, trace);
}

/**
 * Reconcile the trail against the tool's transcript: pull the adapter's
 * normalized transcript + any on-disk plan files and walk them into the trail
 * (back-filling prompts the live hook missed, attributing replies/plans). Used by
 * the `Stop` hook and — for tools whose host never fires `Stop` (Antigravity IDE
 * only dispatches `PostToolUse`) — by `post-edit` when `reconcileOnPostEdit` is
 * set. Idempotent: `reconcileTranscript` dedups by sourceId, so running it on
 * every tool step converges on the full conversation without duplicating events.
 */
async function reconcileFromAdapter(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
  trace: HookTrace,
): Promise<void> {
  const adapter = adapterFor(tool);
  const transcript = adapter?.getTranscript?.(payload, author.shared.root);
  const fallbackNativeId = parseEvent(adapter, payload).nativeSessionId;
  trace.nativeSessionId = transcript?.sessionId ?? fallbackNativeId;
  if (!transcript) return; // No transcript for this tool — nothing to reconcile.
  // The real on-disk plan file(s) this tool wrote, if any. Tools that keep their
  // plan only in the transcript return none and the plan text is materialized.
  let planFiles: DiscoveredPlanFile[] = [];
  try {
    planFiles = adapter?.planFiles?.(payload, author.shared.root) ?? [];
  } catch {
    planFiles = []; // Plan-file discovery is best-effort; never break the hook.
  }
  const summary = await reconcileTranscript(
    author,
    transcript,
    tool,
    config,
    fallbackNativeId,
    planFiles,
  );
  if (summary) {
    trace.sessionId = summary.sessionId;
    trace.sessionStartedAt = summary.sessionStartedAt;
    if (summary.createdSession) trace.createdSession = true;
    trace.replies = summary.replies;
    trace.decisions = summary.decisions;
    trace.plans = summary.plans;
    if (summary.edits > 0) trace.edits = summary.edits;
    if (summary.backlogSkipped > 0) trace.backlogSkipped = summary.backlogSkipped;
    if (summary.recoveredReplies > 0) trace.recoveredReplies = summary.recoveredReplies;
  }
}

/** What a Stop reconcile did, surfaced for the hook trace (not the trail). */
interface StopSummary {
  sessionId: string;
  sessionStartedAt: string;
  /** The reconcile bound to a freshly-created session (a resume after close). */
  createdSession: boolean;
  replies: number;
  decisions: number;
  plans: number;
  /** Per-file diff artifacts imported from the transcript (Codex apply_patch). */
  edits: number;
  /** Transcript prompts dropped as pre-window backlog (older than the session). */
  backlogSkipped: number;
  /**
   * Replies attributed to a prompt that lives in a *closed sibling* session of
   * the same native id (rather than the freshly-resolved one) — work the
   * session-close race would otherwise have orphaned. >0 means the cross-session
   * recovery fired.
   */
  recoveredReplies: number;
}

/**
 * Reconcile a normalized transcript into the trail. Tool-agnostic: it operates
 * only on {@link HookTranscript} messages, never a raw payload.
 *
 * Replies are attributed to the session that mirrors *this transcript's own*
 * session id — never a single global "current" session, which under
 * concurrent/resumed sessions points at the wrong one and silently drops
 * legitimate replies. Content from *before this session started watching*
 * (pre-trail backlog from a resumed transcript) is excluded: a transcript prompt
 * counts as in-window if it matches a prompt we already logged this session
 * (checked first), or it carries a timestamp at/after the session start.
 */
async function reconcileTranscript(
  author: AuthorPaths,
  transcript: HookTranscript,
  tool: Tool,
  config: Config,
  fallbackNativeId?: string,
  planFiles: DiscoveredPlanFile[] = [],
): Promise<StopSummary | undefined> {
  // AI text replies obey `captureAiOutput`; prompts and decisions are the
  // student's own work and are captured regardless.
  const captureAi = config.settings.captureAiOutput !== false;

  // Resolve the session this transcript belongs to. The transcript's own
  // session id is the source of truth; fall back to the payload's, then to the
  // global current session (older clients that send no id).
  const nativeSessionId = transcript.sessionId ?? fallbackNativeId;
  let session;
  let createdSession = false;
  if (nativeSessionId) {
    // Whether an open session already mirrored this native id: if not, the bind
    // below creates a fresh one — i.e. this Stop is reconciling against a
    // session that started *after* the turn it's reconciling, which is exactly
    // when straddling replies get excluded as backlog below.
    createdSession = !readSessions(author).some(
      (s) => s.nativeSessionId === nativeSessionId && !s.endedAt,
    );
    session = sessionForNativeSession(author, nativeSessionId, { tool });
  } else {
    const currentId = readState(author.shared).currentSessionId;
    session = currentId
      ? readSessions(author).find((s) => s.id === currentId)
      : undefined;
  }
  if (!session) return undefined; // No session to attribute to.
  const sessionId = session.id;
  const startedAt = session.startedAt;
  const summary: StopSummary = {
    sessionId,
    sessionStartedAt: startedAt,
    createdSession,
    replies: 0,
    decisions: 0,
    plans: 0,
    edits: 0,
    backlogSkipped: 0,
    recoveredReplies: 0,
  };

  // Prompts already logged, indexed two ways: by transcript uuid (a prompt we
  // back-filled on an earlier Stop) and by stored text as a FIFO (a prompt
  // logged live), so duplicate prompt texts line up in order. Each entry carries
  // the session that owns the prompt.
  //
  // The index spans not just the resolved session but every *sibling* session of
  // the same native id — including closed ones. This is what defeats the
  // session-close race: when a prompt was logged live into a session that has
  // since been closed (idle sweep / SessionEnd) and this Stop has resolved a
  // fresh session, the prompt would otherwise be unmatched here and its reply
  // dropped as backlog. Matching it in its (closed) sibling keeps the reply with
  // its prompt. Sorting siblings by start time makes the FIFO drain oldest-first.
  type PromptRef = { promptId: string; sessionId: string };
  const bySourceId = new Map<string, PromptRef>();
  const byText = new Map<string, PromptRef[]>();
  const siblings = nativeSessionId
    ? readSessions(author)
        .filter((s) => s.nativeSessionId === nativeSessionId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    : [session];
  for (const sib of siblings) {
    for (const p of readSessionEvents(author, sib.id)) {
      if (p.type !== 'prompt') continue;
      const ref: PromptRef = { promptId: p.id, sessionId: sib.id };
      if (p.sourceId) bySourceId.set(p.sourceId, ref);
      const queue = byText.get(p.text) ?? [];
      queue.push(ref);
      byText.set(p.text, queue);
    }
  }

  const seen = importedSourceIds(author);
  // Edits import as one diff artifact per file, keyed `<sourceId>#<file>`.
  const seenArtifacts = importedArtifactSourceIds(author);
  const redactCfg = config.settings.redact;
  let currentTurn: string | undefined; // The prompt id replies attach to.
  // The session that owns `currentTurn` — usually the resolved one, but a
  // closed sibling when the cross-session index matched there (the race fix).
  // Replies are written into this session so they stay grouped with their prompt.
  let currentTurnSession = sessionId;

  // The session's saved plan file path, resolved lazily on the first new plan so
  // a stop with no new plans writes nothing. A tool that wrote a real plan file
  // (Antigravity's `plan.md`) overwrites it per update, so the single discovered
  // file is the session's canonical plan and every plan event links to it; tools
  // with no file (Claude, Codex) fall back to materializing each plan's own text.
  const planFilesForSession = planFiles.filter(
    (f) => !f.nativeSessionId || f.nativeSessionId === nativeSessionId,
  );
  let sessionPlanPath: string | undefined;
  let sessionPlanResolved = false;
  const resolveSessionPlanPath = (): string | undefined => {
    if (!sessionPlanResolved) {
      sessionPlanResolved = true;
      const file = planFilesForSession.at(-1);
      if (file) {
        sessionPlanPath = materializePlan(author.shared, {
          text: file.content,
          sourceId: file.sourceId,
        }).planPath;
      }
    }
    return sessionPlanPath;
  };

  for (const msg of transcript.messages) {
    if (msg.role === 'user') {
      // Match an already-logged prompt FIRST — by uuid, then by redacted text
      // (prompts are stored redacted, so redact the transcript text to compare).
      // A prompt we already logged this session is in-window by definition and
      // must never be reclassified as backlog, even if its transcript timestamp
      // predates this session's start.
      let ref = msg.sourceId ? bySourceId.get(msg.sourceId) : undefined;
      if (!ref) {
        const queue = byText.get(redact(msg.text, redactCfg).text);
        if (queue && queue.length > 0) ref = queue.shift();
      }
      if (!ref) {
        // Unmatched. Back-fill only when a timestamp proves it's in-window
        // (at/after this session's start); a backlog or timestamp-less prompt is
        // skipped so a resumed transcript isn't dumped onto a later turn.
        if (!msg.timestamp || msg.timestamp < startedAt) {
          currentTurn = undefined;
          summary.backlogSkipped += 1;
          continue;
        }
        const { event } = await logEvent(author, {
          type: 'prompt',
          text: msg.text,
          tool,
          timestamp: msg.timestamp,
          sourceId: msg.sourceId,
          sessionId,
        });
        ref = { promptId: event.id, sessionId };
        if (msg.sourceId) bySourceId.set(msg.sourceId, ref);
      }
      currentTurn = ref.promptId;
      currentTurnSession = ref.sessionId;
    } else if (msg.role === 'assistant') {
      // A reply only belongs to the trail if it follows an in-window prompt.
      if (!captureAi || !currentTurn || seen.has(msg.sourceId)) continue;
      await logEvent(author, {
        type: 'ai_output',
        text: msg.text,
        tool,
        // Stamp with the transcript message time (not now, the Stop time), so the
        // reply orders chronologically against edits in the report.
        timestamp: msg.timestamp,
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId: currentTurnSession,
      });
      seen.add(msg.sourceId);
      summary.replies += 1;
      if (currentTurnSession !== sessionId) summary.recoveredReplies += 1;
    } else if (msg.role === 'decision') {
      // The student chose between options the AI offered — their own work, so
      // it's captured even when AI-output capture is off. Attach to the open turn.
      if (!currentTurn || seen.has(msg.sourceId)) continue;
      await logEvent(author, {
        type: 'decision',
        text: msg.text,
        tool,
        timestamp: msg.timestamp, // message time, so it interleaves chronologically
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId: currentTurnSession,
      });
      seen.add(msg.sourceId);
      summary.decisions += 1;
    } else if (msg.role === 'plan') {
      // A plan the AI proposed — captured regardless of AI-output capture. When
      // the tool resolves approval (Claude: approved/revised), that becomes a tag;
      // a tool with no approval concept (Codex, headless) leaves `approved`
      // undefined and the plan carries no badge.
      if (!currentTurn || seen.has(msg.sourceId)) continue;
      const planTags =
        msg.approved === true
          ? [PLAN_APPROVED_TAG]
          : msg.approved === false
            ? [PLAN_REVISED_TAG]
            : [];
      // When the host wrote a real plan file, link it; otherwise `logEvent`
      // materializes this plan's transcript text into a linkable file itself.
      await logEvent(author, {
        type: 'plan',
        text: msg.text,
        tool,
        timestamp: msg.timestamp,
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId: currentTurnSession,
        tags: planTags,
        planPath: resolveSessionPlanPath(),
      });
      seen.add(msg.sourceId);
      summary.plans += 1;
    } else if (msg.role === 'edit') {
      // Import per-file CLEAN diffs (and deletions) recovered from the host's
      // transcript — the reliable diff source when the live hook payload carries
      // the file but not the diff (Codex `apply_patch`). The live snapshot still
      // records the file hash; the report de-dupes the pair to one code change.
      if (config.settings.captureCode === false) continue;
      for (const e of msg.edits ?? []) {
        if (isInternalPath(e.file) || !e.diff) continue;
        const editSourceId = `${msg.sourceId}#${e.file}`;
        if (seenArtifacts.has(editSourceId)) continue;
        const wrote = importEditArtifact(author, {
          path: e.file,
          diff: e.diff,
          tool,
          turnId: currentTurn,
          timestamp: msg.timestamp,
          sessionId: currentTurnSession,
          sourceId: editSourceId,
        });
        if (wrote) {
          seenArtifacts.add(editSourceId);
          summary.edits += 1;
        }
      }
    }
  }
  return summary;
}
