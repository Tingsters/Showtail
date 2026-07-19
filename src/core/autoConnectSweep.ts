/**
 * Opportunistic auto-connect of AI tools — the "never miss a tool" engine.
 *
 * A tool's prompts and edits are only captured once Showtail's hooks live in that
 * tool's config dir. If we waited until a tool was *detected* to wire it, a tool a
 * student installs after Showtail (or uses before the next session-start sweep) would
 * silently capture nothing — the student would lose that work. So the automatic paths
 * run this in **connect-all** mode: they pre-seed the capture hooks for **every**
 * auto-connect-capable tool at user scope, installed or not, so a later install
 * captures from its very first session.
 *
 * Bookkeeping (persisted in the global config) keeps it safe and cheap:
 *   - each tool is wired at most once ever (tracked in `autoConnectedTools`), so a
 *     tool the student later `disconnect`s is never re-installed against their wishes;
 *   - a tool already connected (by `setup` or the user) is marked handled and left
 *     exactly as-is — never rewritten;
 *   - a newly *supported* tool shipped in a later Showtail build is unhandled, so it
 *     gets pre-wired the next time this runs;
 *   - when the running binary is newer than `wiringVersion`, already-wired tools have
 *     their hooks refreshed once to the current format (idempotent merge), so a
 *     student who never re-runs a Showtail command still gets hook updates.
 *
 * Runs from the session-start hook (which connected tools fire regularly) and from the
 * first-run bootstrap. Gated on the same opt-in (`autoInit`) that `setup` turns on, so
 * nothing is written before the student has consented. Entirely best-effort: every step
 * is wrapped so a failure can never disrupt the host session.
 */
import { type ConnectPlugin, connectPlugins } from '../plugins/registry.ts';
import { autoInitEnabled, readGlobalConfig, writeGlobalConfig } from './globalConfig.ts';
import { SHOWTAIL_VERSION } from './version.ts';

export interface SweepConnectResult {
  tool: string;
  label: string;
  hooks: boolean;
}

export interface SweepOptions {
  /**
   * Pre-seed the capture hooks for every auto-connect-capable tool, even ones not
   * currently installed — so a later install captures from session one. The automatic
   * paths (first-run bootstrap + the session-start sweep) pass this to guarantee no
   * tool is ever missed. When false, only installed (detected) tools are wired.
   */
  connectAll?: boolean;
}

/**
 * Wire up any auto-connect-capable plugin that isn't already handled (see module
 * docstring), refreshing already-wired tools when the binary version moved. Returns
 * the tools newly connected this call (empty when there's nothing to do), so the
 * caller can surface a privacy notice. `pluginList` is injectable so tests can drive
 * the sweep with controlled fakes (default: the real registry).
 */
export function autoConnectNewlyDetected(
  cwd: string = process.cwd(),
  pluginList: ConnectPlugin[] = connectPlugins(),
  options: SweepOptions = {},
): SweepConnectResult[] {
  if (!autoInitEnabled()) return [];

  const connectAll = options.connectAll ?? false;
  const plugins = pluginList.filter((p) => p.connect.autoConnect);
  const cfg = readGlobalConfig();
  const handled = new Set(cfg.autoConnectedTools ?? []);
  // Binary newer (or older) than what last wrote the hooks → refresh their format.
  const refresh = cfg.wiringVersion !== SHOWTAIL_VERSION;

  // Fast path: every plugin already handled and the wiring is current.
  if (!refresh && plugins.every((p) => handled.has(p.cliName))) return [];

  const connected: SweepConnectResult[] = [];
  let changed = false;

  for (const plugin of plugins) {
    let detected = false;
    try {
      detected = plugin.connect.detect();
    } catch {
      detected = false;
    }
    // Pre-wire mode considers every tool; detected-only mode only installed ones.
    const eligible = connectAll || detected;

    if (handled.has(plugin.cliName)) {
      // Already wired. On a version bump, refresh an eligible tool's hooks to the
      // current format (idempotent merge; not announced as a fresh connect).
      if (refresh && eligible) {
        try {
          plugin.connect.autoConnect?.(cwd);
        } catch {
          /* refresh is best-effort */
        }
      }
      continue;
    }

    // Not yet handled and not eligible (uninstalled, and we're not pre-wiring) —
    // leave it UNhandled so we reconsider it once it appears.
    if (!eligible) continue;

    // Already connected (by `setup`, or the user)? Mark it handled and leave it
    // exactly as-is — never rewrite a tool that's already wired up.
    let already = false;
    try {
      already = plugin.connect.status(cwd).connected;
    } catch {
      already = false;
    }

    handled.add(plugin.cliName);
    changed = true;
    if (already) continue;

    try {
      const result = plugin.connect.autoConnect?.(cwd);
      if (result) {
        connected.push({
          tool: plugin.cliName,
          label: plugin.label,
          hooks: result.hooks,
        });
      }
    } catch {
      // A connect failure must never break the session; it stays handled so we
      // don't retry-loop every session-start.
    }
  }

  if (changed || refresh) {
    try {
      writeGlobalConfig({
        ...readGlobalConfig(),
        autoConnectedTools: [...handled],
        wiringVersion: SHOWTAIL_VERSION,
      });
    } catch {
      // Persisting the handled set is best-effort; worst case we retry next time.
    }
  }

  return connected;
}
