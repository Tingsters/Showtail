/**
 * Tiny runtime helpers for reading fields off untrusted, loosely-typed JSON
 * (share-page payloads, transcript lines) without resorting to `any`. Each
 * returns a narrowed value or `undefined`, so navigation stays total — a
 * missing or mis-shaped field is never a throw. That matches the parsers'
 * contract: degrade to the paste/skip fallback, never crash a session.
 */

/** True for a non-null object — arrays included, mirroring `typeof x === 'object'`. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read `value[key]` when `value` is a non-null object; `undefined` otherwise. */
export function prop(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/** `value` if it is a string, else `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` if it is a number, else `undefined`. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** `value` if it is an array, else `undefined`. */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A resolved tool_result: its text content and error flag. */
export interface ToolResult {
  content?: string;
  isError?: boolean;
}

/**
 * Collect every `tool_result` block on a transcript line's `message.content[]`,
 * indexed by the `tool_use` id it answers. Shared by any parser that needs to
 * pair a tool_use with its later result (AskUserQuestion answers, tool calls, ...).
 */
export function collectToolResults(obj: unknown, into: Map<string, ToolResult>): void {
  const content = asArray(prop(prop(obj, 'message'), 'content'));
  if (!content) return;
  for (const part of content) {
    if (prop(part, 'type') !== 'tool_result') continue;
    const id = asString(prop(part, 'tool_use_id'));
    if (!id) continue;
    const rec: ToolResult = into.get(id) ?? {};
    const text = asString(prop(part, 'content'));
    if (text !== undefined) rec.content = text;
    const isError = prop(part, 'is_error');
    if (typeof isError === 'boolean') rec.isError = isError;
    into.set(id, rec);
  }
}
