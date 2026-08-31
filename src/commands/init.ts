import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../types.ts';
import { establishIdentity } from '../core/authors.ts';
import { gitToplevel } from '../core/git.ts';
import { sessionTouchesPath, unplacedSessions } from '../core/ledger.ts';
import { emitJson } from '../core/output.ts';
import { makeId } from '../core/ids.ts';
import { noteKnownProject } from '../core/globalConfig.ts';
import {
  matchSessionToRoot,
  prepareCandidateIndex,
  type CandidateIndex,
  type PathRebase,
} from '../core/relocate.ts';
import {
  CONFIG_VERSION,
  ensureTrailId,
  pathsForRoot,
  readConfig,
  writeConfig,
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
 * The negation that keeps journal segments committable. Journal files are named
 * `journal/<machine>/0001.log`, and a `*.log` line in the *project's* own
 * `.gitignore` — which the Node, Python and Java templates all ship — silently
 * excludes every one of them. The trail then commits with its config and object
 * store but **no journal**, so the educator receives a trail containing none of
 * the student's prompts, and `verify`'s git-history check has nothing to read.
 *
 * A deeper `.gitignore` overrides a shallower one, and re-inclusion works here
 * because only the files were excluded, never their parent directories.
 */
const JOURNAL_UNIGNORE = '!authors/**/journal/**/*.log';

/**
 * Ephemeral/regenerable and machine-local bits don't belong in version control.
 * Everything else under .showtail/ — including every author's folder and the
 * shared object store — IS committed, so teammates' trails merge through git.
 */
const GITIGNORE = `state.json
reports/
diag/

# Keep journal segments committable even when the project ignores *.log.
${JOURNAL_UNIGNORE}
`;

/**
 * Make sure the trail's `.gitignore` carries {@link JOURNAL_UNIGNORE}.
 *
 * Written on create, but also repaired on every `ensure`: trails created before
 * this existed are the ones actually at risk, and their journals are silently
 * uncommitted right now. Appends rather than rewrites, so a line someone added
 * themselves survives.
 */
export function ensureJournalUnignored(paths: ShowtailPaths): void {
  const file = join(paths.base, '.gitignore');
  if (!existsSync(file)) {
    writeFileSync(file, GITIGNORE, 'utf8');
    return;
  }
  const current = readFileSync(file, 'utf8');
  if (current.includes(JOURNAL_UNIGNORE)) return;
  const sep = current.endsWith('\n') ? '' : '\n';
  writeFileSync(
    file,
    `${current}${sep}\n# Keep journal segments committable even when the project ignores *.log.\n${JOURNAL_UNIGNORE}\n`,
    'utf8',
  );
}

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
  if (existsSync(paths.config)) {
    // Existing trail: upgrade it in place (mint trailId + bump version on a v3
    // trail). No-op once already at the current version.
    ensureTrailId(paths);
    // Repair a trail whose journal a project-level `*.log` rule is silently
    // keeping out of git. Trails created before that negation existed are the
    // ones actually affected, and they only get fixed on a path like this one.
    ensureJournalUnignored(paths);
    noteKnownProject(root, readConfig(paths).trailId);
    return { created: false, paths };
  }

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
    // Stable id the global ledger links sessions to (survives the repo moving).
    trailId: makeId('trl'),
    settings: {
      git,
      captureAiOutput: true,
      captureCode: true,
      captureToolCalls: true,
      redact: { enabled: true, secrets: true, pii: true },
    },
  };
  if (options.project) config.project = options.project;

  writeConfig(paths, config);
  noteKnownProject(root, config.trailId);
  if (!existsSync(paths.state)) {
    writeState(paths, { currentSessionId: null, currentPromptId: null });
  }
  writeFileSync(join(paths.base, '.gitattributes'), GITATTRIBUTES, 'utf8');
  writeFileSync(join(paths.base, '.gitignore'), GITIGNORE, 'utf8');

  return { created: true, paths };
}

/** What a backfill sweep placed, and what it found but declined to place. */
export interface BackfillResult {
  placed: number;
  /**
   * Sessions whose work matched only on content *similarity* (Tier B). Reported so
   * the student can confirm with `showtail move`, never auto-attributed: in a
   * provenance tool a wrong placement is worse than a missed one.
   */
  candidates: Array<{ id: string; detail: string }>;
}

/**
 * Pull every unplaced session whose captured work belongs under `root` into this
 * trail. This is what makes `showtail track <folder>` rescue work Showtail had
 * parked in the inbox before the folder was a project (e.g. book exercises).
 *
 * Two ways a session can belong here. First the recorded-path test, which is the
 * common case and the original behavior. Failing that — because the student moved
 * the files, or had the AI move them, so every recorded absolute path is now stale
 * — we fall back to content-lineage matching (see `relocate.ts`; never filenames).
 * Deterministic Tier-A evidence places the session; weaker Tier-B evidence is only
 * reported, so attribution never shifts on a guess.
 *
 * Target-missing sessions are considered too, not just `inbox` ones: a trail whose
 * folder moved leaves its sessions `placed` against a path that no longer exists,
 * and those are exactly the ones needing rescue.
 *
 * Best-effort per session; a failure leaves that session where it was. Identity is
 * already established by the caller, so `reattach` resolves the author without
 * prompting. `reattach` is dynamically imported to avoid an init↔reattach cycle.
 */
