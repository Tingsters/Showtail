import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import {
  addArtifact,
  artifactsForPath,
  checkArtifactHashes,
  readAllArtifacts,
  importEditArtifact,
  importEditStub,
} from '../src/core/artifacts.ts';
import { CaptureInterruptedError } from '../src/core/captureGuard.ts';
import { addressOf, objectExists } from '../src/core/objects.ts';
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

  test('automatic capture stops at every live artifact write boundary', async () => {
    const { dir, paths, author } = await initProject();
    try {
      for (const stopAt of [1, 2, 3, 4]) {
        const file = `guarded-${stopAt}.ts`;
        const diff = `+ export const guarded${stopAt} = true;`;
        writeFileSync(join(dir, file), `export const guarded${stopAt} = true;`);
        let checks = 0;

        await expect(
          addArtifact(author, {
            filePath: file,
            diff,
            continueCapture: () => {
              checks += 1;
              return checks < stopAt;
            },
          }),
        ).rejects.toBeInstanceOf(CaptureInterruptedError);

        expect(checks).toBe(stopAt);
        expect(objectExists(paths, addressOf(diff))).toBe(stopAt === 4);
        expect(readAllArtifacts(paths)).toHaveLength(0);
      }
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

describe('artifacts: secret-safety invariants', () => {
  /** Every byte under .showtail/, so a canary can be grepped for anywhere. */
  function allTrailText(root: string): string {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(readFileSync(p, 'utf8'));
      }
    };
    walk(join(root, '.showtail'));
    return out.join('\n');
  }
  const CANARY = 'canary-Zq8Zq8Zq8Zq8Zq8Zq8-9f3b';

  test('a .env file the agent writes leaves no trace in the trail', async () => {
    const { dir, author } = await initProject();
    try {
      writeFileSync(
        join(dir, '.env'),
        `OPENAI_API_KEY=${CANARY}\nDB_PASSWORD=${CANARY}\n`,
      );
      const diff = `+OPENAI_API_KEY=${CANARY}\n+DB_PASSWORD=${CANARY}`;
      const res = await addArtifact(author, { filePath: '.env', diff });
      expect(res.created).toBe(false);
      expect(importEditArtifact(author, { path: '.env', diff })).toBe(false);
      expect(importEditStub(author, { path: '.env' })).toBe(false);
      expect(allTrailText(dir)).not.toContain(CANARY);
      expect(artifactsForPath(author, '.env')).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('credential files outside the project are never captured', async () => {
    const { dir, author } = await initProject();
    try {
      const outside = makeTempDir();
      try {
        mkdirSync(join(outside, '.aws'));
        writeFileSync(
          join(outside, '.aws', 'credentials'),
          `aws_secret_access_key=${CANARY}`,
        );
        const res = await addArtifact(author, {
          filePath: join(outside, '.aws', 'credentials'),
          diff: `+aws_secret_access_key=${CANARY}`,
        });
        expect(res.created).toBe(false);
        expect(allTrailText(dir)).not.toContain(CANARY);
        // An ordinary file outside the project is skipped as well.
        writeFileSync(join(outside, 'notes.txt'), 'hello');
        await expect(
          addArtifact(author, { filePath: join(outside, 'notes.txt') }),
        ).rejects.toThrow(/outside the project/);
      } finally {
        cleanup(outside);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('a key straddling the 64KB diff cap is redacted before truncation', async () => {
    const { dir, author } = await initProject();
    try {
      writeFileSync(join(dir, 'app.py'), 'x = 1');
      const pem = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0B'.repeat(10)}\n-----END PRIVATE KEY-----`;
      const diff = `+${'a'.repeat(64 * 1024 - 40)}\n+${pem}`;
      await addArtifact(author, { filePath: 'app.py', diff });
      expect(allTrailText(dir)).not.toContain('MIIEvQIBADANBgkqhkiG9w0B');
    } finally {
      cleanup(dir);
    }
  });

  test('ordinary project files are still captured', async () => {
    const { dir, author } = await initProject();
    try {
      writeFileSync(join(dir, 'main.py'), 'print(1)');
      const res = await addArtifact(author, { filePath: 'main.py', diff: '+print(1)' });
      expect(res.created).toBe(true);
      expect(res.artifact.path).toBe('main.py');
    } finally {
      cleanup(dir);
    }
  });
});
