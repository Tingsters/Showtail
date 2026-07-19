import {
  autoInitEnabled,
  readGlobalConfig,
  writeGlobalConfig,
} from '../core/globalConfig.ts';
import { emitJson } from '../core/output.ts';
import { connectPlugins } from '../plugins/registry.ts';
import {
  autoConnectNewlyDetected,
  type SweepConnectResult,
} from '../core/autoConnectSweep.ts';

export interface SetupOptions {
  /** Run without any prompts (setup is non-interactive regardless; kept for symmetry). */
  yes?: boolean;
  /** Turn automatic tracking back off (leaves connected tools in place). */
  off?: boolean;
  /**
   * The automatic install/first-run bootstrap (invoked by the installers): turn
   * tracking on, connect installed tools, and pre-seed the tools confirmed safe to wire
   * before install (`prewireSafe`) so a student never loses work to one they install
   * later. Once only. See {@link ensureFirstRunSetup}.
   */
  firstRun?: boolean;
  json?: boolean;
  cwd?: string;
}

interface ConnectedTool {
  tool: string;
  label: string;
  scope: 'user';
  hooks: boolean;
}

/**
 * Flip the master switch: automatic tracking ON, stamped with the completion time
 * and the write-once capture watermark (the "started using Showtail" moment, which
 * auto-backfill never crosses backwards). Shared by the interactive `setup` command
 * and the first-run bootstrap. Returns the completion timestamp.
 */
function markAutoTrackingOn(): string {
  const setupCompletedAt = new Date().toISOString();
  const existing = readGlobalConfig();
  writeGlobalConfig({
    ...existing,
    version: 1,
    autoInit: true,
    setupCompletedAt,
    captureSince: existing.captureSince ?? setupCompletedAt,
  });
  return setupCompletedAt;
}

export interface FirstRunResult {
  /** True if this call performed the one-time bootstrap (false if already set up). */
  ran: boolean;
  /** Tools whose capture hooks were wired this call. */
  connected: SweepConnectResult[];
  /** Guidance for tools that can't be auto-connected (e.g. Copilot's VS Code extension). */
  guidance: string[];
}

/**
 * The one-time, no-command bootstrap that makes Showtail "just work" on install:
 * turn automatic tracking on, connect installed tools, and pre-seed the capture hooks
 * for the tools confirmed safe to wire before install (`prewireSafe`) so one the student
 * adds later never loses work. Idempotent and once-only:
 * a no-op if setup has ever completed, which also means it never re-enables tracking a
 * student turned off with `showtail setup --off` (that path stamps `setupCompletedAt`
 * too). Wrapped so it can never disrupt a command or a host session.
 */
export function ensureFirstRunSetup(options: { cwd?: string } = {}): FirstRunResult {
  const noop: FirstRunResult = { ran: false, connected: [], guidance: [] };
  try {
    // Escape hatch (also how the test suite keeps CLI runs hermetic): never bootstrap
    // when this is set. Lets an environment opt out of auto-on entirely.
    if (process.env.SHOWTAIL_DISABLE_FIRST_RUN) return noop;

    // Only bootstrap when tracking has never been decided. `autoInit` set either way
    // (`setup` turned it on, `setup --off` turned it off) or a completion stamp means
    // a choice was already made — never re-run, and never re-enable an explicit `--off`.
    const cfg = readGlobalConfig();
    if (cfg.autoInit !== undefined || cfg.setupCompletedAt) return noop;

    markAutoTrackingOn();
    // Connect installed tools + pre-seed the ones confirmed safe to wire before install
    // (see `prewireSafe`); the rest are caught by the sweep once they're detected.
    const connected = autoConnectNewlyDetected(options.cwd, undefined, {
      connectAll: true,
    }).connected;
    // Tools that can't be auto-connected but ARE present (Copilot's VS Code extension)
    // contribute guidance so they're not silently absent.
    const guidance: string[] = [];
    for (const plugin of connectPlugins()) {
      if (plugin.connect.autoConnect || !plugin.connect.setupGuidance) continue;
      let detected = false;
      try {
        detected = plugin.connect.detect();
      } catch {
        detected = false;
      }
      if (detected) guidance.push(...plugin.connect.setupGuidance);
    }
    return { ran: true, connected, guidance };
  } catch {
    return noop; // the bootstrap must never break a command or a hook
  }
}

/**
 * The human privacy/readiness notice shown after an auto-connect — at install, on the
 * first-run bootstrap, or when the background sweep wires a newly-supported tool. Framed
 * as readiness (a pre-wired tool may not be installed yet, so we don't claim "connected
 * X"). Returns the lines to print/surface.
 */
export function autoTrackingNotice(
  connected: SweepConnectResult[],
  guidance: string[] = [],
): string[] {
  const lines: string[] = [
    'Showtail is on — your work with AI is captured automatically from now on.',
  ];
  if (connected.length > 0) {
    lines.push(`  Ready to capture from: ${connected.map((c) => c.label).join(', ')}.`);
  }
  for (const g of guidance) lines.push(`  ${g}`);
  lines.push('  Everything stays local under .showtail/ — nothing leaves your machine,');
  lines.push('  and secrets/personal data are scrubbed before storage.');
  lines.push('  Turn it off anytime with `showtail setup --off`.');
  return lines;
}

