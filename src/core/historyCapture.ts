import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { dataHome, dataPath, ensureDataHome } from './dataHome.ts';
import {
  HistoryStore,
  canonical,
  containsPath,
  digest,
  historySettings,
  type HistorySession,
  type RecordInput,
  type SessionInput,
} from './history.ts';
import { getPlugin, getPluginById } from '../plugins/registry.ts';
import type {
  HookTranscript,
  HookTranscriptMessage,
  NormalizedHookEvent,
} from '../plugins/types.ts';
import { extractPrompt, extractSessionId, type HookPayload } from './hookInput.ts';
import {
  readGlobalConfig,
  toolCaptureEnabledAt,
  toolCaptureGloballyDisabled,
} from './globalConfig.ts';
import { isSyntheticPrompt } from './syntheticPrompt.ts';
import { asyncReplyDecision } from './decisions.ts';
import { redact } from './redact.ts';
import { withholdSensitiveParts, ALWAYS_CAPTURE_TOOLS } from './conversationPrivacy.ts';
import { isSensitivePath } from './sensitivePaths.ts';
import { changedFiles, maybeCurrentCommit } from './git.ts';

export type CaptureEvent =
  | 'session-start'
  | 'user-prompt'
  | 'post-edit'
  | 'stop'
  | 'session-end';
export interface CaptureBatch {
  version: 1;
  id: string;
  session: SessionInput;
  records: RecordInput[];
  transcript?: HookTranscript;
  end?: boolean;
  automatic?: { cliName: string; enabledAt?: string; globalEpoch?: string };
}

export function automaticCaptureEnabled(tool: string): boolean {
  return (
    readGlobalConfig().captureEnabled === true &&
    !toolCaptureGloballyDisabled(getPlugin(tool)?.cliName ?? tool)
  );
}
function consentMatches(batch: CaptureBatch): boolean {
  const config = readGlobalConfig();
  return (
    !batch.automatic ||
    (automaticCaptureEnabled(batch.automatic.cliName) &&
      toolCaptureEnabledAt(batch.automatic.cliName) === batch.automatic.enabledAt &&
      (config.captureResumedAt ?? config.captureSince) === batch.automatic.globalEpoch)
  );
}

/** Diagnostics contain categories and counts, never raw host payloads or error messages. */
export function captureIssue(code: string, tool: string): void {
  try {
    ensureDataHome();
    const dir = dataPath('logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'capture.jsonl');
    if (existsSync(path) && statSync(path).size > 1_048_576)
      renameSync(path, join(dir, 'capture.previous.jsonl'));
    appendFileSync(
      path,
      JSON.stringify({ timestamp: new Date().toISOString(), code, tool }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* An observer must never break the host. */
  }
}

export function internalCapturePath(path: string, tool: string): boolean {
  if (containsPath(dataHome(), path)) return true;
  const adapter = getPluginById(tool)?.connect?.hooks;
  if (adapter?.includePaths?.some((re) => re.test(path))) return false;
  return (
    /(^|[\\/])(?:\.git|\.showtail)(?:[\\/]|$)/.test(path) ||
    isSensitivePath(path) ||
    !!adapter?.internalPaths.some((re) => re.test(path))
  );
}

/** Withhold output and redact BEFORE a batch can enter the durable pending queue. */
function safeBatch(batch: CaptureBatch): CaptureBatch {
  const settings = historySettings();
  const scrub = (value: string): string => redact(value, settings.redact).text;
  const visit = (value: any): any =>
    typeof value === 'string'
      ? scrub(value)
      : Array.isArray(value)
        ? value.map(visit)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]))
          : value;
  const cleanRecord = (r: RecordInput): RecordInput => ({
    ...r,
    ...(r.text !== undefined ? { text: scrub(r.text) } : {}),
    ...(r.diff !== undefined
      ? { diff: settings.captureCode === false ? undefined : scrub(r.diff) }
      : {}),
    ...(r.conversationEvent
      ? {
          conversationEvent: visit(withholdSensitiveParts(r.conversationEvent, settings)),
        }
      : {}),
  });
  const allowedRecord = (r: RecordInput) =>
    !(r.kind === 'ai_output' && settings.captureAiOutput === false) &&
    !(r.kind === 'tool_call' && settings.captureToolCalls === false) &&
    !(r.file && internalCapturePath(r.file, batch.session.tool));
  return {
    ...batch,
    records: batch.records.filter(allowedRecord).map(cleanRecord),
    transcript: batch.transcript
      ? {
          ...batch.transcript,
          warnings: undefined,
          messages: batch.transcript.messages
            .filter(
              (m) =>
                !(m.role === 'assistant' && settings.captureAiOutput === false) &&
                !(m.role === 'tool_call' && settings.captureToolCalls === false),
            )
            .map((m) => ({
              ...m,
              text: scrub(m.text),
              edits: m.edits
                ?.filter((e) => !internalCapturePath(e.file, batch.session.tool))
                .map((e) => ({
                  ...e,
                  diff:
                    settings.captureCode === false
                      ? undefined
                      : e.diff
                        ? scrub(e.diff)
                        : undefined,
                })),
            })),
          events: batch.transcript.events
            ?.filter(
              (e) =>
                (e.toolName && ALWAYS_CAPTURE_TOOLS.has(e.toolName.toLowerCase())) ||
                !(
                  (e.type === 'assistant_text' && settings.captureAiOutput === false) ||
                  ((e.type === 'tool_use' || e.type === 'tool_result') &&
                    settings.captureToolCalls === false)
                ),
            )
            .map((e) => visit(withholdSensitiveParts(e, settings))),
        }
      : undefined,
  };
}

