import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import type { Config } from '../types.ts';
import { establishIdentity } from '../core/authors.ts';
import { isGitRepo } from '../core/git.ts';
import { CONFIG_VERSION, pathsForRoot, writeJson, writeState } from '../core/storage.ts';

/**
 * Mark the whole trail as binary so git never normalizes line endings: the
 * object store is content-addressed, and an EOL rewrite (common on Windows)
 * would change bytes and break a file's own hash / the integrity check. This
 * also keeps the shared object store byte-identical across machines, which is
 * what makes a merge of two students' trails conflict-free.
 */
const GITATTRIBUTES = `# Showtail stores content-addressed objects; keep bytes byte-exact.
* -text
`;

/**
 * Ephemeral/regenerable and machine-local bits don't belong in version control.
 * Everything else under .showtail/ — including every author's folder and the
 * shared object store — IS committed, so teammates' trails merge through git.
 */
const GITIGNORE = `state.json
reports/
`;

export interface InitOptions {
  project?: string;
  /** Project root; defaults to cwd. */
  cwd?: string;
}

/**
 * Create the `.showtail/` folder structure and config, then establish the local
 * student's identity (so their work lands in `authors/<slug>/`). Safe to re-run:
 * it won't overwrite an existing config, and a teammate re-running it in a repo
 * that's already set up just bootstraps *their own* author folder.
 */
export async function runInit(options: InitOptions = {}): Promise<void> {
  const root = options.cwd ?? process.cwd();
  const paths = pathsForRoot(root);

  if (existsSync(paths.config)) {
    console.log('Showtail is already set up here (.showtail/config.json exists).');
    // Still make sure *this* student has an author folder — a teammate who just
    // cloned the repo runs `init` to register themselves without re-creating it.
    const author = await establishIdentity(paths, { cwd: root, allowPrompt: true });
    if (author) console.log(`You're tracked as ${author.slug}.`);
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

  // Create the directory tree (per-author folders are created on demand).
  for (const dir of [paths.base, paths.authorsDir, paths.objectsDir, paths.reportsDir]) {
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
  writeFileSync(join(paths.base, '.gitattributes'), GITATTRIBUTES, 'utf8');
  writeFileSync(join(paths.base, '.gitignore'), GITIGNORE, 'utf8');

  // Establish who is working here so their trail is attributed (gh → git → prompt).
  const author = await establishIdentity(paths, { cwd: root, allowPrompt: true });

  console.log('Created .showtail/ — your work trail lives here.');
  console.log('');
  console.log('  .showtail/');
  console.log('    config.json      project settings (shared)');
  console.log('    authors/         one folder per student: their sessions + journal');
  console.log(
    '    objects/         content (prompts, AI responses, diffs), deduped & shared',
  );
  console.log('    reports/         generated reports for your educator');
  console.log('');
  if (author) {
    console.log(
      `You're set up as ${author.slug}. Your teammates each get their own folder.`,
    );
  } else {
    console.log(
      "Couldn't determine your identity yet — set git user.email or run `gh auth login`,",
    );
    console.log('then run `showtail start` to register yourself.');
  }
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
