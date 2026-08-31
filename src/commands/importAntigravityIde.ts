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
import { basename, dirname, isAbsolute, relative } from 'node:path';
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
  ensureLedgerSession,
  markInbox,
  readLedgerRecords,
} from '../core/ledger.ts';
import { captureTranscriptToLedger } from '../core/ledgerCapture.ts';
import {
  autoInitEnabled,
  ensureCaptureSince,
  isStaleForAutoBackfill,
} from '../core/globalConfig.ts';
import { requireActiveAuthor, resolveActiveAuthorForHook } from '../core/authors.ts';
import {
  findRoot,
  isHomedirCatchAll,
  pathsForRoot,
  readConfig,
  requirePaths,
  type AuthorPaths,
} from '../core/storage.ts';
import { oneLine } from '../core/text.ts';
import type { HookTranscript } from '../plugins/types.ts';

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
   * Route by the transcript's edited-file paths into each enclosing `.showtail/`
   * project (scratch sandbox edits go to a dedicated scratch trail) instead of
   * importing into a single `cwd`-derived project. The headless capture path.
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
      // Skip the IDE's own generated state (task logs, etc. under
      // `.system_generated/`) — it's never the student's work, just execution noise.
      if (p.includes('/.system_generated/')) continue;
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
  if (options.list) {
    listConversations();
    return;
  }
  // Headless capture: route by the transcript's edited-file paths into each
  // project, rather than into one `cwd`-derived trail (no folder is reliably open
  // in the IDE's extension host).
  if (options.auto) {
    await runImportAntigravityIdeAuto(target, options);
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
 * Auto-route a transcript by its edited-file paths — the headless capture path.
 * Each edit is filed under its nearest enclosing **project** `.showtail/` trail
 * (`findRoot`): work under a tracked project lands in that project. Folderless /
 * scratch work — the common case for Antigravity, which edits its own sandbox
 * under `~/.gemini/antigravity-ide/scratch/...` with no project of its own — has
 * NO real enclosing trail (the machine-wide `~/.showtail` at HOME does NOT count;
 * see {@link isHomedirCatchAll}), so the whole conversation is parked in the
 * **inbox** (the ledger) for the user to `showtail inbox` → reattach into a
 * project, instead of being dumped into the homedir catch-all. Never prompts;
 * roots whose author can't be resolved are silently skipped.
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
  const transcript = readAntigravityIdeTranscript(info, options.cwd ?? process.cwd());
  const allEdits = safeExtractEdits(info.path, info.sessionId);
  if (transcript.messages.length === 0 && allEdits.length === 0) {
    console.log(
      'Nothing to capture — that conversation has no prompts, replies, or edits.',
    );
    return;
  }

  // Group edits by their enclosing PROJECT trail. The homedir `~/.showtail`
  // catch-all is not a project — folderless work belongs in the inbox, not there.
  const byRoot = new Map<string, TranscriptEdit[]>();
  for (const e of allEdits) {
    const root = isAbsolute(e.path) ? findRoot(dirname(e.path)) : null;
    if (!root || isHomedirCatchAll(root)) continue; // no real project trail
    const list = byRoot.get(root) ?? [];
    list.push(e);
    byRoot.set(root, list);
  }

  const totals: AntigravityIdeImportResult = {
    prompts: 0,
    responses: 0,
    plans: 0,
    edits: 0,
    skipped: 0,
  };
  const importedRoots: string[] = [];
  for (const [root, edits] of byRoot) {
    const paths = pathsForRoot(root);
    if (!existsSync(paths.config)) continue; // not a tracked project — skip
    const author = await resolveActiveAuthorForHook(paths, { cwd: root });
    if (!author) continue; // can't attribute without prompting — skip this root
    const res = await importIntoRoot(author, root, transcript, edits, options);
    totals.prompts += res.prompts;
    totals.responses += res.responses;
    totals.plans += res.plans;
    totals.edits += res.edits;
    totals.skipped += res.skipped;
    if (res.prompts + res.responses + res.plans + res.edits > 0) importedRoots.push(root);
  }

  // No real project trail received this conversation (folderless/scratch work, or
  // a pure-chat conversation): park it in the inbox via the ledger.
  if (importedRoots.length === 0) {
    const inboxed = captureConversationToInbox(info, transcript, allEdits, options);
    printAutoResult(totals, importedRoots, options.withResponses !== false, inboxed);
    return;
  }
  printAutoResult(totals, importedRoots, options.withResponses !== false);
}

/**
 * Park a folderless Antigravity conversation in the inbox (the machine-local
 * ledger), so it surfaces in `showtail inbox` for the user to reattach into a
 * project — instead of dumping it into the homedir `~/.showtail` catch-all.
 * Idempotent: the ledger session is keyed by the stable conversation id and
 * records dedup by sourceId, so the extension re-running `--auto` adds nothing new.
 * Returns whether anything (records or edits) is now captured for this session.
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

function captureConversationToInbox(
  info: AntigravityIdeTranscriptInfo,
  transcript: HookTranscript,
  edits: TranscriptEdit[],
  options: ImportAntigravityIdeOptions,
): boolean {
  // Watch-forward: don't resurrect a conversation that finished before Showtail began
  // capturing here. Set-once watermark (only once tracking is on; `setup` normally
  // sets it — this is the migration net), then skip stale history before creating any
  // ledger session. Explicit `import antigravity-ide` (non-auto) never reaches here.
  if (autoInitEnabled()) ensureCaptureSince();
  if (isStaleForAutoBackfill(newestBackfillTs(transcript.messages, edits))) return false;

  const identity = readMachineIdentity();
  const ledger = ensureLedgerSession({
    tool: 'antigravity-ide',
    nativeSessionId: info.sessionId,
    machineId: identity?.machineId,
    slug: identity?.slug,
    cwd: options.cwd ?? process.cwd(),
  });
  // `backfill` because this is an after-the-fact import of an already-finished
  // conversation whose prompts predate the just-created ledger session.
  captureTranscriptToLedger(
    ledger,
    transcript,
    'antigravity-ide',
    antigravityIdePlanFiles(info.sessionId),
    { backfill: true },
  );
  appendImportEditsToLedger(ledger.id, edits);
  // New ledger sessions are already `inbox`; mark defensively in case a prior run
  // placed and the trail later vanished. Never let bookkeeping break capture.
  try {
    markInbox(ledger.id);
  } catch {
    /* best-effort */
  }
  return readLedgerRecords(ledger.id).length > 0;
}

/**
 * Append the transcript's recovered file edits (absolute scratch paths) to the
 * ledger session as `edit` records, deduped by sourceId. `captureTranscriptToLedger`
 * only records per-file *diffs* carried on edit messages, which the Antigravity
 * parser doesn't emit — the real edits come from the `CODE_ACTION` recovery, so
 * the import adds them here.
 */
function appendImportEditsToLedger(sessionId: string, edits: TranscriptEdit[]): void {
  const seen = new Set(
    readLedgerRecords(sessionId)
      .map((r) => r.sourceId)
      .filter((s): s is string => !!s),
  );
  for (const e of edits) {
    if (!isAbsolute(e.path) || seen.has(e.sourceId)) continue;
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
        '(folderless/scratch work — no project to file it under).',
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