function enqueue(batch: CaptureBatch): void {
  ensureDataHome();
  const dir = dataPath('pending');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${batch.id}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(safeBatch(batch)), { mode: 0o600 });
  renameSync(temp, file);
}

function inWindow(timestamp: string | undefined, since: string | undefined): boolean {
  return (
    !since ||
    (!!timestamp &&
      Number.isFinite(Date.parse(timestamp)) &&
      Date.parse(timestamp) >= Date.parse(since))
  );
}
const roleKind = (role: string): RecordInput['kind'] | undefined =>
  (
    ({
      user: 'prompt',
      assistant: 'ai_output',
      decision: 'decision',
      plan: 'plan',
      tool_call: 'tool_call',
      recap: 'recap',
      edit: 'edit',
    }) as const
  )[role as 'user'];

/** Reconcile under one write transaction so live hooks cannot race prompt matching. */
export function captureTranscript(
  store: HistoryStore,
  session: HistorySession,
  transcript: HookTranscript,
  options: { since?: string; continueCapture?: () => boolean } = {},
): number {
  return store
    .transaction(() => {
      let inserted = 0;
      const initialTurn = store.session(session.id)?.currentTurnId;
      const livePrompts = store
        .records({ kind: 'all' }, { sessionId: session.id })
        .filter((r) => r.kind === 'prompt' && r.sourceId?.startsWith('hook:'));
      const claimed = new Set<string>();
      const promptAliases = new Map<string, string>();
      let currentTurn = transcript.anchorToCurrentTurn ? initialTurn : undefined;
      const append = (input: RecordInput) => {
        if (options.continueCapture?.() === false) return undefined;
        const result = store.append(session.id, input, options);
        if (result.inserted) inserted++;
        return result.record;
      };
      for (const message of transcript.messages) {
        const kind = roleKind(message.role);
        if (!kind) continue;
        if (message.role === 'user') {
          const promptTimestamp = message.submittedAt ?? message.timestamp;
          if (
            message.origin === 'agent' ||
            message.origin === 'harness' ||
            (message.origin !== 'human' && isSyntheticPrompt(message.text))
          ) {
            if (inWindow(promptTimestamp, options.since))
              append({
                kind: 'tool_call',
                origin: message.origin ?? 'harness',
                toolName: 'Provider message',
                text: message.text,
                sourceId: message.sourceId,
                ts: promptTimestamp,
                turnId: currentTurn,
              });
            continue;
          }
          const reply = asyncReplyDecision(message.text);
          if (reply) {
            if (inWindow(promptTimestamp, options.since))
              append({
                kind: 'decision',
                text: reply.text,
                sourceId: reply.sourceId,
                ts: promptTimestamp,
                turnId: currentTurn,
              });
            continue;
          }
          let prompt = store.bySource(session.id, message.sourceId);
          if (!prompt && message.requestId)
            prompt = store.bySource(session.id, `prompt:${message.requestId}`);
          if (!prompt && inWindow(promptTimestamp, options.since)) {
            const text = redact(message.text, historySettings().redact).text;
            // Only unpaired LIVE prompts participate. Separate equal transcript prompts stay separate.
            prompt = livePrompts.find(
              (r) =>
                !claimed.has(r.id) &&
                r.text === text &&
                !!message.timestamp &&
                Math.abs(Date.parse(r.ts) - Date.parse(promptTimestamp!)) <= 5000 &&
                !store
                  .query(
                    "SELECT 1 FROM source_aliases WHERE session_id=? AND record_id=? AND source_id NOT LIKE 'hook:%' AND source_id NOT LIKE 'prompt:%'",
                  )
                  .get(session.id, r.id),
            );
          }
          if (!prompt && inWindow(promptTimestamp, options.since))
            prompt = append({
              kind: 'prompt',
              origin: message.origin,
              text: message.text,
              sourceId: message.sourceId,
              ts: promptTimestamp,
              requestId: message.requestId,
              context: message.context ?? {
                cwd: session.cwd,
                workspacePaths: session.workspacePaths,
              },
            });
          else if (
            prompt &&
            prompt.text !== redact(message.text, historySettings().redact).text &&
            inWindow(promptTimestamp, options.since)
          ) {
            prompt =
              append({
                kind: 'prompt',
                text: message.text,
                sourceId: message.sourceId,
                ts: promptTimestamp,
                requestId: message.requestId,
                context: message.context ?? {
                  cwd: session.cwd,
                  workspacePaths: session.workspacePaths,
                },
              }) ?? prompt;
          }
          currentTurn = prompt?.turnId ?? prompt?.id;
          if (prompt) {
            claimed.add(prompt.id);
            promptAliases.set(message.sourceId, currentTurn!);
            if (options.continueCapture?.() !== false && prompt.sessionId === session.id)
              store.alias(session.id, message.sourceId, prompt.id);
            if (
              message.requestId &&
              prompt.sessionId === session.id &&
              options.continueCapture?.() !== false
            )
              store.alias(session.id, `prompt:${message.requestId}`, prompt.id);
          }
          continue;
        }
        if (
          !inWindow(message.timestamp, options.since) &&
          !(
            !message.timestamp &&
            currentTurn &&
            inWindow(store.record(currentTurn)?.ts, options.since)
          )
        )
          continue;
        if (message.requestId)
          currentTurn =
            store.bySource(session.id, `prompt:${message.requestId}`)?.turnId ??
            currentTurn;
        if (kind === 'edit') {
          const edits = message.edits?.length
            ? message.edits
            : (message.files ?? []).map((file) => ({ file }));
          for (const edit of edits) {
            const file = isAbsolute(edit.file)
              ? edit.file
              : session.cwd
                ? resolve(session.cwd, edit.file)
                : undefined;
            if (!file || internalCapturePath(file, session.tool)) continue;
            append({
              kind: 'edit',
              sourceId: `${message.sourceId}#${file}`,
              ts: message.timestamp,
              file,
              diff:
                'diff' in edit && typeof edit.diff === 'string' ? edit.diff : undefined,
              deleted:
                'deleted' in edit && typeof edit.deleted === 'boolean'
                  ? edit.deleted
                  : undefined,
              turnId: currentTurn,
            });
          }
        } else {
          append({
            kind,
            text: message.text,
            ts: message.timestamp,
            sourceId: message.sourceId,
            turnId: currentTurn,
            requestId: message.requestId,
            approved: message.approved,
            model: message.model,
            toolName: message.toolName,
            isError: message.isError,
            gitBranch: message.gitBranch,
            durationMs: message.durationMs,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
            cacheReadTokens: message.cacheReadTokens,
            cacheCreationTokens: message.cacheCreationTokens,
            transcriptFinal: message.isFinal,
          });
        }
      }
      let eventTurn = transcript.anchorToCurrentTurn ? initialTurn : undefined;
      for (const event of transcript.events ?? []) {
        if (event.type === 'user_text')
          eventTurn =
            promptAliases.get(event.sourceId) ??
            store.bySource(session.id, event.sourceId)?.turnId;
        if (!eventTurn || !inWindow(event.timestamp, options.since)) continue;
        append({
          kind: 'conversation_event',
          sourceId: `conversation:${event.sourceId}`,
          ts: event.timestamp,
          turnId: eventTurn,
          conversationEvent: event,
        });
      }
      // A partial transcript must not replace a newer live prompt with an older one.
      if (initialTurn) {
        const initial = store.record(initialTurn);
        const latest = currentTurn ? store.record(currentTurn) : undefined;
        if (initial && (!latest || initial.ts >= latest.ts))
          store.setCurrentTurn(session.id, initialTurn);
      }
      if (store.repairSchema && options.continueCapture?.() !== false) {
        const prompts = transcript.messages.filter(
          (m) =>
            m.role === 'user' &&
            (m.origin === 'human' || !isSyntheticPrompt(m.text)) &&
            !asyncReplyDecision(m.text),
        );
        const matched = prompts.filter(
          (m) => store.bySource(session.id, m.sourceId)?.kind === 'prompt',
        ).length;
        let sourceStat: { sourceSize?: number; sourceMtime?: number } = {};
        try {
          if (session.transcriptPath) {
            const st = statSync(session.transcriptPath);
            sourceStat = { sourceSize: st.size, sourceMtime: st.mtimeMs };
          }
        } catch {
          /* receipt remains bounded by its read time */
        }
        store.noteSourceRead(session.id, {
          ...sourceStat,
          status:
            prompts.length && matched === prompts.length && !transcript.warnings?.length
              ? 'reconciled'
              : 'partial',
          prompts: prompts.length,
          matched,
          missing: prompts.length - matched,
          warningCodes: transcript.warnings?.length ? ['TRANSCRIPT_DEGRADED'] : [],
          readAt: new Date().toISOString(),
        });
      }

      return inserted;
    })
    .immediate();
}

