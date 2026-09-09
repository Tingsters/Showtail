import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { authorSlugs } from '../core/authors.ts';
import { makeId } from '../core/ids.ts';
import {
  appendJournal,
  JOURNAL_ENTRY_VERSION,
  journalSegmentPaths,
  readJournal,
  readJournalShards,
  rewriteJournal,
} from '../core/journal.ts';
import { readObject } from '../core/objects.ts';
import { authorPaths, pathsForRoot, type AuthorPaths } from '../core/storage.ts';
import type { JournalEntry } from '../types.ts';

const EXPECTED = {
  falseCliPrompts: 63,
  linkedManualPrompts: 11,
  nearbyManualPrompts: 1,
  obsoleteToolCalls: 26,
  total: 101,
} as const;

const REPAIR_LABEL = 'copilot-vscode-duplicate-capture';

interface ToolCall {
  entry: JournalEntry;
  toolUseId: string;
  commandText: string;
}

export interface CopilotDuplicateRepairPlan {
  root: string;
  author: AuthorPaths;
  removeIds: Set<string>;
  counts: typeof EXPECTED;
}

export interface CopilotDuplicateRepairResult {
  removed: number;
  markerId: string;
  backupDir: string;
}

function fail(message: string): never {
  throw new Error(`Copilot duplicate repair refused: ${message}`);
}

function firstRef(entry: JournalEntry): string | undefined {
  return entry.refs?.[0];
}

function at(entry: JournalEntry): number {
  const parsed = Date.parse(entry.ts);
  if (!Number.isFinite(parsed)) fail(`entry ${entry.id} has an invalid timestamp`);
  return parsed;
}

function isPrompt(entry: JournalEntry, tool: string): boolean {
  return entry.kind === 'event' && entry.type === 'prompt' && entry.tool === tool;
}

function isNativeCopilotPrompt(entry: JournalEntry): boolean {
  return (
    isPrompt(entry, 'github-copilot') &&
    typeof entry.sourceId === 'string' &&
    entry.sourceId.startsWith('copilot:user:')
  );
}

function conversationObject(
  entry: JournalEntry,
  paths: ReturnType<typeof pathsForRoot>,
): Record<string, unknown> | null {
  if (entry.kind !== 'conversation') return null;
  const ref = firstRef(entry);
  if (!ref) fail(`conversation entry ${entry.id} has no stored payload`);
  const raw = readObject(paths, ref);
  if (raw === null) fail(`conversation entry ${entry.id} points at a missing object`);
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    fail(`conversation entry ${entry.id} does not contain JSON`);
  }
}

function obsoleteLoggingCall(
  entry: JournalEntry,
  paths: ReturnType<typeof pathsForRoot>,
): ToolCall | null {
  const payload = conversationObject(entry, paths);
  if (!payload || payload.type !== 'tool_use' || payload.toolName !== 'run_in_terminal') {
    return null;
  }
  const input = payload.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const command = (input as Record<string, unknown>).command;
  if (
    typeof command !== 'string' ||
    !/^showtail log --type prompt --text "[\s\S]+" --tool github-copilot\s*$/.test(
      command,
    )
  ) {
    return null;
  }
  const toolUseId = payload.toolUseId;
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
    fail(`obsolete logging call ${entry.id} has no toolUseId`);
  }
  const match = command.match(
    /^showtail log --type prompt --text "([\s\S]+)" --tool github-copilot\s*$/,
  );
  return { entry, toolUseId, commandText: match?.[1] ?? '' };
}

function oneMatch<T>(items: T[], label: string): T {
  if (items.length !== 1) fail(`${label}: expected one match, found ${items.length}`);
  return items[0]!;
}

