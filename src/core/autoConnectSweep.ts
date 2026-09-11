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
 *   - when the binary version OR managed-instruction revision changes, already-wired
 *     tools are refreshed once (idempotent merge). The independent revision lets an
 *     instruction-only fix reach existing installs without relying on a semver bump;
 *   - refresh generations are tracked per tool, so a temporarily unavailable tool
 *     catches up when it returns without making available tools refresh every session;
 *   - a tool the user explicitly disconnects is excluded from both connect and refresh
 *     sweeps until they explicitly reconnect it.
 *
 * Runs from the session-start hook (which connected tools fire regularly) and from the
 * first-run bootstrap. Gated on the same opt-in (`autoInit`) that `setup` turns on, so
 * nothing is written before the student has consented. Entirely best-effort: every step
 * is wrapped so a failure can never disrupt the host session.
 */
import { type ConnectPlugin, connectPlugins } from '../plugins/registry.ts';
import {
  autoInitEnabled,
  readGlobalConfig,
  toolCaptureGloballyDisabled,
  writeGlobalConfig,
} from './globalConfig.ts';
import { MANAGED_INSTRUCTION_REVISION, SHOWTAIL_VERSION } from './version.ts';

export interface SweepConnectResult {
  tool: string;
  label: string;
  hooks: boolean;
}

export interface SweepIssue {
  tool: string;
  label: string;
  operation: 'connect' | 'refresh';
  /** A null result is retryable/pending; a thrown error is an explicit failure. */
  state: 'pending' | 'failed';
  reason?: string;
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
  /** Retryable integrations that could not be completed on this pass. */
  pending: SweepIssue[];
  /** Integrations whose connect/refresh operation threw. */
  failed: SweepIssue[];
}

