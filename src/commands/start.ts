import { requirePaths } from '../core/storage.ts';
import { requireActiveAuthor } from '../core/authors.ts';
import { emitJson } from '../core/output.ts';
import { startSession } from '../core/sessions.ts';
import { connectedToolsLines, toolStatuses } from '../core/tools.ts';
import { connectPlugins } from '../plugins/registry.ts';

export interface StartOptions {
  label?: string;
  cwd?: string;
  /** Emit machine-readable JSON instead of the human guidance. */
  json?: boolean;
}

/** Start a new work session and make it the active one for `log`. */
export async function runStart(options: StartOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });
  const session = startSession(author, options.label);

  if (options.json) {
    emitJson({
      sessionId: session.id,
      startedAt: session.startedAt,
      label: session.label ?? null,
    });
    return;
  }

  console.log(`Started a new work session: ${session.id} (as ${author.slug})`);
  if (session.label) console.log(`  Label: ${session.label}`);

  // Orient the user around how their work gets captured: show which tools are
  // connected, then recommend the next step based on that state.
  const tools = toolStatuses(options.cwd);
  const anyAutomatic = tools.some(
    (tool) =>
      tool.hooksActive === true ||
      tool.captureActive === true ||
      (tool.connected && tool.hooksActive === undefined),
  );
  const anyConnected = tools.some((t) => t.connected);

  console.log('');
  console.log('Connected tools');
  for (const line of connectedToolsLines(tools)) console.log(line);
  console.log('');

  if (anyAutomatic) {
    console.log(
      'Your prompts and edits are captured automatically — just work as usual.',
    );
  } else if (anyConnected) {
    console.log('A tool is connected, but automatic capture is not active.');
    console.log(
      'Re-run `showtail connect <tool>` to restore hands-free prompt and edit capture.',
    );
  } else {
    console.log('No AI tools connected yet. Connect one so your prompts and edits are');
    console.log('captured automatically as you work:');
    for (const p of connectPlugins()) {
      console.log(`  showtail connect ${p.cliName.padEnd(11)}(${p.label})`);
    }
  }

  console.log('');
  console.log('Check progress any time with `showtail status`.');
  console.log(
    'When you finish: `showtail end`, then `showtail report` to build your report.',
  );
}
