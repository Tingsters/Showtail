import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeAuthorPaths, ensureAuthor } from '../src/core/authors.ts';
import { ensureMachineId, slugifyEmail } from '../src/core/identity.ts';
import {
  authorPaths,
  type AuthorPaths,
  type ShowtailPaths,
} from '../src/core/storage.ts';

/** The deterministic test identity seeded in tests/setup.ts. */
export const TEST_EMAIL = 'tester@example.com';
export const TEST_SLUG = 'tester-at-example-com';

/** Create a throwaway temp directory and return its path. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'showtail-test-'));
}

/**
 * The active author's paths for an initialized test project. `runInit` (run with
 * the identity env from setup.ts) establishes the author; this resolves it.
 */
export function authorFor(paths: ShowtailPaths): AuthorPaths {
  const author = activeAuthorPaths(paths);
  if (!author) {
    throw new Error(
      'No active author. Call runInit({cwd}) first (setup.ts seeds the identity env).',
    );
  }
  return author;
}

/**
 * Create an author folder directly (no init) for a given email — used by tests
 * that exercise multi-author behavior without spinning up two machines.
 */
export function seedAuthor(paths: ShowtailPaths, email: string): AuthorPaths {
  const machineId = ensureMachineId();
  ensureAuthor(paths, { email, name: email }, machineId);
  return authorPaths(paths, slugifyEmail(email), machineId);
}

/** Remove a temp directory created with {@link makeTempDir}. */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Environment for spawning the real CLI from a test. Caps `findRoot`'s upward
 * walk at the OS temp dir so a test in a non-initialized temp dir can never
 * escape its sandbox and resolve a real `~/.showtail` (temp dirs live under the
 * user's home). Every test temp dir is created under `tmpdir()` by
 * {@link makeTempDir}, so this boundary is safe for both root- and subdir-cwd
 * runs while keeping the developer's live trail untouched.
 */
export function spawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHOWTAIL_ROOT_CEILING: tmpdir(),
    // Deterministic identity so a spawned `showtail init` never prompts or shells
    // out to gh/git, and caches its machine identity inside the temp dir.
    SHOWTAIL_IDENTITY_EMAIL: process.env.SHOWTAIL_IDENTITY_EMAIL ?? TEST_EMAIL,
    SHOWTAIL_IDENTITY_NAME: process.env.SHOWTAIL_IDENTITY_NAME ?? 'Test Student',
    SHOWTAIL_IDENTITY_HOME:
      process.env.SHOWTAIL_IDENTITY_HOME ?? join(tmpdir(), 'showtail-test-identity'),
  };
}
