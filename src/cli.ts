#!/usr/bin/env bun
import { Command, CommanderError, Option } from 'commander';
import { runInit } from './commands/init.ts';
import { runEnsure } from './commands/ensure.ts';
import { runSetup } from './commands/setup.ts';
import { runCapabilities } from './commands/capabilities.ts';
import { runMatrix } from './commands/matrix.ts';
import { runStart } from './commands/start.ts';
import { runEnd } from './commands/end.ts';
import { runLog } from './commands/log.ts';
import { runArtifactAdd } from './commands/artifact.ts';
import { runTrace } from './commands/trace.ts';
import { runReport } from './commands/report.ts';
import { runVerify } from './commands/verify.ts';
import { runStatus } from './commands/status.ts';
import { runProjects } from './commands/projects.ts';
import { runSessions } from './commands/sessions.ts';
import { runInbox } from './commands/inbox.ts';
import { runIgnore } from './commands/ignore.ts';
import { runMove } from './commands/move.ts';
import { runHook, type HookEvent } from './commands/hook.ts';
import { runImportUndo } from './commands/import.ts';
import { runRedact } from './commands/redact.ts';
import { runMigrate, runMigrateUndo } from './commands/migrate.ts';
import { runUpdate } from './commands/update.ts';
import { eventTypeList } from './core/schema.ts';
import { ShowtailError } from './core/errors.ts';
import { NotInitializedError } from './core/storage.ts';
import {
  connectPluginOrThrow,
  connectPlugins,
  importPlugins,
} from './plugins/registry.ts';
import type {
  ConnectFlag,
  ConnectUninstallResult,
  ImportRunOptions,
} from './plugins/types.ts';
import type { Tool } from './types.ts';
import { SHOWTAIL_VERSION } from './core/version.ts';
import { ensureFirstRunSetup, autoTrackingNotice } from './commands/setup.ts';
import { autoConnectNewlyDetected } from './core/autoConnectSweep.ts';
import {
  autoInitEnabled,
  disableToolAutoConnect,
  disableToolCapture,
  enableToolAutoConnect,
  enableToolCapture,
  readGlobalConfig,
  toolCaptureGloballyDisabled,
} from './core/globalConfig.ts';
import { maybeOfferHistoryMigration } from './commands/upgrade.ts';
import { passiveUpdateNotice } from './core/updateCheck.ts';
import { consumeUpdateResultNotice } from './core/selfUpdate.ts';
import { emitJson } from './core/output.ts';

const VERSION = SHOWTAIL_VERSION;

// Help-group headings (Commander 14 renders commands grouped under these).
const G_CAPTURE = 'Manual capture (optional):';
const G_REVIEW = 'Review your trail:';
const G_CONNECT = 'Connect your tools:';
const G_MAINTAIN = 'Maintain Showtail:';
// Automatic tracking means there's no "get started" step; these are the occasional
// manual/repair commands, shown last and below the everyday workflow.
const G_MANAGE = 'Manage tracking (optional):';

const VERBOSE_DETAIL_KEYS = new Set([
  'claimedSessions',
  'claimedSegments',
  'relocatedSessions',
  'relocatedSegments',
  'relocationCandidates',
  'segmentRelocationCandidates',
  'pendingAmbiguous',
  'pendingAmbiguousRanges',
  'pendingRanges',
  'reroutedSessions',
  'reroutedRanges',
  'cleanedPendingRanges',
  'routingWarnings',
]);

const COMPACT_ERROR_RESOLUTION_BYTES = 2_500;
const COMPACT_ERROR_MESSAGE_LENGTH = 512;