/** Recompute and validate the exact 101-entry cleanup set without changing disk. */
export function planCopilotVscodeDuplicateRepair(
  root: string,
): CopilotDuplicateRepairPlan {
  const paths = pathsForRoot(root);
  if (!existsSync(paths.config)) fail(`${root} is not a Showtail project`);
  const slugs = authorSlugs(paths);
  if (slugs.length !== 1) fail(`expected one author, found ${slugs.length}`);
  const readOnlyAuthor = authorPaths(paths, slugs[0]!);
  const shards = readJournalShards(readOnlyAuthor);
  if (shards.length !== 1) fail(`expected one journal shard, found ${shards.length}`);
  const author = authorPaths(paths, slugs[0]!, shards[0]!.machineId);
  const entries = readJournal(author);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const nativePrompts = entries.filter(isNativeCopilotPrompt);
  const falseCliPrompts = entries.filter((entry) => isPrompt(entry, 'copilot-cli'));
  if (falseCliPrompts.length !== EXPECTED.falseCliPrompts) {
    fail(
      `expected ${EXPECTED.falseCliPrompts} Copilot CLI prompts, found ${falseCliPrompts.length}`,
    );
  }

  const matchedNativeIds = new Set<string>();
  for (const duplicate of falseCliPrompts) {
    const ref = firstRef(duplicate);
    if (!ref || !duplicate.conv)
      fail(`CLI prompt ${duplicate.id} lacks content/session data`);
    const native = oneMatch(
      nativePrompts.filter(
        (candidate) =>
          candidate.conv === duplicate.conv &&
          firstRef(candidate) === ref &&
          at(duplicate) - at(candidate) >= 300 &&
          at(duplicate) - at(candidate) <= 2_500,
      ),
      `CLI prompt ${duplicate.id}`,
    );
    if (matchedNativeIds.has(native.id)) {
      fail(`native prompt ${native.id} matched more than one CLI duplicate`);
    }
    matchedNativeIds.add(native.id);
  }
  if (matchedNativeIds.size !== EXPECTED.falseCliPrompts) {
    fail(`expected ${EXPECTED.falseCliPrompts} one-to-one native prompt matches`);
  }

  const calls = entries
    .map((entry) => obsoleteLoggingCall(entry, paths))
    .filter((call): call is ToolCall => call !== null);
  if (calls.length !== EXPECTED.obsoleteToolCalls) {
    fail(
      `expected ${EXPECTED.obsoleteToolCalls} obsolete logging calls, found ${calls.length}`,
    );
  }
  const callsByToolUseId = new Map(calls.map((call) => [call.toolUseId, call]));
  if (callsByToolUseId.size !== calls.length)
    fail('obsolete logging toolUseIds are not unique');

  for (const call of calls) {
    const turn = call.entry.turn ? byId.get(call.entry.turn) : undefined;
    if (!turn || !isNativeCopilotPrompt(turn) || turn.conv !== call.entry.conv) {
      fail(`obsolete logging call ${call.entry.id} is not tied to its native prompt`);
    }
  }

  const resultsByToolUseId = new Map<
    string,
    Array<{ entry: JournalEntry; text: string }>
  >();
  for (const entry of entries) {
    const payload = conversationObject(entry, paths);
    if (!payload || payload.type !== 'tool_result') continue;
    const toolUseId = payload.toolUseId;
    if (typeof toolUseId !== 'string' || !callsByToolUseId.has(toolUseId)) continue;
    const list = resultsByToolUseId.get(toolUseId) ?? [];
    list.push({ entry, text: JSON.stringify(payload.content ?? '') });
    resultsByToolUseId.set(toolUseId, list);
  }
  if (resultsByToolUseId.size !== calls.length)
    fail('an obsolete logging call has no result');

  const manualPrompts = entries.filter(
    (entry) => isPrompt(entry, 'github-copilot') && !entry.sourceId,
  );
  if (
    manualPrompts.length !==
    EXPECTED.linkedManualPrompts + EXPECTED.nearbyManualPrompts
  ) {
    fail(`expected 12 manual Copilot prompts, found ${manualPrompts.length}`);
  }
  const manualById = new Map(manualPrompts.map((entry) => [entry.id, entry]));
  const linkedManualIds = new Set<string>();

  for (const call of calls) {
    const result = oneMatch(
      resultsByToolUseId.get(call.toolUseId) ?? [],
      `tool result for ${call.entry.id}`,
    );
    if (
      result.entry.conv !== call.entry.conv ||
      Math.abs(at(result.entry) - at(call.entry)) > 100
    ) {
      fail(`tool result ${result.entry.id} does not belong to call ${call.entry.id}`);
    }
    const logged = result.text.match(
      /Logged prompt \((evt_[^)]+)\) to session (ses_[A-Za-z0-9_-]+)/,
    );
    if (!logged) continue;
    const prompt = manualById.get(logged[1]!);
    if (!prompt) fail(`successful result names unknown prompt ${logged[1]}`);
    if (prompt.conv !== logged[2] || prompt.conv !== call.entry.conv) {
      fail(`manual prompt ${prompt.id} has the wrong session`);
    }
    const delta = at(prompt) - at(call.entry);
    if (delta < 0 || delta > 30_000)
      fail(`manual prompt ${prompt.id} has implausible timing`);
    const stored = firstRef(prompt) ? readObject(paths, firstRef(prompt)!) : null;
    if (stored !== call.commandText) {
      fail(`manual prompt ${prompt.id} does not match the successful logging command`);
    }
    linkedManualIds.add(prompt.id);
  }
  if (linkedManualIds.size !== EXPECTED.linkedManualPrompts) {
    fail(
      `expected ${EXPECTED.linkedManualPrompts} result-linked prompts, found ${linkedManualIds.size}`,
    );
  }

  const nearbyManual = manualPrompts.filter((entry) => !linkedManualIds.has(entry.id));
  if (nearbyManual.length !== EXPECTED.nearbyManualPrompts) {
    fail(`expected one additional nearby manual duplicate, found ${nearbyManual.length}`);
  }
  for (const manual of nearbyManual) {
    const ref = firstRef(manual);
    if (!ref || !manual.conv)
      fail(`manual prompt ${manual.id} lacks content/session data`);
    oneMatch(
      nativePrompts.filter((native) => {
        const delta = at(manual) - at(native);
        return (
          native.conv === manual.conv &&
          firstRef(native) === ref &&
          delta >= 9_000 &&
          delta <= 10_000
        );
      }),
      `nearby manual prompt ${manual.id}`,
    );
  }

  const removeIds = new Set([
    ...falseCliPrompts.map((entry) => entry.id),
    ...manualPrompts.map((entry) => entry.id),
    ...calls.map((call) => call.entry.id),
  ]);
  if (removeIds.size !== EXPECTED.total) {
    fail(`expected ${EXPECTED.total} unique removals, found ${removeIds.size}`);
  }

  const removedPromptIds = new Set([
    ...falseCliPrompts.map((entry) => entry.id),
    ...manualPrompts.map((entry) => entry.id),
  ]);
  const dangling = entries.filter(
    (entry) => !removeIds.has(entry.id) && entry.turn && removedPromptIds.has(entry.turn),
  );
  if (dangling.length > 0) {
    fail(
      `retained entries reference removed prompts: ${dangling.map((e) => e.id).join(', ')}`,
    );
  }

  return { root, author, removeIds, counts: EXPECTED };
}

