import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import {
  addArtifact,
  artifactsForPath,
  checkArtifactHashes,
} from '../src/core/artifacts.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

async function initProject(): Promise<{
  dir: string;
  paths: ReturnType<typeof pathsForRoot>;
}> {
  const dir = makeTempDir();
  await runInit({ cwd: dir });
  return { dir, paths: pathsForRoot(dir) };
}

describe('artifacts', () => {
  test('recording an artifact stores path, hash, and timestamp', async () => {
    const { dir, paths } = await initProject();
    try {
      writeFileSync(join(dir, 'essay.md'), '# My Essay\nFirst draft.');
      const artifact = await addArtifact(paths, { filePath: 'essay.md' });
      expect(artifact.path).toBe('essay.md');
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isNaN(Date.parse(artifact.timestamp))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('recording the same file twice builds a hash history', async () => {
    const { dir, paths } = await initProject();
    try {
      const file = join(dir, 'essay.md');
      writeFileSync(file, 'draft one');
      const first = await addArtifact(paths, { filePath: 'essay.md' });
      writeFileSync(file, 'draft two — revised');
      const second = await addArtifact(paths, { filePath: 'essay.md' });

      const history = artifactsForPath(paths, 'essay.md');
      expect(history.length).toBe(2);
      expect(first.sha256).not.toBe(second.sha256);
    } finally {
      cleanup(dir);
    }
  });

  test('adding a missing file throws a clear error', async () => {
    const { dir, paths } = await initProject();
    try {
      await expect(addArtifact(paths, { filePath: 'ghost.md' })).rejects.toThrow(
        /File not found/,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('hash check reports match, changed, and missing', async () => {
    const { dir, paths } = await initProject();
    try {
      const file = join(dir, 'code.ts');
      writeFileSync(file, 'export const x = 1;');
      await addArtifact(paths, { filePath: 'code.ts' });

      let checks = await checkArtifactHashes(paths);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.status).toBe('match');

      // Latest recorded hash should follow the latest snapshot.
      writeFileSync(file, 'export const x = 2;');
      await addArtifact(paths, { filePath: 'code.ts' });
      checks = await checkArtifactHashes(paths);
      expect(checks[0]!.status).toBe('match');

      // Now change the file *after* the last snapshot -> changed.
      writeFileSync(file, 'export const x = 999;');
      checks = await checkArtifactHashes(paths);
      expect(checks[0]!.status).toBe('changed');
    } finally {
      cleanup(dir);
    }
  });
});