function compactErrorMessage(message: string): string {
  if (message.length <= COMPACT_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, COMPACT_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function compactProjectResolution(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const resolution = value as Record<string, unknown>;
  if (!Array.isArray(resolution.candidates)) return value;

  const candidates = resolution.candidates;
  const base = { ...resolution };
  delete base.candidates;
  if (typeof base.selector === 'string') {
    base.selector = compactErrorMessage(base.selector);
  }

  const kept: unknown[] = [];
  for (const candidate of candidates) {
    const proposed = {
      ...base,
      candidates: [...kept, candidate],
      candidateCount: candidates.length,
    };
    if (
      Buffer.byteLength(JSON.stringify(proposed), 'utf8') > COMPACT_ERROR_RESOLUTION_BYTES
    ) {
      break;
    }
    kept.push(candidate);
  }
  return {
    ...base,
    candidates: kept,
    candidateCount: candidates.length,
    ...(kept.length < candidates.length ? { candidatesTruncated: true } : {}),
  };
}

function compactErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  if (process.argv.includes('--verbose-json')) return details;
  const compact: Record<string, unknown> = {};
  const routing: Record<string, number> = {};
  for (const [key, value] of Object.entries(details)) {
    if (VERBOSE_DETAIL_KEYS.has(key) && Array.isArray(value)) {
      routing[key] = value.length;
    } else if (key === 'resolution') {
      compact[key] = compactProjectResolution(value);
    } else {
      compact[key] = value;
    }
  }
  return Object.keys(routing).length > 0 ? { ...compact, routing } : compact;
}

/**
 * Wrap a command action so errors print a clean message and set a stable exit
 * code agents can branch on: 2 = not initialized, the `code` on a
 * {@link ShowtailError}, otherwise 1.
 */
function action<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      const code =
        err instanceof NotInitializedError
          ? 2
          : err instanceof ShowtailError
            ? err.code
            : 1;
      const message = err instanceof Error ? err.message : String(err);
      process.exitCode = code;
      if (process.argv.includes('--json')) {
        const compactMessage = compactErrorMessage(message);
        const rawDetails = err instanceof ShowtailError ? (err.details ?? {}) : {};
        const details = compactErrorDetails(rawDetails);
        emitJson({
          // Flatten report/path details for compatibility, but keep the stable
          // envelope authoritative if a future detail happens to reuse a key.
          ...details,
          ok: false,
          code,
          errorCode:
            err instanceof ShowtailError
              ? err.errorCode
              : err instanceof NotInitializedError
                ? 'NO_PROJECT_TRAIL'
                : 'COMMAND_FAILED',
          message: compactMessage,
          // `error` and flattened details remain for compatibility with the
          // first JSON-failure release; new consumers use message/details.
          error: compactMessage,
          details,
          nextAction:
            err instanceof ShowtailError
              ? err.nextAction
              : err instanceof NotInitializedError
                ? autoInitEnabled()
                  ? 'work'
                  : 'run-setup'
                : 'review-error',
        });
        return;
      }
      console.error(`\nError: ${message}`);
    }
  };
}

/** An explicit empty operand must never collapse back to the agent's cwd. */
function projectPathOperand(path: string | undefined): string | undefined {
  if (path === undefined || path.trim().length > 0) return path;
  throw new ShowtailError(
    'Project path cannot be empty.',
    2,
    {
      requestedRoot: null,
      root: null,
      candidateRoot: null,
      candidates: [],
    },
    'PATH_NOT_FOUND',
    'choose-existing-path',
  );
}

const program = new Command();
// Configure this before registering subcommands so Commander copies the
// override into each command and parse failures can use our JSON envelope.
program.exitOverride();

program
  .name('showtail')
  .description(
    'Show your work. Automatically capture the prompts you send to AI and the\n' +
      'files you build together, into a local, reviewable trail of how you worked.',
  )
  .configureHelp({ sortSubcommands: false })
  .configureOutput({
    writeErr: (value) => {
      if (!process.argv.includes('--json')) process.stderr.write(value);
    },
  })
  .addHelpText(
    'before',
    '\nNormal flow: open your project, work with your AI tool, then run `showtail report`.\n',
  )
  // Point users at help after any parse error (e.g. a mistyped `-all` for `--all`),
  // instead of leaving them with a bare "unknown option" line.
  .showHelpAfterError('(run the command with --help to see valid options)')
  .version(VERSION, '-v, --version');

