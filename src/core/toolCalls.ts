/**
 * Rendering for Claude Code tool_use calls other than the edit/decision/plan
 * tools, which have their own dedicated handling (`claudeCode.ts`'s
 * `EDIT_TOOLS`, `decisions.ts`, `plans.ts`). Pure (no I/O), so it's
 * unit-testable in isolation like its siblings.
 */
import { asString, prop, type ToolResult } from './parse.ts';
import { truncateBlock } from './text.ts';

/** Tools whose invocations are Claude's own bookkeeping — never worth showing. */
export const NOISY_TOOLS = new Set(['TodoWrite']);

/** A human-readable one-line rendering of a tool_use block's `input`. */
export function renderToolCallInput(name: string, input: unknown): string {
  switch (name) {
    case 'Bash': {
      const command = asString(prop(input, 'command'));
      return command ? `$ ${command}` : name;
    }
    case 'Read':
      return describe(name, asString(prop(input, 'file_path')));
    case 'Glob':
      return describe(name, asString(prop(input, 'pattern')));
    case 'Grep': {
      const pattern = asString(prop(input, 'pattern'));
      const path = asString(prop(input, 'path'));
      if (!pattern) return name;
      return path ? `${name}: ${pattern} (in ${path})` : `${name}: ${pattern}`;
    }
    case 'WebFetch':
      return describe(name, asString(prop(input, 'url')));
    case 'WebSearch':
      return describe(name, asString(prop(input, 'query')));
    default:
      // Unrecognized tool (a future built-in, or an MCP tool like
      // `mcp__server__tool`) — fall back to a generic key:value rendering so
      // it never shows up empty.
      return describeGeneric(name, input);
  }
}

function describe(name: string, value: string | undefined): string {
  return value ? `${name}: ${value}` : name;
}

function describeGeneric(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name;
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(
      ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    )
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length > 0 ? `${name} (${parts.join(', ')})` : name;
}

/** The label a background command / agent completion is recorded under. */
export const BACKGROUND_TASK_LABEL = 'Background task';

/** A "this finished" notice for work a turn started in the background. */
export interface TaskNotification {
  /** Human summary, e.g. `Background command "Launch the game" completed (exit code 0)`. */
  summary: string;
  /** `completed`, `failed`, or `killed` (the student stopped it). */
  status?: string;
  /** The `tool_use` id whose completion this reports, when present. */
  toolUseId?: string;
}

/**
 * Parse a background-command / subagent completion notice.
 *
 * When a turn starts work in the background (a backgrounded `Bash` command, a
 * `Task` subagent), its *outcome* arrives later as a tooling-injected user line
 * holding a `<task-notification>` block — never a real prompt, and not a
 * `tool_result` either, so it is invisible to every other parser here. Returns
 * null for anything that isn't one; tolerates missing/extra tags.
 */
export function parseTaskNotification(content: string): TaskNotification | null {
  if (!content.includes('<task-notification>')) return null;
  const summary = tag(content, 'summary');
  if (!summary) return null; // Nothing worth showing without it.
  return {
    summary,
    status: tag(content, 'status'),
    toolUseId: tag(content, 'tool-use-id'),
  };
}

/** The text of one `<name>…</name>` tag, trimmed; undefined when absent/empty. */
function tag(content: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content);
  const value = m?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * The full rendered `Event.text` for a tool call: its already-rendered input
 * `header` (from {@link renderToolCallInput}), followed by its (truncated)
 * result when one was captured.
 */
export function renderToolCallText(
  header: string,
  result: ToolResult | undefined,
): string {
  const body = result?.content ? truncateBlock(result.content) : undefined;
  if (!body) return header;
  const prefix = result?.isError ? '**Error:**\n' : '';
  return `${header}\n\n${prefix}\`\`\`\n${body}\n\`\`\``;
}
