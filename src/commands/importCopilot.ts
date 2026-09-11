/**
 * `showtail import copilot` — back-fill a trail from an existing VS Code **native
 * Copilot Chat** session on disk (`…/workspaceStorage/<hash>/chatSessions/<id>.jsonl`,
 * or a legacy `.json`; no-folder chats live in
 * `…/globalStorage/emptyWindowChatSessions/<id>.jsonl`).
 *
 * Mirrors commands/importCodex.ts: with no target an interactive picker lists this
 * project's sessions (choose one or several); `--list` prints the same list
 * non-interactively; `--file` imports a specific session file; a `<target>` id
 * imports that session directly. Roles are explicit in the file, so there's no
 * guessing about user vs. assistant.
 *
 * `--auto` is the headless/no-folder path (mirrors `import antigravity-ide --auto`):
 * it captures one durable ledger session, then resolves the whole conversation to
 * one deterministic project from its cwd and complete edit set. Ambiguous work
 * stays in the inbox instead of being duplicated across projects. The VS Code
 * extension invokes this for both the folder watcher (`--file`) and the empty-window
 * watcher (`--file --auto`); shared `sourceId` dedupe means the live path and a later
 * manual import never double-count.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { createInterface } from 'node:readline';
import {
  extractCopilotEdits,
  findProjectChatSessions,
  importCopilotChatTranscript,
  isInternalEditPath,
  parseCopilotSession,
  readChatSessionFile,
  reconstructSession,
  summarizeChatSessions,
  type CopilotAbsEdit,
  type CopilotImportResult,
  type CopilotSessionSummary,
} from '../core/copilotChatTranscript.ts';
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
import { captureTranscriptToLedger } from '../core/ledgerCapture.ts';
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
  pathKey,
  pathsForRoot,
  requirePaths,
  resolveProjectContext,
  type AuthorPaths,
} from '../core/storage.ts';
import { isSyntheticPrompt } from '../core/syntheticPrompt.ts';
import type { HookTranscript } from '../plugins/types.ts';
import { oneLine } from '../core/text.ts';
import { parseSelection } from './importCodex.ts';
import { ensureInitialized } from './init.ts';

export interface ImportCopilotOptions {
  /** List this project's sessions and exit. */
  list?: boolean;
  /** Also log Copilot's text replies (not just your prompts). */
  withResponses?: boolean;
  /** Import a specific session file by path (escape hatch; used by the extension). */
  file?: string;
  /** Import into a specific Showtail session id. */
  session?: string;
  /** Suppress the human-facing summary (used by the extension's live watcher). */
  quiet?: boolean;
  /** Resolve the full session to one project from cwd + edit paths (headless). */
  auto?: boolean;
  cwd?: string;
}

interface CopilotAutomaticCaptureWindow {
  automaticCaptureSince?: string;
}

/** Read a consent epoch only while machine-wide automatic capture is enabled. */
function readCopilotAutomaticCaptureWindow(): CopilotAutomaticCaptureWindow | null {
  if (toolCaptureGloballyDisabled('copilot')) return null;
  const automaticCaptureSince = toolCaptureEnabledAt('copilot');
  // Recheck because disconnect and reconnect are separate cross-process writes.
  if (toolCaptureGloballyDisabled('copilot')) return null;
  return { automaticCaptureSince };
}

/** Stop a sweep if consent was revoked or restarted after its transcript read. */
function copilotAutomaticCaptureWindowUnchanged(
  automaticCaptureSince: string | undefined,
): boolean {
  if (toolCaptureGloballyDisabled('copilot')) return false;
  const current = toolCaptureEnabledAt('copilot');
  return !toolCaptureGloballyDisabled('copilot') && current === automaticCaptureSince;
}

