/**
 * Authors: the students contributing to a project. Each one owns a folder under
 * `.showtail/authors/<slug>/` holding their `author.json` identity, their
 * `sessions.json`, and their own append-only `journal/`. There is deliberately
 * NO shared roster file — the roster is derived by scanning the directory — so
 * two students adding themselves on two git branches never conflict on merge.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import {
  authorPaths,
  migrateLegacySessions,
  readJson,
  readState,
  updateState,
  writeJson,
  type AuthorPaths,
  type ShowtailPaths,
} from './storage.ts';
import {
  ensureMachineId,
  readMachineIdentity,
  resolveIdentity,
  slugifyEmail,
  syntheticIdentity,
  writeMachineIdentity,
  type CachedIdentity,
  type Identity,
} from './identity.ts';

/** The contents of an `author.json` — one student's identity within a project. */
export interface Author {
  /** Folder key (slugified email). */
  slug: string;
  email: string;
  name: string;
  githubLogin?: string;
  /** ISO-8601 timestamp the author folder was first created. */
  createdAt: string;
  /**
   * True while this is a computer-derived placeholder ({@link syntheticIdentity}) held
   * only until a real identity (gh/git/env) appears — at which point the work is
   * re-attributed to the real author and this folder is removed. A real author never
   * carries this flag.
   */
  provisional?: boolean;
}

/** Read one author's `author.json`, or null if it isn't there. */
export function readAuthor(author: AuthorPaths): Author | null {
  if (!existsSync(author.authorFile)) return null;
  try {
    return readJson<Author>(author.authorFile);
  } catch {
    return null;
  }
}

/** Write one author's `author.json`. */
export function writeAuthor(author: AuthorPaths, value: Author): void {
  writeJson(author.authorFile, value);
}

/** Every author slug in the project, derived by scanning `authors/`. */
export function authorSlugs(paths: ShowtailPaths): string[] {
  if (!existsSync(paths.authorsDir)) return [];
  const slugs: string[] = [];
  for (const name of readdirSync(paths.authorsDir)) {
    const ap = authorPaths(paths, name);
    if (existsSync(ap.authorFile)) slugs.push(name);
  }
  return slugs.sort();
}

/** Every author record in the project. */
export function readAllAuthors(paths: ShowtailPaths): Author[] {
  const out: Author[] = [];
  for (const slug of authorSlugs(paths)) {
    const a = readAuthor(authorPaths(paths, slug));
    if (a) out.push(a);
  }
  return out;
}

/**
 * Ensure an author folder exists for `identity` and return its paths. Idempotent:
 * creates `authors/<slug>/`, `author.json`, and an empty `sessions.json` only
 * when missing, so re-running never clobbers existing data.
 */
export function ensureAuthor(
  paths: ShowtailPaths,
  identity: Identity,
  machineId?: string,
  opts?: { provisional?: boolean },
): AuthorPaths {
  const slug = slugifyEmail(identity.email);
  const ap = authorPaths(paths, slug, machineId);
  mkdirSync(ap.dir, { recursive: true });
  if (!existsSync(ap.authorFile)) {
    writeAuthor(ap, {
      slug,
      email: identity.email,
      name: identity.name,
      githubLogin: identity.githubLogin,
      createdAt: new Date().toISOString(),
      ...(opts?.provisional ? { provisional: true } : {}),
    });
  }
  // Session shards are created on first write (per-machine). No empty file is
  // seeded here — `readSessions` already tolerates their absence, and seeding one
  // would clobber this machine's shard on every re-run.
  return ap;
}

/**
 * The active author on this machine for `paths` (whoever local captures write
 * as), from `state.json.currentAuthorSlug`, or null if none is set yet. Carries
 * the machine id so the returned paths can be appended to.
 */
export function activeAuthorPaths(paths: ShowtailPaths): AuthorPaths | null {
  const slug = readState(paths).currentAuthorSlug;
  if (!slug) return null;
  return authorPaths(paths, slug, ensureMachineId());
}

/**
 * Resolve the active author, establishing identity interactively if needed.
 * Used by TTY commands (`init`, `start`, …): resolves gh → git → prompt, caches
 * the result at the machine level, creates the author folder, and records the
 * active slug in state. Returns null only if the student declined to identify.
 */
export async function establishIdentity(
  paths: ShowtailPaths,
  opts: { cwd: string; allowPrompt: boolean },
): Promise<AuthorPaths | null> {
  const identity = await resolveIdentity({
    cwd: opts.cwd,
    allowPrompt: opts.allowPrompt,
    allowGh: true,
  });
  if (!identity) return null;
  return cacheAndEnsure(paths, identity);
}

/**
 * Resolve the active author for a write command, establishing identity
 * interactively if this machine hasn't registered one yet. Throws a friendly
 * error if the student can't be identified (and declined to enter one).
 */
export async function requireActiveAuthor(
  paths: ShowtailPaths,
  opts: { cwd: string; allowPrompt?: boolean },
): Promise<AuthorPaths> {
  const existing = activeAuthorPaths(paths);
  if (existing) {
    try {
      migrateLegacySessions(existing);
    } catch {
      /* best-effort */
    }
    return existing;
  }
  const established = await establishIdentity(paths, {
    cwd: opts.cwd,
    allowPrompt: opts.allowPrompt ?? true,
  });
  if (established) {
    try {
      migrateLegacySessions(established);
    } catch {
      /* best-effort */
    }
    return established;
  }
  throw new Error(
    'Could not determine who you are. Set your git identity ' +
      '(`git config user.email "you@example.com"`) or run `gh auth login`, then try again.',
  );
}

