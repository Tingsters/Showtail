/**
 * `showtail import antigravity-ide` — back-fill a trail from the Antigravity IDE's
 * on-disk conversation transcript:
 *   ~/.gemini/antigravity-ide/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * The IDE's lifecycle hooks proved unreliable (only `PostToolUse` fires, no
 * `Stop`/`PreInvocation`, no stable session id), so live prompt/reply capture
 * can't be trusted. The transcript IS the complete, truthful record, so we import
 * it: prompts (`USER_INPUT`), replies (`PLANNER_RESPONSE`), and the generated
 * plans, tagged `antigravity-ide`. Idempotent — every message carries a stable
 * `sourceId`, so re-importing only adds what's new. Everything is local.
 *
 * Mirrors commands/importCodex.ts; reuses the transcript parser in
 * core/antigravityIdeTranscript.ts and the shared event logger.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import {
  antigravityIdePlanFiles,
  findAntigravityIdeTranscripts,
  locateAntigravityIdeTranscript,
  readAntigravityIdeTranscript,
  type AntigravityIdeTranscriptInfo,
} from '../core/antigravityIdeTranscript.ts';
import { importEditArtifact, importedArtifactSourceIds } from '../core/artifacts.ts';
import { importedPromptIds, importedSourceIds, logEvent } from '../core/events.ts';
import {
  conversationEventEnabled,
  importedConversationSourceIds,
  logConversationEvent,
} from '../core/conversationEvents.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../core/plans.ts';
import { makeId } from '../core/ids.ts';
import { readMachineIdentity } from '../core/identity.ts';
import {
  appendLedgerRecord,
  effectiveLedgerPath,
  ensureLedgerSession,
  markInbox,
  markPlaced,
  readLedgerRecords,
  readLedgerSession,
  sessionProjectContext,
  type LedgerSession,
} from '../core/ledger.ts';
import {
  automaticCaptureTimestampAllowed,
  captureTranscriptToLedger,
} from '../core/ledgerCapture.ts';
import { materializeLedgerSession } from '../core/materialize.ts';
import { clearOtherLedgerProjections } from '../core/projectionRouting.ts';
import { CaptureInterruptedError } from '../core/captureGuard.ts';
import {
  autoInitEnabled,
  ensureCaptureSince,
  isStaleForAutoBackfill,
  toolCaptureEnabledAt,
  toolCaptureGloballyDisabled,
} from '../core/globalConfig.ts';
import { requireActiveAuthor, resolveActiveAuthorForHook } from '../core/authors.ts';
import {
  ensureTrailId,
  isEligibleAnchor,
  isPathUnder,
  pathsForRoot,
  readConfig,
  requirePaths,
  resolveProjectContext,
  type AuthorPaths,
} from '../core/storage.ts';
import { isSyntheticPrompt } from '../core/syntheticPrompt.ts';
import { oneLine } from '../core/text.ts';
import type { HookTranscript } from '../plugins/types.ts';
import { ensureInitialized } from './init.ts';

export interface ImportAntigravityIdeOptions {
  /** List this machine's Antigravity IDE conversations and exit. */
  list?: boolean;
  /** Also log the IDE's text replies (not just your prompts). Default true. */
  withResponses?: boolean;
  /** Import a specific transcript `.jsonl` by path (escape hatch). */
  file?: string;
  /** Import into a specific Showtail session id. */
  session?: string;
  cwd?: string;
  /**
   * Resolve the complete transcript to one project from cwd + edit paths, leaving
   * ambiguous work in the ledger inbox. The headless capture path.
   */
  auto?: boolean;
}

export interface AntigravityIdeImportResult {
  prompts: number;
  responses: number;
  plans: number;
  edits: number;
  skipped: number;
  first?: string;
  last?: string;
}

interface AntigravityIdeAutomaticCaptureWindow {
  automaticCaptureSince?: string;
}

/** Read a consent epoch only while machine-wide automatic capture is enabled. */
function readAntigravityIdeAutomaticCaptureWindow(): AntigravityIdeAutomaticCaptureWindow | null {
  if (toolCaptureGloballyDisabled('antigravity-ide')) return null;
  const automaticCaptureSince = toolCaptureEnabledAt('antigravity-ide');
  // Recheck because disconnect and reconnect are separate cross-process writes.
  if (toolCaptureGloballyDisabled('antigravity-ide')) return null;
  return { automaticCaptureSince };
}

