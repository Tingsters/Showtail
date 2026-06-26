/**
 * Opportunistic auto-connect of newly-installed tools.
 *
 * `autoConnect()` otherwise runs in exactly one place — `showtail setup`. That
 * leaves a chicken-and-egg: a connect plugin that ships in a later Showtail build
 * (or a tool the user installs after their last `setup`) is never wired up,
 * because its capture hooks can't fire until they're installed, and they're only
 * installed by `setup`/`connect`. So it can never bootstrap itself.
 *
 * This sweep closes that gap. It runs from the session-start hook (which OTHER,
 * already-connected tools fire regularly), and connects each detected tool **once
 * ever**. The set of tools it has already handled is persisted in the global
 * config, so:
 *   - a tool is auto-connected at most once, and
 *   - if the user later runs `showtail disconnect <tool>`, the sweep does NOT
 *     fight them and re-install it — it's already in the handled set.
 *
 * Gated on the same opt-in (`autoInit`) that `setup` turns on, so nothing is ever
 * written into `~/.copilot` / `.github` before the user has consented. Entirely
 * best-effort: every step is wrapped so a failure can never disrupt the host
 * session.
 */
import { type ConnectPlugin, connectPlugins } from '../plugins/registry.ts';
import { autoInitEnabled, readGlobalConfig, writeGlobalConfig } from './globalConfig.ts';

export interface SweepConnectResult {
  tool: string;
  label: string;
  hooks: boolean;
}

/**
 * Connect any installed-but-not-yet-handled connect plugin once. Returns the
 * tools newly connected this call (empty when there's nothing to do). Pure
 * side-effect-light when everything has already been handled. `pluginList` is
 * injectable so tests can drive the sweep with controlled fakes (default: the
 * real registry).
 */
export function autoConnectNewlyDetected(
  cwd: string = process.cwd(),
  pluginList: ConnectPlugin[] = connectPlugins(),
): SweepConnectResult[] {
  if (!autoInitEnabled()) return [];

  const plugins = pluginList.filter((p) => p.connect.autoConnect);
  const cfg = readGlobalConfig();
  const handled = new Set(cfg.autoConnectedTools ?? []);

  // Fast path: every auto-connectable plugin has already been considered.
  if (plugins.every((p) => handled.has(p.cliName))) return [];

  const connected: SweepConnectResult[] = [];
  let changed = false;

  for (const plugin of plugins) {
    if (handled.has(plugin.cliName)) continue;

    let detected = false;
    try {
      detected = plugin.connect.detect();
    } catch {
      detected = false;
    }
    // Not installed yet — leave it UNhandled so we reconsider it once it appears.
    if (!detected) continue;

    // Already connected (by `setup`, or the user themselves)? Mark it handled and
    // leave it exactly as-is — never rewrite a tool that's already wired up.
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

  if (changed) {
    try {
      writeGlobalConfig({ ...cfg, autoConnectedTools: [...handled] });
    } catch {
      // Persisting the handled set is best-effort; worst case we retry next time.
    }
  }

  return connected;
}