/** Trim milliseconds from an ISO timestamp for friendlier output. */
function trimMs(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** A friendly "how long ago" label for a file's modification time. */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/** A rough "~25 min" / "~2 h" span between the first and last message, if known. */
function spanLabel(first?: string, last?: string): string {
  if (!first || !last) return '';
  const ms = Date.parse(last) - Date.parse(first);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return '~<1 min';
  if (min < 90) return `~${min} min`;
  const hours = Math.round(min / 60);
  return `~${hours} h`;
}

/** The marker shown after an already-imported session in listings. */
function importMarker(state: CopilotSessionSummary['importState']): string {
  if (state === 'full') return '  [imported]';
  if (state === 'partial') return '  [partially imported]';
  return '';
}

/** Print one summary as the numbered block shown in the picker / `--list`. */
function printSummary(s: CopilotSessionSummary, ordinal: number): void {
  const span = spanLabel(s.first, s.last);
  const meta = [`${s.promptCount} prompt(s)`, `${s.editCount} edit(s)`];
  if (span) meta.push(span);
  console.log(
    `  ${ordinal}. ${relativeTime(s.info.mtimeMs)}    ${meta.join(', ')}${importMarker(s.importState)}`,
  );
  if (s.firstPrompt) console.log(`     first: ${oneLine(s.firstPrompt, 100)}`);
  if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) {
    console.log(`     last:  ${oneLine(s.lastPrompt, 100)}`);
  }
  console.log(`     id: ${s.info.sessionId}`);
  console.log('');
}

/**
 * Import an existing native Copilot Chat session from disk. With no target, an
 * interactive picker lists this project's sessions; `--list` prints the same list
 * non-interactively; `--file` imports a specific `.json`; a `<target>` id imports
 * that session directly.
 */
export async function runImportCopilot(
  target: string | undefined,
  options: ImportCopilotOptions,
): Promise<void> {
  // Headless/no-folder capture: route by edited-file paths into each project,
  // rather than into one `cwd`-derived trail. No `.showtail/` need enclose cwd.
  if (options.auto) {
    // `--auto` is extension-driven capture, not a deliberate import. A bare
    // disconnect is a machine-wide consent boundary; stop before reading the
    // transcript or touching the ledger. The ordinary import path below stays
    // available so the student can still import a file explicitly.
    if (!readCopilotAutomaticCaptureWindow()) return;
    try {
      await runImportCopilotAuto(target, options);
    } catch (error) {
      if (error instanceof CaptureInterruptedError) return;
      throw error;
    }
    return;
  }

  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });

  if (options.list) {
    listSessions(author);
    return;
  }

  // Explicit single-session targets (a file or an id) keep their direct behavior.
  if (options.file || target) {
    const path = resolveSessionPath(author, target, options);
    if (!path) return; // A message was already printed.
    await importPaths(author, [path], options);
    return;
  }

  // No target: discover this project's sessions and let the student choose.
  const summaries = summarizeChatSessions(author);
  if (summaries.length === 0) {
    console.log('No native Copilot Chat sessions were found for this project on disk.');
    console.log('If you have a session elsewhere, point at it with --file <path>.');
    return;
  }

  // Non-interactive (piped/CI): fall back to the most recent, as Codex does.
  if (!process.stdin.isTTY) {
    const latest = summaries[0]!;
    console.log(
      `Importing the most recent session (${latest.info.sessionId}). ` +
        'Run in a terminal to pick from the full list.',
    );
    await importPaths(author, [latest.info.path], options);
    return;
  }

  const chosen = await pickSessions(summaries);
  if (!chosen || chosen.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }
  await importPaths(
    author,
    chosen.map((s) => s.info.path),
    options,
  );
}

/** Resolve which single session file to import, printing guidance when it can't. */
function resolveSessionPath(
  author: AuthorPaths,
  target: string | undefined,
  options: ImportCopilotOptions,
): string | null {
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    return options.file;
  }

  const found = findProjectChatSessions(author.shared.root);
  if (found.length === 0) {
    console.log('No native Copilot Chat sessions were found for this project on disk.');
    console.log('If you have a session elsewhere, point at it with --file <path>.');
    return null;
  }

  if (target) {
    const chosen = found.find(
      (t) => t.sessionId === target || t.sessionId.startsWith(target),
    );
    if (!chosen) {
      throw new Error(
        `No Copilot Chat session matching "${target}" for this project. ` +
          'Run `showtail import copilot --list` to see what is available.',
      );
    }
    return chosen.path;
  }

  return null; // Unreachable: callers handle the no-target case.
}

