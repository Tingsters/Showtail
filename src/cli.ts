#!/usr/bin/env bun
import { Command } from 'commander';
import { runInit } from './commands/init.ts';
import { runStart } from './commands/start.ts';
import { runLog } from './commands/log.ts';
import { runArtifactAdd } from './commands/artifact.ts';
import { runTrace } from './commands/trace.ts';
import { runReport } from './commands/report.ts';
import { runVerify } from './commands/verify.ts';
import { runSkillInstall, runSkillStatus, runSkillUninstall } from './commands/skill.ts';
import {
  runCopilotInstall,
  runCopilotStatus,
  runCopilotUninstall,
} from './commands/copilot.ts';
import { runHook, type HookEvent } from './commands/hook.ts';
import { eventTypeList } from './core/schema.ts';

const VERSION = '0.3.5';

/** Wrap a command action so errors print a clean message and set exit code 1. */
function action<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program
  .name('showtail')
  .description(
    'Show your work. Capture prompts, edits, decisions, artifacts, and reflections\n' +
      'into a local, reviewable trail of how you built your project.',
  )
  .version(VERSION, '-v, --version');

program
  .command('init')
  .description('Set up Showtail in this project (creates the .showtail/ folder).')
  .option('-p, --project <name>', 'a name for this project')
  .action(
    action(async (opts: { project?: string }) => runInit({ project: opts.project })),
  );

program
  .command('start')
  .description('Start a new work session.')
  .option('-l, --label <label>', 'a short label for the session')
  .action(action(async (opts: { label?: string }) => runStart({ label: opts.label })));

program
  .command('log')
  .description('Record an event in your current session.')
  .requiredOption('-t, --type <type>', `event type (one of: ${eventTypeList()})`)
  .option('-x, --text <text>', 'the content (or pipe it via stdin)')
  .option('-f, --files <files>', 'comma-separated related files')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--tool <tool>', 'tool this came through (claude-code, github-copilot, cli)')
  .option('-s, --session <id>', 'log to a specific session id')
  .action(
    action(
      async (opts: {
        type?: string;
        text?: string;
        files?: string;
        tags?: string;
        tool?: string;
        session?: string;
      }) => runLog(opts),
    ),
  );

const artifact = program
  .command('artifact')
  .description('Record artifacts (file snapshots) in your trail.');

artifact
  .command('add <file>')
  .description('Record a file: its SHA-256 hash, time, and git commit if available.')
  .option('-s, --session <id>', 'attach to a specific session id')
  .option('-e, --events <ids>', 'comma-separated related event ids')
  .option('--tool <tool>', 'tool this came through (claude-code, github-copilot, cli)')
  .action(
    action(
      async (file: string, opts: { session?: string; events?: string; tool?: string }) =>
        runArtifactAdd(file, opts),
    ),
  );

program
  .command('trace <file>')
  .description('Show the known provenance trail for a file.')
  .option('--format <format>', 'output format: text (default) or json', 'text')
  .action(
    action(async (file: string, opts: { format?: string }) => runTrace(file, opts)),
  );

program
  .command('report')
  .description('Generate a report summarizing your work trail.')
  .option('--format <format>', 'output format: md (default) or json', 'md')
  .action(action(async (opts: { format?: string }) => runReport(opts)));

program
  .command('verify')
  .description('Check that your trail is complete and consistent.')
  .action(
    action(async () => {
      const ok = await runVerify();
      if (!ok) process.exitCode = 1;
    }),
  );

const skill = program
  .command('skill')
  .description('Manage the Showtail Claude Code skill and auto-capture hooks.');

skill
  .command('install')
  .description(
    'Install the Showtail skill into Claude Code (auto-capture hooks on by default).',
  )
  .option('--user', 'install for your user (all projects: ~/.claude)')
  .option('--project', 'install for this project only (./.claude) [default]')
  .option(
    '--no-hooks',
    'skip the auto-capture hooks (the skill captures manually instead)',
  )
  .option('--with-hooks', 'deprecated: hooks are installed by default')
  .option('--force', 'overwrite an existing skill without prompting')
  .action(
    action(
      async (opts: {
        user?: boolean;
        project?: boolean;
        hooks?: boolean;
        force?: boolean;
      }) =>
        runSkillInstall({
          user: opts.user,
          project: opts.project,
          hooks: opts.hooks,
          force: opts.force,
        }),
    ),
  );

skill
  .command('status')
  .description('Report whether the auto-capture hooks are active (used by the skill).')
  .action(action(async () => runSkillStatus()));

skill
  .command('uninstall')
  .description('Remove the Showtail skill and any hooks it installed.')
  .option('--user', 'remove from your user scope (~/.claude)')
  .option('--project', 'remove from this project (./.claude) [default]')
  .action(
    action(async (opts: { user?: boolean }) => runSkillUninstall({ user: opts.user })),
  );

const copilot = program
  .command('copilot')
  .description(
    'Manage the Showtail GitHub Copilot integration (instructions + extension).',
  );

copilot
  .command('install')
  .description('Write the repo Copilot instructions and point to the VS Code extension.')
  .option('--no-extension', 'skip the VS Code extension guidance')
  .action(
    action(async (opts: { extension?: boolean }) =>
      runCopilotInstall({ extension: opts.extension }),
    ),
  );

copilot
  .command('status')
  .description('Report whether the Copilot instructions are installed for this project.')
  .action(action(async () => runCopilotStatus()));

copilot
  .command('uninstall')
  .description('Remove the Showtail Copilot instructions from this project.')
  .action(action(async () => runCopilotUninstall()));

// Internal: invoked by Claude Code hooks (reads the hook JSON from stdin).
// Hidden from the main help; advanced users can still discover it.
program
  .command('hook <event>', { hidden: true })
  .description(
    'Internal: handle a Claude Code hook event (session-start, user-prompt, post-edit, stop).',
  )
  .action(action(async (event: string) => runHook(event as HookEvent)));

program.parseAsync(process.argv);