// Make Showtail "just work" without a setup command: the first time any normal
// command runs after install (the safety net for bun / from-source installs the
// curl/irm installer didn't run), enable automatic project creation, connect
// installed tools, and pre-wire integrations that are safe before their host
// exists (see `ensureFirstRunSetup`). Skipped for:
//   - `hook` (the tool-driven path; it bootstraps itself on session-start),
//   - background `import <tool> --auto` watchers (they must honor consent first),
//   - `setup` (it owns the on/off switch and does its own thing),
//   - `connect` / `disconnect` (they own per-tool wiring; a student turning a tool OFF, or
//     a `connect codex --no-hooks`, must not have a pre-wire-all fight them first), and
//   - `capabilities` (a pure state probe the extension/agents read to DECIDE what to
//     do — it must stay side-effect-free and honestly report "not set up yet").
// The notice goes to stderr so it never pollutes a command's `--json` stdout. Once-only
// and best-effort.
const NO_BOOTSTRAP = new Set([
  'hook',
  'setup',
  'connect',
  'disconnect',
  'capabilities',
  'status',
  'projects',
  'verify',
  'update',
  'move',
]);
let pendingUpdateNotice: Promise<string | null> | null = null;
program.hook('preAction', async (_thisCommand, actionCommand) => {
  // Extension-driven transcript imports are background capture, not a user
  // command. They must reach their command-level consent guard without first
  // bootstrapping setup, refreshing integrations, checking for updates, or
  // offering migrations. In particular, a stale watcher after disconnect must
  // be a completely inert no-op.
  if (actionCommand.parent?.name() === 'import' && actionCommand.opts().auto === true) {
    return;
  }
  const json = actionCommand.opts().json === true;
  pendingUpdateNotice = passiveUpdateNotice({
    command: actionCommand.name(),
    json,
  });
  if (
    !json &&
    process.stderr.isTTY &&
    !['hook', 'capabilities', 'matrix', 'projects', 'status', 'verify'].includes(
      actionCommand.name(),
    )
  ) {
    const previousUpdate = consumeUpdateResultNotice();
    if (previousUpdate) process.stderr.write(previousUpdate + '\n\n');
  }
  if (NO_BOOTSTRAP.has(actionCommand.name())) return;
  const boot = ensureFirstRunSetup();
  if (boot.ran) {
    if (!json) {
      for (const line of autoTrackingNotice(
        boot.connected,
        boot.guidance,
        boot.pending,
        boot.failed,
      )) {
        process.stderr.write(line + '\n');
      }
      process.stderr.write('\n');
    }
    return;
  }
  // Already set up: mutating commands refresh integration wiring and connect newly
  // detected tools. Read-only probes stay side-effect-free; session-start hooks and
  // the next normal command (for example `report`) carry the refresh instead.
  if (autoInitEnabled()) {
    try {
      const { connected, refreshed, pending, failed } = autoConnectNewlyDetected(
        undefined,
        undefined,
        { connectAll: true },
      );
      if (!json && (connected.length > 0 || pending.length > 0 || failed.length > 0)) {
        for (const line of autoTrackingNotice(connected, [], pending, failed)) {
          process.stderr.write(line + '\n');
        }
        process.stderr.write('\n');
      }
      if (!json && refreshed.length > 0) {
        process.stderr.write(
          `Showtail updated its capture integration for: ${refreshed.join(', ')}.\n\n`,
        );
      }
    } catch {
      /* a refresh/connect failure must never break the command */
    }
  }
  if (
    actionCommand.name() !== 'migrate' &&
    actionCommand.parent?.name() !== 'migrate' &&
    actionCommand.opts().json !== true
  ) {
    await maybeOfferHistoryMigration();
  }
});

program.hook('postAction', async () => {
  const notice = await pendingUpdateNotice;
  pendingUpdateNotice = null;
  if (!notice || process.exitCode) return;
  process.stderr.write(`\n${notice}\n`);
});

// --- Hidden lifecycle commands --------------------------------------------
//
// Tracking is automatic, so these are no longer part of a student's flow. They stay
// available for integrations and power users, but are hidden from `--help` to cut the
// getting-started clutter. The `setup` and `track` manual commands live at the end,
// under the "Manage tracking (optional)" group.

program
  .command('ensure', { hidden: true })
  .description(
    'Make sure this project is initialized and a session is open (safe to re-run).',
  )
  .option('--json', 'output machine-readable JSON')
  .action(action(async (opts: { json?: boolean }) => runEnsure({ json: opts.json })));

program
  .command('start', { hidden: true })
  .description('Begin a new work session (sessions otherwise open automatically).')
  .option('-l, --label <label>', 'a short label for the session')
  .option('--json', 'output machine-readable JSON')
  .action(
    action(async (opts: { label?: string; json?: boolean }) =>
      runStart({ label: opts.label, json: opts.json }),
    ),
  );

program
  .command('end', { hidden: true })
  .description('Close the current work session (sessions otherwise close automatically).')
  .option('--json', 'output machine-readable JSON')
  .action(action(async (opts: { json?: boolean }) => runEnd({ json: opts.json })));

// --- Review your trail ----------------------------------------------------

program
  .command('projects [selector]')
  .description('List validated Showtail projects or resolve a project selector.')
  .helpGroup(G_REVIEW)
  .option('--json', 'output the stable project-resolution contract')
  .option('--verbose-json', 'include catalog evidence and path history in JSON')
  .action(
    action(
      async (
        selector: string | undefined,
        opts: { json?: boolean; verboseJson?: boolean },
      ) =>
        runProjects({
          selector,
          json: opts.json,
          verboseJson: opts.verboseJson,
        }),
    ),
  );

program
  .command('status [path]')
  .description(
    'Show project, inbox, and capture state for the current or named folder without changing a trail.',
  )
  .helpGroup(G_REVIEW)
  .option('--json', 'output machine-readable JSON')
  .option('--verbose-json', 'include full pending-work details in JSON')
  .option('--project <selector>', 'select a project by path, trail id, or name')
  .option('--tool <tool>', 'report capture state for one connected tool')
  .addHelpText(
    'after',
    `
Project targeting:
  showtail status --json --tool <tool>        startup capture-mode probe
  showtail status <absolute-project-path> --json --tool <tool>
                                               inspect an intended project explicitly`,
  )
  .action(
    action(
      async (
        path: string | undefined,
        opts: {
          json?: boolean;
          verboseJson?: boolean;
          project?: string;
          tool?: string;
        },
      ) => {
        if (path !== undefined && opts.project !== undefined) {
          throw new ShowtailError(
            'Use either status [path] or --project, not both.',
            2,
            {},
            'PROJECT_ARGUMENT_CONFLICT',
            'choose-one-project-selector',
          );
        }
        const requested = projectPathOperand(path);
        return runStatus({
          cwd: requested,
          explicitPath: requested !== undefined,
          project: opts.project,
          json: opts.json,
          verboseJson: opts.verboseJson,
          tool: opts.tool,
        });
      },
    ),
  );