// --- `--auto`: edit-path routing (headless / no-folder capture) ------------

/** Convert an absolute path to a display path relative to `root` (else posix-absolute). */
function displayPath(p: string, root: string): string {
  if (!isAbsolute(p)) return p.replace(/\\/g, '/');
  const rel = relative(root, p).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : p.replace(/\\/g, '/');
}

/** The session id for a chat file = its basename without the .json/.jsonl extension. */
function sessionIdFromFile(file: string): string {
  return basename(file).replace(/\.jsonl?$/, '');
}

/**
 * `--auto`: capture once to the ledger, then project only when the whole session
 * resolves to one project. This matches live-hook routing: a meaningful prompt may
 * create a candidate trail when automatic tracking is enabled, while mixed-root or
 * otherwise unresolved work stays intact in the inbox.
 */
async function runImportCopilotAuto(
  target: string | undefined,
  options: ImportCopilotOptions,
): Promise<void> {
  void target; // --auto is the headless --file path; <target> ids aren't used.
  const file = options.file;
  if (!file) {
    if (!options.quiet)
      console.log('`import copilot --auto` needs --file <session.jsonl>.');
    return;
  }
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);

  const session = reconstructSession(readFileSync(file, 'utf8'));
  // The file read can overlap a disconnect/reconnect. Use the latest consent
  // epoch, then require it to remain unchanged until each automatic write.
  const captureWindow = readCopilotAutomaticCaptureWindow();
  if (!captureWindow) return;
  const { automaticCaptureSince } = captureWindow;
  const sid = sessionIdFromFile(file);
  const cwd = options.cwd ?? process.cwd();
  const allEdits = extractCopilotEdits(session, sid, {
    automaticCaptureSince,
  }).filter((edit) => isAbsolute(edit.absPath) && !isInternalEditPath(edit.absPath));
  const sourceContext = resolveProjectContext({
    cwd,
    editPaths: allEdits.map((edit) => edit.absPath),
  });
  const sourceRoot =
    sourceContext.state === 'tracked' || sourceContext.state === 'candidate'
      ? sourceContext.root
      : undefined;
  const parsed = parseCopilotSession(session, sourceRoot ?? cwd, {
    automaticCaptureSince,
  });
  const transcript = filterCopilotResponses(parsed, options.withResponses !== false);
  const ledger = captureCopilotConversationToLedger(
    sid,
    transcript,
    allEdits,
    options,
    sourceRoot,
    sourceContext.state === 'tracked',
    automaticCaptureSince,
  );
  const totals: CopilotImportResult = {
    title: '',
    prompts: 0,
    responses: 0,
    edits: 0,
    plans: 0,
    decisions: 0,
    skipped: 0,
  };
  if (!ledger) {
    if (!options.quiet) printAutoResult(totals, [], options.withResponses !== false);
    return;
  }

  const current = readLedgerSession(ledger.id) ?? ledger;
  // A live extension watcher seeds this ledger session through `hook
  // session-start` first, including every root in a multi-root VS Code window.
  // Resolve from the complete durable session so a no-edit multi-root chat stays
  // inbox-only instead of inheriting whichever cwd launched the importer.
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
    if (!(await parkCopilotLedger(current, automaticCaptureSince))) return;
    if (!options.quiet)
      printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }

  const root = context.root;
  if (context.state === 'candidate') {
    if (!(await parkCopilotLedger(current, automaticCaptureSince))) return;
    const meaningfulPrompt = transcript.messages.some(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        !isSyntheticPrompt(message.text),
    );
    if (!autoInitEnabled() || !meaningfulPrompt || !isEligibleAnchor(root)) {
      if (!options.quiet)
        printAutoResult(totals, [], options.withResponses !== false, true);
      return;
    }
    if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
    await ensureInitialized(root, {
      ...(context.evidence === 'trail' ? {} : { anchorKind: context.evidence }),
      initialization: {
        mode: 'automatic',
        evidence: context.evidence,
        ledgerSessionId: current.id,
      },
      continueCapture: () =>
        copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  }

  const paths = pathsForRoot(root);
  if (!existsSync(paths.config)) {
    if (
      !(await parkCopilotLedger(
        readLedgerSession(current.id) ?? current,
        automaticCaptureSince,
      ))
    ) {
      return;
    }
    if (!options.quiet)
      printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  const trailId = ensureTrailId(paths, () =>
    copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  );
  try {
    if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
    await clearOtherLedgerProjections(readLedgerSession(current.id) ?? current, trailId, {
      continueCapture: () =>
        copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  } catch {
    if (
      !(await parkCopilotLedger(
        readLedgerSession(current.id) ?? current,
        automaticCaptureSince,
      ))
    ) {
      return;
    }
    if (!options.quiet)
      printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }
  const author = await resolveActiveAuthorForHook(paths, {
    cwd: root,
    continueCapture: () => copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  if (!author) {
    if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
    try {
      markInbox(current.id, {
        continueCapture: () =>
          copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
      });
    } catch {
      // The ledger remains durable even if placement bookkeeping fails.
    }
    if (!options.quiet)
      printAutoResult(totals, [], options.withResponses !== false, true);
    return;
  }

  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  const materialized = await materializeLedgerSession(
    readLedgerSession(current.id) ?? current,
    author,
    {
      continueCapture: () =>
        copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    },
  );
  if (!materialized.completed) return;
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return;
  markPlaced(current.id, trailId, root, {
    continueCapture: () => copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  totals.prompts = materialized.prompts;
  totals.responses = materialized.replies;
  totals.edits = materialized.edits;
  totals.plans = materialized.plans;
  totals.decisions = materialized.decisions;
  totals.skipped = Math.max(
    0,
    readLedgerRecords(current.id).length - materialized.projected,
  );

  if (!options.quiet) printAutoResult(totals, [root], options.withResponses !== false);
}

/** Omit response-only content when the import explicitly disables AI responses. */
function filterCopilotResponses(
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
async function parkCopilotLedger(
  session: LedgerSession,
  automaticCaptureSince: string | undefined,
): Promise<boolean> {
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return false;
  try {
    await clearOtherLedgerProjections(session, undefined, {
      continueCapture: () =>
        copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  } catch {
    // Best-effort cleanup; the ledger remains the complete source of truth.
  }
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return false;
  try {
    markInbox(session.id, {
      continueCapture: () =>
        copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
    });
  } catch {
    // A ledger write failure must not make the transcript import destructive.
  }
  return copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince);
}

/** The newest ISO timestamp across a conversation's messages and recovered edits. */
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

/**
 * Capture one Copilot conversation into the machine-local ledger. Candidate and
 * inbox work obeys the watch-forward watermark; an already-tracked destination
 * preserves the historical import behavior and may back-fill older content.
 */
function captureCopilotConversationToLedger(
  sid: string,
  transcript: HookTranscript,
  edits: CopilotAbsEdit[],
  options: ImportCopilotOptions,
  sourceRoot: string | undefined,
  allowHistoricalBackfill: boolean,
  automaticCaptureSince: string | undefined,
): LedgerSession | null {
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  // Conversation only. Recovered absolute edits are appended separately so a
  // later placement can safely re-relativize them against its selected root.
  const convo: HookTranscript = {
    sessionId: transcript.sessionId,
    messages: transcript.messages.filter((message) => message.role !== 'edit'),
    events: transcript.events,
  };
  if (
    convo.messages.length === 0 &&
    (convo.events?.length ?? 0) === 0 &&
    edits.length === 0
  ) {
    return null;
  }
  // Watch-forward: don't resurrect a chat that finished before Showtail began
  // capturing here, except when a real tracked trail is the explicit destination.
  if (!allowHistoricalBackfill) {
    if (autoInitEnabled()) ensureCaptureSince();
    if (isStaleForAutoBackfill(newestBackfillTs(convo.messages, edits))) return null;
  }

  const identity = readMachineIdentity();
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  const ledger = ensureLedgerSession({
    tool: 'github-copilot',
    nativeSessionId: sid,
    machineId: identity?.machineId,
    slug: identity?.slug,
    cwd: options.cwd ?? process.cwd(),
    continueCapture: () => copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  // `backfill`: an after-the-fact import of an already-finished conversation whose
  // prompts predate the just-created ledger session.
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  const captured = captureTranscriptToLedger(ledger, convo, 'github-copilot', [], {
    backfill: true,
    automaticCaptureSince,
    continueCapture: () => copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince),
  });
  if (!captured) return null;
  if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return null;
  if (!appendCopilotEditsToLedger(ledger.id, edits, sourceRoot, automaticCaptureSince)) {
    return null;
  }
  return readLedgerSession(ledger.id) ?? ledger;
}

/**
 * Append the recovered absolute Copilot edits to the ledger session as `edit`
 * records, deduped by sourceId. The conversation capture above does not record
 * edits (the transcript's edit messages are dropped), so these are the edit source.
 */
function appendCopilotEditsToLedger(
  sessionId: string,
  edits: CopilotAbsEdit[],
  sourceRoot?: string,
  automaticCaptureSince?: string,
): boolean {
  const session = readLedgerSession(sessionId);
  const records = readLedgerRecords(sessionId);
  const seen = new Set(
    records.flatMap((record) => (record.sourceId ? [record.sourceId] : [])),
  );
  for (const e of edits) {
    if (!isAbsolute(e.absPath)) continue;
    const effectiveEditPath = session
      ? effectiveLedgerPath(session, e.absPath)
      : e.absPath;
    if (
      records.some(
        (record) =>
          record.kind === 'edit' &&
          record.file !== undefined &&
          pathKey(session ? effectiveLedgerPath(session, record.file) : record.file) ===
            pathKey(effectiveEditPath) &&
          record.sourceId?.startsWith(`${e.sourceIdBase}#`),
      )
    ) {
      continue;
    }
    const suffix =
      sourceRoot && isPathUnder(effectiveEditPath, sourceRoot)
        ? displayPath(effectiveEditPath, sourceRoot)
        : effectiveEditPath.replace(/\\/g, '/');
    const sourceId = `${e.sourceIdBase}#${suffix}`;
    if (seen.has(sourceId)) continue;
    if (!copilotAutomaticCaptureWindowUnchanged(automaticCaptureSince)) return false;
    const record = appendLedgerRecord(sessionId, {
      kind: 'edit',
      tool: 'github-copilot',
      file: e.absPath,
      diff: e.diff,
      ts: e.timestamp,
      sourceId,
    });
    records.push(record);
    seen.add(sourceId);
  }
  return true;
}

/**
 * Summarize an `--auto` capture: what was recorded, and into which project(s).
 * When no project trail received it (`roots` empty) but it was parked in the inbox
 * (`inboxed`), point the user at `showtail inbox`.
 */
function printAutoResult(
  res: CopilotImportResult,
  roots: string[],
  withResponses: boolean,
  inboxed = false,
): void {
  if (roots.length === 0 && inboxed) {
    console.log(
      'Captured native Copilot Chat to the Showtail inbox ' +
        '(not attached to one project trail yet).',
    );
    console.log('Place it in a project:  showtail inbox');
    return;
  }
  const total = res.prompts + res.responses + res.edits + res.plans + res.decisions;
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
  if (res.decisions) parts.push(`${res.decisions} decision(s)`);
  console.log(
    `Captured native Copilot Chat: ${parts.join(', ')} (tool: github-copilot) ` +
      `into ${roots.length} project(s):`,
  );
  for (const r of roots) console.log(`  ${r}`);
}

/**
 * Import one or more session files as a single undoable batch, then print a
 * combined result (unless `--quiet`). Overlapping messages dedupe automatically
 * because every import re-reads the trail's source ids.
 */
async function importPaths(
  author: AuthorPaths,
  filePaths: string[],
  options: ImportCopilotOptions,
): Promise<void> {
  const batchId = makeId('imp');
  const totals: CopilotImportResult = {
    title: '',
    prompts: 0,
    responses: 0,
    edits: 0,
    plans: 0,
    decisions: 0,
    skipped: 0,
  };
  let imported = 0;

  for (const path of filePaths) {
    const transcript = readChatSessionFile(path, author.shared.root);
    if (transcript.messages.length === 0) continue;
    const res = await importCopilotChatTranscript(author, transcript, {
      withResponses: options.withResponses,
      sessionId: options.session,
      batchId,
    });
    imported += 1;
    totals.prompts += res.prompts;
    totals.responses += res.responses;
    totals.edits += res.edits;
    totals.plans += res.plans;
    totals.decisions += res.decisions;
    totals.skipped += res.skipped;
    if (res.first && (!totals.first || res.first < totals.first))
      totals.first = res.first;
    if (res.last && (!totals.last || res.last > totals.last)) totals.last = res.last;
  }

  if (options.quiet) return;

  if (imported === 0) {
    console.log(
      'Nothing to import — no prompts or edits were found in those session(s).',
    );
    return;
  }

  printResult(totals, Boolean(options.withResponses), filePaths.length);
}

/**
 * Interactively pick one or more sessions to import. Prints the numbered list,
 * then reads a single line: a comma/space list with optional ranges, `all`, or
 * `q`/empty to cancel. Re-prompts once on invalid input, then gives up. Reuses
 * Codex's {@link parseSelection} so the two pickers behave identically.
 */
async function pickSessions(
  summaries: CopilotSessionSummary[],
): Promise<CopilotSessionSummary[] | null> {
  console.log(`Copilot Chat sessions for this project (${summaries.length}):`);
  console.log('');
  summaries.forEach((s, i) => printSummary(s, i + 1));

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (
        await new Promise<string>((resolve) => {
          rl.question(
            `Pick sessions to import [e.g. 1,3 or 'all', q to quit]: `,
            resolve,
          );
        })
      )
        .trim()
        .toLowerCase();

      if (answer === '' || answer === 'q' || answer === 'quit') return null;
      if (answer === 'all' || answer === '*') return summaries;

      const chosen = parseSelection(answer, summaries.length);
      if (chosen) return chosen.map((i) => summaries[i]!);

      process.stderr.write(
        `  Didn't understand that. Enter numbers between 1 and ${summaries.length} (e.g. 1,3), 'all', or q.\n`,
      );
    }
    return null;
  } finally {
    rl.close();
  }
}

/** Print the available sessions so a student can pick one by id. */
function listSessions(author: AuthorPaths): void {
  const summaries = summarizeChatSessions(author);
  if (summaries.length === 0) {
    console.log('No native Copilot Chat sessions were found for this project on disk.');
    return;
  }

  console.log(`Copilot Chat sessions for this project (${summaries.length}):`);
  console.log('');
  summaries.forEach((s, i) => printSummary(s, i + 1));
  console.log('Import one with:  showtail import copilot <session-id>');
  console.log('Or run `showtail import copilot` to pick interactively.');
}

function printResult(
  res: CopilotImportResult,
  withResponses: boolean,
  sessionCount: number,
): void {
  const total = res.prompts + res.responses + res.edits + res.plans + res.decisions;
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
  parts.push(`${res.edits} edit(s)`);
  if (res.plans) parts.push(`${res.plans} plan(s)`);
  if (res.decisions) parts.push(`${res.decisions} decision(s)`);
  const from =
    sessionCount > 1
      ? `${sessionCount} Copilot Chat sessions`
      : 'your Copilot Chat session';
  console.log(`Imported from ${from}: ${parts.join(', ')} (tool: github-copilot).`);
  if (res.skipped) console.log(`  ${res.skipped} already-imported item(s) skipped.`);
  if (res.first && res.last) {
    console.log(`  Spanned ${trimMs(res.first)} → ${trimMs(res.last)}.`);
  }

  console.log('');
  console.log('This was all local — nothing left your machine.');
  console.log('Not what you expected? Undo this whole batch:  showtail import undo');
  console.log(
    'Looks right? `showtail report` shows it interleaved with your other work.',
  );
}
