import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import {
  addArtifact,
  artifactsForPath,
  checkArtifactHashes,
} from '../src/core/artifacts.ts';
import { pathsForRoot, type AuthorPaths } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

async function initProject(): Promise<{
  dir: string;
  paths: ReturnType<typeof pathsForRoot>;
  author: AuthorPaths;
}> {
  const dir = makeTempDir();
  await runInit({ cwd: dir });
  const paths = pathsForRoot(dir);
  return { dir, paths, author: authorFor(paths) };
}

describe('artifacts', () => {
  test('recording an artifact stores path, hash, and timestamp', async () => {
    const { dir, paths, author } = await initProject();
    try {
      writeFileSync(join(dir, 'essay.md'), '# My Essay\nFirst draft.');
      const { artifact } = await addArtifact(author, { filePath: 'essay.md' });
      expect(artifact.path).toBe('essay.md');
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isNaN(Date.parse(artifact.timestamp))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('recording the same file twice builds a hash history', async () => {
    const { dir, paths, author } = await initProject();
    try {
      const file = join(dir, 'essay.md');
      writeFileSync(file, 'draft one');
      const { artifact: first } = await addArtifact(author, { filePath: 'essay.md' });
      writeFileSync(file, 'draft two — revised');
      const { artifact: second } = await addArtifact(author, { filePath: 'essay.md' });

      const history = artifactsForPath(author, 'essay.md');
      expect(history.length).toBe(2);
      expect(first.sha256).not.toBe(second.sha256);
    } finally {
      cleanup(dir);
    }
  });

  test('recording unchanged content twice is deduped to one record', async () => {
    const { dir, paths, author } = await initProject();
    try {
      writeFileSync(join(dir, 'essay.md'), 'same content');
      const a = await addArtifact(author, { filePath: 'essay.md' });
      const b = await addArtifact(author, { filePath: 'essay.md' });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(artifactsForPath(author, 'essay.md').length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('a worktree edit is recorded relative to the worktree root', async () => {
    const { dir, paths, author } = await initProject();
    try {
      // Edits made inside .claude/worktrees/<name>/ are real work, captured and
      // recorded by their logical repo path — not the ephemeral worktree path.
      const wtFile = join(dir, '.claude', 'worktrees', 'wt', 'src', 'foo.ts');
      mkdirSync(dirname(wtFile), { recursive: true });
      writeFileSync(wtFile, 'export const foo = 1;');
      const { artifact } = await addArtifact(author, {
        filePath: wtFile,
        diff: '+ export const foo = 1;',
      });
      expect(artifact.path).toBe('src/foo.ts');
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.diffHash).toBeTruthy();

      // A normal (non-worktree) nested edit still records relative to the root.
      const normal = join(dir, 'src', 'bar.ts');
      mkdirSync(dirname(normal), { recursive: true });
      writeFileSync(normal, 'export const bar = 2;');
      const { artifact: n } = await addArtifact(author, { filePath: normal });
      expect(n.path).toBe('src/bar.ts');
    } finally {
      cleanup(dir);
    }
  });

  test('adding a missing file throws a clear error', async () => {
    const { dir, paths, author } = await initProject();
    try {
      await expect(addArtifact(author, { filePath: 'ghost.md' })).rejects.toThrow(
        /File not found/,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('hash check reports match, changed, and missing', async () => {
    const { dir, paths, author } = await initProject();
    try {
      const file = join(dir, 'code.ts');
      writeFileSync(file, 'export const x = 1;');
      await addArtifact(author, { filePath: 'code.ts' });

      let checks = await checkArtifactHashes(paths);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.status).toBe('match');

      // Latest recorded hash should follow the latest snapshot.
      writeFileSync(file, 'export const x = 2;');
      await addArtifact(author, { filePath: 'code.ts' });
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

  test('a worktree edit keeps a clean display path plus a resolvable link path', async () => {
    const { dir, author } = await initProject();
    try {
      const wtFile = join(dir, '.claude', 'worktrees', 'wt', 'src', 'foo.ts');
      mkdirSync(dirname(wtFile), { recursive: true });
      writeFileSync(wtFile, 'export const x = 1;\n');
      const { artifact } = await addArtifact(author, { filePath: wtFile });
      // Display path is stripped to the repo-logical form…
      expect(artifact.path).toBe('src/foo.ts');
      // …but the link path keeps the full trail-root-relative location, so the
      // report's `../../<linkPath>` actually reaches the file.
      expect(artifact.linkPath).toBe('.claude/worktrees/wt/src/foo.ts');
    } finally {
      cleanup(dir);
    }
  });

  test('a plain edit records no separate link path', async () => {
    const { dir, author } = await initProject();
    try {
      writeFileSync(join(dir, 'notes.md'), 'hi');
      const { artifact } = await addArtifact(author, { filePath: 'notes.md' });
      expect(artifact.path).toBe('notes.md');
      expect(artifact.linkPath).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });
});
