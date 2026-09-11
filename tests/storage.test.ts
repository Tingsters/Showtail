import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  NotInitializedError,
  appendJsonl,
  eligibleProjectRoot,
  findRoot,
  isHomedirCatchAll,
  isPathUnder,
  pathsForRoot,
  readJsonl,
  requirePaths,
  toRepoRelative,
  writeJson,
  readJson,
  resolveProjectContext,
} from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('storage', () => {
  test('isHomedirCatchAll only matches the home directory', () => {
    expect(isHomedirCatchAll(homedir())).toBe(true);
    expect(isHomedirCatchAll(join(homedir(), 'projects', 'app'))).toBe(false);
    expect(isHomedirCatchAll(makeTempDir())).toBe(false);
  });

  test('isPathUnder handles a filesystem root without doubling its separator', () => {
    const root = parse(tmpdir()).root;
    expect(isPathUnder(join(root, 'child'), root)).toBe(true);
  });

  test('JSON round-trips', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'data.json');
      writeJson(file, { a: 1, b: ['x', 'y'] });
      expect(readJson<Record<string, unknown>>(file)).toEqual({ a: 1, b: ['x', 'y'] });
    } finally {
      cleanup(dir);
    }
  });

  test('JSONL appends and reads, skipping blank lines', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'log.jsonl');
      appendJsonl(file, { n: 1 });
      appendJsonl(file, { n: 2 });
      expect(readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      cleanup(dir);
    }
  });

  test('readJsonl of a missing file is empty', () => {
    const dir = makeTempDir();
    try {
      expect(readJsonl(join(dir, 'nope.jsonl'))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('findRoot walks up to the .showtail folder', () => {
    const dir = makeTempDir();
    try {
      const paths = pathsForRoot(dir);
      mkdirSync(paths.base, { recursive: true });
      const nested = join(dir, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      expect(findRoot(nested)).toBe(dir);
    } finally {
      cleanup(dir);
    }
  });

  test('a nested git repo is not captured by a broad parent trail', () => {
    const parent = makeTempDir();
    try {
      mkdirSync(join(parent, '.showtail'), { recursive: true });
      const repo = join(parent, 'projects', 'parser');
      const nested = join(repo, 'src');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(nested, { recursive: true });

      expect(eligibleProjectRoot(nested)).toBe(repo);
      expect(findRoot(nested)).toBeNull();

      mkdirSync(join(repo, '.showtail'), { recursive: true });
      expect(findRoot(nested)).toBe(repo);
    } finally {
      cleanup(parent);
    }
  });

  test('a non-git project marker outranks a broad parent trail', () => {
    const parent = makeTempDir();
    try {
      mkdirSync(join(parent, '.showtail'), { recursive: true });
      const project = join(parent, 'courses', 'calculator');
      const nested = join(project, 'src');
      mkdirSync(nested, { recursive: true });
      writeJson(join(project, 'package.json'), { private: true });

      expect(eligibleProjectRoot(nested)).toBe(project);
      expect(findRoot(nested)).toBeNull();
    } finally {
      cleanup(parent);
    }
  });

  test('git keeps a monorepo together despite nested package markers', () => {
    const repo = makeTempDir();
    try {
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.showtail'), { recursive: true });
      const pkg = join(repo, 'packages', 'web');
      const nested = join(pkg, 'src');
      mkdirSync(nested, { recursive: true });
      writeJson(join(pkg, 'package.json'), { private: true });

      expect(eligibleProjectRoot(nested)).toBe(repo);
      expect(findRoot(nested)).toBe(repo);
    } finally {
      cleanup(repo);
    }
  });

  test('ordinary subfolders still inherit their tracked project root', () => {
    const project = makeTempDir();
    try {
      mkdirSync(join(project, '.showtail'), { recursive: true });
      const nested = join(project, 'notes', 'drafts');
      mkdirSync(nested, { recursive: true });
      expect(eligibleProjectRoot(nested)).toBe(project);
      expect(findRoot(nested)).toBe(project);
    } finally {
      cleanup(project);
    }
  });

  test('an empty .showtail directory is still an initialization candidate', () => {
    const project = makeTempDir();
    try {
      mkdirSync(join(project, '.showtail'));
      expect(resolveProjectContext({ cwd: project })).toEqual({
        state: 'candidate',
        root: project,
        evidence: 'trail',
      });
    } finally {
      cleanup(project);
    }
  });

  test('edit evidence keeps a normal cwd instead of turning src into the project', () => {
    const project = makeTempDir();
    try {
      const src = join(project, 'src');
      mkdirSync(src);
      const file = join(src, 'index.ts');
      writeFileSync(file, 'export {};\n');

      expect(resolveProjectContext({ cwd: project, editPaths: [file] })).toEqual({
        state: 'candidate',
        root: project,
        evidence: 'cwd',
      });
    } finally {
      cleanup(project);
    }
  });

  test('persisted edit evidence never inherits the reporting process cwd', () => {
    const project = makeTempDir();
    try {
      const src = join(project, 'src');
      mkdirSync(src);
      const file = join(src, 'index.ts');
      writeFileSync(file, 'export {};\n');

      expect(resolveProjectContext({ cwd: null, editPaths: [file] })).toEqual({
        state: 'candidate',
        root: src,
        evidence: 'edit',
      });
    } finally {
      cleanup(project);
    }
  });

  test('workspace evidence routes a folderless launch into the opened project', () => {
    const launcher = makeTempDir();
    const project = makeTempDir();
    try {
      const file = join(project, 'index.ts');
      writeFileSync(file, 'export {};\n');

      expect(
        resolveProjectContext({
          cwd: launcher,
          editPaths: [file],
          workspacePaths: [project],
        }),
      ).toEqual({ state: 'candidate', root: project, evidence: 'workspace' });
    } finally {
      cleanup(launcher);
      cleanup(project);
    }
  });

  test('nested workspace hints resolve to the most specific root', () => {
    const project = makeTempDir();
    try {
      const nested = join(project, 'assignment');
      mkdirSync(nested);

      expect(
        resolveProjectContext({
          cwd: project,
          workspacePaths: [project, nested],
        }),
      ).toEqual({ state: 'candidate', root: nested, evidence: 'workspace' });
    } finally {
      cleanup(project);
    }
  });

  test('a file path is not treated as a project folder', () => {
    const project = makeTempDir();
    try {
      const file = join(project, 'notes.md');
      writeFileSync(file, 'hello');
      expect(resolveProjectContext({ cwd: file })).toEqual({
        state: 'none',
        root: null,
        evidence: null,
        candidates: [],
      });
    } finally {
      cleanup(project);
    }
  });

  test('edits across independent strong roots stay ambiguous', () => {
    const first = makeTempDir();
    const second = makeTempDir();
    try {
      mkdirSync(join(first, '.git'));
      mkdirSync(join(second, '.git'));
      const one = join(first, 'one.ts');
      const two = join(second, 'two.ts');
      writeFileSync(one, 'export const one = 1;\n');
      writeFileSync(two, 'export const two = 2;\n');

      const context = resolveProjectContext({ cwd: first, editPaths: [one, two] });
      expect(context.state).toBe('ambiguous');
      if (context.state === 'ambiguous') {
        expect(context.candidates).toEqual(expect.arrayContaining([first, second]));
      }
    } finally {
      cleanup(first);
      cleanup(second);
    }
  });

  test('plain multi-root workspace edits stay ambiguous under a common cwd', () => {
    const umbrella = makeTempDir();
    try {
      const first = join(umbrella, 'first');
      const second = join(umbrella, 'second');
      mkdirSync(first);
      mkdirSync(second);
      const one = join(first, 'one.ts');
      const two = join(second, 'two.ts');
      writeFileSync(one, 'export const one = 1;\n');
      writeFileSync(two, 'export const two = 2;\n');

      const context = resolveProjectContext({
        cwd: umbrella,
        workspacePaths: [first, second],
        editPaths: [one, two],
      });
      expect(context.state).toBe('ambiguous');
      if (context.state === 'ambiguous') {
        expect(context.candidates).toEqual(expect.arrayContaining([first, second]));
      }
    } finally {
      cleanup(umbrella);
    }
  });

  test('workspace-owned and unresolved edits stay ambiguous under a common cwd', () => {
    const umbrella = makeTempDir();
    try {
      const first = join(umbrella, 'first');
      const second = join(umbrella, 'second');
      const third = join(umbrella, 'third');
      mkdirSync(first);
      mkdirSync(second);
      mkdirSync(third);
      const one = join(first, 'one.ts');
      const three = join(third, 'three.ts');
      writeFileSync(one, 'export const one = 1;\n');
      writeFileSync(three, 'export const three = 3;\n');

      const context = resolveProjectContext({
        cwd: umbrella,
        workspacePaths: [first, second],
        editPaths: [one, three],
      });
      expect(context.state).toBe('ambiguous');
      if (context.state === 'ambiguous') {
        expect(context.candidates).toEqual(expect.arrayContaining([first, third]));
      }
    } finally {
      cleanup(umbrella);
    }
  });

  test('edits in separate temp projects never infer the shared temp container', () => {
    const launcher = makeTempDir();
    const first = makeTempDir();
    const second = makeTempDir();
    try {
      const one = join(first, 'one.ts');
      const two = join(second, 'two.ts');
      writeFileSync(one, 'export const one = 1;\n');
      writeFileSync(two, 'export const two = 2;\n');

      const context = resolveProjectContext({ cwd: launcher, editPaths: [one, two] });
      expect(context.state).toBe('ambiguous');
      if (context.state === 'ambiguous') {
        expect(context.candidates).toEqual(expect.arrayContaining([first, second]));
      }
    } finally {
      cleanup(launcher);
      cleanup(first);
      cleanup(second);
    }
  });

  test('findRoot stops at SHOWTAIL_ROOT_CEILING and never escapes upward', () => {
    const outer = makeTempDir();
    try {
      // A real `.showtail` sits ABOVE the search start — mimicking a developer's
      // global `~/.showtail` above the OS temp dir that tests must never reach.
      mkdirSync(join(outer, '.showtail'), { recursive: true });
      const ceiling = join(outer, 'sandbox');
      const start = join(ceiling, 'project', 'src');
      mkdirSync(start, { recursive: true });

      const prev = process.env.SHOWTAIL_ROOT_CEILING;
      process.env.SHOWTAIL_ROOT_CEILING = ceiling;
      try {
        // Without the ceiling this resolves `outer` (the `.showtail` above).
        expect(findRoot(start)).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.SHOWTAIL_ROOT_CEILING;
        else process.env.SHOWTAIL_ROOT_CEILING = prev;
      }
    } finally {
      cleanup(outer);
    }
  });

  test('requirePaths throws NotInitializedError when uninitialized', () => {
    const dir = makeTempDir();
    try {
      expect(() => requirePaths(dir)).toThrow(NotInitializedError);
    } finally {
      cleanup(dir);
    }
  });

  test('toRepoRelative produces clean forward-slash paths', () => {
    const dir = makeTempDir();
    try {
      expect(toRepoRelative(dir, join(dir, 'src', 'a.ts'))).toBe('src/a.ts');
      expect(toRepoRelative(dir, 'README.md')).toBe('README.md');
    } finally {
      cleanup(dir);
    }
  });
});