const EMPTY: SweepResult = { connected: [], refreshed: [], pending: [], failed: [] };
const CURRENT_INTEGRATION_GENERATION = `${SHOWTAIL_VERSION}:${MANAGED_INSTRUCTION_REVISION}`;

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wire up any auto-connect-capable plugin that isn't already handled (see module
 * docstring), refreshing already-wired tools when the binary version or managed
 * instruction revision moved. Returns the tools newly connected and the tools refreshed,
 * so the caller can surface a notice.
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
  const cfg = readGlobalConfig();
  const integrationDisabled = (tool: string): boolean => {
    const current = readGlobalConfig();
    return (
      current.autoConnectDisabledTools?.includes(tool) === true ||
      toolCaptureGloballyDisabled(tool)
    );
  };
  const plugins = pluginList.filter(
    (plugin) => plugin.connect.autoConnect && !integrationDisabled(plugin.cliName),
  );
  const handled = new Set(cfg.autoConnectedTools ?? []);
  const legacyHandled = new Set(handled);
  const legacyGenerationCurrent =
    cfg.wiringVersion === SHOWTAIL_VERSION &&
    cfg.managedInstructionRevision === MANAGED_INSTRUCTION_REVISION;
  const hadGenerationMap = cfg.toolIntegrationGenerations !== undefined;
  const generations = { ...(cfg.toolIntegrationGenerations ?? {}) };

  // A missing map is a legacy config: its global stamps remain authoritative until
  // the first per-tool update is persisted. Once a map exists, a missing entry must
  // stay stale so an unavailable tool can catch up when detection returns.
  const generationIsCurrent = (tool: string): boolean => {
    const generation = generations[tool];
    if (generation !== undefined) return generation === CURRENT_INTEGRATION_GENERATION;
    return !hadGenerationMap && legacyGenerationCurrent && legacyHandled.has(tool);
  };

  // Fast path: every plugin is handled and each integration is current.
  if (
    legacyGenerationCurrent &&
    plugins.every(
      (plugin) => handled.has(plugin.cliName) && generationIsCurrent(plugin.cliName),
    )
  ) {
    return EMPTY;
  }

  const connected: SweepConnectResult[] = [];
  const refreshed: string[] = [];
  const pending: SweepIssue[] = [];
  const failed: SweepIssue[] = [];
  let changed = false;
  let generationsChanged = false;

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
    // A disconnect can race a sweep that started in another process. Re-read the
    // durable consent state after detection and again around every write-producing
    // install so stale sweeps cannot knowingly restore an opted-out integration.
    if (integrationDisabled(plugin.cliName)) continue;

    if (handled.has(plugin.cliName)) {
      // Already wired. On a version bump, refresh an eligible tool's hooks to the
      // current format (idempotent merge) — this is how a fix in a newer Showtail
      // reaches already-installed hooks, carried by whatever runs this sweep.
      if (!generationIsCurrent(plugin.cliName) && eligible) {
        try {
          if (integrationDisabled(plugin.cliName)) continue;
          const result = plugin.connect.autoConnect?.(cwd);
          if (integrationDisabled(plugin.cliName)) continue;
          if (!result) {
            pending.push({
              tool: plugin.cliName,
              label: plugin.label,
              operation: 'refresh',
              state: 'pending',
            });
            continue;
          }
          refreshed.push(plugin.cliName);
          generations[plugin.cliName] = CURRENT_INTEGRATION_GENERATION;
          generationsChanged = true;
        } catch (error) {
          failed.push({
            tool: plugin.cliName,
            label: plugin.label,
            operation: 'refresh',
            state: 'failed',
            reason: failureReason(error),
          });
          // Leave this tool stale so a later sweep retries the failed refresh.
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
      if (integrationDisabled(plugin.cliName)) continue;
      already = plugin.connect.status(cwd).connected;
    } catch {
      already = false;
    }
    if (integrationDisabled(plugin.cliName)) continue;

    handled.add(plugin.cliName);
    changed = true;
    if (already) {
      // Preserve a manually connected tool exactly as-is and treat that observed
      // integration as the current baseline, matching the legacy sweep behavior.
      generations[plugin.cliName] = CURRENT_INTEGRATION_GENERATION;
      generationsChanged = true;
      continue;
    }

    try {
      if (integrationDisabled(plugin.cliName)) continue;
      const result = plugin.connect.autoConnect?.(cwd);
      if (integrationDisabled(plugin.cliName)) continue;
      // `null` means the integration could not be completed (for example an
      // extension install failed). Leave it stale so a later sweep can retry.
      if (!result) {
        pending.push({
          tool: plugin.cliName,
          label: plugin.label,
          operation: 'connect',
          state: 'pending',
        });
        continue;
      }
      generations[plugin.cliName] = CURRENT_INTEGRATION_GENERATION;
      generationsChanged = true;
      connected.push({
        tool: plugin.cliName,
        label: plugin.label,
        hooks: result.hooks,
      });
    } catch (error) {
      failed.push({
        tool: plugin.cliName,
        label: plugin.label,
        operation: 'connect',
        state: 'failed',
        reason: failureReason(error),
      });
      // A connect failure must never break the session. It stays handled but stale,
      // so the normal refresh path can retry it on a later sweep.
    }
  }

  // If this is the first write of a per-tool map from a current legacy config,
  // carry forward only tools handled before this sweep. A newly handled connect
  // that failed must remain stale so the next sweep retries it.
  if (!hadGenerationMap && legacyGenerationCurrent && (changed || generationsChanged)) {
    for (const plugin of plugins) {
      if (
        legacyHandled.has(plugin.cliName) &&
        generations[plugin.cliName] === undefined
      ) {
        generations[plugin.cliName] = CURRENT_INTEGRATION_GENERATION;
        generationsChanged = true;
      }
    }
  }

  const allHandledIntegrationsCurrent = plugins
    .filter((plugin) => handled.has(plugin.cliName))
    .every((plugin) => generationIsCurrent(plugin.cliName));
  const stampLegacyGeneration = allHandledIntegrationsCurrent && !legacyGenerationCurrent;

  if (changed || generationsChanged || stampLegacyGeneration) {
    try {
      writeGlobalConfig({
        ...readGlobalConfig(),
        autoConnectedTools: [...handled],
        toolIntegrationGenerations: generations,
        ...(stampLegacyGeneration
          ? {
              wiringVersion: SHOWTAIL_VERSION,
              managedInstructionRevision: MANAGED_INSTRUCTION_REVISION,
            }
          : {}),
      });
    } catch {
      // Persisting the handled set is best-effort; worst case we retry next time.
    }
  }

  return { connected, refreshed, pending, failed };
}
