/** Local identity stored beside the central history; sessions retain their original attribution. */
import { existsSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ghApiUser, gitUser } from './git.ts';
import { readJson, writeJson } from './storage.ts';
import { dataPath } from './dataHome.ts';

/** A student's resolved identity. `email` is the stable key; `name` is for display. */
export interface Identity {
  email: string;
  name: string;
  githubLogin?: string;
}

/**
 * A last-resort identity derived from the computer itself (OS username + hostname),
 * used when nothing real (gh / git config / env) is available so a student's work is
 * still captured and attributed instead of dropped. Recognizable and stable per machine;
 * replaced automatically the moment a real identity appears (see the provisional upgrade
 * in `resolveActiveAuthorForHook`). `email` is synthetic (`<user>@<host>.local`).
 */
export function syntheticIdentity(): Identity {
  let user = 'student';
  let host = 'local';
  try {
    const u = userInfo().username?.trim();
    if (u) user = u;
  } catch {
    /* keep default */
  }
  try {
    const h = hostname()
      .trim()
      .replace(/\.local$/i, '');
    if (h) host = h;
  } catch {
    /* keep default */
  }
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return { email: `${safe(user)}@${safe(host)}.local`, name: user };
}

/** The machine-level cache: an identity plus its derived slug and a machine id. */
export interface CachedIdentity extends Identity {
  /** Stable author key derived from the email (see {@link slugifyEmail}). */
  slug: string;
  /** Random identifier for this local Showtail installation. */
  machineId: string;
  /**
   * True when this is a computer-derived placeholder ({@link syntheticIdentity}) used
   * because no real identity (gh/git/env) was available yet. The resolver keeps probing
   * for a real one while this is set, and upgrades (re-attributes the work) as soon as it
   * finds it. A real identity never carries this flag.
   */
  provisional?: boolean;
}

/**
 * Turn an email into a filesystem-safe, merge-stable folder key.
 * `alice@example.com` → `alice-at-example-com`. Lowercased so the same address
 * never yields two folders; `@` becomes a readable `-at-`; every other run of
 * non-alphanumeric characters collapses to a single dash.
 */
export function slugifyEmail(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Identity shares the one Showtail data home. */
export function machineIdentityPath(): string {
  return dataPath('identity.json');
}

/** The cached machine identity, or null if this machine has none yet. */
export function readMachineIdentity(): CachedIdentity | null {
  const file = machineIdentityPath();
  if (!existsSync(file)) return null;
  try {
    return readJson<CachedIdentity>(file);
  } catch {
    return null;
  }
}

/** Persist the machine identity cache (atomic write, creates the dir). */
export function writeMachineIdentity(id: CachedIdentity): void {
  writeJson(machineIdentityPath(), id);
}

/** The machine's id, from the cache if present, otherwise a fresh random one. */
export function ensureMachineId(): string {
  return readMachineIdentity()?.machineId ?? randomUUID();
}

export interface ResolveOptions {
  cwd: string;
  /** Allow an interactive prompt as a last resort (only on a TTY command). */
  allowPrompt: boolean;
  /** Allow the (slower) `gh api user` call. Off in hooks to stay fast. Default on. */
  allowGh?: boolean;
}

/**
 * Resolve the student's identity, or `undefined` if nothing could be determined
 * without prompting. See the resolution order in the module doc comment.
 */
export async function resolveIdentity(
  opts: ResolveOptions,
): Promise<Identity | undefined> {
  // 0. Explicit override — for automation, CI, and tests (no subprocess at all).
  const envEmail = process.env.SHOWTAIL_IDENTITY_EMAIL;
  if (envEmail) {
    return {
      email: envEmail,
      name: process.env.SHOWTAIL_IDENTITY_NAME ?? envEmail,
      githubLogin: process.env.SHOWTAIL_IDENTITY_LOGIN || undefined,
    };
  }

  // 1. GitHub, since that is where teammates already share the repo.
  let ghLogin: string | undefined;
  let ghName: string | undefined;
  if (opts.allowGh ?? true) {
    const gh = await ghApiUser(opts.cwd);
    if (gh) {
      ghLogin = gh.login;
      ghName = gh.name;
      if (gh.email) {
        return {
          email: gh.email,
          name: gh.name ?? gh.login ?? gh.email,
          githubLogin: gh.login,
        };
      }
    }
  }

  // 2. Git config — the identity that already stamps their commits.
  const g = await gitUser(opts.cwd);
  if (g.email) {
    return {
      email: g.email,
      name: g.name ?? ghName ?? ghLogin ?? g.email,
      githubLogin: ghLogin,
    };
  }

  // 3. Environment — what git itself would use for authorship, and the common `EMAIL`
  //    var many shells/CI set. A cheap, no-subprocess real-identity source.
  const authorEmail = (
    process.env.GIT_AUTHOR_EMAIL ||
    process.env.GIT_COMMITTER_EMAIL ||
    process.env.EMAIL ||
    ''
  ).trim();
  if (authorEmail) {
    const authorName = (
      process.env.GIT_AUTHOR_NAME ||
      process.env.GIT_COMMITTER_NAME ||
      ''
    ).trim();
    return {
      email: authorEmail,
      name: authorName || g.name || ghName || ghLogin || authorEmail,
      githubLogin: ghLogin,
    };
  }

  // 4. Ask, pre-filling whatever partial info we gathered above.
  if (opts.allowPrompt) {
    return promptIdentity({ name: g.name ?? ghName ?? ghLogin, githubLogin: ghLogin });
  }
  return undefined;
}

/** Ask one question on the terminal, returning the trimmed answer or a default. */
function ask(question: string, def = ''): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = def ? ` [${def}]` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}

/** Interactively collect an identity. Returns undefined if no email is given. */
async function promptIdentity(defaults: {
  name?: string;
  githubLogin?: string;
}): Promise<Identity | undefined> {
  console.log('Showtail needs to know who you are so your work is attributed to you.');
  const email = await ask('Your email');
  if (!email) {
    console.log('No email entered — skipping identity setup for now.');
    return undefined;
  }
  const name = await ask('Your name', defaults.name ?? email);
  return { email, name, githubLogin: defaults.githubLogin };
}
