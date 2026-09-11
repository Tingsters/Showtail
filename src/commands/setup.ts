import {
  autoInitEnabled,
  detectHistoryUpgrade,
  enableToolAutoConnect,
  enableToolCapture,
  readGlobalConfig,
  writeGlobalConfig,
} from '../core/globalConfig.ts';
import { HISTORY_GENERATION } from '../core/version.ts';
import { maybeOfferHistoryMigration } from './upgrade.ts';
import { emitJson } from '../core/output.ts';
import { connectPlugins } from '../plugins/registry.ts';
import {
  autoConnectNewlyDetected,
  type SweepConnectResult,
  type SweepIssue,
} from '../core/autoConnectSweep.ts';
import {
  ensureMachineId,
  readMachineIdentity,
  resolveIdentity,
  slugifyEmail,
  writeMachineIdentity,
} from '../core/identity.ts';

/**
 * Seed the machine identity from gh/git/env at INSTALL time (the installer has network,
 * so gh is fine here — unlike the hook path). This means the first hook attributes work
 * to the student's REAL identity, skipping the provisional-placeholder phase for anyone
 * with git/gh/EMAIL set. Best-effort; never overwrites an existing cached identity.
 */
async function seedRealIdentityAtInstall(cwd: string): Promise<void> {
  try {
    if (readMachineIdentity()) return; // already known (real or provisional) — leave it
    const id = await resolveIdentity({ cwd, allowGh: true, allowPrompt: false });
    if (!id) return; // no real identity yet; the provisional net will cover first use
    writeMachineIdentity({
      ...id,
      slug: slugifyEmail(id.email),
      machineId: ensureMachineId(),
    });
  } catch {
    /* best-effort — the provisional fallback + auto-link still cover it */
  }
}

export interface SetupOptions {
  /** Run without any prompts (setup is non-interactive regardless; kept for symmetry). */
  yes?: boolean;
  /** Stop hook-driven creation of new project trails (leaves connected tools in place). */
  off?: boolean;
  /**
   * The automatic install/first-run bootstrap (invoked by the installers): turn
   * tracking on, connect installed tools, and pre-seed integrations confirmed safe to
   * wire before their host exists (`prewireSafe`). Once only. See
   * {@link ensureFirstRunSetup}.
   */
  firstRun?: boolean;
  json?: boolean;
  cwd?: string;
  /** Installer-only: present the one-time history migration offer when upgrading. */
  offerMigration?: boolean;
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
    historyGeneration: HISTORY_GENERATION,
  });
  return setupCompletedAt;
}

export interface FirstRunResult {
  /** True if this call performed the one-time bootstrap (false if already set up). */
  ran: boolean;
  /** Tools whose capture hooks were wired this call. */
  connected: SweepConnectResult[];
  /** Retryable integrations that did not complete during bootstrap. */
  pending: SweepIssue[];
  /** Integrations whose bootstrap operation failed. */
  failed: SweepIssue[];
  /** Guidance for tools that can't be auto-connected (e.g. Copilot's VS Code extension). */
  guidance: string[];
}

/**
 * The one-time, no-command bootstrap that makes Showtail "just work" on install:
 * turn automatic tracking on, connect installed tools, and pre-seed capture hooks for
 * integrations confirmed safe to wire before their host exists (`prewireSafe`).
 * Idempotent and once-only:
 * a no-op if setup has ever completed, which also means it never re-enables tracking a
 * student turned off with `showtail setup --off` (that path stamps `setupCompletedAt`
 * too). Wrapped so it can never disrupt a command or a host session.
 */
