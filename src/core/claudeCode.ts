/**
 * Import an existing Claude Code session transcript from disk.
 *
 * Claude Code writes a full JSONL transcript of every session to
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` (one object per line).
 * A student who only enabled Showtail partway through — or not at all — can use
 * this to back-fill their trail from that transcript, so it reads as if Showtail
 * had been capturing from the start.
 *
 * Everything here is local: no network, and the roles are explicit in the
 * transcript, so (unlike the ChatGPT paste importer) there is no guessing about
 * what the student wrote vs. what the AI produced.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importedSourceIds, logEvent } from './events.ts';
import { asArray, asString, isObject, prop } from './parse.ts';
import { toRepoRelative, type AuthorPaths } from './storage.ts';

/** One option the AI offered for a decision, and whether the student picked it. */
export interface DecisionOption {
  label: string;
  description?: string;
  chosen: boolean;
}

/** One question in an AskUserQuestion decision, with its options and the answer. */
export interface DecisionQuestion {
  question: string;
  header?: string;
  options: DecisionOption[];
  /** The student's answer text (a chosen label, or free-typed text). */
  answer?: string;
  /** True when the answer was typed in, matching no offered option. */
  custom: boolean;
}

/** A normalized message recovered from a transcript. */
export interface ClaudeMessage {
  /**
   * "user" (a typed prompt), "assistant" (a text reply), "edit" (a file the AI
   * changed), or "decision" (a choice the student made when the AI paused to ask).
   */
  role: 'user' | 'assistant' | 'edit' | 'decision';
  text: string;
  /** ISO-8601 timestamp from the transcript line, if present. */
  timestamp?: string;
  /** A stable id (the line uuid, or a tool_use id) so re-imports dedupe. */
  sourceId: string;
  /** For edits: the repo-relative file path(s) the AI touched. */
  files?: string[];
  /**
   * For decisions: the parsed questions + options. The answer is filled in a
   * second pass (the student's reply is a later transcript line), after which
   * `text` is rendered from this.
   */
  questions?: DecisionQuestion[];
}

/** A normalized transcript: just the messages we care about, in order. */
export interface ClaudeTranscript {
  sessionId?: string;
  title: string;
  messages: ClaudeMessage[];
}

/** A transcript file found on disk for a given project. */
export interface TranscriptInfo {
  path: string;
  /** The Claude Code session id (the file name without `.jsonl`). */
  sessionId: string;
  mtimeMs: number;
}

/**
 * An at-a-glance summary of one transcript, so a student can tell sessions
 * apart in the picker without opening each file. Built by parsing the
 * transcript once and counting what's in it.
 */
export interface TranscriptSummary {
  info: TranscriptInfo;
  /** Number of typed prompts in the session. */
  promptCount: number;
  /** Number of file edits Claude made in the session. */
  editCount: number;
  /** The first and last typed prompt (for recognizing the session). */
  firstPrompt: string;
  lastPrompt: string;
  /** Earliest / latest message timestamp (ISO), for a rough duration. */
  first?: string;
  last?: string;
  /**
   * Whether this session is already in the trail: `none` (nothing imported),
   * `full` (every message already imported), or `partial` (some but not all).
   */
  importState: 'none' | 'partial' | 'full';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** User-content wrappers that are tooling chrome, not something the student typed. */
const WRAPPER_RE =
  /^<(local-command-caveat|command-name|command-message|command-args|command-stdout|command-stderr|user-prompt-submit-hook|session-start-hook)/;

/** Don't record edits to Showtail/Claude bookkeeping files. Mirrors hook.ts. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|claude)([\\/]|$)/.test(p);
}

// --- Locating transcripts on disk -----------------------------------------

function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? override : join(homedir(), '.claude');
}

/** The directory Claude Code stores per-project session transcripts under. */
export function claudeProjectsDir(): string {
  return join(claudeHome(), 'projects');
}

/**
 * Compare two absolute paths for equality. Both the project root and the
 * transcript `cwd` are already absolute, so we normalize separators and (on
 * Windows) case rather than going through `path.resolve` — which can't be
 * trusted to keep win32 semantics across runtimes.
 */
function normPath(p: string): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** Read the first chunk of a (possibly huge) file without slurping all of it. */
function readHead(path: string, maxBytes = 131072): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

/** Pull the `cwd` field out of the first transcript line that carries one. */
function cwdOf(head: string): string | null {
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
    } catch {
      // A line cut off by the head window (or malformed) — keep scanning.
    }
  }
  return null;
}

