import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../types.ts';
import { establishIdentity } from '../core/authors.ts';
import { gitToplevel } from '../core/git.ts';
import { emitJson } from '../core/output.ts';
import {
  CONFIG_VERSION,
  pathsForRoot,
  readConfig,
  writeJson,
  writeState,
  type ShowtailPaths,
} from '../core/storage.ts';

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
  /** Emit machine-readable JSON instead of the human banner. */
  json?: boolean;
}

export interface EnsureInitOptions {
  project?: string;
}

/**
 * Create the shared `.showtail/` folder structure and config at `root` if it
 * isn't there yet, and report whether it was just created. This is the
 * idempotent core shared by the interactive `showtail init`, `showtail ensure`,
 * and the hook auto-init path. It prints nothing and does NOT establish an author
 * identity — callers own any user-facing output and identity resolution. Per-
 * author folders are created on demand (by `ensureAuthor`), not here.
 *
 * Concurrency: two near-simultaneous first hooks for the same new project can
 * both pass the config check. `writeJson` is an atomic temp+rename so config is
 * never torn; and `state` is written only when still absent, so a racing hook
 * that already recorded the active author isn't reset.
 */
export async function ensureInitialized(
  root: string,
  options: EnsureInitOptions = {},
): Promise<{ created: boolean; paths: ShowtailPaths }> {
  const paths = pathsForRoot(root);
  if (existsSync(paths.config)) return { created: false, paths };

  // Create the shared directory tree (per-author folders are created on demand).
  for (const dir of [paths.base, paths.authorsDir, paths.objectsDir, paths.reportsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // One git probe drives both the commit-capture flag and the anchor record:
  // a repo whose top-level *is* this root was anchored at the repo; otherwise
  // the trail sits at a plain working dir.
  const top = await gitToplevel(root);
  const git = top !== undefined;
  const anchorKind: 'git' | 'cwd' = git && resolve(top) === resolve(root) ? 'git' : 'cwd';

  const config: Config = {
    version: CONFIG_VERSION,
    createdAt: new Date().toISOString(),
    anchor: resolve(root),
    anchorKind,
    settings: {
      git,
      captureAiOutput: true,
      captureCode: true,
      redact: { enabled: true, secrets: true, pii: true },
    },
  };
  if (options.project) config.project = options.project;

  writeJson(paths.config, config);
  if (!existsSync(paths.state)) {
    writeState(paths, { currentSessionId: null, currentPromptId: null });
  }
  writeFileSync(join(paths.base, '.gitattributes'), GITATTRIBUTES, 'utf8');
  writeFileSync(join(paths.base, '.gitignore'), GITIGNORE, 'utf8');

  return { created: true, paths };
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
    if (options.json) {
      emitJson({
        created: false,
        root,
        anchorKind: readConfig(paths).anchorKind ?? null,
      });
      return;
    }
    console.log('Showtail is already set up here (.showtail/config.json exists).');
    // Still make sure *this* student has an author folder — a teammate who just
    // cloned the repo runs `init` to register themselves without re-creating it.
    const author = await establishIdentity(paths, { cwd: root, allowPrompt: true });
    if (author) console.log(`You're tracked as ${author.slug}.`);
    console.log('Run `showtail start` to begin a work session.');
    return;
  }

  if (options.json) {
    await ensureInitialized(root, { project: options.project });
    // Register the local student silently when possible (no prompt in JSON mode).
    await establishIdentity(paths, { cwd: root, allowPrompt: false });
    emitJson({ created: true, root, anchorKind: readConfig(paths).anchorKind ?? null });
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

  await ensureInitialized(root, { project: options.project });
  const config = readConfig(paths);

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
