/**
 * Shared, idempotent merge/unmerge of Showtail's auto-capture hooks into a
 * host's hook config. Used for both Claude Code (`.claude/settings.json`) and
 * Codex (`.codex/hooks.json`), which share the same array-of-groups shape.
 *
 * Every Showtail hook command contains {@link HOOK_MARKER}, so we can recognize
 * and cleanly remove only our own entries without clobbering the user's hooks.
 */

/** A single hook command entry. */
export interface HookCommand {
  type: 'command';
  command: string;
  /** Per-command timeout in seconds. Used by hosts that support it (Antigravity IDE). */
  timeout?: number;
}

/** A matcher group: optional `matcher` plus the commands to run. */
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** Map of hook event name -> matcher groups. */
export type HookEvents = Record<string, HookGroup[]>;

/** Marker used to recognize (and cleanly remove) the hooks we install. */
export const HOOK_MARKER = 'showtail hook';

/** Is this matcher group one that we installed? */
export function isOurGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER),
  );
}

/**
 * Merge `events` into a hooks object, idempotently and without clobbering the
 * user's existing hooks. Returns the updated object.
 */
export function mergeHookEvents(
  settings: Record<string, unknown>,
  events: HookEvents,
): Record<string, unknown> {
  const next = { ...settings };
  const hooks: HookEvents =
    next.hooks && typeof next.hooks === 'object' ? { ...(next.hooks as HookEvents) } : {};

  for (const [event, groups] of Object.entries(events)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event]! : [];
    // Drop any prior Showtail entries so re-running install never duplicates.
    const preserved = existing.filter((g) => !isOurGroup(g));
    hooks[event] = [...preserved, ...groups];
  }

  next.hooks = hooks;
  return next;
}

/** Remove only our hooks from a hooks object. Returns it updated. */
export function unmergeHookEvents(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings };
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const hooks: HookEvents = { ...(next.hooks as HookEvents) };

  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
    const kept = groups.filter((g) => !isOurGroup(g));
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return next;
}

/** Does this hooks object contain our auto-capture hooks? */
export function hasOurHooks(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as HookEvents | undefined;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks).some(
    (groups) => Array.isArray(groups) && groups.some(isOurGroup),
  );
}
