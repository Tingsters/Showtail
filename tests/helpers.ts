import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a throwaway temp directory and return its path. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'showtail-test-'));
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
  return { ...process.env, SHOWTAIL_ROOT_CEILING: tmpdir() };
}
