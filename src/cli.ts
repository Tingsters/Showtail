#!/usr/bin/env bun
import { Command } from 'commander';
import { runInit } from './commands/init.ts';
import { runStart } from './commands/start.ts';
import { runEnd } from './commands/end.ts';
import { runLog } from './commands/log.ts';
import { runArtifactAdd } from './commands/artifact.ts';
import { runTrace } from './commands/trace.ts';
import { runReport } from './commands/report.ts';
import { runVerify } from './commands/verify.ts';
import { runStatus } from './commands/status.ts';
import { runSessions } from './commands/sessions.ts';
import { runSkillInstall, runSkillUninstall } from './commands/skill.ts';
import { runCopilotInstall, runCopilotUninstall } from './commands/copilot.ts';
import { runCodexInstall, runCodexUninstall } from './commands/codex.ts';
import { runHook, type HookEvent } from './commands/hook.ts';
import { runImportChatgpt, runImportUndo } from './commands/import.ts';
import { runImportGemini } from './commands/importGemini.ts';
import { runImportClaudeCode } from './commands/importClaude.ts';
import { eventTypeList } from './core/schema.ts';
import type { Tool } from './types.ts';

const VERSION = '0.9.3';

// Help-group headings (Commander 14 renders commands grouped under these).
const G_START = 'Get started:';
const G_CAPTURE = 'Capture your work:';
const G_REVIEW = 'Review your trail:';
const G_CONNECT = 'Connect your tools:';

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
    'Show your work. Automatically capture the prompts you send to AI and the\n' +
      'files you build together, into a local, reviewable trail of how you worked.',
  )
  .configureHelp({ sortSubcommands: false })
  .version(VERSION, '-v, --version');

// --- Get started ----------------------------------------------------------

program
  .command('init')
  .description('Set up Showtail in this project (creates the .showtail/ folder).')
  .helpGroup(G_START)
  .option('-p, --project <name>', 'a name for this project')
  .action(
    action(async (opts: { project?: string }) => runInit({ project: opts.project })),
  );

program
  .command('start')
  .description('Begin a new work session (run this each time you sit down to work).')
  .helpGroup(G_START)
  .option('-l, --label <label>', 'a short label for the session')
  .action(action(async (opts: { label?: string }) => runStart({ label: opts.label })));

program
  .command('end')
  .description('Close the current work session.')
  .helpGroup(G_START)
  .action(action(async () => runEnd()));

// --- Capture your work ----------------------------------------------------

program
  .command('log')
  .description('Record an event (usually a prompt) in your current session.')
  .helpGroup(G_CAPTURE)
  .requiredOption('-t, --type <type>', `event type (one of: ${eventTypeList()})`)
  .option('-x, --text <text>', 'the content (or pipe it via stdin)')
  .option('-f, --files <files>', 'comma-separated related files')
  .option('--tool <tool>', 'tool this came through (e.g. claude-code, codex, cli)')
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
  .action(action(async (opts: { json?: boolean }) => runSessions({ json: opts.json })));

program
  .command('report')
  .description(
    'Generate a shareable report (HTML by default) summarizing your work trail.',
  )
  .helpGroup(G_REVIEW)
  .option('--format <format>', 'output format: html (default), md, or json', 'html')
  .action(action(async (opts: { format?: string }) => runReport(opts)));

