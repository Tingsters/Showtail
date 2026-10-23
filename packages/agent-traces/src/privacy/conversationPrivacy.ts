/**
 * What a structured conversation event may keep, before any pattern redaction runs.
 *
 * The structured stream records every tool call a model makes: its full `input` and, for
 * a result, its `stdout`, `stderr` and `content`. That is where secrets actually live:
 * `cat .env`, `printenv`, a Write whose `content` is a credentials file, a failing request
 * that echoes its Authorization header. No list of key formats can promise to catch all of
 * that, so these parts are withheld by default rather than scrubbed:
 *
 *  - a tool *result* keeps its exit status and error flag, not its output;
 *  - a tool *use* aimed at a credential file keeps the path, not what it was given.
 *
 * `settings.captureToolOutput: true` opts back in to keeping output (it still goes through
 * the pattern and known-value redaction like everything else).
 */
import type { ConversationEvent, JsonValue } from '../model.ts';
import { isSensitivePath } from './sensitivePaths.ts';

/**
 * Tools whose results are the *student's own choices*, not command output: they are always
 * kept. (Also the set `conversationEvents` always captures, whatever the other switches say.)
 */
export const ALWAYS_CAPTURE_TOOLS = new Set([
  'askuserquestion',
  'request_user_input',
  'vscode_askquestions',
  'enterplanmode',
  'exitplanmode',
  'update_plan',
]);

export const OUTPUT_WITHHELD = '(output not captured)';
export const CREDENTIAL_WITHHELD = 'credential file: content not captured';

/** Keys whose string value names a file or directory a tool will touch. */
const PATH_KEY =
  /^(?:file_?path|path|file|filename|file_?name|target_?file|target|absolute_?path|notebook_?path|destination|dest|cwd|dir|directory)$/i;
/** A patch envelope header (`*** Update File: .env`) as Codex's apply_patch writes it. */
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every path a tool input names: path-like keys at any depth, plus patch headers. */
function namedPaths(value: JsonValue | undefined, depth = 0): string[] {
  if (value === undefined || value === null || depth > 6) return [];
  if (typeof value === 'string') {
    const out: string[] = [];
    for (const m of value.matchAll(PATCH_HEADER)) out.push(m[1]!.trim());
    return out;
  }
  if (Array.isArray(value)) return value.flatMap((v) => namedPaths(v, depth + 1));
  if (isObject(value)) {
    const out: string[] = [];
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'string' && PATH_KEY.test(key)) out.push(v);
      else out.push(...namedPaths(v, depth + 1));
    }
    return out;
  }
  return [];
}

/** True when a tool input is aimed at a credential file. */
export function inputTargetsCredentialFile(input: JsonValue | undefined): boolean {
  return namedPaths(input).some((p) => isSensitivePath(p));
}

/** Keep only the path-like entries of an input, so the report still says what was touched. */
function pathsOnly(input: JsonValue | undefined): Record<string, JsonValue> {
  const kept: Record<string, JsonValue> = {};
  if (isObject(input)) {
    for (const [key, v] of Object.entries(input)) {
      if (typeof v === 'string' && PATH_KEY.test(key)) kept[key] = v;
    }
  }
  return kept;
}

export interface PrivacyOptions {
  /** `settings.captureToolOutput`: keep a result's output (still redacted). Default false. */
  captureToolOutput?: boolean;
}

/** An answer to a question the student was asked: kept, because it is their decision. */
function isDecisionResult(event: ConversationEvent): boolean {
  if (event.toolName && ALWAYS_CAPTURE_TOOLS.has(event.toolName.toLowerCase()))
    return true;
  return isObject(event.content) && 'answers' in event.content;
}

/** Apply the policy above to one event, returning a copy. */
export function withholdSensitiveParts(
  event: ConversationEvent,
  options: PrivacyOptions = {},
): ConversationEvent {
  if (
    event.type === 'tool_result' &&
    options.captureToolOutput !== true &&
    !isDecisionResult(event)
  ) {
    const { stdout: _stdout, stderr: _stderr, ...rest } = event;
    void _stdout;
    void _stderr;
    return {
      ...rest,
      ...(rest.content !== undefined ? { content: OUTPUT_WITHHELD } : {}),
      ...(rest.text !== undefined ? { text: OUTPUT_WITHHELD } : {}),
    };
  }
  if (event.type === 'tool_use' && inputTargetsCredentialFile(event.input)) {
    return {
      ...event,
      input: { ...pathsOnly(event.input), withheld: CREDENTIAL_WITHHELD },
      ...(event.text !== undefined ? { text: CREDENTIAL_WITHHELD } : {}),
    };
  }
  return event;
}