function backupJournal(plan: CopilotDuplicateRepairPlan): {
  backupDir: string;
  snapshots: Map<string, string>;
} {
  const paths = pathsForRoot(plan.root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(paths.base, 'backups', `${REPAIR_LABEL}-${stamp}`);
  const snapshots = new Map<string, string>();
  for (const segment of journalSegmentPaths(plan.author)) {
    const content = readFileSync(segment, 'utf8');
    snapshots.set(segment, content);
    const destination = join(
      backupDir,
      relative(plan.author.journalDir, dirname(segment)),
      basename(segment),
    );
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(segment, destination);
  }
  return { backupDir, snapshots };
}

/** Apply the already-guarded cleanup, leaving objects in place and declaring the rewrite. */
export function applyCopilotVscodeDuplicateRepair(
  root: string,
): CopilotDuplicateRepairResult {
  const plan = planCopilotVscodeDuplicateRepair(root);
  const { backupDir, snapshots } = backupJournal(plan);
  for (const [segment, before] of snapshots) {
    if (readFileSync(segment, 'utf8') !== before) {
      fail(`journal changed while it was being backed up (${segment})`);
    }
  }

  const removed = rewriteJournal(plan.author, (entry) => !plan.removeIds.has(entry.id));
  if (removed !== EXPECTED.total) {
    fail(`rewrite removed ${removed} entries instead of ${EXPECTED.total}`);
  }
  const markerId = makeId('red');
  appendJournal(plan.author, {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'redaction',
    id: markerId,
    ts: new Date().toISOString(),
    type: 'redaction',
    actorSlug: plan.author.slug,
    redaction: {
      reason: 'repair',
      entries: EXPECTED.total,
      values: 0,
      labels: [REPAIR_LABEL],
    },
  });

  const remaining = readJournal(plan.author);
  const stillPresent = remaining.filter((entry) => plan.removeIds.has(entry.id));
  if (stillPresent.length > 0) fail('one or more guarded entries remain after rewrite');
  const dangling = remaining.filter(
    (entry) => entry.turn && plan.removeIds.has(entry.turn),
  );
  if (dangling.length > 0)
    fail('the repaired journal contains a dangling turn reference');

  return { removed, markerId, backupDir };
}
