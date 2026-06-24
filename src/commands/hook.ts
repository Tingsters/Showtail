import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
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
  findRoot,
  isEligibleAnchor,
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
import { recordHookTrace, type HookTrace } from '../core/hookTrace.ts';
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
    trace.nativeSessionId = parseEvent(adapterFor(tool), payload).nativeSessionId;

    let root = findRoot(cwd);
    if (!root) {
      // Automatic tracking: silently start a trail on the first real activity in
      // an eligible project (git repo / dev folder), once the user has opted in
      // via `showtail setup`. Only a task start may create one — never a stray
      // edit/stop. `isEligibleAnchor` also refuses HOME, so a whole home dir is
      // never turned into one shared trail.
      if (event !== 'session-start' && event !== 'user-prompt') return;
      if (!autoInitEnabled()) return;
      const anchor = await resolveAnchor(cwd);
      if (!isEligibleAnchor(anchor)) return;
      await ensureInitialized(anchor);
      root = anchor;
    }
    paths = pathsForRoot(root);
    if (!existsSync(paths.config)) return; // Not initialized.
    const config = readConfig(paths);

    // Resolve who is writing this trail. Cache-only / git-config at worst — never
    // prompts or hits the network, so the hook stays fast and non-blocking. If
    // identity can't be settled silently, no-op rather than guess.
    const author = await resolveActiveAuthorForHook(paths, { cwd });
    if (!author) return;

    // On any live capture, first close this author's sessions that have gone idle
    // (stamped at their last event), so a finished task's session doesn't linger
    // open. Tool-agnostic fallback to the SessionEnd hook below.
    if (event === 'user-prompt' || event === 'post-edit') {
      const idleMin = config.settings.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
      const swept = sweepIdleSessions(author, idleMin * 60_000, Date.now());
      if (swept.length > 0) trace.closedSessions = swept;
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
  // Capture the AI-suggested code (unless code capture is turned off).
  const diff = config.settings.captureCode === false ? undefined : ev.suggestedDiff;
  let edits = 0;
  for (const file of ev.editedFiles) {
    if (isInternalPath(file)) continue;
    try {
      await addArtifact(author, { filePath: file, tool, turnId, diff });
      edits += 1;
    } catch {
      // File may have been moved/deleted by now — skip it quietly.
    }
  }
  trace.edits = edits;

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
    }
    // `edit` messages are ignored — the post-edit hook already records those.
  }
  return summary;
}