async function backfillInboxUnder(root: string): Promise<BackfillResult> {
  const { reattachLedgerSession } = await import('./reattach.ts');
  const result: BackfillResult = { placed: 0, candidates: [] };
  const sessions = unplacedSessions({ includeHidden: true });
  if (sessions.length === 0) return result;

  // Walked and hashed once, then shared across every session tested against it.
  let index: CandidateIndex | undefined;

  for (const session of sessions) {
    let why: string | null = sessionTouchesPath(session, root)
      ? 'captured under this folder'
      : null;
    let rebase: PathRebase | undefined;

    if (!why) {
      index ??= prepareCandidateIndex(root);
      const match = await matchSessionToRoot(session, root, {}, index);
      if (match?.tier === 'A') {
        why = match.detail;
        rebase = match.rebase;
      } else if (match) {
        result.candidates.push({ id: session.id, detail: match.detail });
        continue;
      }
    }
    if (!why) continue;

    try {
      await reattachLedgerSession(session, root, { rebase });
      result.placed += 1;
    } catch {
      /* best-effort — a failed session simply stays where it was */
    }
  }
  return result;
}

/** Print what a backfill did, including near-misses the student can confirm. */
function reportBackfill(result: BackfillResult): void {
  if (result.placed > 0) {
    console.log(
      `Pulled ${result.placed} already-captured session(s) here from your inbox.`,
    );
    console.log('');
  }
  if (result.candidates.length > 0) {
    console.log(
      `${result.candidates.length} more session(s) look like they belong here, but the match`,
    );
    console.log("isn't certain, so they were left alone:");
    for (const c of result.candidates) {
      console.log(`  ${c.id} — ${c.detail}`);
    }
    console.log('  Place one with: showtail move <id> --to .');
    console.log('');
  }
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
    // Repair a trail whose journal a project-level `*.log` rule is keeping out of
    // git. `showtail track .` is what `verify` tells people to run for this, so it
    // has to actually fix it — and this is the branch a re-run takes.
    ensureJournalUnignored(paths);
    // The one mutation a re-run performs: set/update the project name. (init is
    // intentionally the single project-config entry point — no separate command.)
    let projectUpdated: string | null = null;
    if (options.project) {
      const config = readConfig(paths);
      if (config.project !== options.project) {
        config.project = options.project;
        writeConfig(paths, config);
      }
      projectUpdated = options.project;
    }

    // A re-run still backfills. This matters for the student who MOVED an already
    // tracked project: `.showtail/` travelled with the folder, so `init`/`track`
    // takes this branch — and returning early here is exactly what used to leave
    // their orphaned sessions stranded in the ledger.
    if (options.json) {
      const cfg = readConfig(paths);
      const jsonAuthor = await establishIdentity(paths, {
        cwd: root,
        allowPrompt: false,
      });
      const back = jsonAuthor
        ? await backfillInboxUnder(root)
        : { placed: 0, candidates: [] as BackfillResult['candidates'] };
      emitJson({
        created: false,
        root,
        anchorKind: cfg.anchorKind ?? null,
        project: cfg.project ?? null,
        backfilled: back.placed,
        candidates: back.candidates,
      });
      return;
    }
    console.log('Showtail is already set up here (.showtail/config.json exists).');
    if (projectUpdated) console.log(`Updated project name to "${projectUpdated}".`);
    // Still make sure *this* student has an author folder — a teammate who just
    // cloned the repo runs `init` to register themselves without re-creating it.
    const author = await establishIdentity(paths, { cwd: root, allowPrompt: true });
    if (author) console.log(`You're tracked as ${author.slug}.`);
    if (author) reportBackfill(await backfillInboxUnder(root));
    console.log('Just start working with your AI tool — capture happens automatically.');
    return;
  }

  if (options.json) {
    await ensureInitialized(root, { project: options.project });
    // Register the local student silently when possible (no prompt in JSON mode).
    const jsonAuthor = await establishIdentity(paths, { cwd: root, allowPrompt: false });
    const back = jsonAuthor
      ? await backfillInboxUnder(root)
      : { placed: 0, candidates: [] as BackfillResult['candidates'] };
    emitJson({
      created: true,
      root,
      anchorKind: readConfig(paths).anchorKind ?? null,
      backfilled: back.placed,
      candidates: back.candidates,
    });
    return;
  }

  // Guard against initializing in the home directory: that would make every
  // folder under your home look like this one project (commands walk up to the
  // nearest .showtail/). Warn, but still proceed if that's truly intended.
  if (resolve(root) === resolve(homedir())) {
    console.log('Warning: initializing Showtail in your HOME directory.');
    console.log('  Work in any subfolder would then be recorded into this one trail.');
    console.log('  Prefer running `showtail track` inside your actual project folder.');
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
      'No git/gh identity yet — Showtail will still capture your work under a temporary',
    );
    console.log(
      'name and switch it to your real identity automatically once you set git user.email',
    );
    console.log('(which you do to commit/collaborate anyway).');
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
  if (author) reportBackfill(await backfillInboxUnder(root));
  console.log('Next: just start working with your AI tool — capture is automatic.');
}
