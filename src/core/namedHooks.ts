/**
 * Merge/unmerge of Showtail's auto-capture hooks into a host's *named-hooks*
 * config — the shape Google's Antigravity IDE language server loads from
 * `~/.gemini/config/hooks.json`:
 *
 *   { "<name>": { "enabled": true, "<Event>": [ { matcher?, hooks: [...] } ] } }
 *
 * This differs from the `{ hooks: { <Event>: [...] } }` map shape used by Claude
 * Code / Codex / the Antigravity *CLI* (see {@link hookMerge.ts}). The IDE keys
 * each hook bundle by a top-level *name* with an `enabled` flag, so a single file
 * can carry several independent named bundles. The Antigravity IDE owns
 * `showtail-ide` and the Antigravity CLI owns `showtail-cli` (both may share this
 * file); each merges/unmerges only its own key and never touches the others.
 *
 * Every command we install contains {@link HOOK_MARKER}, so our bundle is
 * recognized by its commands even if the name were reused.
 */
import { HOOK_MARKER, type HookEvents, type HookGroup } from './hookMerge.ts';

/** A named hook bundle: an `enabled` flag plus event → matcher-group arrays. */
export type NamedHookBundle = { enabled?: boolean } & Record<string, HookGroup[]>;

/** Does this named bundle contain one of our auto-capture commands? */
function bundleIsOurs(bundle: unknown): boolean {
  if (!bundle || typeof bundle !== 'object') return false;
  return Object.entries(bundle as Record<string, unknown>).some(([key, groups]) => {
    if (key === 'enabled' || !Array.isArray(groups)) return false;
    return (groups as HookGroup[]).some((g) =>
      g?.hooks?.some(
        (h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER),
      ),
    );
  });
}

/**
 * Merge our events into `config` under the named bundle `name`, idempotently and
 * without disturbing any other named bundle. Our bundle is always rewritten whole
 * (it's wholly ours), with `enabled: true` so the host honors it. Returns the
 * updated config.
 */
export function mergeNamedHooks(
  config: Record<string, unknown>,
  name: string,
  events: HookEvents,
): Record<string, unknown> {
  const next = { ...config };
  next[name] = { enabled: true, ...events };
  return next;
}

/**
 * Remove our named bundle from `config` (only if it's actually ours — recognized
 * by the {@link HOOK_MARKER} in its commands, so we never delete a user's bundle
 * that happens to share the name). Returns the updated config.
 */
export function unmergeNamedHooks(
  config: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  if (!bundleIsOurs(config[name])) return { ...config };
  const next = { ...config };
  delete next[name];
  return next;
}

/** Does `config` contain our auto-capture hooks under the named bundle `name`? */
export function hasNamedHooks(config: Record<string, unknown>, name: string): boolean {
  return bundleIsOurs(config[name]);
}
