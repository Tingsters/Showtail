import { requirePaths } from '../core/storage.ts';
import { startSession } from '../core/sessions.ts';
import { connectedToolsLines, toolStatuses } from '../core/tools.ts';

export interface StartOptions {
  label?: string;
  cwd?: string;
}

const LOG_EXAMPLES = [
  '  showtail log --type prompt --text "How should I structure this?"',
  '  showtail log --type decision --text "I chose the simpler approach."',
];

/** Start a new work session and make it the active one for `log`. */
export async function runStart(options: StartOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const session = startSession(paths, options.label);

  console.log(`Started a new work session: ${session.id}`);
  if (session.label) console.log(`  Label: ${session.label}`);

  // Orient the user around how their work gets captured: show which tools are
  // connected, then recommend the next step based on that state.
  const tools = toolStatuses(options.cwd);
  const anyHooks = tools.some((t) => t.hooksActive);
  const anyConnected = tools.some((t) => t.connected);

  console.log('');
  console.log('Connected tools');
  for (const line of connectedToolsLines(tools)) console.log(line);
  console.log('');

  if (anyHooks) {
    console.log(
      'Your prompts and edits are captured automatically — just work as usual.',
    );
    console.log('Add your own notes any time, for example:');
    console.log(LOG_EXAMPLES[1]);
  } else if (anyConnected) {
    console.log('A tool is connected, but auto-capture hooks are not active.');
    console.log('Re-run `showtail connect <tool>` to enable them, or log as you work:');
    for (const ex of LOG_EXAMPLES) console.log(ex);
  } else {
    console.log('No AI tools connected yet. Connect one so your prompts and edits are');
    console.log('captured automatically as you work:');
    console.log('  showtail connect claude     (Claude Code)');
    console.log('  showtail connect copilot    (GitHub Copilot)');
    console.log('  showtail connect codex      (OpenAI Codex)');
    console.log('');
    console.log('Prefer to log by hand? Record events as you go:');
    for (const ex of LOG_EXAMPLES) console.log(ex);
  }

  console.log('');
  console.log('Check progress any time with `showtail status`.');
  console.log(
    'When you finish: `showtail end`, then `showtail report` to build your report.',
  );
}