program
  .command('verify')
  .description(
    'Run integrity checks on your trail (config, journal, artifact hashes, report).',
  )
  .helpGroup(G_REVIEW)
  .action(
    action(async () => {
      const ok = await runVerify();
      if (!ok) process.exitCode = 1;
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

/** Tools that `connect`/`disconnect` understand, plus accepted aliases. */
const TOOL_ALIASES: Record<string, 'claude' | 'copilot' | 'codex'> = {
  claude: 'claude',
  'claude-code': 'claude',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  codex: 'codex',
};

function resolveConnectTool(raw: string): 'claude' | 'copilot' | 'codex' {
  const tool = TOOL_ALIASES[raw.toLowerCase()];
  if (!tool) {
    throw new Error(`Unknown tool "${raw}". Choose one of: claude, copilot, codex.`);
  }
  return tool;
}

/** Friendly flag spelling for an option key, for error messages. */
const FLAG_LABEL: Record<string, string> = {
  hooks: '--no-hooks',
  extension: '--no-extension',
};

/**
 * Reject options the user explicitly passed that don't apply to the chosen
 * tool, so a typo like `connect copilot --user` fails loudly instead of being
 * silently ignored. Only flags actually typed on the CLI are checked.
 */
function rejectInapplicable(
  command: Command,
  tool: string,
  applicable: readonly string[],
): void {
  const all = ['user', 'project', 'hooks', 'extension', 'yes', 'force'];
  for (const name of all) {
    if (applicable.includes(name)) continue;
    if (command.getOptionValueSource(name) === 'cli') {
      const flag = FLAG_LABEL[name] ?? `--${name}`;
      throw new Error(`${flag} is not valid for \`connect ${tool}\`.`);
    }
  }
}

interface ConnectOptions {
  user?: boolean;
  project?: boolean;
  hooks?: boolean;
  extension?: boolean;
  yes?: boolean;
  force?: boolean;
}

program
  .command('connect <tool>')
  .description(
    'Connect an AI tool so your prompts and edits are captured as you work (claude | copilot | codex).',
  )
  .helpGroup(G_CONNECT)
  .option('--user', 'install for your user, all projects (claude, codex)')
  .option('--project', 'install for this project only [default] (claude, codex)')
  .option(
    '--no-hooks',
    'skip auto-capture hooks; log prompts/edits yourself via the skill (claude, codex)',
  )
  .option('--no-extension', 'skip the VS Code extension guidance (copilot)')
  .option('--yes', 'enable Codex hooks in config.toml without prompting (codex)')
  .option('--force', 'overwrite existing instructions/skill (take the latest)')
  .action(
    action(async (raw: string, opts: ConnectOptions, command: Command) => {
      const tool = resolveConnectTool(raw);
      if (tool === 'claude') {
        rejectInapplicable(command, 'claude', ['user', 'project', 'hooks', 'force']);
        await runSkillInstall({
          user: opts.user,
          project: opts.project,
          hooks: opts.hooks,
          force: opts.force,
        });
      } else if (tool === 'copilot') {
        rejectInapplicable(command, 'copilot', ['extension', 'force']);
        await runCopilotInstall({ extension: opts.extension, force: opts.force });
      } else {
        rejectInapplicable(command, 'codex', [
          'user',
          'project',
          'hooks',
          'yes',
          'force',
        ]);
        await runCodexInstall({
          user: opts.user,
          project: opts.project,
          hooks: opts.hooks,
          yes: opts.yes,
          force: opts.force,
        });
      }
    }),
  );

program
  .command('disconnect <tool>')
  .description(
    'Disconnect an AI tool (removes its instructions/skill and any auto-capture hooks).',
  )
  .helpGroup(G_CONNECT)
  .option('--user', 'remove from your user scope (claude, codex)')
  .option('--project', 'remove from this project [default] (claude, codex)')
  .action(
    action(async (raw: string, opts: { user?: boolean }) => {
      const tool = resolveConnectTool(raw);
      if (tool === 'claude') {
        await runSkillUninstall({ user: opts.user });
      } else if (tool === 'copilot') {
        await runCopilotUninstall();
      } else {
        await runCodexUninstall({ user: opts.user });
      }
    }),
  );

const importCmd = program
  .command('import')
  .description(
    'Import conversations from other AI tools (ChatGPT, Gemini, Claude Code) into your trail.',
  )
  .helpGroup(G_CONNECT);

importCmd
  .command('chatgpt [share-url]')
  .description(
    'Import a ChatGPT conversation. A share link is easiest; if it will not work,\n' +
      'paste the conversation instead with --paste (or --file a saved page/transcript).',
  )
  .option('--no-responses', "don't import ChatGPT's responses, only your prompts")
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
  .command('claude [target]')
  .alias('claude-code')
  .description(
    'Import an existing Claude Code session transcript from disk into your trail.\n' +
      "With no target, opens an interactive picker of this project's sessions " +
      '(choose one or several); --list prints the same list non-interactively.',
  )
  .option('--list', "list this project's Claude Code transcripts and exit")
  .option('--no-responses', "don't import Claude's text responses, only your prompts")
  .option('--file <path>', 'import a specific transcript .jsonl by path')
  .option('-s, --session <id>', 'import into a specific Showtail session id')
  .action(
    action(
      async (
        target: string | undefined,
        opts: {
          list?: boolean;
          responses?: boolean;
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
  .description('Undo the most recent import (permanently removes that batch of events).')
  .action(action(async () => runImportUndo()));

// Internal: invoked by Claude Code / Codex hooks (reads the hook JSON from stdin).
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
