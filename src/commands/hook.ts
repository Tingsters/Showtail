import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../core/plans.ts';
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
import { connectPlugins, getPluginById } from '../plugins/registry.ts';
import type {
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
  try {
    const payload = await readHookPayload();
    const cwd = payload?.cwd ?? options.cwd ?? process.cwd();
    const tool: Tool = options.tool ?? 'claude-code';

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
    const paths = pathsForRoot(root);
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
      sweepIdleSessions(author, idleMin * 60_000, Date.now());
    }

    switch (event) {
      case 'session-start':
        return handleSessionStart(author, payload, tool);
      case 'user-prompt':
        return await handleUserPrompt(author, payload, tool);
      case 'post-edit':
        return await handlePostEdit(author, payload, tool, config);
      case 'stop':
        return await handleStop(author, payload, tool, config);
      case 'session-end':
        return handleSessionEnd(author, payload, tool);
    }
  } catch {
    // Swallow everything — a hook must never break the session.
    return;
  }
}

function handleSessionStart(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
): void {
  // Bind this session to the tool's own session id when we have one, so a
  // resume/compact reuses the *same* trail instead of spawning a new session
  // each time. Without an id (older clients), fall back to the single current
  // session. Either way this becomes the CLI's "current" session.
  const nativeSessionId = parseEvent(adapterFor(tool), payload).nativeSessionId;
  const session = nativeSessionId
    ? sessionForNativeSession(author, nativeSessionId, { tool })
    : (currentSession(author) ?? startSession(author));
  updateState(author.shared, { currentSessionId: session.id });
  // SessionStart stdout is injected into Claude's context — keep it to one line.
  process.stdout.write(
    `Showtail is capturing this session's work trail (session ${session.id}). ` +
      `Your prompts and edits are captured automatically — just work as usual.\n`,
  );
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
): void {
  const nativeSessionId = parseEvent(adapterFor(tool), payload).nativeSessionId;
  const sessions = readSessions(author);
  const session = nativeSessionId
    ? sessions.find((s) => s.nativeSessionId === nativeSessionId && !s.endedAt)
    : sessions.find((s) => s.id === readState(author.shared).currentSessionId);
  if (!session) return;
  let lastTs = session.startedAt;
  for (const e of readSessionEvents(author, session.id)) {
    if (e.timestamp > lastTs) lastTs = e.timestamp;
  }
  const at = new Date().toISOString();
  closeSession(author, session.id, lastTs > at ? lastTs : at);
}

async function handleUserPrompt(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
): Promise<void> {
  if (!payload) return;
  const ev = parseEvent(adapterFor(tool), payload);
  const text = ev.prompt;
  if (!text) return;
  // Log the prompt into the session that owns this tool's session id (creating
  // it if the session-start hook never fired); without an id, the current
  // session is used (unchanged behavior).
  const nativeSessionId = ev.nativeSessionId;
  const sessionId = nativeSessionId
    ? sessionForNativeSession(author, nativeSessionId, { tool }).id
    : undefined;
  const { event } = await logEvent(author, { type: 'prompt', text, tool, sessionId });
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
): Promise<void> {
  if (!payload) return;
  const ev = parseEvent(adapterFor(tool), payload);
  // Attach the edit to the open turn of *its* tool session when we can tell
  // which one fired; otherwise the global current turn (unchanged behavior).
  const turnId =
    (ev.nativeSessionId
      ? turnForNativeSession(author.shared, ev.nativeSessionId)
      : undefined) ??
    readState(author.shared).currentPromptId ??
    undefined;
  // Capture the AI-suggested code (unless code capture is turned off).
  const diff = config.settings.captureCode === false ? undefined : ev.suggestedDiff;
  for (const file of ev.editedFiles) {
    if (isInternalPath(file)) continue;
    try {
      await addArtifact(author, { filePath: file, tool, turnId, diff });
    } catch {
      // File may have been moved/deleted by now — skip it quietly.
    }
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
): Promise<void> {
  const adapter = adapterFor(tool);
  const transcript = adapter?.getTranscript?.(payload, author.shared.root);
  if (!transcript) return; // No transcript for this tool — nothing to reconcile.
  const fallbackNativeId = parseEvent(adapter, payload).nativeSessionId;
  await reconcileTranscript(author, transcript, tool, config, fallbackNativeId);
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
): Promise<void> {
  // AI text replies obey `captureAiOutput`; prompts and decisions are the
  // student's own work and are captured regardless.
  const captureAi = config.settings.captureAiOutput !== false;

  // Resolve the session this transcript belongs to. The transcript's own
  // session id is the source of truth; fall back to the payload's, then to the
  // global current session (older clients that send no id).
  const nativeSessionId = transcript.sessionId ?? fallbackNativeId;
  let session;
  if (nativeSessionId) {
    session = sessionForNativeSession(author, nativeSessionId, { tool });
  } else {
    const currentId = readState(author.shared).currentSessionId;
    session = currentId
      ? readSessions(author).find((s) => s.id === currentId)
      : undefined;
  }
  if (!session) return; // No session to attribute to.
  const sessionId = session.id;
  const startedAt = session.startedAt;

  // Prompts already logged this session, indexed two ways: by transcript uuid
  // (a prompt we back-filled on an earlier Stop) and by stored text as a FIFO
  // (a prompt logged live), so duplicate prompt texts line up in order.
  const bySourceId = new Map<string, string>();
  const byText = new Map<string, string[]>();
  for (const p of readSessionEvents(author, sessionId)) {
    if (p.type !== 'prompt') continue;
    if (p.sourceId) bySourceId.set(p.sourceId, p.id);
    const queue = byText.get(p.text) ?? [];
    queue.push(p.id);
    byText.set(p.text, queue);
  }

  const seen = importedSourceIds(author);
  const redactCfg = config.settings.redact;
  let currentTurn: string | undefined; // The prompt id replies attach to.

  for (const msg of transcript.messages) {
    if (msg.role === 'user') {
      // Match an already-logged prompt FIRST — by uuid, then by redacted text
      // (prompts are stored redacted, so redact the transcript text to compare).
      // A prompt we already logged this session is in-window by definition and
      // must never be reclassified as backlog, even if its transcript timestamp
      // predates this session's start.
      let id = msg.sourceId ? bySourceId.get(msg.sourceId) : undefined;
      if (!id) {
        const queue = byText.get(redact(msg.text, redactCfg).text);
        if (queue && queue.length > 0) id = queue.shift();
      }
      if (!id) {
        // Unmatched. Back-fill only when a timestamp proves it's in-window
        // (at/after this session's start); a backlog or timestamp-less prompt is
        // skipped so a resumed transcript isn't dumped onto a later turn.
        if (!msg.timestamp || msg.timestamp < startedAt) {
          currentTurn = undefined;
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
        id = event.id;
        if (msg.sourceId) bySourceId.set(msg.sourceId, id);
      }
      currentTurn = id;
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
        sessionId,
      });
      seen.add(msg.sourceId);
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
        sessionId,
      });
      seen.add(msg.sourceId);
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
      await logEvent(author, {
        type: 'plan',
        text: msg.text,
        tool,
        timestamp: msg.timestamp,
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId,
        tags: planTags,
      });
      seen.add(msg.sourceId);
    }
    // `edit` messages are ignored — the post-edit hook already records those.
  }
}
