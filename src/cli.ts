#!/usr/bin/env bun
import { Command, Option } from 'commander';
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
import { runSessions } from './commands/sessions.ts';
import { runInbox } from './commands/inbox.ts';
import { runIgnore } from './commands/ignore.ts';
import { runMove } from './commands/move.ts';
import { runHook, type HookEvent } from './commands/hook.ts';
import { runImportUndo } from './commands/import.ts';
import { runRedact } from './commands/redact.ts';
import { eventTypeList } from './core/schema.ts';
import { ShowtailError } from './core/errors.ts';
import { NotInitializedError } from './core/storage.ts';
import {
  connectPluginOrThrow,
  connectPlugins,
  importPlugins,
} from './plugins/registry.ts';
import type { ConnectFlag, ImportRunOptions } from './plugins/types.ts';
import type { Tool } from './types.ts';
import { SHOWTAIL_VERSION } from './core/version.ts';
import { ensureFirstRunSetup, autoTrackingNotice } from './commands/setup.ts';
import { autoConnectNewlyDetected } from './core/autoConnectSweep.ts';
import { autoInitEnabled } from './core/globalConfig.ts';

const VERSION = SHOWTAIL_VERSION;

// Help-group headings (Commander 14 renders commands grouped under these).
const G_CAPTURE = 'Capture your work:';
const G_REVIEW = 'Review your trail:';
const G_CONNECT = 'Connect your tools:';
// Automatic tracking means there's no "get started" step; these are the occasional
// manual/repair commands, shown last and below the everyday workflow.
const G_MANAGE = 'Manage tracking (optional):';

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
      console.error(`\nError: ${(err as Error).message}`);
      process.exitCode =
        err instanceof NotInitializedError
          ? 2
          : err instanceof ShowtailError
            ? err.code
            : 1;
    }
  };
}

const program = new Command();

program
  .name('showtail')
  .description(
    'Show your work. Automatically capture the prompts you send to AI and the\n' +
      'files you build together, into a local, reviewable trail of how you worked.',
  )
  .configureHelp({ sortSubcommands: false })
  // Point users at help after any parse error (e.g. a mistyped `-all` for `--all`),
  // instead of leaving them with a bare "unknown option" line.
  .showHelpAfterError('(run the command with --help to see valid options)')
  .version(VERSION, '-v, --version');

// Make Showtail "just work" without a setup command: the first time any normal
// command runs after install (the safety net for bun / from-source installs the
// curl/irm installer didn't run), turn automatic tracking on and pre-wire every AI
// tool (see `ensureFirstRunSetup`). Skipped for:
//   - `hook` (the tool-driven path; it bootstraps itself on session-start),
//   - `setup` (it owns the on/off switch and does its own thing),
//   - `connect` / `disconnect` (they own per-tool wiring; a student turning a tool OFF, or
//     a `connect codex --no-hooks`, must not have a pre-wire-all fight them first), and
//   - `capabilities` (a pure state probe the extension/agents read to DECIDE what to
//     do — it must stay side-effect-free and honestly report "not set up yet").
// The notice goes to stderr so it never pollutes a command's `--json` stdout. Once-only
// and best-effort.
const NO_BOOTSTRAP = new Set(['hook', 'setup', 'connect', 'disconnect', 'capabilities']);
program.hook('preAction', (_thisCommand, actionCommand) => {
  if (NO_BOOTSTRAP.has(actionCommand.name())) return;
  const boot = ensureFirstRunSetup();
  if (boot.ran) {
    for (const line of autoTrackingNotice(boot.connected, boot.guidance)) {
      process.stderr.write(line + '\n');
    }
    process.stderr.write('\n');
    return;
  }
  // Already set up: carry the version refresh (and connect any newly-detected tool) from
  // a channel that survives a tool update breaking its own hooks — so a fix shipped in a
  // newer Showtail reaches already-installed hooks the next time ANY showtail command
  // runs (the AI skill's `showtail status`, a `showtail report`, …). Cheap: the sweep
  // fast-paths when the wiring is already current. Best-effort — never break a command.
  if (!autoInitEnabled()) return;
  try {
    const { connected, refreshed } = autoConnectNewlyDetected(undefined, undefined, {
      connectAll: true,
    });
    if (connected.length > 0) {
      for (const line of autoTrackingNotice(connected)) process.stderr.write(line + '\n');
      process.stderr.write('\n');
    }
    if (refreshed.length > 0) {
      process.stderr.write(
        `Showtail updated its capture integration for: ${refreshed.join(', ')}.\n\n`,
      );
    }
  } catch {
    /* a refresh/connect failure must never break the command */
  }
});

// --- Hidden lifecycle commands --------------------------------------------
//
// Tracking is automatic, so these are no longer part of a student's flow. They stay
// available (the VS Code extension calls `ensure` on project open; `start`/`end` give
// power users manual session control) but are hidden from `--help` to cut the
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

// --- Capture your work ----------------------------------------------------

program
  .command('log')
  .description('Record an event (usually a prompt) in your current session.')
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
  .description(
    "Snapshot a file's current state (hash, time, git commit) to show how it changed over time.",
  )
  .helpGroup(G_CAPTURE)
  .option('-s, --session <id>', 'attach to a specific session id')
  .option('--tool <tool>', 'tool this came through (e.g. claude-code, codex, cli)')
  .action(
    action(async (file: string, opts: { session?: string; tool?: string }) =>
      runArtifactAdd(file, opts),
    ),
  );