program
  .command('sessions')
  .description('List your work sessions.')
  .helpGroup(G_REVIEW)
  .option('--json', 'output machine-readable JSON')
  .option('--all', "list every contributor's sessions, not just yours")
  .action(
    action(async (opts: { json?: boolean; all?: boolean }) =>
      runSessions({ json: opts.json, all: opts.all }),
    ),
  );

program
  .command('inbox')
  .description(
    'Captured work not yet attached to one project. Pick to place (or dismiss) it. Filtered low-signal or ignored work remains available with --all.',
  )
  .helpGroup(G_REVIEW)
  .option('--all', 'also show unresolved, low-signal, ignored, and dismissed work')
  .option('--json', 'output machine-readable JSON')
  .addHelpText(
    'after',
    `
Managing your inbox:
  showtail inbox                     work waiting to be placed; in the picker, type
                                     numbers to place, or 'd1,3' / 'dismiss all' to dismiss
  showtail inbox --all               also show filtered work (unresolved/trivial/
                                     ignored/dismissed), tagged with why
  showtail track <folder>            make a folder a project and pull its captured work in
  showtail ignore <folder>           keep a folder's work out of the inbox
  showtail move <range-id> --to <folder>
                                     place one specific turn range by id

Moved or renamed your project?
  Work tagged [files moved or deleted] is still here — run 'showtail track <new
  folder>'. Showtail finds it by content, not by its old path.`,
  )
  .action(
    action(async (opts: { json?: boolean; all?: boolean }) =>
      runInbox({ json: opts.json, all: opts.all }),
    ),
  );

program
  .command('ignore [path]')
  .description(
    "Keep a folder's captured sessions out of `showtail inbox` (still visible with --all). No path lists ignored folders.",
  )
  .helpGroup(G_REVIEW)
  .option('--remove', 'stop ignoring the folder')
  .option('--list', 'list the ignored folders')
  .option('--json', 'output machine-readable JSON')
  .addHelpText('after', '\nSee `showtail inbox --help` for the full inbox workflow.')
  .action(
    action(
      async (
        path: string | undefined,
        opts: { remove?: boolean; list?: boolean; json?: boolean },
      ) => runIgnore(path, { remove: opts.remove, list: opts.list, json: opts.json }),
    ),
  );

program
  .command('move [sessionId]')
  .alias('reattach')
  .description(
    'Move a captured turn range to another project folder. A bare session id works only when it contains one range.',
  )
  .helpGroup(G_REVIEW)
  .option(
    '--to <path>',
    'the project folder to move the range into (default: current dir)',
  )
  .option('--json', 'list all sessions as machine-readable JSON')
  .action(
    action(async (sessionId: string | undefined, opts: { to?: string; json?: boolean }) =>
      runMove(sessionId, { to: opts.to, json: opts.json }),
    ),
  );

program
  .command('capabilities')
  .description('Report this folder’s tracking state and what to do next (for AI agents).')
  .helpGroup(G_REVIEW)
  .option('--json', 'output machine-readable JSON')
  .option('--tool <tool>', 'report capture guidance for one connected tool')
  .action(
    action(async (opts: { json?: boolean; tool?: string }) =>
      runCapabilities({ json: opts.json, tool: opts.tool }),
    ),
  );

program
  // Hidden: an informational/maintainer command (capability matrix + the maintainer-only
  // --write-readme/--verify-live). No student or agent workflow calls it, so keep it out of
  // the everyday help. Still fully runnable (`showtail matrix`).
  .command('matrix', { hidden: true })
  .description(
    'Show which capabilities each AI tool integration supports (the capability matrix).',
  )
  .option('--json', 'output machine-readable JSON')
  .option('--write-readme', "regenerate the docs site's matrix block (maintainers)")
  .option(
    '--verify-live',
    'drive installed tools live to certify capture cells (maintainers)',
  )
  .action(
    action(
      async (opts: { json?: boolean; writeReadme?: boolean; verifyLive?: boolean }) =>
        runMatrix({
          json: opts.json,
          writeReadme: opts.writeReadme,
          verifyLive: opts.verifyLive,
        }),
    ),
  );

