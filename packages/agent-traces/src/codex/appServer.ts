/**
 * Read a Codex session through Codex's own app-server protocol instead of parsing
 * its rollout file.
 *
 * Why: the rollout JSONL is an internal, versionless format that OpenAI documents as
 * "not a stable interface" — it changed shape at Codex v0.148 (the `event_msg`
 * user/agent messages vanished, `apply_patch` calls became `exec`) and Showtail's file
 * reader silently captured nothing. `codex app-server` is the documented read path
 * (`thread/items/list`, `thread/turns/list`): the same typed `ThreadItem`s
 * (`userMessage`, `agentMessage`, `fileChange`, `plan`, …) regardless of how Codex
 * stores the thread on disk. It is marked experimental, so everything here fails soft:
 * callers fall back to the live hook payloads and surface a warning, never silence.
 *
 * Verified against Codex 0.163 on real threads: item counts, ids, texts and file
 * diffs match the raw data 1:1, and legacy (v0.139–0.142) threads match the previous
 * file parser's output (see tests/codexAppServer.test.ts for the recorded fixtures).
 *
 * Protocol notes (newline-delimited JSON-RPC over stdio):
 *   initialize {clientInfo, capabilities:{experimentalApi:true}} → `initialized`
 *   thread/items/list {threadId, limit, cursor?, sortDirection:'asc'} — paginated store
 *   thread/turns/list {threadId, limit, cursor?, sortDirection:'asc', itemsView:'full'}
 *     — works for legacy-store threads, where thread/items/list is "not supported yet"
 *   thread/read {threadId} — thread metadata (model, cwd, cliVersion)
 */
import { spawn } from 'node:child_process';
import {
  answeredAsyncQuestions,
  asyncQuestionsFrom,
  asyncReplyDecision,
  asyncReplyCallId,
  parseAsyncQuestionReply,
  renderDecisionText,
} from '../transcript/decisions.ts';
import type { EditedFile } from '../hooks/payload.ts';
import { asArray, asString, prop } from '../util/parse.ts';
import { toRepoRelative } from '../paths/pathUtil.ts';
import type { CodexMessage, CodexTranscript } from './transcript.ts';
import type { HookTranscriptEvent } from '../model.ts';

// --- JSON-RPC transport ------------------------------------------------------

