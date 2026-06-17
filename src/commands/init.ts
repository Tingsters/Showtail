import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../types.ts';
import { isGitRepo } from '../core/git.ts';
import {
  CONFIG_VERSION,
  pathsForRoot,
  writeJson,
  writeSessions,
  writeState,
} from '../core/storage.ts';

/**
 * Mark the whole trail as binary so git never normalizes line endings: the
 * object store is content-addressed, and an EOL rewrite (common on Windows)
 * would change bytes and break a file's own hash / the integrity check.
 */
const GITATTRIBUTES = `# Showtail stores content-addressed objects; keep bytes byte-exact.
* -text
`;

/** Ephemeral/regenerable bits don't belong in version control. */
const GITIGNORE = `state.json
reports/
`;

export interface InitOptions {
  project?: string;
  /** Project root; defaults to cwd. */
  cwd?: string;
}

/**
 * Create the `.showtail/` folder structure and config. Safe to re-run: it will
 * not overwrite an existing config, just report that the project is ready.
 */
export async function runInit(options: InitOptions = {}): Promise<void> {
  const root = options.cwd ?? process.cwd();
  const paths = pathsForRoot(root);

  if (existsSync(paths.config)) {
    console.log('Showtail is already set up here (.showtail/config.json exists).');
    console.log('Run `showtail start` to begin a work session.');
    return;
  }

  // Guard against initializing in the home directory: that would make every
  // folder under your home look like this one project (commands walk up to the
  // nearest .showtail/). Warn, but still proceed if that's truly intended.
  if (resolve(root) === resolve(homedir())) {
    console.log('Warning: initializing Showtail in your HOME directory.');
    console.log('  Work in any subfolder would then be recorded into this one trail.');
    console.log('  Prefer running `showtail init` inside your actual project folder.');
    console.log('');
  }

  // Create the directory tree.
  for (const dir of [
    paths.base,
    paths.sessionsDir,
    paths.objectsDir,
    paths.journalDir,
    paths.reportsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const config: Config = {
    version: CONFIG_VERSION,
    createdAt: new Date().toISOString(),
    settings: {
      git: await isGitRepo(root),
      captureAiOutput: true,
      captureCode: true,
      redact: { enabled: true, secrets: true, pii: true },
    },
  };
  if (options.project) config.project = options.project;

  writeJson(paths.config, config);
  writeState(paths, { currentSessionId: null, currentPromptId: null });
  writeSessions(paths, []);
  writeFileSync(join(paths.base, '.gitattributes'), GITATTRIBUTES, 'utf8');
  writeFileSync(join(paths.base, '.gitignore'), GITIGNORE, 'utf8');

  console.log('Created .showtail/ — your work trail lives here.');
  console.log('');
  console.log('  .showtail/');
  console.log('    config.json      project settings');
  console.log('    sessions/        your work sessions (index of conversations)');
  console.log('    journal/         append-only log of prompts, AI output, and edits');
  console.log('    objects/         content (prompts, AI responses, diffs), deduped');
  console.log('    reports/         generated reports for your educator');
  console.log('');
  if (config.settings.git) {
    console.log('Git detected: commit hashes will be captured automatically.');
  } else {
    console.log(
      'No git repo detected: Showtail will still work, just without commit hashes.',
    );
  }
  console.log('');
  console.log('Next: run `showtail start` to begin your first session.');
}