/**
 * The cheap, hook-safe path to the active author: never prompts, never hits the
 * network. Order: the project's recorded slug → the machine cache → a silent
 * `git config` read. Returns undefined when identity can't be settled without
 * interaction, so the hook simply no-ops (a hook must never block the session).
 */
export async function resolveActiveAuthorForHook(
  paths: ShowtailPaths,
  opts: { cwd: string },
): Promise<AuthorPaths | undefined> {
  const machineId = ensureMachineId();
  const currentSlug = readState(paths).currentAuthorSlug;
  const currentAuthor = currentSlug
    ? authorPaths(paths, currentSlug, machineId)
    : undefined;
  const currentIsProvisional = currentAuthor
    ? (readAuthor(currentAuthor)?.provisional ?? false)
    : false;

  // Fast path: an established, REAL (non-provisional) author for this project.
  if (currentAuthor && !currentIsProvisional) return currentAuthor;

  // Unestablished or provisional → look for a real identity: the machine cache (if
  // real), then a cheap silent probe (git config + env; no gh, no prompt).
  const cached = readMachineIdentity();
  let real: Identity | undefined = cached && !cached.provisional ? cached : undefined;
  if (!real) {
    real =
      (await resolveIdentity({ cwd: opts.cwd, allowPrompt: false, allowGh: false })) ??
      undefined;
  }

  if (real) {
    const realAuthor = cacheAndEnsure(paths, real);
    // A real identity just appeared over a provisional placeholder → move the
    // placeholder's work to the real author and drop it. Best-effort; the hook never
    // blocks, and the work is safe in the ledger either way.
    if (
      currentAuthor &&
      currentIsProvisional &&
      slugifyEmail(real.email) !== currentSlug
    ) {
      try {
        const { upgradeProvisionalAuthor } = await import('./provisionalUpgrade.ts');
        await upgradeProvisionalAuthor(paths, currentAuthor, realAuthor, machineId, real);
      } catch {
        /* placeholder lingers until next time; nothing lost */
      }
    }
    return realAuthor;
  }

  // No real identity anywhere → a computer-derived placeholder so work is still captured
  // and reported (never dropped). Upgraded automatically once a real identity appears.
  if (currentAuthor && currentIsProvisional) return currentAuthor;
  return createProvisionalAuthor(paths, machineId, cached);
}

/** Write the machine cache (as REAL), create the author folder, and mark it active. */
function cacheAndEnsure(paths: ShowtailPaths, identity: Identity): AuthorPaths {
  const machineId = ensureMachineId();
  const slug = slugifyEmail(identity.email);
  writeMachineIdentity({ ...identity, slug, machineId });
  const ap = ensureAuthor(paths, identity, machineId);
  updateState(paths, { currentAuthorSlug: slug });
  return ap;
}

/**
 * Create (or adopt) a computer-derived placeholder author ({@link syntheticIdentity}) so
 * a student's work is captured and reported even before any real identity exists. Cached
 * with `provisional: true` so the resolver keeps probing and upgrades to the real
 * identity as soon as one appears. Never prompts.
 */
function createProvisionalAuthor(
  paths: ShowtailPaths,
  machineId: string,
  cached: CachedIdentity | null,
): AuthorPaths {
  const identity: Identity =
    cached && cached.provisional
      ? { email: cached.email, name: cached.name, githubLogin: cached.githubLogin }
      : syntheticIdentity();
  const slug = slugifyEmail(identity.email);
  if (!(cached && cached.provisional)) {
    writeMachineIdentity({ ...identity, slug, machineId, provisional: true });
  }
  const ap = ensureAuthor(paths, identity, machineId, { provisional: true });
  updateState(paths, { currentAuthorSlug: slug });
  return ap;
}

/**
 * For non-hook commands (`report`/`status`): if the active author is a provisional
 * placeholder and a real identity is now resolvable (gh allowed, no prompt), upgrade and
 * re-attribute the work so the turn-in/output is under the student's real identity — even
 * if they never made a git commit. Best-effort, silent, never throws.
 */
export async function upgradeIdentityIfProvisional(
  paths: ShowtailPaths,
  opts: { cwd: string; allowGh?: boolean },
): Promise<void> {
  try {
    const currentSlug = readState(paths).currentAuthorSlug;
    if (!currentSlug) return;
    const machineId = ensureMachineId();
    const currentAuthor = authorPaths(paths, currentSlug, machineId);
    if (!(readAuthor(currentAuthor)?.provisional ?? false)) return;
    const real = await resolveIdentity({
      cwd: opts.cwd,
      allowPrompt: false,
      allowGh: opts.allowGh ?? true,
    });
    if (!real || slugifyEmail(real.email) === currentSlug) return;
    const realAuthor = cacheAndEnsure(paths, real);
    const { upgradeProvisionalAuthor } = await import('./provisionalUpgrade.ts');
    await upgradeProvisionalAuthor(paths, currentAuthor, realAuthor, machineId, real);
  } catch {
    /* best-effort */
  }
}