// --- Review your trail ----------------------------------------------------

program
  .command('status')
  .description('Your current session and connected tools at a glance.')
  .helpGroup(G_REVIEW)
  .option('--json', 'output machine-readable JSON')
  .action(action(async (opts: { json?: boolean }) => runStatus({ json: opts.json })));

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
    'Real-project work captured but not yet placed. Pick to place (or dismiss) it. Scratch/folderless work is kept aside — see --all.',
  )
  .helpGroup(G_REVIEW)
  .option(
    '--all',
    'also show scratch work kept aside (folderless/trivial/ignored/dismissed)',
  )
  .option('--json', 'output machine-readable JSON')
  .addHelpText(
    'after',
    `
Managing your inbox:
  showtail inbox                     work waiting to be placed; in the picker, type
                                     numbers to place, or 'd1,3' / 'dismiss all' to dismiss
  showtail inbox --all               also show scratch kept aside (folderless/trivial/
                                     ignored/dismissed), tagged with why
  showtail track <folder>            make a folder a project and pull its captured work in
  showtail ignore <folder>           keep a folder's work out of the inbox
  showtail move <id> --to <folder>   place one specific session by id

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
    'Mark a folder as scratch so its captured sessions stay out of `showtail inbox` (still under --all). No path lists ignored folders.',
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
    'Move a captured session to another project folder. With no id, lists every session (id + current folder) to pick from.',
  )
  .helpGroup(G_REVIEW)
  .option(
    '--to <path>',
    'the project folder to move the session into (default: current dir)',
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
  .action(
    action(async (opts: { json?: boolean }) => runCapabilities({ json: opts.json })),
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
  .command('report')
  .description(
    'Generate a shareable report (HTML by default) summarizing your work trail.',
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
  .option(
    '--no-sync',
    'skip the catch-up read of your AI tool’s transcript (report only what is already captured)',
  )
  .action(
    action(
      async (opts: {
        format?: string;
        open?: boolean;
        ask?: boolean;
        author?: string;
        team?: boolean;
        title?: string;
        ai?: string | boolean;
        json?: boolean;
        sync?: boolean;
      }) => runReport(opts),
    ),
  );

program
  .command('verify')
  .description(
    'Run integrity checks on your trail (config, journal chain, stored content, report).',
  )
  .helpGroup(G_REVIEW)
  .option('--json', 'output machine-readable JSON ({ ok, checks: [...] })')
  .action(
    action(async (opts: { json?: boolean }) => {
      const ok = await runVerify({ json: opts.json });
      if (!ok) process.exitCode = 3;
    }),
  );

program
  .command('trace <file>')
  .description('Show every snapshot and related event (prompts, edits) for a file.')
  .helpGroup(G_REVIEW)
  .option('--format <format>', 'output format: text (default) or json', 'text')
  .action(
    action(async (file: string, opts: { format?: string }) => runTrace(file, opts)),
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
connectCmd.action(
  action(async (raw: string, opts: ConnectOptions, command: Command) => {
    const plugin = connectPluginOrThrow(raw);
    rejectInapplicable(command, plugin);
    await plugin.connect.install({
      user: opts.user,
      project: opts.project,
      hooks: opts.hooks,
      extension: opts.extension,
      yes: opts.yes,
      force: opts.force,
    });
  }),
);

program
  .command('disconnect <tool>')
  .description(
    'Disconnect an AI tool (removes its instructions/skill and any auto-capture hooks).',
  )
  .helpGroup(G_CONNECT)
  .option('--user', 'remove from your user scope (where the tool supports it)')
  .option('--project', 'remove from this project [default]')
  .action(
    action(async (raw: string, opts: { user?: boolean }) => {
      const plugin = connectPluginOrThrow(raw);
      await plugin.connect.uninstall({ user: opts.user });
    }),
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

// --- Manage tracking (optional) -------------------------------------------
//
// Tracking turns on by itself after install, so these are the rare manual controls:
// turn tracking off, or wire up a single project/name by hand.

program
  .command('setup')
  .description(
    'Manage automatic tracking (it turns on by itself after install). --off turns it off.',
  )
  .helpGroup(G_MANAGE)
  .option('--off', 'turn automatic tracking off')
  .option('--yes', 'run without prompts')
  // Hidden: the installers' once-only bootstrap — turn tracking on + pre-wire every
  // tool (installed or not) so a later install never loses work.
  .addOption(new Option('--first-run', 'automatic install bootstrap').hideHelp())
  .option('--json', 'output machine-readable JSON')
  .action(
    action(
      async (opts: {
        off?: boolean;
        yes?: boolean;
        firstRun?: boolean;
        json?: boolean;
      }) =>
        runSetup({
          off: opts.off,
          yes: opts.yes,
          firstRun: opts.firstRun,
          json: opts.json,
        }),
    ),
  );

program
  .command('track [path]')
  .description(
    'Set up one project by hand: name it, declare a non-code folder as a project, and pull its already-captured work in — including work whose files have since moved. Safe to re-run. (Projects otherwise initialize automatically.)',
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

program.parseAsync(process.argv);
