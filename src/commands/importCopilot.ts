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
 * it routes each session's prompts/replies/edits into the `.showtail/` project that
 * encloses its edited files (`findRoot`), falling back to the trail enclosing the
 * invocation cwd — so an empty-window chat still lands somewhere (e.g. a machine-wide
 * `~/.showtail`). The VS Code extension invokes this for both the folder watcher
 * (`--file`) and the empty-window watcher (`--file --auto`); shared `sourceId` dedupe
 * means the live path and a later manual import never double-count.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { createInterface } from 'node:readline';
import {
  extractCopilotEdits,
  findProjectChatSessions,
  importCopilotChatTranscript,
  importCopilotEdits,
  importCopilotMessages,
  isInternalEditPath,
  parseCopilotSession,
  readChatSessionFile,
  reconstructSession,
  requestIdOf,
  summarizeChatSessions,
  type CopilotAbsEdit,
  type CopilotEditArtifact,
  type CopilotImportResult,
  type CopilotSessionSummary,
} from '../core/copilotChatTranscript.ts';
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
  requirePaths,
  type AuthorPaths,
} from '../core/storage.ts';
import type { HookTranscript } from '../plugins/types.ts';
import { oneLine } from '../core/text.ts';
import { parseSelection } from './importCodex.ts';

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
  /** Route by edited-file paths into each enclosing `.showtail/` project (headless). */
  auto?: boolean;
  cwd?: string;
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
    await runImportCopilotAuto(target, options);
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
 * `--auto`: route a session's prompts/replies/edits by edited-file path into each
 * enclosing `.showtail/` project (mirrors `runImportAntigravityIdeAuto`). Edits under
 * a tracked project land there; if no edit resolves to a trail (pure Q&A / untracked
 * scratch), fall back to the trail enclosing the invocation cwd — the extension
 * invokes with `cwd = homedir()`, so an empty-window chat lands in a machine-wide
 * `~/.showtail` when present. The full conversation is imported into every touched
 * trail; roots whose author can't be resolved without prompting are skipped.
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
  const sid = sessionIdFromFile(file);
  const allEdits = extractCopilotEdits(session, sid);

  // Group edits by the PROJECT `.showtail/` that encloses them. The homedir
  // `~/.showtail` catch-all is not a project — folderless work belongs in the
  // inbox (below), not there.
  const byRoot = new Map<string, typeof allEdits>();
  for (const e of allEdits) {
    if (!isAbsolute(e.absPath)) continue;
    const root = findRoot(dirname(e.absPath));
    if (!root || isHomedirCatchAll(root)) continue; // no real project trail
    const list = byRoot.get(root) ?? [];
    list.push(e);
    byRoot.set(root, list);
  }

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
  const importedRoots: string[] = [];
  for (const [root, edits] of byRoot) {
    const paths = pathsForRoot(root);
    if (!existsSync(paths.config)) continue; // not a tracked project — skip
    const author = await resolveActiveAuthorForHook(paths, { cwd: root });
    if (!author) continue; // can't attribute without prompting — skip this root

    const transcript = parseCopilotSession(session, root);
    const msg = await importCopilotMessages(author, transcript, {
      withResponses: options.withResponses,
      sessionId: options.session,
      batchId,
    });
    // Map this root's absolute edits to in-repo artifacts (skip internal / out-of-repo),
    // linking each to its prompt turn so it renders inside that turn.
    const artifacts: CopilotEditArtifact[] = [];
    for (const e of edits) {
      const display = displayPath(e.absPath, root);
      if (display.startsWith('..') || isInternalEditPath(display)) continue;
      artifacts.push({
        path: display,
        diff: e.diff,
        timestamp: e.timestamp,
        turnId: msg.turnIds.get(requestIdOf(e.sourceIdBase)),
        sourceId: `${e.sourceIdBase}#${display}`,
      });
    }
    const editRes = importCopilotEdits(author, artifacts, {
      sessionId: options.session,
      batchId,
    });

    totals.prompts += msg.prompts;
    totals.responses += msg.responses;
    totals.edits += editRes.written;
    totals.plans += msg.plans;
    totals.decisions += msg.decisions;
    totals.skipped += msg.skipped + editRes.skipped;
    if (msg.first && (!totals.first || msg.first < totals.first))
      totals.first = msg.first;
    if (msg.last && (!totals.last || msg.last > totals.last)) totals.last = msg.last;
    if (msg.prompts + msg.responses + msg.plans + msg.decisions + editRes.written > 0)
      importedRoots.push(root);
  }

  // No real project trail received this conversation (folderless / empty-window
  // Copilot chat, or pure Q&A): park it in the inbox via the ledger so
  // `showtail inbox` can place it — instead of dumping it into ~/.showtail.
  if (importedRoots.length === 0) {
    const inboxed = captureCopilotConversationToInbox(sid, session, allEdits, options);
    if (!options.quiet)
      printAutoResult(totals, importedRoots, options.withResponses !== false, inboxed);
    return;
  }

  if (options.quiet) return;
  printAutoResult(totals, importedRoots, options.withResponses !== false);
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
 * Park a folderless Copilot conversation in the inbox (the machine-local ledger),
 * so it surfaces in `showtail inbox` for reattach — instead of the homedir
 * `~/.showtail` catch-all. Idempotent: keyed by the stable chat-session id, records
 * dedup by sourceId, so the watcher re-running `--auto` adds nothing new. Returns
 * whether anything is now captured for this session.
 */