/** The slice of the app-server client the reader needs (injectable for tests). */
export interface CodexRpc {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

/** An app-server failure, with the JSON-RPC error code when the server sent one. */
export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

export interface OpenRpcOptions {
  /** The Codex binary to run (default `$SHOWTAIL_CODEX_BIN`, else `codex`). */
  bin?: string;
  /** Arguments for the binary (default `["app-server"]`; overridden by tests). */
  args?: string[];
  /** Per-request timeout in ms (default 30s). */
  requestTimeoutMs?: number;
}

/** Whether (on Windows) `bin` must go through a shell: a bare name or a `.cmd`/`.bat` shim. */
function needsShell(bin: string): boolean {
  const hasDir = bin.includes('/') || bin.includes(String.fromCharCode(92));
  const lower = bin.toLowerCase();
  return !hasDir || lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/** Spawn `codex app-server` and complete the initialize handshake. */
export async function openCodexRpc(opts: OpenRpcOptions = {}): Promise<CodexRpc> {
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;
  const bin = opts.bin ?? process.env.SHOWTAIL_CODEX_BIN ?? 'codex';
  const child = spawn(bin, opts.args ?? ['app-server'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    // A bare `codex` (or an npm `.cmd` launcher) needs a shell to resolve on Windows;
    // an absolute path to a real executable does not, and must not be re-split.
    shell: process.platform === 'win32' && needsShell(bin),
    windowsHide: true,
  });

  let nextId = 1;
  let buffer = '';
  let dead: CodexAppServerError | undefined;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }
  >();
  type Timer = ReturnType<typeof setTimeout>;

  const failAll = (error: CodexAppServerError): void => {
    dead ??= error;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(error);
    }
  };
  child.on('error', (e) =>
    failAll(new CodexAppServerError(`cannot run codex: ${e.message}`)),
  );
  child.on('exit', (code) =>
    failAll(new CodexAppServerError(`codex app-server exited (${code ?? 'signal'})`)),
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not a JSON-RPC line (banner/log noise) — ignore.
      }
      const id = prop(msg, 'id');
      const p = typeof id === 'number' ? pending.get(id) : undefined;
      if (!p) continue; // A notification — the reader doesn't use any.
      clearTimeout(p.timer);
      pending.delete(id as number);
      const error = prop(msg, 'error');
      if (error !== undefined) {
        const code = prop(error, 'code');
        p.reject(
          new CodexAppServerError(
            asString(prop(error, 'message')) ?? 'app-server error',
            typeof code === 'number' ? code : undefined,
          ),
        );
      } else p.resolve(prop(msg, 'result'));
    }
  });

  const send = (payload: unknown): void => {
    child.stdin.write(JSON.stringify(payload) + '\n');
  };
  const rpc: CodexRpc = {
    request(method, params) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CodexAppServerError(`timed out waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    close() {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // Already gone.
      }
    },
  };

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'showtail', title: 'Showtail', version: '0' },
      capabilities: { experimentalApi: true },
    });
    send({ jsonrpc: '2.0', method: 'initialized' });
  } catch (error) {
    rpc.close();
    throw error;
  }
  return rpc;
}

// --- Reading a thread ---------------------------------------------------------

/** One persisted item with its turn and (when the store records them) timestamps. */
export interface ThreadEntry {
  turnId?: string;
  item: unknown;
  startedAtMs?: number;
  completedAtMs?: number;
}

export interface ThreadRead {
  entries: ThreadEntry[];
  /** Which API produced them: the paginated item store, or the legacy turn listing. */
  via: 'items' | 'turns';
  /** Thread metadata from `thread/read`, when available. */
  model?: string;
  cwd?: string;
  cliVersion?: string;
}

const PAGE_LIMIT = 500;
const MAX_PAGES = 400;

/** Page every item of a thread, preferring `thread/items/list`. */
export async function readThread(rpc: CodexRpc, threadId: string): Promise<ThreadRead> {
  const entries: ThreadEntry[] = [];
  let via: ThreadRead['via'] = 'items';
  try {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await rpc.request('thread/items/list', {
        threadId,
        limit: PAGE_LIMIT,
        sortDirection: 'asc',
        ...(cursor ? { cursor } : {}),
      });
      for (const d of asArray(prop(r, 'data')) ?? []) {
        entries.push({
          turnId: asString(prop(d, 'turnId')),
          item: prop(d, 'item'),
          startedAtMs: asNumber(prop(d, 'startedAtMs')),
          completedAtMs: asNumber(prop(d, 'completedAtMs')),
        });
      }
      cursor = asString(prop(r, 'nextCursor'));
      if (!cursor) break;
    }
  } catch (error) {
    // Legacy-store threads: "thread/items/list is not supported yet" (-32601).
    if (!(error instanceof CodexAppServerError) || error.code !== -32601) throw error;
    via = 'turns';
    entries.length = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await rpc.request('thread/turns/list', {
        threadId,
        limit: 100,
        sortDirection: 'asc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      });
      for (const turn of asArray(prop(r, 'data')) ?? []) {
        // Legacy turns carry second-resolution turn times, not per-item ones: stamp
        // each item at the turn start plus its index so order is preserved.
        const startedAt = asNumber(prop(turn, 'startedAt'));
        (asArray(prop(turn, 'items')) ?? []).forEach((item, i) => {
          entries.push({
            turnId: asString(prop(turn, 'id')),
            item,
            startedAtMs: startedAt === undefined ? undefined : startedAt * 1000 + i,
          });
        });
      }
      cursor = asString(prop(r, 'nextCursor'));
      if (!cursor) break;
    }
  }

  const out: ThreadRead = { entries, via };
  try {
    const thread = prop(await rpc.request('thread/read', { threadId }), 'thread');
    out.model = asString(prop(thread, 'model'));
    out.cwd = asString(prop(thread, 'cwd'));
    out.cliVersion = asString(prop(thread, 'cliVersion'));
  } catch {
    // Metadata is a nicety; the items are what matter.
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// --- Mapping items → Showtail messages ---------------------------------------

const INTERNAL_PATH_RE = /(^|[\\/])\.(showtail|codex)([\\/]|$)/;

/** Keep only the changed lines of a unified diff, as Showtail's `+ ` / `- ` form. */
export function cleanUnifiedDiff(diff: string): string {
  const out: string[] = [];
  for (const raw of diff.split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) out.push('+ ' + l.slice(1));
    else if (l.startsWith('-')) out.push('- ' + l.slice(1));
    // Context and hunk headers are dropped, like Claude's old→new style.
  }
  return out.join('\n');
}

/** Every line of an added/removed file's content, prefixed `+ ` / `- `. */
function wholeFileDiff(content: string, sign: '+' | '-'): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((l) => `${sign} ${l}`).join('\n');
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function userText(item: unknown): string {
  return (asArray(prop(item, 'content')) ?? [])
    .filter((p) => prop(p, 'type') === 'text')
    .map((p) => asString(prop(p, 'text')) ?? '')
    .join('')
    .trim();
}

export interface MapOptions {
  /** The project root: edits outside it, or in `.showtail`/`.codex`, are dropped. */
  root: string;
  /** The model in effect (e.g. from the hook payload), stamped onto replies. */
  model?: string;
}

/**
 * Turn a thread's items into the normalized transcript the generic Stop reconcile and
 * `import codex` consume. Source ids keep the file parser's schemes
 * (`codex:user|asst:<thread>:<n>`, `codex:edit|plan|decision:<id>`) so sessions that
 * were already captured dedupe instead of duplicating.
 */
export function threadToTranscript(
  threadId: string,
  entries: ThreadEntry[],
  opts: MapOptions,
): CodexTranscript & { events: HookTranscriptEvent[] } {
  const messages: CodexMessage[] = [];
  const events: HookTranscriptEvent[] = [];
  let userSeq = 0;
  let asstSeq = 0;
  let eventSeq = 0;
  // call id → the questions of a non-blocking ask, so the later answer renders
  // against the options Codex offered.
  const asked = new Map<string, ReturnType<typeof asyncQuestionsFrom>>();

  for (const entry of entries) {
    const item = entry.item;
    const type = asString(prop(item, 'type'));
    const id = asString(prop(item, 'id'));
    const timestamp = iso(entry.completedAtMs ?? entry.startedAtMs);

    if (type === 'userMessage') {
      const text = userText(item);
      if (!text) continue;
      const replies = parseAsyncQuestionReply(text);
      if (replies) {
        // The student's answer to a non-blocking question, steered into the turn.
        const callId = asyncReplyCallId(replies);
        messages.push({
          role: 'decision',
          text: renderDecisionText(
            answeredAsyncQuestions(callId ? asked.get(callId) : undefined, replies),
            'Codex',
            { nonBlocking: true },
          ),
          timestamp,
          sourceId: callId
            ? `codex:decision:${callId}`
            : `codex:decision:${threadId}:async${userSeq}`,
        });
        continue;
      }
      const malformed = asyncReplyDecision(text);
      if (malformed) {
        // An envelope we could not parse: keep the student's words, never drop them.
        messages.push({
          role: 'decision',
          text: malformed.text,
          timestamp,
          sourceId: `codex:decision:${threadId}:raw${userSeq}`,
        });
        continue;
      }
      const sourceId = `codex:user:${threadId}:${userSeq++}`;
      messages.push({ role: 'user', text, timestamp, sourceId });
      events.push({
        sequence: eventSeq++,
        type: 'user_text',
        sourceId,
        timestamp,
        text,
      });
    } else if (type === 'agentMessage') {
      const text = (asString(prop(item, 'text')) ?? '').trim();
      const questions = asArray(prop(item, 'questions'));
      if (prop(item, 'delivery') === 'async' && questions && id) {
        // The echo of a non-blocking question: its question and options become the
        // "asked" half of a decision, shown where Codex asked it.
        const parsed = asyncQuestionsFrom(questions);
        if (parsed.length > 0) {
          asked.set(id, parsed);
          messages.push({
            role: 'decision',
            text: renderDecisionText(parsed, 'Codex', { nonBlocking: true }),
            timestamp,
            sourceId: `codex:decision-ask:${id}`,
          });
          continue;
        }
      }
      if (!text) continue;
      const sourceId = `codex:asst:${threadId}:${asstSeq++}`;
      messages.push({
        role: 'assistant',
        text,
        timestamp,
        sourceId,
        model: opts.model,
        isFinal: prop(item, 'phase') === 'final_answer',
      });
      events.push({
        sequence: eventSeq++,
        type: 'assistant_text',
        sourceId,
        timestamp,
        text,
      });
    } else if (type === 'fileChange') {
      if (!id || (asString(prop(item, 'status')) ?? 'completed') !== 'completed')
        continue;
      const edits: EditedFile[] = [];
      for (const change of asArray(prop(item, 'changes')) ?? []) {
        const path = asString(prop(change, 'path'));
        if (!path) continue;
        const file = toRepoRelative(opts.root, path);
        if (!file || file.startsWith('..') || INTERNAL_PATH_RE.test(file)) continue;
        const kind =
          asString(prop(prop(change, 'kind'), 'type')) ?? asString(prop(change, 'kind'));
        const diff = asString(prop(change, 'diff')) ?? '';
        if (kind === 'delete') {
          edits.push({
            file,
            deleted: true,
            diff: diff ? wholeFileDiff(diff, '-') : undefined,
          });
        } else if (kind === 'add') {
          edits.push({ file, diff: diff ? wholeFileDiff(diff, '+') : undefined });
        } else {
          edits.push({ file, diff: cleanUnifiedDiff(diff) || undefined });
        }
      }
      if (edits.length === 0) continue;
      const files = edits.map((e) => e.file);
      messages.push({
        role: 'edit',
        text: `Codex edited ${files.join(', ')}`,
        files,
        edits,
        timestamp,
        sourceId: `codex:edit:${id}`,
      });
      events.push(
        {
          sequence: eventSeq++,
          type: 'tool_use',
          sourceId: `codex:tool:${id}:use`,
          timestamp,
          toolUseId: id,
          toolName: 'apply_patch',
          input: { files },
        },
        {
          sequence: eventSeq++,
          type: 'tool_result',
          sourceId: `codex:tool:${id}:result`,
          timestamp,
          toolUseId: id,
          content: `edited ${files.join(', ')}`,
        },
      );
    } else if (type === 'plan') {
      const text = (asString(prop(item, 'text')) ?? '').trim();
      if (!id || !text) continue;
      messages.push({ role: 'plan', text, timestamp, sourceId: `codex:plan:${id}` });
      events.push({
        sequence: eventSeq++,
        type: 'plan_snapshot',
        sourceId: `codex:plan:${id}:snapshot`,
        timestamp,
        plan: text,
      });
    } else if (type === 'commandExecution' && id) {
      const status = asString(prop(item, 'status'));
      const exitCode = asNumber(prop(item, 'exitCode'));
      const output = asString(prop(item, 'aggregatedOutput'));
      events.push(
        {
          sequence: eventSeq++,
          type: 'tool_use',
          sourceId: `codex:tool:${id}:use`,
          timestamp: iso(entry.startedAtMs) ?? timestamp,
          toolUseId: id,
          toolName: 'shell',
          input: {
            command: asString(prop(item, 'command')) ?? '',
            cwd: asString(prop(item, 'cwd')) ?? '',
          },
        },
        {
          sequence: eventSeq++,
          type: 'tool_result',
          sourceId: `codex:tool:${id}:result`,
          timestamp,
          toolUseId: id,
          ...(output === undefined ? {} : { content: output, stdout: output }),
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(status === 'failed' || (exitCode !== undefined && exitCode !== 0)
            ? { isError: true }
            : {}),
        },
      );
    }
    // reasoning, webSearch, imageView, sleep, contextCompaction, … are not part of
    // the student's visible work, exactly as the file parser ignored them.
  }

  return {
    sessionId: threadId,
    title: `Codex session ${threadId.slice(0, 8)}`,
    messages,
    events,
  };
}

// --- One-call convenience -----------------------------------------------------

export interface ReadTranscriptOptions extends MapOptions {
  /** Inject a client (tests); otherwise `codex app-server` is spawned. */
  rpc?: CodexRpc;
  openRpc?: () => Promise<CodexRpc>;
}

export interface ThreadTranscriptResult {
  transcript: CodexTranscript & { events: HookTranscriptEvent[] };
  via: ThreadRead['via'];
  cliVersion?: string;
}

/** Read one thread end to end through the app-server. Throws on any failure. */
export async function readThreadTranscript(
  threadId: string,
  opts: ReadTranscriptOptions,
): Promise<ThreadTranscriptResult> {
  const own = !opts.rpc;
  const rpc = opts.rpc ?? (await (opts.openRpc ?? (() => openCodexRpc()))());
  try {
    const thread = await readThread(rpc, threadId);
    const transcript = threadToTranscript(threadId, thread.entries, {
      root: opts.root,
      model: opts.model ?? thread.model,
    });
    return { transcript, via: thread.via, cliVersion: thread.cliVersion };
  } finally {
    if (own) rpc.close();
  }
}
