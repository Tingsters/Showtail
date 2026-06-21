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
  readJson,
  readState,
  updateState,
  writeJson,
  writeSessions,
  type AuthorPaths,
  type ShowtailPaths,
} from './storage.ts';
import {
  ensureMachineId,
  readMachineIdentity,
  resolveIdentity,
  slugifyEmail,
  writeMachineIdentity,
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
    });
  }
  if (!existsSync(ap.sessionsIndex)) writeSessions(ap, []);
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
  if (existing) return existing;
  const established = await establishIdentity(paths, {
    cwd: opts.cwd,
    allowPrompt: opts.allowPrompt ?? true,
  });
  if (established) return established;
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
  // 1. Already established for this project.
  const slug = readState(paths).currentAuthorSlug;
  if (slug) return authorPaths(paths, slug, ensureMachineId());

  // 2. This machine knows the student from another repo — adopt it, no prompt.
  const cached = readMachineIdentity();
  if (cached) {
    const ap = ensureAuthor(paths, cached, cached.machineId);
    updateState(paths, { currentAuthorSlug: cached.slug });
    return ap;
  }

  // 3. Last resort: a silent git-config read (no gh, no prompt). Seed the cache.
  const identity = await resolveIdentity({
    cwd: opts.cwd,
    allowPrompt: false,
    allowGh: false,
  });
  if (!identity) return undefined;
  return cacheAndEnsure(paths, identity);
}

/** Write the machine cache, create the author folder, and mark it active. */
function cacheAndEnsure(paths: ShowtailPaths, identity: Identity): AuthorPaths {
  const machineId = ensureMachineId();
  const slug = slugifyEmail(identity.email);
  writeMachineIdentity({ ...identity, slug, machineId });
  const ap = ensureAuthor(paths, identity, machineId);
  updateState(paths, { currentAuthorSlug: slug });
  return ap;
}
