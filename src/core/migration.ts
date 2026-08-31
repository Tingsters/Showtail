/** Plan and apply append-only recovery from local provider transcripts. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type {
  EnrichmentRecord,
  Event,
  EventEnrichmentOverlay,
  EventType,
  MigrationMatchMethod,
  Session,
  Tool,
} from '../types.ts';
import type {
  HookTranscript,
  HookTranscriptEvent,
  HookTranscriptMessage,
  MigrationTranscriptCandidate,
} from '../plugins/types.ts';
import {
  getPlugin,
  migrationPlugins,
  type MigrationPlugin,
} from '../plugins/registry.ts';
import {
  importEditArtifact,
  importEditStub,
  importedArtifactSourceIds,
  readArtifacts,
} from './artifacts.ts';
import {
  conversationEventEnabled,
  importedConversationSourceIds,
  logConversationEvent,
} from './conversationEvents.ts';
import { recordEnrichment, migratedTranscriptDigests } from './enrichments.ts';
import { importedSourceIds, logEvent, readSessionEvents } from './events.ts';
import { makeId } from './ids.ts';
import { readJournal } from './journal.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from './plans.ts';
import { materializePlan } from './plans.ts';
import { readConfig, readSessions, type AuthorPaths } from './storage.ts';
import { renderToolCallInput, renderToolCallText } from './toolCalls.ts';

const MATCH_DRIFT_MS = 10 * 60_000;
const EVENT_MATCH_DRIFT_MS = 2 * 60_000;
const EDIT_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'write_to_file',
  'replace_file_content',
  'replace_string_in_file',
  'insert_edit_into_file',
  'create_file',
  'write_file',
]);
const DECISION_TOOLS = new Set([
  'askuserquestion',
  'request_user_input',
  'vscode_askquestions',
]);
const PLAN_TOOLS = new Set([
  'enterplanmode',
  'exitplanmode',
  'update_plan',
  'manage_todo_list',
  'create_plan',
  'write_plan',
  'set_plan',
  'plan',
  'create_task_list',
  'update_task_list',
  'write_task_list',
  'task_list',
  'update_tasks',
]);
const NOISY_TOOLS = new Set(['todowrite', 'rename_session']);

export type MigrationStatus =
  | 'planned'
  | 'migrated'
  | 'unchanged'
  | 'ambiguous'
  | 'unmatched'
  | 'skipped'
  | 'error';

export interface MigrationMatchSummary {
  method: MigrationMatchMethod;
  confidence: 'exact' | 'high' | 'confirmed';
}

export interface MigrationCounts {
  prompts: number;
  responses: number;
  edits: number;
  decisions: number;
  plans: number;
  toolCalls: number;
  recaps: number;
  conversationEvents: number;
  overlays: number;
}

export interface MigrationSessionResult {
  showtailSessionId: string;
  tool?: Tool;
  providerSessionId?: string;
  sourceDigest?: string;
  match?: MigrationMatchSummary;
  status: MigrationStatus;
  recovered: MigrationCounts;
  skipped: Record<string, number>;
  warnings: string[];
}

export interface ProjectMigrationResult {
  root: string;
  author: string;
  batchId: string | null;
  dryRun: boolean;
  sessions: MigrationSessionResult[];
  totals: MigrationCounts;
  warnings: string[];
}

export interface AmbiguousMigrationCandidate {
  provider: Tool;
  providerSessionId: string;
  path: string;
  firstPrompt?: string;
  lastPrompt?: string;
  first?: string;
  last?: string;
}

export interface ProjectMigrationOptions {
  tool?: string;
  sessionId?: string;
  file?: string;
  dryRun?: boolean;
  /** Interactive resolver; absent means ambiguous candidates are skipped. */
  confirmMatch?: (
    session: Session,
    candidates: AmbiguousMigrationCandidate[],
  ) => Promise<number | null>;
}

interface ParsedCandidate {
  plugin: MigrationPlugin;
  info: MigrationTranscriptCandidate;
  transcript: HookTranscript;
  digest: string;
  prompts: HookTranscriptMessage[];
  first?: string;
  last?: string;
  planFiles: ReturnType<NonNullable<MigrationPlugin['migration']['planFiles']>>;
}

