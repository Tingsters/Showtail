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