function applyBatch(store: HistoryStore, batch: CaptureBatch): number {
  if (!consentMatches(batch)) return 0;
  return store
    .transaction(() => {
      if (!consentMatches(batch)) return 0;
      const session = store.ensureSession(batch.session);
      let count = 0;
      for (const input of batch.records) {
        const result = store.append(session.id, input, {
          continueCapture: () => consentMatches(batch),
        });
        if (result.inserted) count++;
        if (result.record?.kind === 'prompt' && input.requestId)
          store.alias(session.id, `prompt:${input.requestId}`, result.record.id);
      }
      if (batch.transcript && consentMatches(batch))
        count += captureTranscript(store, store.session(session.id)!, batch.transcript, {
          since: batch.automatic ? batch.session.automaticSince : undefined,
          continueCapture: () => consentMatches(batch),
        });
      if (batch.end && consentMatches(batch)) store.endSession(session.id);
      return count;
    })
    .immediate();
}

export function drainPending(store: HistoryStore): number {
  const dir = dataPath('pending');
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)
    .filter((n) => /^[\w-]+\.json$/.test(n))
    .sort()) {
    const path = join(dir, name);
    let batch: CaptureBatch;
    try {
      batch = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      captureIssue('PENDING_INVALID', 'unknown');
      continue;
    }
    if (
      batch.version !== 1 ||
      !batch.id ||
      !batch.session?.tool ||
      !Array.isArray(batch.records)
    ) {
      captureIssue('PENDING_INVALID', 'unknown');
      continue;
    }
    total += applyBatch(store, batch);
    try {
      unlinkSync(path);
    } catch {
      /* Replaying an already committed batch is idempotent. */
    }
  }
  return total;
}

