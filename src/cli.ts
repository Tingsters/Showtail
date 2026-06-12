#!/usr/bin/env bun
import { Command } from 'commander';
import { runInit } from './commands/init.ts';
import { runStart } from './commands/start.ts';
import { runLog } from './commands/log.ts';
import { runArtifactAdd } from './commands/artifact.ts';
import { runTrace } from './commands/trace.ts';
import { runReport } from './commands/report.ts';
import { runVerify } from './commands/verify.ts';
import { eventTypeList } from './core/schema.ts';

const VERSION = '0.1.0';

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
  .option('-s, --session <id>', 'log to a specific session id')
  .action(
    action(
      async (opts: {
        type?: string;
        text?: string;
        files?: string;
        tags?: string;
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
  .action(
    action(async (file: string, opts: { session?: string; events?: string }) =>
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

program.parseAsync(process.argv);