export function ensureFirstRunSetup(options: { cwd?: string } = {}): FirstRunResult {
  const noop: FirstRunResult = {
    ran: false,
    connected: [],
    pending: [],
    failed: [],
    guidance: [],
  };
  try {
    // Escape hatch (also how the test suite keeps CLI runs hermetic): never bootstrap
    // when this is set. Lets an environment opt out of auto-on entirely.
    if (process.env.SHOWTAIL_DISABLE_FIRST_RUN) return noop;
    detectHistoryUpgrade(HISTORY_GENERATION);

    // Only bootstrap when tracking has never been decided. `autoInit` set either way
    // (`setup` turned it on, `setup --off` turned it off) or a completion stamp means
    // a choice was already made — never re-run, and never re-enable an explicit `--off`.
    const cfg = readGlobalConfig();
    if (cfg.autoInit !== undefined || cfg.setupCompletedAt) return noop;

    markAutoTrackingOn();
    // Connect installed tools + pre-seed the ones confirmed safe to wire before install
    // (see `prewireSafe`); the rest are caught by the sweep once they're detected.
    const sweep = autoConnectNewlyDetected(options.cwd, undefined, {
      connectAll: true,
    });
    // Tools that can't be auto-connected but ARE present (Copilot's VS Code extension)
    // contribute guidance so they're not silently absent.
    const guidance: string[] = [];
    for (const plugin of connectPlugins()) {
      if (!plugin.connect.setupGuidance) continue;
      let detected = false;
      try {
        detected = plugin.connect.detect();
      } catch {
        detected = false;
      }
      const needsGuidance =
        !plugin.connect.autoConnect ||
        sweep.pending.some((issue) => issue.tool === plugin.cliName) ||
        sweep.failed.some((issue) => issue.tool === plugin.cliName);
      if (detected && needsGuidance) guidance.push(...plugin.connect.setupGuidance);
    }
    return {
      ran: true,
      connected: sweep.connected,
      pending: sweep.pending,
      failed: sweep.failed,
      guidance,
    };
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
  pending: SweepIssue[] = [],
  failed: SweepIssue[] = [],
): string[] {
  const incomplete = pending.length > 0 || failed.length > 0 || guidance.length > 0;
  const lines: string[] = [
    incomplete
      ? 'Showtail project tracking is on, but automatic AI capture still needs attention.'
      : 'Showtail is on — your work with AI is captured automatically from now on.',
  ];
  if (connected.length > 0) {
    lines.push(`  Ready to capture from: ${connected.map((c) => c.label).join(', ')}.`);
  }
  for (const issue of [...pending, ...failed]) {
    const verb = issue.operation === 'refresh' ? 'refresh' : 'connection';
    lines.push(
      `  ${issue.label}: ${verb} ${issue.state}; run \`showtail connect ${issue.tool}\` to retry.`,
    );
  }
  for (const g of guidance) lines.push(`  ${g}`);
  lines.push('  Capture stays local: resolved work is projected into project .showtail/');
  lines.push(
    '  folders; unresolved or multi-project work waits in the local inbox/ledger.',
  );
  lines.push('  Secrets and personal data are scrubbed before storage.');
  lines.push(
    '  Stop creating new project trails with `showtail setup --off`; stop one tool with',
  );
  lines.push('  `showtail disconnect <tool>`.');
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
  detectHistoryUpgrade(HISTORY_GENERATION);
  if (options.off) {
    writeGlobalConfig({ ...readGlobalConfig(), version: 1, autoInit: false });
    if (options.json) {
      emitJson({ autoInit: false });
      return;
    }
    console.log('Automatic creation of new project trails is now OFF.');
    console.log('Connected tools still capture in existing trails.');
    console.log('Use `showtail disconnect <tool>` to stop a tool, or `showtail setup`');
    console.log('to resume automatic project creation.');
    return;
  }

  // The installers call `showtail setup --first-run`: the once-only bootstrap that
  // connects detected tools and pre-wires only integrations marked `prewireSafe`.
  // A no-op if tracking was already decided, so re-running an installer never fights
  // a `--off`/`disconnect`.
  if (options.firstRun) {
    // Honor the opt-out BEFORE seeding anything. `ensureFirstRunSetup` checks
    // SHOWTAIL_DISABLE_FIRST_RUN itself, but it is called below — so seeding here first
    // wrote a machine identity into the home of an environment that had explicitly asked
    // Showtail to keep its hands off. That matters wherever `install.sh` runs somewhere
    // disposable and unowned: a CI runner (the GitHub Action hit exactly this), a Docker
    // layer, a classroom image being baked. The variable has to mean what its name says.
    if (process.env.SHOWTAIL_DISABLE_FIRST_RUN) {
      // Stay quiet on the human path (the installer prints its own summary), but keep
      // the `--json` contract: a consumer must never get empty stdout.
      if (options.json) emitJson({ firstRun: false, disabled: true });
      return;
    }

    // Layer 1: capture the student's real identity now (install has network for gh), so
    // most students never hit the provisional placeholder.
    await seedRealIdentityAtInstall(options.cwd ?? process.cwd());
    const result = ensureFirstRunSetup({ cwd: options.cwd });
    // If already set up (e.g. an installer re-run on UPGRADE), still run the sweep so a
    // newer Showtail re-wires already-connected tools to the current hook format — this
    // is how an integration fix reaches an existing user's on-disk hooks without relying
    // on the tool's own (possibly broken) hooks to fire. Best-effort.
    let refreshed: string[] = [];
    let lateConnected = result.connected;
    let pending = result.pending;
    let failed = result.failed;
    if (!result.ran && autoInitEnabled()) {
      try {
        const sweep = autoConnectNewlyDetected(options.cwd, undefined, {
          connectAll: true,
        });
        refreshed = sweep.refreshed;
        lateConnected = sweep.connected;
        pending = sweep.pending;
        failed = sweep.failed;
      } catch {
        /* refresh is best-effort */
      }
    }
    if (options.json) {
      emitJson({
        ran: result.ran,
        connected: result.ran ? result.connected : lateConnected,
        refreshed,
        pending,
        failed,
        autoInit: readGlobalConfig().autoInit ?? false,
      });
      return;
    }
    if (result.ran) {
      for (const line of autoTrackingNotice(
        result.connected,
        result.guidance,
        result.pending,
        result.failed,
      )) {
        console.log(line);
      }
    } else if (
      refreshed.length > 0 ||
      lateConnected.length > 0 ||
      pending.length > 0 ||
      failed.length > 0
    ) {
      if (lateConnected.length > 0) {
        for (const line of autoTrackingNotice(lateConnected, [], pending, failed)) {
          console.log(line);
        }
      } else if (pending.length > 0 || failed.length > 0) {
        for (const line of autoTrackingNotice([], [], pending, failed)) {
          console.log(line);
        }
      }
      if (refreshed.length > 0) {
        console.log(
          `Updated Showtail's capture integration for: ${refreshed.join(', ')}.`,
        );
      }
    } else {
      console.log('Showtail automatic tracking is already set up and current.');
    }
    if (options.offerMigration) await maybeOfferHistoryMigration({ cwd: options.cwd });
    return;
  }

  const detected = connectPlugins().map((plugin) => {
    try {
      return { plugin, installed: plugin.connect.detect() };
    } catch {
      return { plugin, installed: false };
    }
  });

  const connected: ConnectedTool[] = [];
  const guidance: string[] = [];
  const pending: SweepIssue[] = [];
  const failed: SweepIssue[] = [];
  for (const { plugin, installed } of detected) {
    if (!installed) continue;
    try {
      const result = plugin.connect.autoConnect?.(options.cwd);
      if (result) {
        enableToolAutoConnect(plugin.cliName);
        // This is the explicit `showtail setup` path, not an automatic sweep:
        // a successful reconnect is consent to resume this tool's capture.
        enableToolCapture(plugin.cliName);
        connected.push({
          tool: plugin.cliName,
          label: plugin.label,
          scope: 'user',
          hooks: result.hooks,
        });
      } else if (plugin.connect.autoConnect) {
        pending.push({
          tool: plugin.cliName,
          label: plugin.label,
          operation: 'connect',
          state: 'pending',
        });
      }
    } catch (error) {
      failed.push({
        tool: plugin.cliName,
        label: plugin.label,
        operation: 'connect',
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      plugin.connect.setupGuidance &&
      (pending.some((issue) => issue.tool === plugin.cliName) ||
        failed.some((issue) => issue.tool === plugin.cliName) ||
        !plugin.connect.autoConnect)
    ) {
      guidance.push(...plugin.connect.setupGuidance);
    }
  }

  // The single switch that turns automatic tracking on everywhere.
  const setupCompletedAt = markAutoTrackingOn();

  if (options.json) {
    emitJson({
      detected: detected.map((d) => ({ tool: d.plugin.cliName, installed: d.installed })),
      connected,
      pending,
      failed,
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
      console.log(`  ${c.label} · automatic capture on`);
    }
  } else if (pending.length === 0 && failed.length === 0) {
    const names = connectPlugins()
      .filter((p) => p.connect.autoConnect)
      .map((p) => p.cliName);
    const example = names[0] ?? '<tool>';
    console.log('No AI tools were detected to connect automatically.');
    console.log(`  Connect one anytime with \`showtail connect ${example}\`.`);
  }
  for (const issue of [...pending, ...failed]) {
    const verb = issue.operation === 'refresh' ? 'refresh' : 'connection';
    console.log(
      `  ${issue.label}: ${verb} ${issue.state}; run \`showtail connect ${issue.tool}\` to retry.`,
    );
  }
  if (guidance.length > 0) {
    console.log('');
    for (const line of guidance) console.log(line);
  }
  console.log('');
  if (pending.length > 0 || failed.length > 0 || guidance.length > 0) {
    console.log(
      'Automatic project tracking is ON, but finish the integration above before relying on hands-free capture.',
    );
  } else {
    console.log('Automatic tracking is ON. From now on, just work:');
  }
  console.log(
    '  • The first time you use AI in a project, Showtail starts a trail for you.',
  );
  console.log('  • Sessions open and close around your tasks — no commands to run.');
  console.log('  • Ask your AI to "generate a Showtail report" whenever you want one.');
  console.log('');
  console.log('Privacy: capture stays local. Resolved sessions are projected into each');
  console.log("project's .showtail/ folder; unresolved or multi-project work waits in");
  console.log('the machine-local inbox/ledger. Secrets and personal data are scrubbed.');
  console.log(
    'Stop creating new project trails with `showtail setup --off`; stop one tool',
  );
  console.log('everywhere with `showtail disconnect <tool>`.');
}