export function commitCapture(batch: CaptureBatch): number {
  if (!consentMatches(batch)) return 0;
  try {
    using store = new HistoryStore();
    drainPending(store);
    return applyBatch(store, batch);
  } catch (error) {
    if (/SQLITE_BUSY|database is locked/i.test(String(error))) {
      enqueue(batch);
      captureIssue('CAPTURE_QUEUED', batch.session.tool);
      return 0;
    }
    throw error;
  }
}

export async function runHistoryHook(
  event: CaptureEvent,
  raw: unknown,
  toolName: string,
): Promise<void> {
  const plugin = getPlugin(toolName);
  const tool = plugin?.id ?? toolName;
  const adapter = plugin?.connect?.hooks;
  if (adapter?.acceptsPayload && !adapter.acceptsPayload(raw)) return;
  if (!automaticCaptureEnabled(tool)) return;
  const payload = (raw && typeof raw === 'object' ? raw : {}) as HookPayload &
    Record<string, any>;
  const parsed: NormalizedHookEvent = adapter?.parse(payload) ?? {
    nativeSessionId: extractSessionId(payload),
    prompt: extractPrompt(payload) ?? undefined,
    editedFiles: [],
  };
  const cwd =
    parsed.projectCwd !== undefined
      ? parsed.projectCwd
      : typeof payload.cwd === 'string' && isAbsolute(payload.cwd)
        ? payload.cwd
        : null;
  const workspaces =
    parsed.workspacePaths ??
    (Array.isArray(payload.workspacePaths)
      ? payload.workspacePaths.filter(
          (p: unknown): p is string => typeof p === 'string' && isAbsolute(p),
        )
      : []);
  const operationalRoot = cwd ?? workspaces[0] ?? dataHome();
  const now = new Date().toISOString();
  const timestamp =
    typeof payload.timestamp === 'string' &&
    Number.isFinite(Date.parse(payload.timestamp))
      ? payload.timestamp
      : now;
  const requestId = [payload.request_id, payload.turn_id, payload.prompt_id].find(
    (id) => typeof id === 'string' && id.length > 0,
  ) as string | undefined;
  const nativeId =
    parsed.nativeSessionId ??
    (typeof payload.transcript_path === 'string'
      ? `transcript:${digest(payload.transcript_path)}`
      : `synthetic:${randomUUID()}`);
  const cliName = plugin?.cliName ?? tool;
  const enabledAt = toolCaptureEnabledAt(cliName);
  const config = readGlobalConfig();
  const since =
    [enabledAt, config.captureResumedAt, config.captureSince]
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? now;
  const batch: CaptureBatch = {
    version: 1,
    id: `${Date.now()}-${randomUUID()}`,
    automatic: {
      cliName,
      enabledAt,
      globalEpoch: config.captureResumedAt ?? config.captureSince,
    },
    session: {
      tool,
      nativeSessionId: nativeId,
      cwd,
      workspacePaths: workspaces,
      startedAt: timestamp,
      automaticSince: since,
      transcriptPath:
        typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined,
    },
    records: [],
  };
  const gitCommit = cwd ? await maybeCurrentCommit(cwd, true) : undefined;
  if (event === 'user-prompt' && parsed.prompt) {
    const kind = payload.origin?.kind;
    const origin =
      parsed.promptOrigin ??
      (payload.isMeta ||
      payload.isSidechain ||
      payload.isCompactSummary ||
      ['system', 'sdk'].includes(payload.promptSource) ||
      ['system', 'task-notification'].includes(kind)
        ? 'harness'
        : kind === 'peer' || kind === 'agent'
          ? 'agent'
          : kind === 'human' ||
              ['typed', 'queued', 'suggestion_accepted'].includes(payload.promptSource)
            ? 'human'
            : undefined);
    const providerMessage =
      origin === 'agent' ||
      origin === 'harness' ||
      (origin !== 'human' && isSyntheticPrompt(parsed.prompt));
    const decision = providerMessage ? null : asyncReplyDecision(parsed.prompt);
    if (providerMessage)
      batch.records.push({
        kind: 'tool_call',
        origin: origin ?? 'harness',
        toolName: 'Provider message',
        text: parsed.prompt,
        ts: timestamp,
        sourceId: 'hook-provider:' + digest(canonical(payload)),
      });
    else if (decision)
      batch.records.push({
        kind: 'decision',
        text: decision.text,
        sourceId: decision.sourceId,
        ts: timestamp,
      });
    else {
      // Do not dedupe equal prompts unless the HOST provides an invocation identity.
      const key =
        requestId ?? (payload.timestamp ? digest(canonical(payload)) : randomUUID());
      batch.records.push({
        id: `rec_${randomUUID()}`,
        kind: 'prompt',
        origin,
        text: parsed.prompt,
        sourceId: `hook:${key}`,
        requestId,
        ts: timestamp,
        model: parsed.model,
        gitCommit,
        context: { cwd, workspacePaths: workspaces },
      });
    }
  }
  if (event === 'post-edit') {
    let edits = parsed.edits?.length
      ? parsed.edits
      : parsed.editedFiles.map((file) => ({ file, diff: parsed.suggestedDiff }));
    if (!edits.length && cwd && adapter?.recoverEditsFromGit) {
      edits = (await changedFiles(cwd)).flatMap((file) => {
        const path = resolve(cwd, file);
        try {
          return Date.now() - statSync(path).mtimeMs <= 5 * 60_000
            ? [{ file: path, diff: undefined }]
            : [];
        } catch {
          return [];
        }
      });
    }
    for (const edit of edits) {
      const file = isAbsolute(edit.file)
        ? edit.file
        : cwd
          ? resolve(cwd, edit.file)
          : undefined;
      if (!file || internalCapturePath(file, tool)) continue;
      let sha256: string | undefined;
      try {
        sha256 = createFileHash(file);
      } catch {
        /* A deletion/path-only event is still useful. */
      }
      batch.records.push({
        kind: 'edit',
        file,
        diff: edit.diff,
        deleted: 'deleted' in edit ? edit.deleted : undefined,
        sha256,
        gitCommit,
        requestId,
        ts: timestamp,
        sourceId: requestId
          ? `hook-edit:${requestId}:${file}:${digest(edit.diff ?? sha256 ?? '')}`
          : `hook-edit:${digest(canonical({ nativeId, file, diff: edit.diff, sha256, timestamp: payload.timestamp ?? now }))}`,
      });
    }
  }
  if (
    event === 'stop' ||
    event === 'session-end' ||
    (event === 'post-edit' && adapter?.reconcileOnPostEdit)
  ) {
    try {
      batch.transcript =
        (await adapter?.getTranscript?.(payload, operationalRoot)) ?? undefined;
    } catch {
      captureIssue('TRANSCRIPT_UNAVAILABLE', tool);
    }
    for (const warning of batch.transcript?.warnings ?? []) {
      void warning;
      captureIssue('TRANSCRIPT_DEGRADED', tool);
    }
    for (const plan of adapter?.planFiles?.(payload, operationalRoot) ?? []) {
      try {
        if (plan.nativeSessionId && plan.nativeSessionId !== nativeId) continue;
        if (statSync(plan.absPath).mtimeMs < Date.parse(since)) continue;
        batch.records.push({
          kind: 'plan',
          text: plan.content,
          sourceId: plan.sourceId,
          ts: timestamp,
          requestId,
        });
      } catch {
        /* A provider can remove its own plan while the hook runs. */
      }
    }
  }
  batch.end = event === 'session-end';
  if (batch.records.length || batch.transcript || batch.end) commitCapture(batch);
}

function createFileHash(path: string): string {
  // Hashes are evidence only; the captured diff supplies the reviewable content.
  return digestBytes(readFileSync(path));
}
import { createHash } from 'node:crypto';
function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