program
  .command('report [path]')
  .description(
    "Generate a shareable report from captured work, creating this project's trail if needed.",
  )
  .helpGroup(G_REVIEW)
  .option('--format <format>', 'output format: html (default), md, or json', 'html')
  .option('--open', 'open the generated report without asking')
  .option('--no-open', 'do not open the report or show the open menu')
  .option('--ask', 'always show the open menu (ignores a remembered always/never choice)')
  .option('--author <slug>', 'generate only this contributor’s report')
  .option('--team', 'generate only the combined team report')
  .option('--title <text>', 'name shown in the report title (overrides the project name)')
  .option(
    '--ai <mode>',
    'how much AI narration to show: collapsed (default), full, or off',
  )
  .option('--no-ai', 'omit AI narration entirely (same as --ai off)')
  .option('--json', 'output machine-readable JSON (the written paths + summary)')
  .option('--verbose-json', 'include full routing and relocation details in JSON')
  .option('--project <selector>', 'select a project by path, trail id, or name')
  .option(
    '--no-sync',
    'skip the catch-up read of your AI tool’s transcript (report only what is already captured)',
  )
  .addHelpText(
    'after',
    '\nAgent use: showtail report <absolute-project-path> --json --no-open',
  )
  .action(
    action(
      async (
        path: string | undefined,
        opts: {
          format?: string;
          open?: boolean;
          ask?: boolean;
          author?: string;
          team?: boolean;
          title?: string;
          ai?: string | boolean;
          json?: boolean;
          verboseJson?: boolean;
          project?: string;
          sync?: boolean;
        },
      ) => {
        if (path !== undefined && opts.project !== undefined) {
          throw new ShowtailError(
            'Use either report [path] or --project, not both.',
            2,
            {},
            'PROJECT_ARGUMENT_CONFLICT',
            'choose-one-project-selector',
          );
        }
        const requested = projectPathOperand(path);
        return runReport({
          ...opts,
          cwd: requested,
          explicitPath: requested !== undefined,
        });
      },
    ),
  );

program
  .command('verify [path]')
  .description(
    'Run integrity checks on the current or named trail (config, journal chain, stored content, report).',
  )
  .helpGroup(G_REVIEW)
  .option('--json', 'output machine-readable JSON ({ ok, root, checks: [...] })')
  .option('--verbose-json', 'include full verification detail text in JSON')
  .option('--project <selector>', 'select a project by path, trail id, or name')
  .addHelpText(
    'after',
    '\nAgent use: showtail verify <absolute-project-path> --json (confirm the returned root)',
  )
  .action(
    action(
      async (
        path: string | undefined,
        opts: { json?: boolean; verboseJson?: boolean; project?: string },
      ) => {
        if (path !== undefined && opts.project !== undefined) {
          throw new ShowtailError(
            'Use either verify [path] or --project, not both.',
            2,
            {},
            'PROJECT_ARGUMENT_CONFLICT',
            'choose-one-project-selector',
          );
        }
        const requested = projectPathOperand(path);
        const ok = await runVerify({
          cwd: requested,
          explicitPath: requested !== undefined,
          project: opts.project,
          json: opts.json,
          verboseJson: opts.verboseJson,
        });
        if (!ok) process.exitCode = 3;
      },
    ),
  );

program
  .command('trace <file>')
  .description('Show every snapshot and related event (prompts, edits) for a file.')
  .helpGroup(G_REVIEW)
  .option('--format <format>', 'output format: text (default) or json', 'text')
  .action(
    action(async (file: string, opts: { format?: string }) => runTrace(file, opts)),
  );

// --- Optional manual capture ----------------------------------------------

program
  .command('log')
  .description('Record an optional event in the current session.')
  .helpGroup(G_CAPTURE)
  .requiredOption('-t, --type <type>', `event type (one of: ${eventTypeList()})`)
  .option('-x, --text <text>', 'the content (or pipe it via stdin)')
  .option('-f, --files <files>', 'comma-separated related files')
  .option('--tool <tool>', 'tool this came through (e.g. claude-code, codex, cli)')
  .option(
    '--model <model>',
    'the AI model that produced this (e.g. claude-opus-4-8, gpt-5.5)',
  )
  .option('-s, --session <id>', 'log to a specific session id')
  .option(
    '--turn <id>',
    'link this event to a prompt (e.g. an AI response to your prompt)',
  )
  .action(
    action(
      async (opts: {
        type?: string;
        text?: string;
        files?: string;
        tool?: string;
        model?: string;
        session?: string;
        turn?: string;
      }) => runLog(opts),
    ),
  );

program
  .command('artifact <file>')
  .description("Optionally snapshot a file's current state (hash, time, and git commit).")
  .helpGroup(G_CAPTURE)
  .option('-s, --session <id>', 'attach to a specific session id')
  .option('--tool <tool>', 'tool this came through (e.g. claude-code, codex, cli)')
  .action(
    action(async (file: string, opts: { session?: string; tool?: string }) =>
      runArtifactAdd(file, opts),
    ),
  );

// --- Connect your tools ---------------------------------------------------
//
// Both `connect`/`disconnect` and `import` dispatch through the plugin registry
// (src/plugins/). cli.ts holds no tool names and no per-tool flag knowledge —
// each plugin declares the flags it understands and how to install/import.