/**
 * Find every Claude Code transcript that belongs to `root`, newest first.
 *
 * We match by the `cwd` field *embedded in each transcript* rather than trusting
 * the encoded directory name (Claude Code rewrites `/ \ : .` to `-`, and that
 * encoding has shifted across versions). Reading the embedded cwd is exact.
 */
export function findProjectTranscripts(root: string): TranscriptInfo[] {
  const dir = claudeProjectsDir();
  if (!existsSync(dir)) return [];
  const out: TranscriptInfo[] = [];

  for (const projectDir of safeReaddir(dir)) {
    const full = join(dir, projectDir);
    if (!isDir(full)) continue;
    for (const file of safeReaddir(full)) {
      if (!file.endsWith('.jsonl')) continue;
      const fp = join(full, file);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      let cwd: string | null = null;
      try {
        cwd = cwdOf(readHead(fp));
      } catch {
        continue;
      }
      if (!cwd || !samePath(cwd, root)) continue;

      out.push({
        path: fp,
        sessionId: file.replace(/\.jsonl$/, ''),
        mtimeMs: st.mtimeMs,
      });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Summarize every transcript for `paths.root`, newest first, so the picker can
 * show counts, a time span, and first/last prompt for each. Each transcript is
 * parsed once; a transcript that fails to parse still appears (counts zeroed)
 * so it can be tried via `--file`. `importState` is computed against the source
 * ids already in the trail so the picker can flag already-imported sessions.
 */
export function summarizeTranscripts(author: AuthorPaths): TranscriptSummary[] {
  const seen = importedSourceIds(author);
  const root = author.shared.root;
  return findProjectTranscripts(root).map((info) => {
    const summary: TranscriptSummary = {
      info,
      promptCount: 0,
      editCount: 0,
      firstPrompt: '',
      lastPrompt: '',
      importState: 'none',
    };

    let parsed: ClaudeTranscript;
    try {
      parsed = parseClaudeTranscript(readFileSync(info.path, 'utf8'), root);
    } catch {
      return summary; // Couldn't parse — list it bare so --file can still reach it.
    }

    const prompts = parsed.messages.filter((m) => m.role === 'user');
    summary.promptCount = prompts.length;
    summary.editCount = parsed.messages.filter((m) => m.role === 'edit').length;
    summary.firstPrompt = prompts[0]?.text ?? '';
    summary.lastPrompt = prompts[prompts.length - 1]?.text ?? '';

    let importedCount = 0;
    for (const m of parsed.messages) {
      if (seen.has(m.sourceId)) importedCount += 1;
      if (m.timestamp) {
        if (!summary.first || m.timestamp < summary.first) summary.first = m.timestamp;
        if (!summary.last || m.timestamp > summary.last) summary.last = m.timestamp;
      }
    }
    if (parsed.messages.length > 0) {
      summary.importState =
        importedCount === 0
          ? 'none'
          : importedCount === parsed.messages.length
            ? 'full'
            : 'partial';
    }

    return summary;
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- Parsing ---------------------------------------------------------------

/** Read a transcript file from disk and parse it. */
export function readTranscriptFile(path: string, root: string): ClaudeTranscript {
  if (!existsSync(path)) {
    throw new Error(`Transcript not found: ${path}`);
  }
  return parseClaudeTranscript(readFileSync(path, 'utf8'), root);
}

/**
 * Parse a Claude Code JSONL transcript into normalized messages. Edits are
 * reported relative to `root` (and edits outside the repo, or to internal
 * `.showtail`/`.claude` files, are dropped). Malformed lines are skipped.
 */
export function parseClaudeTranscript(content: string, root: string): ClaudeTranscript {
  const messages: ClaudeMessage[] = [];
  let sessionId: string | undefined;
  // The student's answers to AskUserQuestion arrive as `tool_result` blocks on
  // *later* user lines, keyed by the question's `tool_use` id. Collect them as we
  // go, then resolve each decision's answer in a second pass below.
  const answersByToolId = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const sid = asString(prop(obj, 'sessionId'));
    if (sid !== undefined && !sessionId) sessionId = sid;

    // Drop noise that isn't the student's direct work.
    if (
      prop(obj, 'isSidechain') === true ||
      prop(obj, 'isMeta') === true ||
      prop(obj, 'isApiErrorMessage') === true
    ) {
      continue;
    }

    const type = prop(obj, 'type');
    if (type === 'user') {
      collectDecisionAnswers(obj, answersByToolId);
      const msg = handleUser(obj);
      if (msg) messages.push(msg);
    } else if (type === 'assistant') {
      messages.push(...handleAssistant(obj, root));
    }
  }

  // Second pass: pair each decision with the student's answer and (re-)render it.
  for (const m of messages) {
    if (m.role !== 'decision' || !m.questions) continue;
    const blob = answersByToolId.get(m.sourceId);
    if (blob) resolveDecisionAnswers(m.questions, blob);
    m.text = renderDecisionText(m.questions);
  }

  return {
    sessionId,
    title: sessionId
      ? `Claude Code session ${sessionId.slice(0, 8)}`
      : 'Claude Code session',
    messages,
  };
}

/** A real typed prompt: string content, not a tool result or a tooling wrapper. */
function handleUser(obj: unknown): ClaudeMessage | null {
  const content = asString(prop(prop(obj, 'message'), 'content'));
  if (content === undefined) return null; // tool_result lines carry an array.

  const source = prop(obj, 'promptSource');
  // Accept typed/pasted prompts; older transcripts may omit the field entirely.
  if (typeof source === 'string' && source !== 'typed' && source !== 'paste') return null;

  const text = content.trim();
  if (!text || WRAPPER_RE.test(text)) return null;

  return {
    role: 'user',
    text,
    timestamp: asString(prop(obj, 'timestamp')),
    sourceId: asString(prop(obj, 'uuid')) ?? `cc:user:${text.slice(0, 24)}`,
  };
}

/** Assistant turns: text parts become one reply; Edit/Write/MultiEdit become edits. */
function handleAssistant(obj: unknown, root: string): ClaudeMessage[] {
  const msg = prop(obj, 'message');
  if (!msg || prop(msg, 'model') === '<synthetic>') return [];
  const content = asArray(prop(msg, 'content'));
  if (!content) return [];

  const timestamp = asString(prop(obj, 'timestamp'));
  const uuid = asString(prop(obj, 'uuid')) ?? '';
  const out: ClaudeMessage[] = [];

  const texts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;

    const type = prop(part, 'type');
    const partText = asString(prop(part, 'text'));
    const name = prop(part, 'name');
    if (type === 'text' && partText !== undefined && partText.trim()) {
      texts.push(partText.trim());
    } else if (type === 'tool_use' && typeof name === 'string' && EDIT_TOOLS.has(name)) {
      const rel = relForEdit(prop(prop(part, 'input'), 'file_path'), root);
      if (!rel) continue;
      const partId = asString(prop(part, 'id'));
      out.push({
        role: 'edit',
        text: `Claude edited ${rel}`,
        files: [rel],
        timestamp,
        sourceId: partId ? partId : `${uuid}:${out.length}`,
      });
    } else if (type === 'tool_use' && name === 'AskUserQuestion') {
      // The AI paused to ask the student to choose. Capture the question(s) and
      // options now; the student's answer is a later transcript line and is
      // resolved in a second pass (see parseClaudeTranscript).
      const questions = parseDecisionQuestions(prop(part, 'input'));
      if (questions.length === 0) continue;
      const partId = asString(prop(part, 'id'));
      out.push({
        role: 'decision',
        text: renderDecisionText(questions), // provisional; re-rendered with the answer
        questions,
        timestamp,
        sourceId: partId ? partId : `${uuid}:${out.length}`,
      });
    }
  }

  if (texts.length > 0) {
    out.unshift({
      role: 'assistant',
      text: texts.join('\n'),
      timestamp,
      sourceId: uuid || `cc:asst:${texts[0]!.slice(0, 24)}`,
    });
  }

  return out;
}

/** Repo-relative path for an edited file, or null if outside the repo / internal. */
function relForEdit(filePath: unknown, root: string): string | null {
  if (typeof filePath !== 'string' || !filePath) return null;
  const rel = toRepoRelative(root, filePath);
  if (rel.startsWith('..') || isInternalPath(rel)) return null;
  return rel;
}

// --- Decisions (AskUserQuestion) -------------------------------------------

/** Parse the `input` of an AskUserQuestion tool_use into structured questions. */
function parseDecisionQuestions(input: unknown): DecisionQuestion[] {
  const questions = asArray(prop(input, 'questions'));
  if (!questions) return [];
  const out: DecisionQuestion[] = [];
  for (const q of questions) {
    const question = asString(prop(q, 'question'));
    if (!question) continue;
    const options: DecisionOption[] = [];
    for (const o of asArray(prop(q, 'options')) ?? []) {
      const label = asString(prop(o, 'label'));
      if (!label) continue;
      options.push({
        label,
        description: asString(prop(o, 'description')),
        chosen: false,
      });
    }
    out.push({ question, header: asString(prop(q, 'header')), options, custom: false });
  }
  return out;
}

/** Collect any AskUserQuestion answers carried on a user line's tool_result blocks. */
function collectDecisionAnswers(obj: unknown, into: Map<string, string>): void {
  const content = asArray(prop(prop(obj, 'message'), 'content'));
  if (!content) return;
  for (const part of content) {
    if (prop(part, 'type') !== 'tool_result') continue;
    const id = asString(prop(part, 'tool_use_id'));
    const text = asString(prop(part, 'content'));
    if (id && text) into.set(id, text);
  }
}

/**
 * Pull the answer *values* out of the result string, in order. The harness
 * formats answers as `"<question>"="<answer>" selected preview:\n…`, so we match
 * each `"…"="(answer)"` value positionally (the question text in the result can
 * differ slightly from the asked text, so we don't key on it).
 */
function parseAnswerValues(blob: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"\s*=\s*"([^"]*)"(?=\s+selected preview|\s*[,.]|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null) out.push(m[1]!);
  return out;
}

/** Fill in which option each question's student chose, or flag a typed answer. */
function resolveDecisionAnswers(questions: DecisionQuestion[], blob: string): void {
  const answers = parseAnswerValues(blob);
  questions.forEach((q, i) => {
    const answer = answers[i];
    if (answer === undefined) return;
    q.answer = answer;
    // multiSelect answers are comma-joined labels; single answers match one label.
    const picked = answer.split(/,\s*/);
    let matched = false;
    for (const o of q.options) {
      if (o.label === answer || picked.includes(o.label)) {
        o.chosen = true;
        matched = true;
      }
    }
    q.custom = !matched; // no option matched → the student typed their own answer
  });
}

/** Render a decision as readable Markdown: the question, every option, the choice. */
function renderDecisionText(questions: DecisionQuestion[]): string {
  const blocks: string[] = [];
  for (const q of questions) {
    const lines: string[] = [`**Claude asked:** ${q.question}`, ''];
    for (const o of q.options) {
      lines.push(o.chosen ? `- **${o.label}** ✅ _(your choice)_` : `- ${o.label}`);
    }
    if (q.custom && q.answer) lines.push('', `**You typed:** ${q.answer}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

// --- Importing -------------------------------------------------------------

export interface ClaudeImportOptions {
  /** Also log Claude's text replies as `ai_output` events (default: prompts only). */
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
}

export interface ClaudeImportResult {
  title: string;
  prompts: number;
  responses: number;
  edits: number;
  decisions: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed transcript into the trail. User prompts become `prompt`
 * events, assistant replies become `ai_output` (only with `withResponses`),
 * each AI edit becomes a back-dated `artifact` event noting the file (not a hash
 * snapshot, since a past file's hash can't be recovered), and each AskUserQuestion
 * choice becomes a `decision` event (always imported — it's the student's own
 * work). Every event is tagged `tool: claude-code` and `imported`, stamped with
 * the original time, and deduped by `sourceId` so re-importing adds nothing.
 */
export async function importClaudeTranscript(
  author: AuthorPaths,
  transcript: ClaudeTranscript,
  options: ClaudeImportOptions = {},
): Promise<ClaudeImportResult> {
  const seen = importedSourceIds(author);
  const result: ClaudeImportResult = {
    title: transcript.title,
    prompts: 0,
    responses: 0,
    edits: 0,
    decisions: 0,
    skipped: 0,
  };

  // A user prompt opens a turn; the assistant reply and edits that follow it
  // link back via this id, so the report groups the imported exchange.
  let currentTurnId: string | undefined;

  for (const msg of transcript.messages) {
    if (msg.role === 'assistant' && !options.withResponses) continue;
    if (seen.has(msg.sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(msg.sourceId);

    const type =
      msg.role === 'user'
        ? 'prompt'
        : msg.role === 'assistant'
          ? 'ai_output'
          : msg.role === 'decision'
            ? 'decision'
            : 'artifact';

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool: 'claude-code',
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      files: msg.files,
      tags: ['imported'],
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') currentTurnId = event.id;

    if (msg.role === 'user') result.prompts += 1;
    else if (msg.role === 'assistant') result.responses += 1;
    else if (msg.role === 'decision') result.decisions += 1;
    else result.edits += 1;

    if (msg.timestamp) {
      if (!result.first || msg.timestamp < result.first) result.first = msg.timestamp;
      if (!result.last || msg.timestamp > result.last) result.last = msg.timestamp;
    }
  }

  return result;
}
