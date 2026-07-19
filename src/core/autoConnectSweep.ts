/**
 * Opportunistic auto-connect of AI tools — the "never miss a tool" engine.
 *
 * A tool's prompts and edits are only captured once Showtail's hooks live in that
 * tool's config dir. To catch a tool a student installs *after* Showtail, the automatic
 * paths run this in **connect-all** mode. But pre-seeding a tool's config before the
 * tool exists only works if that tool honors a config it didn't create — so connect-all
 * pre-seeds an *undetected* tool ONLY when its plugin is flagged `prewireSafe` (i.e.
 * empirically confirmed; today just Claude Code). Every other tool is connected the
 * moment it's actually **detected** (installed) — no pre-existing-config assumption.
 *
 * Bookkeeping (persisted in the global config) keeps it safe and cheap:
 *   - each tool is wired at most once ever (tracked in `autoConnectedTools`), so a
 *     tool the student later `disconnect`s is never re-installed against their wishes;
 *   - a tool already connected (by `setup` or the user) is marked handled and left
 *     exactly as-is — never rewritten;
 *   - a not-yet-installed, non-`prewireSafe` tool is left UNhandled, so it's connected
 *     the first time it's detected (also covers newly *supported* tools shipped later);
 *   - when the running binary is newer than `wiringVersion`, already-wired tools have
 *     their hooks refreshed once to the current format (idempotent merge) — this is how
 *     a fix in a newer Showtail reaches already-installed hooks, and it runs from any
 *     carrier that calls this (the CLI, the installer, or a still-working tool hook),
 *     not only the tool's own hook (which the tool update may have broken).
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
   * Pre-seed the capture hooks for tools that aren't installed yet, so a later install
   * captures from session one. The automatic paths (first-run bootstrap + the
   * session-start sweep) pass this. Pre-seeding an *undetected* tool happens ONLY for
   * plugins flagged `connect.prewireSafe` — tools empirically confirmed to honor a
   * config written before they existed. Every other tool is still connected the moment
   * it's actually detected (installed), which needs no pre-existing-config assumption.
   */
  connectAll?: boolean;
}

export interface SweepResult {
  /** Tools whose capture hooks were freshly installed this call. */
  connected: SweepConnectResult[];
  /** cliNames of already-wired tools whose hooks were refreshed to the current version. */
  refreshed: string[];
}

const EMPTY: SweepResult = { connected: [], refreshed: [] };

/**
 * Wire up any auto-connect-capable plugin that isn't already handled (see module
 * docstring), refreshing already-wired tools when the binary version moved. Returns the
 * tools newly connected and the tools refreshed, so the caller can surface a notice.
 * `pluginList` is injectable so tests can drive the sweep with controlled fakes
 * (default: the real registry).
 */
export function autoConnectNewlyDetected(
  cwd: string = process.cwd(),
  pluginList: ConnectPlugin[] = connectPlugins(),
  options: SweepOptions = {},
): SweepResult {
  if (!autoInitEnabled()) return EMPTY;

  const connectAll = options.connectAll ?? false;
  const plugins = pluginList.filter((p) => p.connect.autoConnect);
  const cfg = readGlobalConfig();
  const handled = new Set(cfg.autoConnectedTools ?? []);
  // Binary newer (or older) than what last wrote the hooks → refresh their format.
  const refresh = cfg.wiringVersion !== SHOWTAIL_VERSION;

  // Fast path: every plugin already handled and the wiring is current.
  if (!refresh && plugins.every((p) => handled.has(p.cliName))) return EMPTY;

  const connected: SweepConnectResult[] = [];
  const refreshed: string[] = [];
  let changed = false;

  for (const plugin of plugins) {
    let detected = false;
    try {
      detected = plugin.connect.detect();
    } catch {
      detected = false;
    }
    // Detected tools are always eligible; an UNdetected tool is pre-seeded only when
    // we're pre-wiring AND the plugin is confirmed safe to write before it's installed.
    const eligible = detected || (connectAll && plugin.connect.prewireSafe === true);

    if (handled.has(plugin.cliName)) {
      // Already wired. On a version bump, refresh an eligible tool's hooks to the
      // current format (idempotent merge) — this is how a fix in a newer Showtail
      // reaches already-installed hooks, carried by whatever runs this sweep.
      if (refresh && eligible) {
        try {
          plugin.connect.autoConnect?.(cwd);
          refreshed.push(plugin.cliName);
        } catch {
          /* refresh is best-effort */
        }
      }
      continue;
    }

    // Not yet handled and not eligible (uninstalled, and not a pre-wire-safe tool) —
    // leave it UNhandled so we reconsider (and connect) it once it appears.
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

  if (changed || refreshed.length > 0 || refresh) {
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

  return { connected, refreshed };
}