/**
 * The union of connect flags across all plugins (deduped by option name; the
 * first plugin's spelling/help wins). Registered once on the `connect` command.
 */
const CONNECT_FLAGS: ConnectFlag[] = (() => {
  const seen = new Map<string, ConnectFlag>();
  for (const p of connectPlugins()) {
    for (const f of p.connect.flags) if (!seen.has(f.name)) seen.set(f.name, f);
  }
  return [...seen.values()];
})();

interface ConnectOptions {
  user?: boolean;
  project?: boolean;
  hooks?: boolean;
  extension?: boolean;
  yes?: boolean;
  force?: boolean;
  managedRefresh?: boolean;
}

/**
 * Reject options the user explicitly typed that don't apply to the chosen tool,
 * so a typo like `connect copilot --user` fails loudly instead of being silently
 * ignored. Only flags actually typed on the CLI are checked.
 */
function rejectInapplicable(
  command: Command,
  plugin: { cliName: string; connect: { applicableFlags: readonly string[] } },
): void {
  for (const f of CONNECT_FLAGS) {
    if (plugin.connect.applicableFlags.includes(f.name)) continue;
    if (command.getOptionValueSource(f.name) === 'cli') {
      throw new Error(`${f.flag} is not valid for \`connect ${plugin.cliName}\`.`);
    }
  }
}

const connectNames = connectPlugins()
  .map((p) => p.cliName)
  .join(' | ');

const connectCmd = program
  .command('connect <tool>')
  .description(
    `Connect an AI tool so your prompts and edits are captured as you work (${connectNames}).`,
  )
  .helpGroup(G_CONNECT);
for (const f of CONNECT_FLAGS) connectCmd.option(f.flag, f.description);
connectCmd.addOption(
  new Option(
    '--managed-refresh',
    'refresh managed integration files without changing capture consent',
  ).hideHelp(),
);
connectCmd.action(
  action(async (raw: string, opts: ConnectOptions, command: Command) => {
    const plugin = connectPluginOrThrow(raw);
    rejectInapplicable(command, plugin);
    const instructionsOnly = opts.hooks === false;
    const managedRefresh = opts.managedRefresh === true;
    // Editor-driven refresh must never override an earlier machine-wide stop,
    // scoped disconnect, or manual-mode choice. A distinct no-op exit keeps the
    // extension from recording a refused refresh as a successful install.
    if (managedRefresh) {
      const global = readGlobalConfig();
      const refreshDisabled =
        toolCaptureGloballyDisabled(plugin.cliName) ||
        global.autoConnectDisabledTools?.includes(plugin.cliName) === true;
      if (refreshDisabled) {
        throw new ShowtailError(
          `Managed refresh skipped for ${plugin.label}: this integration was explicitly disconnected or set to manual mode.`,
          4,
          { tool: plugin.cliName },
          'MANAGED_REFRESH_DISABLED',
          'run-explicit-connect',
        );
      }
    }
    try {
      await plugin.connect.install({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        extension: opts.extension,
        yes: opts.yes,
        force: opts.force,
      });
    } finally {
      // `--no-hooks` is an explicit manual-mode choice. Persist it even if a
      // partial install fails, so a later generation refresh cannot restore the
      // hooks the user just asked to remove.
      if (instructionsOnly && !managedRefresh) disableToolAutoConnect(plugin.cliName);
    }
    if (!instructionsOnly && !managedRefresh) {
      enableToolAutoConnect(plugin.cliName);
      enableToolCapture(plugin.cliName);
    }
  }),
);

const disconnectCmd = program
  .command('disconnect <tool>')
  .description(
    'Stop capture for an AI tool everywhere; use a scope flag for a narrower removal.',
  )
  .helpGroup(G_CONNECT)
  .option('--user', 'remove only your user-scope integration')
  .option('--project', 'remove only this project’s integration');
disconnectCmd.action(
  action(
    async (
      raw: string,
      opts: { user?: boolean; project?: boolean },
      command: Command,
    ) => {
      const plugin = connectPluginOrThrow(raw);
      const user = command.getOptionValueSource('user') === 'cli' && opts.user === true;
      const project =
        command.getOptionValueSource('project') === 'cli' && opts.project === true;
      const everywhere = !user && !project;
      if (user && project) {
        throw new Error('Choose either --user or --project, not both.');
      }
      if (user && !plugin.connect.scopes.includes('user')) {
        throw new Error(`--user is not valid for \`disconnect ${plugin.cliName}\`.`);
      }
      if (project && !plugin.connect.scopes.includes('project')) {
        throw new Error(`--project is not valid for \`disconnect ${plugin.cliName}\`.`);
      }

      // Persist the opt-out before physical removal. Capture therefore stops at
      // command entry, survives a failed/hung native uninstaller, and cannot be
      // raced by an editor refresh while uninstall is still in progress.
      if (everywhere) disableToolCapture(plugin.cliName);
      disableToolAutoConnect(plugin.cliName);

      const result: ConnectUninstallResult | void = await plugin.connect.uninstall({
        user,
        all: !user && !project,
      });

      for (const warning of result?.warnings ?? []) console.log(`Warning: ${warning}`);
      let captureActive: boolean | undefined;
      try {
        const status = plugin.connect.status();
        captureActive = status.hooksActive === true || status.captureActive === true;
      } catch {
        captureActive = undefined;
      }
      if (
        (everywhere && toolCaptureGloballyDisabled(plugin.cliName)) ||
        (result?.captureStopped === true && captureActive !== true)
      ) {
        console.log(`Automatic capture is off for ${plugin.label}.`);
      } else {
        console.log(
          `Automatic capture may still be active for ${plugin.label}; review the warning or remaining scope above.`,
        );
      }
    },
  ),
);