/** Stop a sweep if consent was revoked or restarted after its transcript read. */
function antigravityIdeAutomaticCaptureWindowUnchanged(
  automaticCaptureSince: string | undefined,
): boolean {
  if (toolCaptureGloballyDisabled('antigravity-ide')) return false;
  const current = toolCaptureEnabledAt('antigravity-ide');
  return (
    !toolCaptureGloballyDisabled('antigravity-ide') && current === automaticCaptureSince
  );
}

/** An edited file recovered from a transcript: the path + the IDE's edit note. */
export interface TranscriptEdit {
  /** Display path (repo-relative when under `root`, else absolute, posix slashes). */
  path: string;
  /** The CODE_ACTION description, recorded as the artifact's "diff" body. */
  diff: string;
  timestamp?: string;
  /** Stable id for idempotent re-import (see importedArtifactSourceIds). */
  sourceId: string;
}

/** Convert a `file:///C:/x/y.py` URI to a usable OS path (posix slashes). */
function fileUriToPath(uri: string): string | null {
  try {
    let p = decodeURIComponent(uri);
    // `file:///C:/…` → `C:/…`; a leading slash before a drive letter is spurious.
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    p = p.replace(/\\/g, '/');
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Tool/project bookkeeping paths are never student edit artifacts. */
function isInternalEditPath(path: string): boolean {
  return /(^|[\\/])\.(showtail|git|vscode|system_generated)([\\/]|$)/.test(path);
}

/** Make a path repo-relative against `root` when it lives under it; else posix-absolute. */
function displayPath(p: string, root: string): string {
  if (!isAbsolute(p)) return p.replace(/\\/g, '/');
  const rel = relative(root, p).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : p.replace(/\\/g, '/');
}

/**
 * Recover the files the IDE edited from a raw transcript. Each `CODE_ACTION` line
 * describes one file operation and embeds the target as a `file://` URI in its
 * `content` (e.g. "Created file file:///C:/…/x.py with requested content."). We
 * pull the path and keep the description as the artifact body. (The parsed
 * conversation drops edits, so this reads the raw JSONL directly.)
 */
export function extractTranscriptEdits(
  rawContent: string,
  sessionId: string,
): TranscriptEdit[] {
  const out: TranscriptEdit[] = [];
  let seq = 0;
  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: {
      type?: unknown;
      content?: unknown;
      created_at?: unknown;
      step_index?: unknown;
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'CODE_ACTION') continue;
    const content = typeof obj.content === 'string' ? obj.content : '';
    const idx = typeof obj.step_index === 'number' ? String(obj.step_index) : `n${seq++}`;
    const timestamp = typeof obj.created_at === 'string' ? obj.created_at : undefined;
    for (const m of content.matchAll(/file:\/\/([^\s)'"]+)/g)) {
      const p = fileUriToPath(m[1]!);
      if (!p) continue;
      if (isInternalEditPath(p)) continue;
      out.push({
        path: p,
        diff: content.trim() || `Antigravity edited ${p}`,
        timestamp,
        sourceId: `agy:edit:${sessionId}:${idx}:${p}`,
      });
    }
  }
  return out;
}

/**
 * Log a parsed IDE transcript's prompts/replies/plans into the trail, tagged
 * `antigravity-ide`. Idempotent: messages whose sourceId is already in the trail
 * are skipped. (The parser drops raw edits — those are captured by the VS Code
 * extension / live hooks, not the import.)
 */
export async function importAntigravityIdeTranscript(
  author: AuthorPaths,
  transcript: HookTranscript,
  options: { withResponses?: boolean; sessionId?: string; batchId?: string } = {},
): Promise<AntigravityIdeImportResult> {
  const seen = importedSourceIds(author);
  const result: AntigravityIdeImportResult = {
    prompts: 0,
    responses: 0,
    plans: 0,
    edits: 0,
    skipped: 0,
  };
  // A user prompt opens a turn; the reply/plan that follow link back via this id.
  let currentTurnId: string | undefined;
  const promptBySourceId = importedPromptIds(author);
  const stamp = (ts?: string): void => {
    if (!ts) return;
    if (!result.first || ts < result.first) result.first = ts;
    if (!result.last || ts > result.last) result.last = ts;
  };

  for (const msg of transcript.messages) {
    if (msg.role === 'assistant' && options.withResponses === false) continue;
    const type =
      msg.role === 'user'
        ? 'prompt'
        : msg.role === 'assistant'
          ? 'ai_output'
          : msg.role === 'plan'
            ? 'plan'
            : null;
    if (type === null) continue; // 'edit' / unknown roles are not imported here.

    if (seen.has(msg.sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(msg.sourceId);

    const tags = ['imported'];
    if (type === 'plan') {
      tags.push(msg.approved === false ? PLAN_REVISED_TAG : PLAN_APPROVED_TAG);
    }

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool: 'antigravity-ide',
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      tags,
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') {
      currentTurnId = event.id;
      promptBySourceId.set(msg.sourceId, event.id);
    }

    if (type === 'prompt') result.prompts += 1;
    else if (type === 'ai_output') result.responses += 1;
    else result.plans += 1;
    stamp(msg.timestamp);
  }

  const seenConversation = importedConversationSourceIds(author);
  const events = transcript.events ?? [];
  const toolNames = new Map(
    events.flatMap((event) =>
      event.type === 'tool_use' && event.toolUseId && event.toolName
        ? [[event.toolUseId, event.toolName] as const]
        : [],
    ),
  );
  const settings = readConfig(author.shared).settings;
  let conversationTurnId: string | undefined;
  for (const raw of events) {
    if (raw.type === 'user_text') {
      conversationTurnId = promptBySourceId.get(raw.sourceId);
    }
    if (!conversationTurnId) continue;
    if (
      !conversationEventEnabled(raw, toolNames, settings, {
        includeResponses: options.withResponses !== false,
      })
    ) {
      continue;
    }
    const sourceId = `conversation:${raw.sourceId}`;
    if (seenConversation.has(sourceId)) continue;
    logConversationEvent(author, {
      event: { ...raw, sourceId },
      tool: 'antigravity-ide',
      turnId: conversationTurnId,
      sessionId: options.sessionId,
      batchId: options.batchId,
    });
    seenConversation.add(sourceId);
  }

  return result;
}

/**
 * Import the edited files recovered from a transcript as back-dated artifacts,
 * tagged `antigravity-ide`. Idempotent (dedup by sourceId) and de-duped within the
 * run by sourceId. Returns how many new edit artifacts were written.
 */
export function importAntigravityIdeEdits(
  author: AuthorPaths,
  edits: TranscriptEdit[],
  options: { root: string; sessionId?: string; batchId?: string },
): number {
  const seen = importedArtifactSourceIds(author);
  const inRun = new Set<string>();
  let count = 0;
  for (const e of edits) {
    if (seen.has(e.sourceId) || inRun.has(e.sourceId)) continue;
    inRun.add(e.sourceId);
    const wrote = importEditArtifact(author, {
      path: displayPath(e.path, options.root),
      diff: e.diff,
      tool: 'antigravity-ide',
      timestamp: e.timestamp,
      sessionId: options.sessionId,
      sourceId: e.sourceId,
      batchId: options.batchId,
    });
    if (wrote) count += 1;
  }
  return count;
}

/** Resolve which transcript to import: `--file`, a `<conversationId>`, else newest. */
function resolveTranscript(
  target: string | undefined,
  options: ImportAntigravityIdeOptions,
): AntigravityIdeTranscriptInfo | null {
  if (options.file) {
    if (!existsSync(options.file)) throw new Error(`File not found: ${options.file}`);
    // Derive the conversation id from the brain layout when possible (stable
    // sourceIds); otherwise fall back to the file's own name.
    const m = /([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/.exec(
      options.file,
    );
    return {
      path: options.file,
      sessionId: m?.[1] ?? basename(options.file),
      mtimeMs: 0,
    };
  }
  if (target) {
    const found = findAntigravityIdeTranscripts();
    const chosen = found.find(
      (t) => t.sessionId === target || t.sessionId.startsWith(target),
    );
    if (!chosen) {
      throw new Error(
        `No Antigravity IDE conversation matching "${target}". ` +
          'Run `showtail import antigravity-ide --list` to see what is available.',
      );
    }
    return chosen;
  }
  return locateAntigravityIdeTranscript(undefined); // newest
}

/**
 * Import an Antigravity IDE conversation transcript. With no target, imports the
 * most recent conversation; `--list` prints what's available; `--file` imports a
 * specific transcript; a `<conversationId>` imports that conversation directly.
 */
export async function runImportAntigravityIde(
  target: string | undefined,
  options: ImportAntigravityIdeOptions,
): Promise<void> {
  // `--auto` is background extension capture. Honor a machine-wide disconnect
  // before even listing or resolving transcript files; explicit imports without
  // `--auto` remain available to the student.
  if (options.auto && toolCaptureGloballyDisabled('antigravity-ide')) return;
  if (options.list) {
    listConversations();
    return;
  }
  // Headless capture: route by the transcript's edited-file paths into each
  // project, rather than into one `cwd`-derived trail (no folder is reliably open
  // in the IDE's extension host).
  if (options.auto) {
    try {
      await runImportAntigravityIdeAuto(target, options);
    } catch (error) {
      if (error instanceof CaptureInterruptedError) return;
      throw error;
    }
    return;
  }

  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });

  const info = resolveTranscript(target, options);
  if (!info) {
    console.log('No Antigravity IDE conversations were found on disk.');
    console.log('If you have a transcript elsewhere, point at it with --file <path>.');
    return;
  }

  const transcript = readAntigravityIdeTranscript(info, paths.root);
  if (transcript.messages.length === 0) {
    console.log('Nothing to import — that conversation has no prompts or replies yet.');
    return;
  }

  // The parsed conversation drops edits, so recover edited files from the raw
  // transcript's CODE_ACTION lines and record them under the same batch.
  const edits = safeExtractEdits(info.path, info.sessionId);
  const res = await importIntoRoot(author, paths.root, transcript, edits, options);
  printResult(res, options.withResponses !== false);
}

/** Read a transcript's CODE_ACTION edits, swallowing read errors (best-effort). */
function safeExtractEdits(file: string, sessionId: string): TranscriptEdit[] {
  try {
    return extractTranscriptEdits(readFileSync(file, 'utf8'), sessionId);
  } catch {
    return [];
  }
}

/**
 * Import one parsed conversation + a given set of recovered edits into a single
 * project root, tagged `antigravity-ide`. Idempotent by sourceId. The edits are
 * passed in (not re-extracted) so the auto-router can hand each root only the
 * edits that belong to it.
 */
async function importIntoRoot(
  author: AuthorPaths,
  root: string,
  transcript: HookTranscript,
  edits: TranscriptEdit[],
  options: { withResponses?: boolean; session?: string },
): Promise<AntigravityIdeImportResult> {
  const batchId = makeId('imp');
  const res = await importAntigravityIdeTranscript(author, transcript, {
    withResponses: options.withResponses,
    sessionId: options.session,
    batchId,
  });
  res.edits = importAntigravityIdeEdits(author, edits, {
    root,
    sessionId: options.session,
    batchId,
  });
  return res;
}

/**
 * Capture once to the ledger, then project only when the complete transcript
 * resolves to one project. A meaningful prompt can initialize a candidate when
 * automatic tracking is enabled; mixed-root work remains one inbox session.
 */
async function runImportAntigravityIdeAuto(
  target: string | undefined,
  options: ImportAntigravityIdeOptions,
): Promise<void> {
  const info = resolveTranscript(target, options);
  if (!info) {
    console.log('No Antigravity IDE conversations were found on disk.');
    return;
  }
  const cwd = options.cwd ?? process.cwd();
  const extractedEdits = safeExtractEdits(info.path, info.sessionId);
  // The file read can overlap a disconnect/reconnect. Use the latest consent
  // epoch, then require it to remain unchanged until each automatic write.
  const captureWindow = readAntigravityIdeAutomaticCaptureWindow();
  if (!captureWindow) return;
  const { automaticCaptureSince } = captureWindow;
  const allEdits = extractedEdits.filter((edit) =>
    automaticCaptureTimestampAllowed(edit.timestamp, automaticCaptureSince),
  );
  const sourceContext = resolveProjectContext({
    cwd,
    editPaths: allEdits.map((edit) => edit.path),
  });
  const sourceRoot =
    sourceContext.state === 'tracked' || sourceContext.state === 'candidate'
      ? sourceContext.root
      : undefined;
  const parsed = readAntigravityIdeTranscript(info, sourceRoot ?? cwd);
  const responseFiltered = filterAntigravityResponses(
    parsed,
    options.withResponses !== false,
  );
  const transcript: HookTranscript = {
    ...responseFiltered,
    messages: responseFiltered.messages.filter((message) =>
      automaticCaptureTimestampAllowed(message.timestamp, automaticCaptureSince),
    ),
    events: responseFiltered.events?.filter((event) =>
      automaticCaptureTimestampAllowed(event.timestamp, automaticCaptureSince),
    ),
  };
  if (transcript.messages.length === 0 && allEdits.length === 0) {
    console.log(
      'Nothing to capture — that conversation has no prompts, replies, or edits.',
    );
    return;
  }

  const totals: AntigravityIdeImportResult = {
    prompts: 0,
    responses: 0,
    plans: 0,
    edits: 0,
    skipped: 0,
  };
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  const ledger = captureConversationToLedger(
    info,
    transcript,
    allEdits,
    options,
    sourceContext.state === 'tracked',
    automaticCaptureSince,
  );
  if (!ledger) {
    printAutoResult(totals, [], options.withResponses !== false);
    return;
  }

  const current = readLedgerSession(ledger.id) ?? ledger;
  const context = sessionProjectContext(current);
  const resolvedRoot =
    context.state === 'tracked' || context.state === 'candidate'
      ? context.root
      : undefined;
  const safelyContained =
    resolvedRoot !== undefined &&
    readLedgerRecords(current.id).every(
      (record) =>
        record.kind !== 'edit' ||
        (record.file !== undefined &&
          isAbsolute(effectiveLedgerPath(current, record.file)) &&
          isPathUnder(effectiveLedgerPath(current, record.file), resolvedRoot)),
    );
  if (context.state === 'ambiguous' || context.state === 'none' || !safelyContained) {
    if (!(await parkAntigravityLedger(current, automaticCaptureSince))) return;
    printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }

  const root = context.root;
  if (context.state === 'candidate') {
    if (!(await parkAntigravityLedger(current, automaticCaptureSince))) return;
    const meaningfulPrompt = transcript.messages.some(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        !isSyntheticPrompt(message.text),
    );
    if (!autoInitEnabled() || !meaningfulPrompt || !isEligibleAnchor(root)) {
      printAutoResult(totals, [], options.withResponses !== false, true);
      return;
    }
    if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
    await ensureInitialized(root, {
      ...(context.evidence === 'trail' ? {} : { anchorKind: context.evidence }),
      initialization: {
        mode: 'automatic',
        evidence: context.evidence,
        ledgerSessionId: current.id,
      },
      continueCapture: () =>
        antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  }

  const paths = pathsForRoot(root);
  if (!existsSync(paths.config)) {
    if (
      !(await parkAntigravityLedger(
        readLedgerSession(current.id) ?? current,
        automaticCaptureSince,
      ))
    ) {
      return;
    }
    printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  const trailId = ensureTrailId(paths, () =>
    antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  );
  try {
    if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
    await clearOtherLedgerProjections(readLedgerSession(current.id) ?? current, trailId, {
      continueCapture: () =>
        antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  } catch {
    if (
      !(await parkAntigravityLedger(
        readLedgerSession(current.id) ?? current,
        automaticCaptureSince,
      ))
    ) {
      return;
    }
    printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }
  const author = await resolveActiveAuthorForHook(paths, {
    cwd: root,
    continueCapture: () =>
      antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  if (!author) {
    if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
    try {
      markInbox(current.id, {
        continueCapture: () =>
          antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
      });
    } catch {
      // The ledger remains durable even if placement bookkeeping fails.
    }
    printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }

  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  const materialized = await materializeLedgerSession(
    readLedgerSession(current.id) ?? current,
    author,
    {
      continueCapture: () =>
        antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    },
  );
  if (!materialized.completed) return;
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  markPlaced(current.id, trailId, root, {
    continueCapture: () =>
      antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  totals.prompts = materialized.prompts;
  totals.responses = materialized.replies;
  totals.plans = materialized.plans;
  totals.edits = materialized.edits;
  totals.skipped = Math.max(
    0,
    readLedgerRecords(current.id).length - materialized.projected,
  );
  printAutoResult(totals, [root], options.withResponses !== false);
}

/** Omit response-only content when the import explicitly disables AI responses. */
function filterAntigravityResponses(
  transcript: HookTranscript,
  withResponses: boolean,
): HookTranscript {
  if (withResponses) return transcript;
  return {
    ...transcript,
    messages: transcript.messages.filter((message) => message.role !== 'assistant'),
    events: transcript.events?.filter((event) => event.type !== 'assistant_text'),
  };
}

/** Remove any old projection and leave the complete session awaiting placement. */
async function parkAntigravityLedger(
  session: LedgerSession,
  automaticCaptureSince: string | undefined,
): Promise<boolean> {
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return false;
  try {
    await clearOtherLedgerProjections(session, undefined, {
      continueCapture: () =>
        antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  } catch {
    // Best-effort cleanup; the ledger remains the complete source of truth.
  }
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return false;
  try {
    markInbox(session.id, {
      continueCapture: () =>
        antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  } catch {
    // A ledger write failure must not make the transcript import destructive.
  }
  return antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince);
}

/**
 * Capture one Antigravity conversation into the machine-local ledger. Every
 * automatic import obeys the explicit resume boundary; candidate and inbox work
 * also obey the older watch-forward watermark used before per-tool consent epochs.
 */
function newestBackfillTs(
  messages: Array<{ timestamp?: string }>,
  edits: Array<{ timestamp?: string }>,
): string | undefined {
  let newest: string | undefined;
  for (const ts of [...messages, ...edits].map((x) => x.timestamp)) {
    if (ts && (!newest || ts > newest)) newest = ts;
  }
  return newest;
}

function captureConversationToLedger(
  info: AntigravityIdeTranscriptInfo,
  transcript: HookTranscript,
  edits: TranscriptEdit[],
  options: ImportAntigravityIdeOptions,
  allowHistoricalBackfill: boolean,
  automaticCaptureSince: string | undefined,
): LedgerSession | null {
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  if (
    transcript.messages.length === 0 &&
    (transcript.events?.length ?? 0) === 0 &&
    edits.length === 0
  ) {
    return null;
  }
  // The legacy watch-forward guard is still needed where no tracked destination
  // exists. The explicit per-tool resume boundary was already applied above and
  // remains enforced by captureTranscriptToLedger and the edit append below.
  if (!allowHistoricalBackfill) {
    if (autoInitEnabled()) {
      if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince))
        return null;
      ensureCaptureSince();
    }
    if (isStaleForAutoBackfill(newestBackfillTs(transcript.messages, edits))) return null;
  }

  const identity = readMachineIdentity();
  const cwd = options.cwd ?? process.cwd();
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  const ledger = ensureLedgerSession({
    tool: 'antigravity-ide',
    nativeSessionId: info.sessionId,
    machineId: identity?.machineId,
    slug: identity?.slug,
    cwd,
    continueCapture: () =>
      antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  // `backfill` because this is an after-the-fact import of an already-finished
  // conversation whose prompts predate the just-created ledger session.
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  const captured = captureTranscriptToLedger(
    ledger,
    transcript,
    'antigravity-ide',
    antigravityIdePlanFiles(info.sessionId),
    {
      backfill: true,
      automaticCaptureSince,
      continueCapture: () =>
        antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    },
  );
  if (!captured) return null;
  if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  if (!appendImportEditsToLedger(ledger.id, edits, automaticCaptureSince)) return null;
  return readLedgerSession(ledger.id) ?? ledger;
}

/**
 * Append the transcript's recovered file edits (absolute scratch paths) to the
 * ledger session as `edit` records, deduped by sourceId. `captureTranscriptToLedger`
 * only records per-file *diffs* carried on edit messages, which the Antigravity
 * parser doesn't emit — the real edits come from the `CODE_ACTION` recovery, so
 * the import adds them here.
 */
function appendImportEditsToLedger(
  sessionId: string,
  edits: TranscriptEdit[],
  automaticCaptureSince: string | undefined,
): boolean {
  const seen = new Set(
    readLedgerRecords(sessionId)
      .map((r) => r.sourceId)
      .filter((s): s is string => !!s),
  );
  for (const e of edits) {
    if (
      !automaticCaptureTimestampAllowed(e.timestamp, automaticCaptureSince) ||
      !isAbsolute(e.path) ||
      seen.has(e.sourceId)
    ) {
      continue;
    }
    if (!antigravityIdeAutomaticCaptureWindowUnchanged(automaticCaptureSince))
      return false;
    appendLedgerRecord(sessionId, {
      kind: 'edit',
      tool: 'antigravity-ide',
      file: e.path,
      diff: e.diff,
      ts: e.timestamp,
      sourceId: e.sourceId,
    });
    seen.add(e.sourceId);
  }
  return true;
}

/** Print the conversations available to import, so a student can pick one by id. */
function listConversations(): void {
  const found = findAntigravityIdeTranscripts();
  if (found.length === 0) {
    console.log('No Antigravity IDE conversations were found on disk.');
    return;
  }
  console.log(`Antigravity IDE conversations (${found.length}, newest first):`);
  console.log('');
  for (const t of found) {
    let first = '';
    try {
      first =
        readAntigravityIdeTranscript(t, t.path).messages.find((m) => m.role === 'user')
          ?.text ?? '';
    } catch {
      /* best-effort preview */
    }
    console.log(`  ${t.sessionId}`);
    if (first) console.log(`     first: ${oneLine(first, 100)}`);
  }
  console.log('');
  console.log('Import one with:  showtail import antigravity-ide <conversation-id>');
  console.log('Or run `showtail import antigravity-ide` to import the most recent.');
}

/**
 * Summarize an auto-route capture: what was recorded, and into which project(s).
 * When no project trail received it (`roots` empty) but it was parked in the inbox
 * (`inboxed`), point the user at `showtail inbox` to place it.
 */
function printAutoResult(
  res: AntigravityIdeImportResult,
  roots: string[],
  withResponses: boolean,
  inboxed = false,
): void {
  if (roots.length === 0 && inboxed) {
    console.log(
      'Captured your Antigravity IDE conversation to the Showtail inbox ' +
        '(not attached to one project trail yet).',
    );
    console.log('Place it in a project:  showtail inbox');
    return;
  }
  const total = res.prompts + res.responses + res.plans + res.edits;
  if (total === 0) {
    console.log(
      res.skipped > 0
        ? `Already captured — nothing new (${res.skipped} item(s) already in your trail).`
        : 'Nothing new to capture.',
    );
    return;
  }
  const parts = [`${res.prompts} prompt(s)`];
  if (withResponses) parts.push(`${res.responses} response(s)`);
  if (res.edits) parts.push(`${res.edits} edit(s)`);
  if (res.plans) parts.push(`${res.plans} plan(s)`);
  console.log(
    `Captured from Antigravity IDE: ${parts.join(', ')} (tool: antigravity-ide) ` +
      `into ${roots.length} project(s):`,
  );
  for (const r of roots) console.log(`  ${r}`);
}

function printResult(res: AntigravityIdeImportResult, withResponses: boolean): void {
  const total = res.prompts + res.responses + res.plans + res.edits;
  if (total === 0) {
    console.log(
      res.skipped > 0
        ? `Already imported — nothing new (${res.skipped} item(s) already in your trail).`
        : 'Nothing new to import.',
    );
    return;
  }
  const parts = [`${res.prompts} prompt(s)`];
  if (withResponses) parts.push(`${res.responses} response(s)`);
  if (res.edits) parts.push(`${res.edits} edit(s)`);
  if (res.plans) parts.push(`${res.plans} plan(s)`);
  console.log(
    `Imported from Antigravity IDE: ${parts.join(', ')} (tool: antigravity-ide).`,
  );
  if (res.skipped) console.log(`  ${res.skipped} already-imported item(s) skipped.`);

  console.log('');
  console.log('This was all local — nothing left your machine.');
  console.log('Not what you expected? Undo this whole batch:  showtail import undo');
  console.log(
    'Looks right? `showtail report` shows it interleaved with your other work.',
  );
}
