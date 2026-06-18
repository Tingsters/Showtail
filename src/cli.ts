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
import { runCodexInstall, runCodexStatus, runCodexUninstall } from './commands/codex.ts';
import { runHook, type HookEvent } from './commands/hook.ts';
import { runImportChatgpt, runImportUndo } from './commands/import.ts';
import { runImportGemini } from './commands/importGemini.ts';
import { runImportClaudeCode } from './commands/importClaude.ts';
import { eventTypeList } from './core/schema.ts';
import type { Tool } from './types.ts';

const VERSION = '0.9.1';

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
  .option('--turn <id>', "link to a prompt's turn (e.g. an ai_output for a prompt)")
  .action(
    action(
      async (opts: {
        type?: string;
        text?: string;
        files?: string;
        tags?: string;
        tool?: string;
        session?: string;
        turn?: string;
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
  .option('--format <format>', 'output format: html (default), md, or json', 'html')
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
  .option('--force', 'overwrite instructions you have edited (take the latest)')
  .action(
    action(async (opts: { extension?: boolean; force?: boolean }) =>
      runCopilotInstall({ extension: opts.extension, force: opts.force }),
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

const codex = program
  .command('codex')
  .description(
    'Manage the Showtail OpenAI Codex integration (AGENTS.md instructions + hooks).',
  );

codex
  .command('install')
  .description(
    'Install the Codex AGENTS.md instructions and auto-capture hooks (on by default).',
  )
  .option('--user', 'install for your user (all projects: ~/.codex)')
  .option('--project', 'install for this project only (./.codex, ./AGENTS.md) [default]')
  .option(
    '--no-hooks',
    'skip the auto-capture hooks (AGENTS.md captures manually instead)',
  )
  .option('--yes', 'enable Codex hooks in config.toml without prompting')
  .option('--force', 'overwrite instructions you have edited (take the latest)')
  .action(
    action(
      async (opts: {
        user?: boolean;
        project?: boolean;
        hooks?: boolean;
        yes?: boolean;
        force?: boolean;
      }) =>
        runCodexInstall({
          user: opts.user,
          project: opts.project,
          hooks: opts.hooks,
          yes: opts.yes,
          force: opts.force,
        }),
    ),
  );

codex
  .command('status')
  .description('Report whether the Codex integration is installed and capturing.')
  .action(action(async () => runCodexStatus()));

codex
  .command('uninstall')
  .description('Remove the Showtail Codex instructions and any hooks it installed.')
  .option('--user', 'remove from your user scope (~/.codex)')
  .option('--project', 'remove from this project (./.codex, ./AGENTS.md) [default]')
  .action(
    action(async (opts: { user?: boolean }) => runCodexUninstall({ user: opts.user })),
  );

const importCmd = program
  .command('import')
  .description('Import work done in other AI tools into your trail.');

importCmd
  .command('chatgpt [share-url]')
  .description(
    'Import a ChatGPT conversation. A share link is easiest; if it will not work,\n' +
      'paste the conversation instead with --paste (or --file a saved page/transcript).',
  )
  .option('--no-responses', "don't import ChatGPT's responses, only your prompts")
  .option('--with-responses', 'deprecated: responses are imported by default')
  .option('--paste', 'import a copied conversation (reads your clipboard)')
  .option('--clipboard', 'import the conversation from your clipboard')
  .option('-y, --yes', 'skip the clipboard preview/confirmation prompt')
  .option('--file <path>', 'parse a saved share page or a saved transcript file')
  .option('--date <yyyy-mm-dd>', 'date a pasted conversation so it lands on the timeline')
  .option('-s, --session <id>', 'import into a specific session id')
  .action(
    action(
      async (
        shareUrl: string | undefined,
        opts: {
          responses?: boolean;
          withResponses?: boolean;
          paste?: boolean;
          clipboard?: boolean;
          yes?: boolean;
          file?: string;
          date?: string;
          session?: string;
        },
      ) =>
        runImportChatgpt(shareUrl, {
          withResponses: opts.responses !== false,
          paste: opts.paste,
          clipboard: opts.clipboard,
          yes: opts.yes,
          file: opts.file,
          date: opts.date,
          session: opts.session,
        }),
    ),
  );

importCmd
  .command('gemini [share-url]')
  .description(
    'Import a Google Gemini conversation from a share link (gemini.google.com/share/…).\n' +
      'If a link will not work, paste the conversation with --paste (or --file a transcript).',
  )
  .option('--no-responses', "don't import Gemini's responses, only your prompts")
  .option('--with-responses', 'deprecated: responses are imported by default')
  .option('--paste', 'import a copied conversation (reads your clipboard)')
  .option('--clipboard', 'import the conversation from your clipboard')
  .option('-y, --yes', 'skip the clipboard preview/confirmation prompt')
  .option('--file <path>', 'parse a saved share page or a saved transcript file')
  .option('--date <yyyy-mm-dd>', 'date a pasted conversation so it lands on the timeline')
  .option('-s, --session <id>', 'import into a specific session id')
  .action(
    action(
      async (
        shareUrl: string | undefined,
        opts: {
          responses?: boolean;
          withResponses?: boolean;
          paste?: boolean;
          clipboard?: boolean;
          yes?: boolean;
          file?: string;
          date?: string;
          session?: string;
        },
      ) =>
        runImportGemini(shareUrl, {
          withResponses: opts.responses !== false,
          paste: opts.paste,
          clipboard: opts.clipboard,
          yes: opts.yes,
          file: opts.file,
          date: opts.date,
          session: opts.session,
        }),
    ),
  );

importCmd
  .command('claude-code [target]')
  .description(
    'Import an existing Claude Code session transcript from disk into your trail.\n' +
      'With no target, imports the most recent session for this project; --list shows all.',
  )
  .option('--list', "list this project's Claude Code transcripts and exit")
  .option('--no-responses', "don't import Claude's text responses, only your prompts")
  .option('--with-responses', 'deprecated: responses are imported by default')
  .option('--file <path>', 'import a specific transcript .jsonl by path')
  .option('-s, --session <id>', 'import into a specific Showtail session id')
  .action(
    action(
      async (
        target: string | undefined,
        opts: {
          list?: boolean;
          responses?: boolean;
          withResponses?: boolean;
          file?: string;
          session?: string;
        },
      ) =>
        runImportClaudeCode(target, {
          list: opts.list,
          withResponses: opts.responses !== false,
          file: opts.file,
          session: opts.session,
        }),
    ),
  );

importCmd
  .command('undo')
  .description('Undo the most recent import (removes that batch of events).')
  .action(action(async () => runImportUndo()));

// Internal: invoked by Claude Code hooks (reads the hook JSON from stdin).
// Hidden from the main help; advanced users can still discover it.
program
  .command('hook <event>', { hidden: true })
  .description(
    'Internal: handle a hook event (session-start, user-prompt, post-edit, stop).',
  )
  .option('--tool <tool>', 'which tool fired the hook (claude-code [default] or codex)')
  .action(
    action(async (event: string, opts: { tool?: string }) =>
      runHook(event as HookEvent, { tool: opts.tool as Tool | undefined }),
    ),
  );

program.parseAsync(process.argv);