const importCmd = program
  .command('import')
  .description(
    'Import conversations from other AI tools (ChatGPT, Gemini, Claude Code) into your trail.',
  )
  .helpGroup(G_CONNECT);

/** Commander option bag for an import subcommand (both shapes). */
interface ImportCliOptions {
  responses?: boolean;
  paste?: boolean;
  clipboard?: boolean;
  yes?: boolean;
  file?: string;
  date?: string;
  session?: string;
  list?: boolean;
  model?: string;
  auto?: boolean;
  quiet?: boolean;
}

function toImportOptions(o: ImportCliOptions): ImportRunOptions {
  return {
    withResponses: o.responses !== false,
    paste: o.paste,
    clipboard: o.clipboard,
    yes: o.yes,
    file: o.file,
    date: o.date,
    session: o.session,
    list: o.list,
    model: o.model,
    auto: o.auto,
    quiet: o.quiet,
  };
}

// One subcommand per import-capable plugin, its flag-set chosen by its shape.
for (const p of importPlugins()) {
  const sub = importCmd
    .command(`${p.import.command} [source]`)
    .description(p.import.description);
  for (const alias of p.import.aliases ?? []) sub.alias(alias);

  if (p.import.shape === 'share') {
    sub
      .option('--no-responses', "don't import the AI's responses, only your prompts")
      .option('--paste', 'import a copied conversation (reads your clipboard)')
      .option('--clipboard', 'import the conversation from your clipboard')
      .option('-y, --yes', 'skip the clipboard preview/confirmation prompt')
      .option('--file <path>', 'parse a saved share page or a saved transcript file')
      .option(
        '--date <yyyy-mm-dd>',
        'date a pasted conversation so it lands on the timeline',
      )
      .option('-s, --session <id>', 'import into a specific session id')
      .option(
        '--model <model>',
        "the AI model, when the source doesn't record one (e.g. a paste)",
      );
  } else {
    sub
      .option('--list', "list this project's transcripts and exit")
      .option('--no-responses', "don't import the AI's text responses, only your prompts")
      .option('--file <path>', 'import a specific transcript file by path')
      .option('-s, --session <id>', 'import into a specific Showtail session id')
      .option('--model <model>', "the AI model, when the source doesn't record one")
      .option(
        '--auto',
        "route by the transcript's edited-file paths into each project (headless capture)",
      )
      .option('--quiet', 'suppress the summary (used by the Copilot extension watcher)');
  }

  sub.action(
    action(async (source: string | undefined, opts: ImportCliOptions) =>
      p.import.run(source, toImportOptions(opts)),
    ),
  );
}

importCmd
  .command('undo')
  .description('Undo the most recent import (permanently removes that batch of events).')
  .action(action(async () => runImportUndo()));

const migrateCmd = program
  .command('migrate')
  .description(
    'Recover missing tool calls and other details from local AI-tool transcripts.',
  )
  .helpGroup(G_MANAGE)
  .argument('[tool]', 'limit recovery to one tool')
  .argument('[batch-id]', 'batch id when the first argument is undo')
  .option('-s, --session <id>', 'limit recovery to one Showtail session')
  .option('--file <path>', 'read one explicit transcript (requires a tool)')
  .option('--dry-run', 'preview recoverable details without writing')
  .option('-y, --yes', 'apply conclusive matches without confirmation')
  .option('--json', 'output machine-readable JSON and never prompt')
  .option('--resume <run-id>', 'resume an accepted interrupted bulk migration')
  .action(
    action(
      async (
        tool: string | undefined,
        batchId: string | undefined,
        opts: {
          session?: string;
          file?: string;
          dryRun?: boolean;
          yes?: boolean;
          json?: boolean;
          resume?: string;
        },
      ) => {
        if (tool === 'undo') {
          if (opts.session || opts.file || opts.dryRun || opts.resume) {
            throw new Error(
              '`showtail migrate undo` accepts only [batch-id], --yes, and --json.',
            );
          }
          await runMigrateUndo({ batchId, yes: opts.yes, json: opts.json });
          return;
        }
        if (batchId) throw new Error(`Unexpected argument "${batchId}".`);
        if (opts.resume && tool) {
          throw new Error('--resume cannot be combined with a provider name.');
        }
        await runMigrate({
          tool,
          session: opts.session,
          file: opts.file,
          dryRun: opts.dryRun,
          yes: opts.yes,
          json: opts.json,
          resume: opts.resume,
        });
      },
    ),
  );

