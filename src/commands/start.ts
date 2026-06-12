import { requirePaths } from '../core/storage.ts';
import { startSession } from '../core/sessions.ts';

export interface StartOptions {
  label?: string;
  cwd?: string;
}

/** Start a new work session and make it the active one for `log`. */
export async function runStart(options: StartOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const session = startSession(paths, options.label);

  console.log(`Started a new work session: ${session.id}`);
  if (session.label) console.log(`  Label: ${session.label}`);
  console.log('');
  console.log('Log events as you work, for example:');
  console.log('  showtail log --type prompt --text "How should I structure this?"');
  console.log('  showtail log --type decision --text "I chose the simpler approach."');
}