/**
 * One-time guided setup: connect every installed AI tool at user scope (so it
 * works in all projects) and turn on automatic tracking. After this, a student
 * never has to run a Showtail command again — trails create themselves on first
 * AI use and sessions close themselves. Idempotent: safe to re-run.
 *
 * Detection and connection are driven entirely by the plugin registry; this
 * command names no tool. Each connect plugin reports whether it's installed
 * (`detect`) and either auto-connects at user scope (`autoConnect`) or supplies
 * guidance to print (`setupGuidance`, e.g. Copilot's VS Code extension).
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  if (options.off) {
    writeGlobalConfig({ ...readGlobalConfig(), version: 1, autoInit: false });
    if (options.json) {
      emitJson({ autoInit: false });
      return;
    }
    console.log('Automatic tracking is now OFF.');
    console.log('Existing trails are untouched; connected tools stay connected.');
    console.log('Turn it back on anytime with `showtail setup`.');
    return;
  }

  // The installers call `showtail setup --first-run`: the once-only, pre-wire-every-tool
  // bootstrap (so a tool installed later never loses work). A no-op if tracking was
  // already decided, so re-running an installer never fights a `--off`/`disconnect`.
  if (options.firstRun) {
    const result = ensureFirstRunSetup({ cwd: options.cwd });
    // If already set up (e.g. an installer re-run on UPGRADE), still run the sweep so a
    // newer Showtail re-wires already-connected tools to the current hook format — this
    // is how an integration fix reaches an existing user's on-disk hooks without relying
    // on the tool's own (possibly broken) hooks to fire. Best-effort.
    let refreshed: string[] = [];
    let lateConnected = result.connected;
    if (!result.ran && autoInitEnabled()) {
      try {
        const sweep = autoConnectNewlyDetected(options.cwd, undefined, {
          connectAll: true,
        });
        refreshed = sweep.refreshed;
        lateConnected = sweep.connected;
      } catch {
        /* refresh is best-effort */
      }
    }
    if (options.json) {
      emitJson({
        ran: result.ran,
        connected: result.ran ? result.connected : lateConnected,
        refreshed,
        autoInit: readGlobalConfig().autoInit ?? false,
      });
      return;
    }
    if (result.ran) {
      for (const line of autoTrackingNotice(result.connected, result.guidance)) {
        console.log(line);
      }
    } else if (refreshed.length > 0 || lateConnected.length > 0) {
      if (lateConnected.length > 0) {
        for (const line of autoTrackingNotice(lateConnected)) console.log(line);
      }
      if (refreshed.length > 0) {
        console.log(
          `Updated Showtail's capture integration for: ${refreshed.join(', ')}.`,
        );
      }
    } else {
      console.log('Showtail automatic tracking is already set up and current.');
    }
    return;
  }

  const detected = connectPlugins().map((plugin) => ({
    plugin,
    installed: plugin.connect.detect(),
  }));

  const connected: ConnectedTool[] = [];
  const guidance: string[] = [];
  for (const { plugin, installed } of detected) {
    if (!installed) continue;
    const result = plugin.connect.autoConnect?.(options.cwd);
    if (result) {
      connected.push({
        tool: plugin.cliName,
        label: plugin.label,
        scope: 'user',
        hooks: result.hooks,
      });
    } else if (plugin.connect.setupGuidance) {
      guidance.push(...plugin.connect.setupGuidance);
    }
  }

  // The single switch that turns automatic tracking on everywhere.
  const setupCompletedAt = markAutoTrackingOn();

  if (options.json) {
    emitJson({
      detected: detected.map((d) => ({ tool: d.plugin.cliName, installed: d.installed })),
      connected,
      autoInit: true,
      setupCompletedAt,
    });
    return;
  }

  console.log('Showtail setup');
  console.log('');
  if (connected.length > 0) {
    console.log('Connected your AI tools (for all projects):');
    for (const c of connected) {
      console.log(`  ${c.label} · hooks ${c.hooks ? 'on' : 'off'}`);
    }
  } else {
    const names = connectPlugins()
      .filter((p) => p.connect.autoConnect)
      .map((p) => p.cliName);
    const example = names[0] ?? '<tool>';
    console.log('No AI tools were detected to connect automatically.');
    console.log(`  Connect one anytime with \`showtail connect ${example}\`.`);
  }
  if (guidance.length > 0) {
    console.log('');
    for (const line of guidance) console.log(line);
  }
  console.log('');
  console.log('Automatic tracking is ON. From now on, just work:');
  console.log(
    '  • The first time you use AI in a project, Showtail starts a trail for you.',
  );
  console.log('  • Sessions open and close around your tasks — no commands to run.');
  console.log('  • Ask your AI to "generate a Showtail report" whenever you want one.');
  console.log('');
  console.log('Privacy: everything stays local under .showtail/. Secrets and personal');
  console.log('data are scrubbed before storage, and nothing ever leaves your machine.');
  console.log(
    'Turn automatic tracking off anytime with `showtail setup --off`' +
      ' or `showtail disconnect <tool>`.',
  );
}