// --- Manage tracking (optional) -------------------------------------------
//
// Automatic project creation turns on after install, so these are the rare manual
// controls: pause new trail creation, or declare one project/name by hand.

program
  .command('update')
  .description('Check for and install the latest stable Showtail release.')
  .helpGroup(G_MAINTAIN)
  .option('--check', 'check for an update without installing it')
  .option('--auto-check <on|off>', 'turn quiet automatic update checks on or off')
  .option('--json', 'output machine-readable JSON')
  .action(
    action(async (opts: { check?: boolean; autoCheck?: string; json?: boolean }) =>
      runUpdate({ check: opts.check, autoCheck: opts.autoCheck, json: opts.json }),
    ),
  );

program
  .command('setup')
  .description('Manage automatic creation of new project trails (enabled after install).')
  .helpGroup(G_MANAGE)
  .option('--off', 'stop creating new project trails automatically; tools stay connected')
  .option('--yes', 'run without prompts')
  // Hidden: the installers' once-only bootstrap — turn tracking on, connect
  // detected tools, and pre-wire integrations that are safe before their host exists.
  .addOption(new Option('--first-run', 'automatic install bootstrap').hideHelp())
  .option('--json', 'output machine-readable JSON')
  .addOption(
    new Option(
      '--offer-migration',
      'offer the one-time v1 to v2 history migration',
    ).hideHelp(),
  )
  .action(
    action(
      async (opts: {
        off?: boolean;
        yes?: boolean;
        firstRun?: boolean;
        json?: boolean;
        offerMigration?: boolean;
      }) =>
        runSetup({
          off: opts.off,
          yes: opts.yes,
          firstRun: opts.firstRun,
          json: opts.json,
          offerMigration: opts.offerMigration,
        }),
    ),
  );

program
  .command('track [path]')
  .description(
    'Optional override: name a project, choose an unusual boundary, repair its trail, or pull already-captured work in — including work whose files have moved. Safe to re-run; normal projects initialize automatically.',
  )
  .helpGroup(G_MANAGE)
  .option(
    '-p, --project <name>',
    "set or update this project's name (shown in report titles)",
  )
  .option('--json', 'output machine-readable JSON')
  .action(
    action(async (path: string | undefined, opts: { project?: string; json?: boolean }) =>
      runInit({ cwd: path, project: opts.project, json: opts.json }),
    ),
  );

program
  .command('redact')
  .description(
    'Scrub a secret the write-time rules missed out of an already-captured trail, without deleting it. --pattern previews unless you pass --yes.',
  )
  .helpGroup(G_MANAGE)
  .option(
    '--rescan',
    "re-run this project's current redaction rules over everything stored",
  )
  .option(
    '--pattern <regex>',
    'scrub one specific value you know leaked (previews by default)',
  )
  .option('--dry-run', 'report what would change and write nothing')
  .option('-y, --yes', 'apply a --pattern scrub (it is a preview without this)')
  .option('--json', 'output machine-readable JSON')
  .action(
    action(
      async (opts: {
        rescan?: boolean;
        pattern?: string;
        dryRun?: boolean;
        yes?: boolean;
        json?: boolean;
      }) =>
        runRedact({
          rescan: opts.rescan,
          pattern: opts.pattern,
          dryRun: opts.dryRun,
          yes: opts.yes,
          json: opts.json,
        }),
    ),
  );

// Internal: invoked by Claude Code / Codex hooks (reads the hook JSON from stdin).
// Hidden from the main help; advanced users can still discover it.
program
  .command('hook <event>', { hidden: true })
  .description(
    'Internal: handle a hook event (session-start, user-prompt, post-edit, stop, session-end).',
  )
  .option('--tool <tool>', 'which tool fired the hook (claude-code [default] or codex)')
  .action(
    action(async (event: string, opts: { tool?: string }) =>
      runHook(event as HookEvent, { tool: opts.tool as Tool | undefined }),
    ),
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
    process.exitCode = 0;
  } else {
    const code = error.exitCode || 1;
    process.exitCode = code;
    if (process.argv.includes('--json')) {
      const message = error.message.replace(/^error:\s*/i, '').trim();
      emitJson({
        ok: false,
        code,
        errorCode: 'CLI_USAGE_ERROR',
        message,
        error: message,
        details: { commanderCode: error.code },
        nextAction: 'run-command-help',
      });
    }
  }
}