function captureCopilotConversationToInbox(
  sid: string,
  session: unknown,
  edits: CopilotAbsEdit[],
  options: ImportCopilotOptions,
): boolean {
  // Conversation only (prompts/replies/plans/decisions). Edits are appended below
  // from the recovered ABSOLUTE list so a reattach can re-relativize them against
  // the target repo; the transcript's own relativized edit messages are dropped to
  // avoid double-counting.
  const parsed = parseCopilotSession(session, options.cwd ?? process.cwd());
  const convo: HookTranscript = {
    sessionId: parsed.sessionId,
    messages: parsed.messages.filter((m) => m.role !== 'edit'),
  };
  // Watch-forward: don't resurrect a chat that finished before Showtail began
  // capturing here. Establish the set-once watermark (only once tracking is on;
  // `setup` normally sets it — this is the migration net for pre-feature setups),
  // then skip stale history BEFORE creating any ledger session, so no empty shard is
  // left behind. Explicit `import copilot` (not `--auto`) never reaches here, so
  // on-purpose history imports are unaffected.
  if (autoInitEnabled()) ensureCaptureSince();
  if (isStaleForAutoBackfill(newestBackfillTs(convo.messages, edits))) return false;

  const identity = readMachineIdentity();
  const ledger = ensureLedgerSession({
    tool: 'github-copilot',
    nativeSessionId: sid,
    machineId: identity?.machineId,
    slug: identity?.slug,
    cwd: options.cwd ?? process.cwd(),
  });
  // `backfill`: an after-the-fact import of an already-finished conversation whose
  // prompts predate the just-created ledger session.
  captureTranscriptToLedger(ledger, convo, 'github-copilot', [], { backfill: true });
  appendCopilotEditsToLedger(ledger.id, edits);
  try {
    markInbox(ledger.id);
  } catch {
    /* best-effort — new ledger sessions already default to inbox */
  }
  return readLedgerRecords(ledger.id).length > 0;
}

/**
 * Append the recovered absolute Copilot edits to the ledger session as `edit`
 * records, deduped by sourceId. The conversation capture above does not record
 * edits (the transcript's edit messages are dropped), so these are the edit source.
 */
function appendCopilotEditsToLedger(sessionId: string, edits: CopilotAbsEdit[]): void {
  const seen = new Set(
    readLedgerRecords(sessionId)
      .map((r) => r.sourceId)
      .filter((s): s is string => !!s),
  );
  for (const e of edits) {
    if (!isAbsolute(e.absPath)) continue;
    const sourceId = `${e.sourceIdBase}#${e.absPath}`;
    if (seen.has(sourceId)) continue;
    appendLedgerRecord(sessionId, {
      kind: 'edit',
      tool: 'github-copilot',
      file: e.absPath,
      diff: e.diff,
      ts: e.timestamp,
      sourceId,
    });
    seen.add(sourceId);
  }
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
      'Captured native Copilot Chat to the Showtail inbox (folderless work — ' +
        'no project to file it under).',
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
