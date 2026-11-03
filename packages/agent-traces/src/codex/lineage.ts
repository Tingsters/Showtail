import { asString, prop } from '../util/parse.ts';

export interface CodexSessionLineage {
  parentNativeSessionId?: string;
  inputOrigin?: 'agent';
}

/** Native rollouts use subagent; the documented API serializes subAgent. */
export function codexSessionLineage(
  source: unknown,
  parentThreadId?: unknown,
): CodexSessionLineage {
  const subagent = prop(source, 'subagent') ?? prop(source, 'subAgent');
  const parent =
    asString(parentThreadId) ??
    asString(prop(prop(subagent, 'thread_spawn'), 'parent_thread_id'));
  const delegated =
    subagent !== undefined ||
    !!parent ||
    (typeof source === 'string' &&
      /^subagent(?:review|compact|threadspawn|other)?$/i.test(source));
  return delegated
    ? {
        inputOrigin: 'agent',
        ...(parent ? { parentNativeSessionId: parent } : {}),
      }
    : {};
}

/** A child thread's user-role inputs are delegated instructions, not human prompts. */
export function applyCodexLineage<
  T extends {
    messages: { role: string; origin?: 'human' | 'agent' | 'harness' }[];
    events?: { type: string; origin?: 'human' | 'agent' | 'harness' }[];
    parentNativeSessionId?: string;
    inputOrigin?: 'agent';
  },
>(transcript: T, lineage: CodexSessionLineage): T {
  if (lineage.parentNativeSessionId)
    transcript.parentNativeSessionId = lineage.parentNativeSessionId;
  if (lineage.inputOrigin) transcript.inputOrigin = lineage.inputOrigin;
  if (transcript.inputOrigin === 'agent' || transcript.parentNativeSessionId) {
    for (const message of transcript.messages)
      if (message.role === 'user') message.origin = 'agent';
    for (const event of transcript.events ?? [])
      if (event.type === 'user_text') event.origin = 'agent';
  }
  return transcript;
}