interface EventOperation {
  kind: 'event';
  message: HookTranscriptMessage;
  type: EventType;
  turnSourceId?: string;
}

interface ArtifactOperation {
  kind: 'artifact';
  edit: NonNullable<HookTranscriptMessage['edits']>[number];
  message: HookTranscriptMessage;
  sourceId: string;
  turnSourceId?: string;
}

interface ConversationOperation {
  kind: 'conversation';
  event: HookTranscriptEvent;
  sourceId: string;
  turnSourceId: string;
}

type MigrationOperation = EventOperation | ArtifactOperation | ConversationOperation;

interface SessionPlan {
  session: Session;
  candidate?: ParsedCandidate;
  match?: MigrationMatchSummary;
  status: MigrationStatus;
  operations: MigrationOperation[];
  overlays: EventEnrichmentOverlay[];
  promptIds: Map<string, string>;
  counts: MigrationCounts;
  skipped: Record<string, number>;
  warnings: string[];
}

function emptyCounts(): MigrationCounts {
  return {
    prompts: 0,
    responses: 0,
    edits: 0,
    decisions: 0,
    plans: 0,
    toolCalls: 0,
    recaps: 0,
    conversationEvents: 0,
    overlays: 0,
  };
}

function addCounts(target: MigrationCounts, source: MigrationCounts): void {
  for (const key of Object.keys(target) as Array<keyof MigrationCounts>) {
    target[key] += source[key];
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function samePath(a: string, b: string): boolean {
  const key = (value: string) => {
    const normalized = resolve(value)
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return key(a) === key(b);
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function closeInTime(a: string | undefined, b: string | undefined): boolean {
  const left = timestampMs(a);
  const right = timestampMs(b);
  return left !== undefined && right !== undefined
    ? Math.abs(left - right) <= EVENT_MATCH_DRIFT_MS
    : true;
}

function transcriptSpan(transcript: HookTranscript): { first?: string; last?: string } {
  let first: string | undefined;
  let last: string | undefined;
  for (const item of [...transcript.messages, ...(transcript.events ?? [])]) {
    const ts = item.timestamp;
    if (!ts) continue;
    if (!first || ts < first) first = ts;
    if (!last || ts > last) last = ts;
  }
  return { first, last };
}

function sessionOverlaps(session: Session, candidate: ParsedCandidate): boolean {
  const sessionStart = timestampMs(session.startedAt);
  const sessionEnd = timestampMs(session.endedAt) ?? sessionStart;
  const candidateStart = timestampMs(candidate.first);
  const candidateEnd = timestampMs(candidate.last) ?? candidateStart;
  if (
    sessionStart === undefined ||
    sessionEnd === undefined ||
    candidateStart === undefined ||
    candidateEnd === undefined
  ) {
    return false;
  }
  return (
    candidateStart <= sessionEnd + MATCH_DRIFT_MS &&
    candidateEnd >= sessionStart - MATCH_DRIFT_MS
  );
}

function isContiguousSubsequence(needles: string[], haystack: string[]): boolean {
  if (needles.length === 0 || needles.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needles.length; start += 1) {
    for (let i = 0; i < needles.length; i += 1) {
      if (needles[i] !== haystack[start + i]) continue outer;
    }
    return true;
  }
  return false;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function messageType(role: string): EventType | null {
  if (role === 'user') return 'prompt';
  if (role === 'assistant') return 'ai_output';
  if (role === 'decision') return 'decision';
  if (role === 'plan') return 'plan';
  if (role === 'tool_call') return 'tool_call';
  if (role === 'recap') return 'recap';
  return null;
}

function countEvent(counts: MigrationCounts, type: EventType): void {
  if (type === 'prompt') counts.prompts += 1;
  else if (type === 'ai_output') counts.responses += 1;
  else if (type === 'decision') counts.decisions += 1;
  else if (type === 'plan') counts.plans += 1;
  else if (type === 'tool_call') counts.toolCalls += 1;
  else if (type === 'recap') counts.recaps += 1;
}

function stringifyResult(event: HookTranscriptEvent | undefined): string | undefined {
  if (!event) return undefined;
  const parts: string[] = [];
  if (event.stdout) parts.push(event.stdout);
  if (event.stderr) parts.push(event.stderr);
  if (event.content !== undefined) {
    parts.push(
      typeof event.content === 'string'
        ? event.content
        : JSON.stringify(event.content, null, 2),
    );
  }
  if (event.exitCode !== undefined) parts.push(`exit code ${event.exitCode}`);
  return parts.filter(Boolean).join('\n').trim() || undefined;
}

/** Derive readable tool-call messages for providers that only expose raw events. */
function withDerivedToolCalls(transcript: HookTranscript): HookTranscriptMessage[] {
  if (transcript.messages.some((message) => message.role === 'tool_call')) {
    return transcript.messages;
  }
  const results = new Map<string, HookTranscriptEvent>();
  for (const event of transcript.events ?? []) {
    if (event.type === 'tool_result' && event.toolUseId) {
      results.set(event.toolUseId, event);
    }
  }
  const derived: HookTranscriptMessage[] = [];
  for (const event of transcript.events ?? []) {
    if (event.type !== 'tool_use' || !event.toolUseId) continue;
    const toolName = event.toolName ?? 'Tool';
    const key = toolName.toLowerCase();
    if (
      EDIT_TOOLS.has(key) ||
      DECISION_TOOLS.has(key) ||
      PLAN_TOOLS.has(key) ||
      NOISY_TOOLS.has(key)
    ) {
      continue;
    }
    const result = results.get(event.toolUseId);
    const text = renderToolCallText(renderToolCallInput(toolName, event.input), {
      content: stringifyResult(result),
      isError: result?.isError === true,
    });
    derived.push({
      role: 'tool_call',
      text,
      timestamp: event.timestamp,
      sourceId: `tool-call:${event.toolUseId}`,
      toolName,
      isError: result?.isError === true,
    });
  }
  return [...transcript.messages, ...derived].sort((a, b) =>
    (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
  );
}

function withinSessionWindow(message: { timestamp?: string }, session: Session): boolean {
  const at = timestampMs(message.timestamp);
  if (at === undefined) return true;
  const start = timestampMs(session.startedAt);
  const end = timestampMs(session.endedAt);
  if (start !== undefined && at < start - MATCH_DRIFT_MS) return false;
  if (end !== undefined && at > end + MATCH_DRIFT_MS) return false;
  return true;
}

async function parseCandidates(
  plugins: MigrationPlugin[],
  root: string,
  explicitFile?: string,
): Promise<{ candidates: ParsedCandidate[]; warnings: string[] }> {
  const candidates: ParsedCandidate[] = [];
  const warnings: string[] = [];
  for (const plugin of plugins) {
    let discovered: MigrationTranscriptCandidate[];
    try {
      discovered = explicitFile
        ? [
            {
              path: explicitFile,
              providerSessionId: basename(explicitFile).replace(/\.[^.]+$/, ''),
              mtimeMs: statSync(explicitFile).mtimeMs,
            },
          ]
        : plugin.migration.discover();
    } catch (error) {
      warnings.push(`${plugin.label}: ${String((error as Error).message ?? error)}`);
      continue;
    }
    for (const info of discovered) {
      try {
        const raw = readFileSync(info.path);
        const transcript = plugin.migration.read(info, root);
        const span = transcriptSpan(transcript);
        candidates.push({
          plugin,
          info: {
            ...info,
            providerSessionId: transcript.sessionId ?? info.providerSessionId,
          },
          transcript,
          digest: createHash('sha256').update(raw).digest('hex'),
          prompts: transcript.messages.filter((message) => message.role === 'user'),
          ...span,
          planFiles: plugin.migration.planFiles?.(info) ?? [],
        });
      } catch (error) {
        warnings.push(
          `${plugin.label} ${info.providerSessionId}: ${String((error as Error).message ?? error)}`,
        );
      }
    }
  }
  return { candidates, warnings };
}

function candidateSummary(candidate: ParsedCandidate): AmbiguousMigrationCandidate {
  return {
    provider: candidate.plugin.id,
    providerSessionId: candidate.info.providerSessionId,
    path: candidate.info.path,
    firstPrompt: candidate.prompts[0]?.text,
    lastPrompt: candidate.prompts.at(-1)?.text,
    first: candidate.first,
    last: candidate.last,
  };
}

async function chooseCandidate(
  author: AuthorPaths,
  session: Session,
  candidates: ParsedCandidate[],
  confirmMatch: ProjectMigrationOptions['confirmMatch'],
): Promise<{
  candidate?: ParsedCandidate;
  match?: MigrationMatchSummary;
  status: MigrationStatus;
}> {
  const compatible = candidates.filter(
    (candidate) => !session.tool || candidate.plugin.id === session.tool,
  );
  const exact = session.nativeSessionId
    ? compatible.filter(
        (candidate) => candidate.info.providerSessionId === session.nativeSessionId,
      )
    : [];
  if (exact.length === 1) {
    return {
      candidate: exact[0],
      match: { method: 'native-session-id', confidence: 'exact' },
      status: 'planned',
    };
  }

  const sessionPrompts = readSessionEvents(author, session.id)
    .filter((event) => event.type === 'prompt')
    .map((event) => normalizeText(event.text));
  if (sessionPrompts.length === 0) return { status: 'unmatched' };

  const promptMatches = compatible.filter((candidate) => {
    const transcriptPrompts = candidate.prompts.map((message) =>
      normalizeText(message.text),
    );
    return isContiguousSubsequence(sessionPrompts, transcriptPrompts);
  });
  const high = promptMatches.filter(
    (candidate) =>
      sessionPrompts.length >= 2 &&
      sessionOverlaps(session, candidate) &&
      (!candidate.info.cwd || samePath(candidate.info.cwd, author.shared.root)),
  );
  if (high.length === 1) {
    return {
      candidate: high[0],
      match: { method: 'prompt-sequence', confidence: 'high' },
      status: 'planned',
    };
  }

  const partial = compatible.filter((candidate) => {
    const transcriptPrompts = new Set(
      candidate.prompts.map((message) => normalizeText(message.text)),
    );
    return sessionPrompts.some((prompt) => transcriptPrompts.has(prompt));
  });
  const ambiguous = [...new Set([...exact, ...promptMatches, ...partial])];
  if (ambiguous.length === 0) return { status: 'unmatched' };
  if (!confirmMatch) return { status: 'ambiguous' };
  const chosen = await confirmMatch(session, ambiguous.map(candidateSummary));
  if (chosen === null || !ambiguous[chosen]) return { status: 'ambiguous' };
  return {
    candidate: ambiguous[chosen],
    match: { method: 'user-confirmed', confidence: 'confirmed' },
    status: 'planned',
  };
}

function findLegacyEvent(
  events: Event[],
  used: Set<string>,
  type: EventType,
  message: HookTranscriptMessage,
): Event | undefined {
  return events.find(
    (event) =>
      !used.has(event.id) &&
      event.type === type &&
      normalizeText(event.text) === normalizeText(message.text) &&
      closeInTime(event.timestamp, message.timestamp),
  );
}

function buildSessionPlan(
  author: AuthorPaths,
  session: Session,
  candidate: ParsedCandidate,
  match: MigrationMatchSummary,
): SessionPlan {
  const counts = emptyCounts();
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];
  const operations: MigrationOperation[] = [];
  const overlays: EventEnrichmentOverlay[] = [];
  const promptIds = new Map<string, string>();
  const existing = readSessionEvents(author, session.id);
  const existingSourceIds = importedSourceIds(author);
  const artifactSourceIds = importedArtifactSourceIds(author);
  const conversationSourceIds = importedConversationSourceIds(author);
  const existingArtifacts = readArtifacts(author).filter(
    (artifact) => artifact.sessionId === session.id,
  );
  const usedEvents = new Set<string>();
  const config = readConfig(author.shared);

  if (migratedTranscriptDigests(author, session.id).has(candidate.digest)) {
    return {
      session,
      candidate,
      match,
      status: 'unchanged',
      operations,
      overlays,
      promptIds,
      counts,
      skipped,
      warnings,
    };
  }

  let currentTurnSource: string | undefined;
  const messages = withDerivedToolCalls(candidate.transcript).filter((message) =>
    withinSessionWindow(message, session),
  );
  for (const message of messages) {
    const type = messageType(message.role);
    if (message.role === 'user') {
      const sourceMatch = existing.find(
        (event) => event.type === 'prompt' && event.sourceId === message.sourceId,
      );
      const textMatch = existing.find(
        (event) =>
          !usedEvents.has(event.id) &&
          event.type === 'prompt' &&
          normalizeText(event.text) === normalizeText(message.text) &&
          closeInTime(event.timestamp, message.timestamp),
      );
      const matched = sourceMatch ?? textMatch;
      currentTurnSource = message.sourceId;
      if (matched) {
        usedEvents.add(matched.id);
        promptIds.set(message.sourceId, matched.id);
        const overlay: EventEnrichmentOverlay = { targetEventId: matched.id };
        if (!matched.sourceId) overlay.sourceId = message.sourceId;
        if (message.model && !matched.model) overlay.model = message.model;
        if (Object.keys(overlay).length > 1) overlays.push(overlay);
        continue;
      }
      operations.push({ kind: 'event', message, type: 'prompt' });
      counts.prompts += 1;
      continue;
    }
    if (message.role === 'edit') {
      const edits = message.edits ?? message.files?.map((file) => ({ file })) ?? [];
      for (const edit of edits) {
        const sourceId = `${message.sourceId}#${edit.file}`;
        if (artifactSourceIds.has(sourceId)) {
          increment(skipped, 'already-present');
          continue;
        }
        const legacy = existingArtifacts.find(
          (artifact) =>
            artifact.path === edit.file &&
            closeInTime(artifact.timestamp, message.timestamp),
        );
        if (legacy) {
          increment(skipped, 'legacy-edit-match');
          continue;
        }
        operations.push({
          kind: 'artifact',
          edit,
          message,
          sourceId,
          turnSourceId: currentTurnSource,
        });
        counts.edits += 1;
      }
      continue;
    }
    if (!type || !currentTurnSource) continue;
    if (type === 'ai_output' && config.settings.captureAiOutput === false) {
      increment(skipped, 'responses-disabled');
      continue;
    }
    if (type === 'tool_call' && config.settings.captureToolCalls === false) {
      increment(skipped, 'tool-calls-disabled');
      continue;
    }
    const bySource = existing.find((event) => event.sourceId === message.sourceId);
    const matched = bySource ?? findLegacyEvent(existing, usedEvents, type, message);
    if (matched) {
      usedEvents.add(matched.id);
      const overlay: EventEnrichmentOverlay = { targetEventId: matched.id };
      if (!matched.sourceId) overlay.sourceId = message.sourceId;
      if (message.model && !matched.model) overlay.model = message.model;
      if (!matched.turnId) {
        const turnId = promptIds.get(currentTurnSource);
        if (turnId) overlay.turnId = turnId;
      }
      if (Object.keys(overlay).length > 1) overlays.push(overlay);
      continue;
    }
    if (existingSourceIds.has(message.sourceId)) {
      increment(skipped, 'already-present');
      continue;
    }
    operations.push({
      kind: 'event',
      message,
      type,
      turnSourceId: currentTurnSource,
    });
    countEvent(counts, type);
  }

  const toolNames = new Map(
    (candidate.transcript.events ?? []).flatMap((event) =>
      event.type === 'tool_use' && event.toolUseId && event.toolName
        ? [[event.toolUseId, event.toolName] as const]
        : [],
    ),
  );
  let conversationTurnSource: string | undefined;
  for (const event of candidate.transcript.events ?? []) {
    if (!withinSessionWindow(event, session)) continue;
    if (event.type === 'user_text') conversationTurnSource = event.sourceId;
    if (!conversationTurnSource) continue;
    if (
      !conversationEventEnabled(event, toolNames, config.settings, {
        includeResponses: config.settings.captureAiOutput !== false,
      })
    ) {
      increment(skipped, 'capture-setting');
      continue;
    }
    const sourceId = `conversation:${event.sourceId}`;
    if (conversationSourceIds.has(sourceId)) {
      increment(skipped, 'already-present');
      continue;
    }
    operations.push({
      kind: 'conversation',
      event,
      sourceId,
      turnSourceId: conversationTurnSource,
    });
    counts.conversationEvents += 1;
  }

  counts.overlays = overlays.length;
  return {
    session,
    candidate,
    match,
    status: operations.length > 0 || overlays.length > 0 ? 'planned' : 'unchanged',
    operations,
    overlays,
    promptIds,
    counts,
    skipped,
    warnings,
  };
}

async function applySessionPlan(
  author: AuthorPaths,
  plan: SessionPlan,
  batchId: string,
): Promise<void> {
  if (!plan.candidate || !plan.match || plan.status !== 'planned') return;
  const redactedBefore = readJournal(author)
    .filter((entry) => entry.batch === batchId)
    .reduce((total, entry) => total + (entry.redacted ?? 0), 0);
  const promptIds = new Map(plan.promptIds);
  for (const operation of plan.operations) {
    if (operation.kind === 'event') {
      const message = operation.message;
      const tags = ['migrated'];
      if (message.role === 'plan' && message.approved === true) {
        tags.push(PLAN_APPROVED_TAG);
      } else if (message.role === 'plan' && message.approved === false) {
        tags.push(PLAN_REVISED_TAG);
      }
      const turnId = operation.turnSourceId
        ? promptIds.get(operation.turnSourceId)
        : undefined;
      const { event } = await logEvent(author, {
        type: operation.type,
        text: message.text,
        tool: plan.candidate.plugin.id,
        model: message.model,
        timestamp: message.timestamp,
        sourceId: message.sourceId,
        batchId,
        sessionId: plan.session.id,
        turnId,
        tags,
        toolName: message.toolName,
        isError: message.isError,
        durationMs: message.durationMs,
        gitBranch: message.gitBranch,
        inputTokens: message.inputTokens,
        outputTokens: message.outputTokens,
        cacheReadTokens: message.cacheReadTokens,
        cacheCreationTokens: message.cacheCreationTokens,
        planPath:
          operation.type === 'plan' && plan.candidate.planFiles.length > 0
            ? materializePlan(author.shared, {
                text: plan.candidate.planFiles.at(-1)!.content,
                sourceId: plan.candidate.planFiles.at(-1)!.sourceId,
              }).planPath
            : undefined,
      });
      if (operation.type === 'prompt') promptIds.set(message.sourceId, event.id);
    } else if (operation.kind === 'artifact') {
      const turnId = operation.turnSourceId
        ? promptIds.get(operation.turnSourceId)
        : undefined;
      const input = {
        path: operation.edit.file,
        tool: plan.candidate.plugin.id,
        turnId,
        timestamp: operation.message.timestamp,
        sessionId: plan.session.id,
        sourceId: operation.sourceId,
        batchId,
      };
      if (operation.edit.diff) {
        if (!importEditArtifact(author, { ...input, diff: operation.edit.diff })) {
          importEditStub(author, input);
        }
      } else {
        importEditStub(author, input);
      }
    } else {
      const turnId = promptIds.get(operation.turnSourceId);
      if (!turnId) continue;
      logConversationEvent(author, {
        event: { ...operation.event, sourceId: operation.sourceId },
        tool: plan.candidate.plugin.id,
        turnId,
        sessionId: plan.session.id,
        batchId,
      });
    }
  }

  const redactedAfter = readJournal(author)
    .filter((entry) => entry.batch === batchId)
    .reduce((total, entry) => total + (entry.redacted ?? 0), 0);
  const redacted = redactedAfter - redactedBefore;
  const added: Record<string, number> = {};
  for (const [key, value] of Object.entries(plan.counts)) {
    if (key !== 'overlays' && value > 0) added[key] = value;
  }
  const enrichment: EnrichmentRecord = {
    version: 1,
    batchId,
    migratedAt: new Date().toISOString(),
    provider: plan.candidate.plugin.id,
    providerSessionId: plan.candidate.info.providerSessionId,
    transcriptSha256: plan.candidate.digest,
    showtailSessionId: plan.session.id,
    matchMethod: plan.match.method,
    matchConfidence: plan.match.confidence,
    added,
    overlaid: plan.overlays.length,
    skipped: plan.skipped,
    redacted,
    ...(plan.overlays.length > 0 ? { overlays: plan.overlays } : {}),
  };
  recordEnrichment(author, enrichment);
  plan.status = 'migrated';
}

function operationSourceId(operation: MigrationOperation): string {
  if (operation.kind === 'event') return `event:${operation.message.sourceId}`;
  if (operation.kind === 'artifact') return `artifact:${operation.sourceId}`;
  return `conversation:${operation.sourceId}`;
}

function recountPlan(plan: SessionPlan): void {
  plan.counts = emptyCounts();
  for (const operation of plan.operations) {
    if (operation.kind === 'event') countEvent(plan.counts, operation.type);
    else if (operation.kind === 'artifact') plan.counts.edits += 1;
    else plan.counts.conversationEvents += 1;
  }
  plan.counts.overlays = plan.overlays.length;
  if (plan.operations.length === 0 && plan.overlays.length === 0) {
    plan.status = 'unchanged';
  }
}

/** Prevent one provider record being planned into two overlapping legacy sessions. */
function dedupeAcrossPlans(plans: SessionPlan[]): void {
  const sources = new Set<string>();
  const overlaySources = new Set<string>();
  for (const plan of plans) {
    plan.operations = plan.operations.filter((operation) => {
      const sourceId = `${plan.candidate?.plugin.id ?? 'unknown'}:${operationSourceId(operation)}`;
      if (sources.has(sourceId)) {
        increment(plan.skipped, 'claimed-by-another-session');
        return false;
      }
      sources.add(sourceId);
      return true;
    });
    plan.overlays = plan.overlays.filter((overlay) => {
      if (!overlay.sourceId) return true;
      const sourceId = `${plan.candidate?.plugin.id ?? 'unknown'}:${overlay.sourceId}`;
      if (overlaySources.has(sourceId)) {
        increment(plan.skipped, 'claimed-by-another-session');
        return false;
      }
      overlaySources.add(sourceId);
      return true;
    });
    recountPlan(plan);
  }
}

function resultForPlan(plan: SessionPlan): MigrationSessionResult {
  return {
    showtailSessionId: plan.session.id,
    tool: plan.session.tool,
    providerSessionId: plan.candidate?.info.providerSessionId,
    sourceDigest: plan.candidate?.digest,
    match: plan.match,
    status: plan.status,
    recovered: plan.counts,
    skipped: plan.skipped,
    warnings: plan.warnings,
  };
}

/** Discover, match, plan, and optionally apply migration for one project/author. */
export async function migrateProject(
  author: AuthorPaths,
  options: ProjectMigrationOptions = {},
): Promise<ProjectMigrationResult> {
  let plugins = migrationPlugins();
  if (options.tool) {
    const plugin = getPlugin(options.tool);
    if (!plugin?.migration) {
      throw new Error(`Tool "${options.tool}" has no local transcript migration.`);
    }
    plugins = [plugin as MigrationPlugin];
  }
  if (options.file && plugins.length !== 1) {
    throw new Error('--file requires a specific migration tool.');
  }

  const parsed = await parseCandidates(plugins, author.shared.root, options.file);
  const sessions = readSessions(author).filter(
    (session) => !options.sessionId || session.id === options.sessionId,
  );
  if (options.sessionId && sessions.length === 0) {
    throw new Error(`Session "${options.sessionId}" was not found for ${author.slug}.`);
  }

  const plans: SessionPlan[] = [];
  for (const session of sessions) {
    const chosen =
      options.file && options.sessionId && parsed.candidates.length === 1
        ? {
            candidate: parsed.candidates[0],
            match: {
              method: 'explicit-file' as const,
              confidence: 'confirmed' as const,
            },
            status: 'planned' as const,
          }
        : await chooseCandidate(author, session, parsed.candidates, options.confirmMatch);
    if (!chosen.candidate || !chosen.match) {
      plans.push({
        session,
        status: chosen.status,
        operations: [],
        overlays: [],
        promptIds: new Map(),
        counts: emptyCounts(),
        skipped: {},
        warnings: [],
      });
      continue;
    }
    plans.push(buildSessionPlan(author, session, chosen.candidate, chosen.match));
  }
  dedupeAcrossPlans(plans);

  const batchId =
    !options.dryRun && plans.some((plan) => plan.status === 'planned')
      ? makeId('mig')
      : null;
  if (!options.dryRun && batchId) {
    for (const plan of plans) await applySessionPlan(author, plan, batchId);
  }

  const totals = emptyCounts();
  for (const plan of plans) addCounts(totals, plan.counts);
  const results = plans.map(resultForPlan);
  return {
    root: author.shared.root,
    author: author.slug,
    batchId,
    dryRun: options.dryRun === true,
    sessions: results,
    totals,
    warnings: parsed.warnings,
  };
}
