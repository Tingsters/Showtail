/**
 * Relocation durability — a student's captured work must survive them moving their
 * files, whether they drag the folder themselves or ask the AI to do it.
 *
 * These are the first tests in the repo that actually `renameSync` a fixture after
 * capture; the pre-existing "gone target" tests only ever *delete*, which is why the
 * moved-folder path went unverified for so long.
 *
 * Both the pre- and post-move fixture dirs live under `tmpdir()` so the test root
 * ceiling keeps project discovery hermetic. `makeTempDir()` satisfies this.
 *
 * Ledger writes go to the shared `SHOWTAIL_HOME` and are cleared between tests by the
 * preload.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { authorFor, cleanup, makeTempDir, runCli } from './helpers.ts';
import { claimPendingWork, pendingWorkForRoot, runInit } from '../src/commands/init.ts';
import { readArtifacts } from '../src/core/artifacts.ts';
import { sha256OfString } from '../src/core/hash.ts';
import {
  appendLedgerRecord,
  effectiveLedgerPath,
  ensureLedgerSegments,
  ensureLedgerSession,
  hiddenReason,
  isSurfaced,
  knownTrailPath,
  listActionableLedgerRanges,
  markLedgerSegmentPlaced,
  markPlaced,
  noteTrailAt,
  readLedgerSession,
  sessionEditPaths,
  sessionPathsGone,
  sessionProjectContext,
  unplacedSessions,
  type LedgerSession,
} from '../src/core/ledger.ts';
import { materializeLedgerSession } from '../src/core/materialize.ts';
import {
  applyRebase,
  applyRebaseForPathStyle,
  deriveRebase,
  deriveRebaseAgainstRoot,
  matchLedgerSegmentToRoot,
  matchSessionToRoot,
} from '../src/core/relocate.ts';
import { runMove } from '../src/commands/move.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { pathsForRoot, readConfig } from '../src/core/storage.ts';
import { readObject } from '../src/core/objects.ts';

/** A substantial, distinctive file body — the kind of thing a student actually writes. */
const GAME_SOURCE = `"""A tiny maze game, written while pairing with the AI."""

import random


class Maze:
    """Grid maze generated with randomized recursive backtracking."""

    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.wall = [[True] * width for _ in range(height)]

    def carve_passages_from(self, cx, cy, visited):
        visited.add((cx, cy))
        neighbours = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        random.shuffle(neighbours)
        for dx, dy in neighbours:
            nx, ny = cx + dx, cy + dy
            if (nx, ny) in visited:
                continue
            self.wall[ny][nx] = False
            self.carve_passages_from(nx, ny, visited)

    def is_open(self, x, y):
        return not self.wall[y][x]
`;

/** The `+`-prefixed capture form Showtail records for a whole-file Write. */
function writeDiffFor(content: string): string {
  return content
    .split('\n')
    .map((l) => `+ ${l}`)
    .join('\n');
}

/**
 * A ledger session that captured one whole-file Write of `content` at `file`,
 * exactly as the post-edit hook would have recorded it (absolute path, live hash,
 * `+`-prefixed diff), plus enough prompts to clear the signal floor.
 */
function captureSession(
  nativeId: string,
  file: string,
  content: string,
  opts: { prompts?: number; gitCommit?: string; withDiff?: boolean } = {},
): LedgerSession {
  const s = ensureLedgerSession({
    tool: 'claude-code',
    nativeSessionId: nativeId,
    cwd: dirname(file),
  });
  for (let i = 0; i < (opts.prompts ?? 3); i += 1) {
    appendLedgerRecord(s.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: `prompt ${i}`,
      gitCommit: opts.gitCommit,
    });
  }
  appendLedgerRecord(s.id, {
    kind: 'edit',
    tool: 'claude-code',
    file,
    diff: opts.withDiff === false ? undefined : writeDiffFor(content),
    sha256: sha256OfString(content),
    gitCommit: opts.gitCommit,
  });
  return s;
}

/** Create `<dir>/game/main.py` holding `content` and return its path. */
function seedProjectFile(dir: string, content: string): string {
  const sub = join(dir, 'game');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'main.py');
  writeFileSync(file, content, 'utf8');
  return file;
}

/** Claim deterministic pending work without an interactive identity prompt. */
async function claimResolved(root: string) {
  return claimPendingWork(root, {
    mode: 'resolved',
    initialization: {
      anchorKind: 'cwd',
      initialization: { mode: 'report', evidence: 'cwd' },
    },
    provisionalAuthor: true,
  });
}

describe('relocation: visibility of moved work', () => {
  test('a session whose folder was renamed still surfaces in the default inbox', () => {
    const parent = makeTempDir();
    try {
      const before = join(parent, 'untitled folder');
      const file = seedProjectFile(before, GAME_SOURCE);
      const s = captureSession('s-moved', file, GAME_SOURCE);

      // An existing writable folder is already a valid project candidate.
      expect(hiddenReason(s)).toBeNull();
      expect(isSurfaced(s)).toBe(true);

      renameSync(before, join(parent, 'homework'));

      expect(sessionPathsGone(s)).toBe(true);
      expect(isSurfaced(s)).toBe(true);
      expect(hiddenReason(s)).toBe(null);
      const listed = unplacedSessions().find((x) => x.id === s.id);
      expect(listed?.pathGone).toBe(true);
    } finally {
      cleanup(parent);
    }
  });

  test('a deleted file in a folder that still exists is not classified as moved', () => {
    // Guards the distinction the predicate turns on: only a missing *directory*
    // means relocation. A missing file inside a live folder is just a deletion, and
    // that folder can still be judged on its own merits.
    const scratch = makeTempDir();
    try {
      const s = captureSession('s-deleted', join(scratch, 'a.py'), GAME_SOURCE);
      expect(sessionPathsGone(s)).toBe(false);
      expect(hiddenReason(s)).toBeNull();
      expect(isSurfaced(s)).toBe(true);
    } finally {
      cleanup(scratch);
    }
  });

  test('a trivial session whose folder moved stays hidden as low-signal', () => {
    // Surfacing moved work must not flood the default inbox with noise — a session
    // with nothing in it stays hidden even though its folder is gone.
    const parent = makeTempDir();
    try {
      const before = join(parent, 'scratch');
      mkdirSync(before, { recursive: true });
      const s = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-trivial',
        cwd: before,
      });
      renameSync(before, join(parent, 'scratch-renamed'));
      expect(sessionPathsGone(s)).toBe(true);
      expect(hiddenReason(s)).toBe('low-signal');
      expect(isSurfaced(s)).toBe(false);
    } finally {
      cleanup(parent);
    }
  });
});

describe('relocation: content-lineage matching', () => {
  test('segment matching cannot borrow an exact hash from a sibling turn', async () => {
    const source = makeTempDir();
    const movedFirst = makeTempDir();
    const movedSecond = makeTempDir();
    const secondSource = [
      'import csv',
      '',
      'def load_temperatures(path):',
      '    """Read daily observations from the climate assignment."""',
      '    with open(path, encoding="utf8") as handle:',
      '        rows = csv.reader(handle)',
      '        return [float(row[1]) for row in rows if row]',
      '',
      'def average_temperature(values):',
      '    return sum(values) / len(values) if values else 0.0',
    ].join('\n');
    try {
      const sharedFile = seedProjectFile(source, GAME_SOURCE);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-segment-hash-isolation',
      });
      const firstPrompt = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'build the maze game',
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: sharedFile,
        diff: writeDiffFor(GAME_SOURCE),
        sha256: sha256OfString(GAME_SOURCE),
        turnKey: firstPrompt.id,
      });
      writeFileSync(sharedFile, secondSource, 'utf8');
      const secondPrompt = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'build the word game',
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: sharedFile,
        diff: writeDiffFor(secondSource),
        sha256: sha256OfString(secondSource),
        turnKey: secondPrompt.id,
      });
      const [firstSegment, secondSegment] = ensureLedgerSegments(session).segments;

      seedProjectFile(movedFirst, GAME_SOURCE);
      seedProjectFile(movedSecond, secondSource);

      expect(await matchLedgerSegmentToRoot(session, firstSegment!, movedSecond)).toBe(
        null,
      );
      expect(
        await matchLedgerSegmentToRoot(session, secondSegment!, movedSecond),
      ).toEqual(expect.objectContaining({ tier: 'A' }));
      expect(await matchLedgerSegmentToRoot(session, firstSegment!, movedFirst)).toEqual(
        expect.objectContaining({ tier: 'A' }),
      );
    } finally {
      cleanup(source);
      cleanup(movedFirst);
      cleanup(movedSecond);
    }
  });

  test('segment matching derives the next move from that segment rebase only', async () => {
    const original = makeTempDir();
    const intermediate = makeTempDir();
    const destination = makeTempDir();
    try {
      const originalFile = seedProjectFile(original, GAME_SOURCE);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-segment-rebase-lineage',
      });
      const prompt = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'move this game twice',
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: originalFile,
        diff: writeDiffFor(GAME_SOURCE),
        sha256: sha256OfString(GAME_SOURCE),
        turnKey: prompt.id,
      });
      const segment = ensureLedgerSegments(session).segments[0]!;

      const intermediateFile = join(intermediate, 'game', 'main.py');
      mkdirSync(dirname(intermediateFile), { recursive: true });
      renameSync(originalFile, intermediateFile);
      markLedgerSegmentPlaced(session.id, segment.id, 'trl_intermediate', intermediate, {
        pathRebase: { fromRoot: original, toRoot: intermediate },
      });

      const destinationFile = join(destination, 'game', 'main.py');
      mkdirSync(dirname(destinationFile), { recursive: true });
      renameSync(intermediateFile, destinationFile);
      const rebasedSegment = ensureLedgerSegments(session).segments[0]!;
      const match = await matchLedgerSegmentToRoot(session, rebasedSegment, destination);

      expect(match).toEqual(
        expect.objectContaining({
          tier: 'A',
          rebase: {
            fromRoot: resolve(intermediate),
            toRoot: resolve(destination),
          },
        }),
      );
    } finally {
      cleanup(original);
      cleanup(intermediate);
      cleanup(destination);
    }
  });

  test('Tier A matches a byte-identical moved file by hash', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-hash', file, GAME_SOURCE);
      // Move the file to a different folder, bytes untouched (what a drag-and-drop
      // or an AI `mv` does).
      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(file, join(to, 'game', 'main.py'));

      const match = await matchSessionToRoot(s, to);
      expect(match?.tier).toBe('A');
      expect(match?.rebase?.fromRoot).toBe(from);
      expect(match?.rebase?.toRoot).toBe(to);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('Tier B matches when the file was edited after moving (hash misses)', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-edited', file, GAME_SOURCE);
      mkdirSync(join(to, 'game'), { recursive: true });
      const moved = join(to, 'game', 'main.py');
      renameSync(file, moved);
      // The student kept working after moving, so the hash no longer matches.
      writeFileSync(
        moved,
        GAME_SOURCE + '\n\n    def solve(self):\n        pass\n',
        'utf8',
      );

      const match = await matchSessionToRoot(s, to);
      expect(match?.tier).toBe('B');
      expect(match!.score).toBeGreaterThan(0.6);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('an unrelated file with the SAME name is never matched', async () => {
    // The false-positive guard this whole design exists for: students have many
    // `main.py` files, so a filename must never be evidence.
    const from = makeTempDir();
    const other = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-collide', file, GAME_SOURCE);
      // A completely different `game/main.py` belonging to another project.
      seedProjectFile(
        other,
        [
          'import csv',
          '',
          'def load_temperatures(path):',
          '    """Read the weather CSV for the climate assignment."""',
          '    with open(path) as handle:',
          '        return [float(row[1]) for row in csv.reader(handle)]',
          '',
          'def average(values):',
          '    return sum(values) / len(values) if values else 0.0',
        ].join('\n'),
      );

      expect(await matchSessionToRoot(s, other)).toBe(null);
    } finally {
      cleanup(from);
      cleanup(other);
    }
  });

  test('Tier A matches via captured git commit containment', async () => {
    const repo = makeTempDir();
    try {
      const git = (...args: string[]) =>
        spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      if (git('init').status !== 0) return; // no git available — nothing to assert
      git('config', 'user.email', 'tester@example.com');
      git('config', 'user.name', 'Test Student');
      writeFileSync(join(repo, 'notes.md'), 'first\n', 'utf8');
      git('add', '-A');
      if (git('commit', '-m', 'initial').status !== 0) return;
      const sha = git('rev-parse', 'HEAD').stdout.trim();
      if (!sha) return;

      // A session that captured this commit, but whose recorded file path is bogus:
      // the commit alone must be enough to place it.
      const s = captureSession(
        's-commit',
        join(makeTempDir(), 'gone', 'whatever.py'),
        GAME_SOURCE,
        { gitCommit: sha },
      );

      const match = await matchSessionToRoot(s, repo);
      expect(match?.tier).toBe('A');
      expect(match?.detail).toContain(sha.slice(0, 8));
    } finally {
      cleanup(repo);
    }
  });
});

describe('relocation: rebase derivation', () => {
  test('applyRebase handles POSIX and Windows filesystem roots', () => {
    expect(
      applyRebaseForPathStyle(
        { fromRoot: '/', toRoot: '/moved' },
        '/project/src/main.ts',
        'posix',
      ),
    ).toBe('/moved/project/src/main.ts');

    expect(
      applyRebaseForPathStyle(
        { fromRoot: 'C:\\', toRoot: 'D:\\moved' },
        'c:\\Project\\src\\main.ts',
        'win32',
      ),
    ).toBe('D:\\moved\\Project\\src\\main.ts');
    expect(
      applyRebaseForPathStyle(
        { fromRoot: 'C:\\', toRoot: 'D:\\moved' },
        'E:\\other\\main.ts',
        'win32',
      ),
    ).toBeUndefined();

    expect(
      applyRebaseForPathStyle(
        { fromRoot: '\\\\server\\share\\', toRoot: 'D:\\moved' },
        '\\\\SERVER\\SHARE\\project\\main.ts',
        'win32',
      ),
    ).toBe('D:\\moved\\project\\main.ts');
  });

  test('deriveRebase strips the shared tail and applyRebase re-points siblings', () => {
    // Built from the filesystem root so these literals are absolute on every
    // platform (`/app/bin/…` on POSIX, `C:\app\bin\…` on Windows). Hard-coding `C:`
    // made them *relative* on Linux/macOS, which `resolve()` then prefixed with the
    // cwd — green on Windows, red everywhere else.
    const root = resolve('/');
    const oldAbs = join(root, 'app', 'bin', 'game', 'main.py');
    const newAbs = join(root, 'users', 'kid', 'Documents', 'game', 'main.py');
    const rebase = deriveRebase(oldAbs, newAbs);
    expect(rebase?.fromRoot).toBe(join(root, 'app', 'bin'));
    expect(rebase?.toRoot).toBe(join(root, 'users', 'kid', 'Documents'));
    // A different file under the same old root follows the same mapping.
    expect(applyRebase(rebase!, join(root, 'app', 'bin', 'game', 'sprites.py'))).toBe(
      join(root, 'users', 'kid', 'Documents', 'game', 'sprites.py'),
    );
    // A path outside the old root is left alone.
    expect(applyRebase(rebase!, join(root, 'elsewhere', 'x.py'))).toBeUndefined();
  });

  test('deriveRebase returns undefined when nothing is shared', () => {
    const root = resolve('/');
    expect(
      deriveRebase(join(root, 'a', 'one.py'), join(root, 'b', 'two.py')),
    ).toBeUndefined();
  });

  test('deriveRebaseAgainstRoot locates a recorded file with no matched pair', () => {
    // What a git-commit match needs: the folder is already proven, but no file pair
    // was ever formed, so the mapping has to come from finding a recorded file.
    const from = makeTempDir();
    const to = makeTempDir();
    const unrelated = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(file, join(to, 'game', 'main.py'));

      const rebase = deriveRebaseAgainstRoot([file], to);
      expect(rebase?.fromRoot).toBe(from);
      expect(rebase?.toRoot).toBe(to);
      expect(deriveRebaseAgainstRoot([file], unrelated)).toBeUndefined();
    } finally {
      cleanup(from);
      cleanup(to);
      cleanup(unrelated);
    }
  });
});

describe('relocation: persisted path history', () => {
  test('a stored rebase materializes raw records without a transient option', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: to });
      const oldFile = seedProjectFile(from, GAME_SOURCE);
      const session = captureSession('s-stored-rebase', oldFile, GAME_SOURCE);
      const movedFile = join(to, 'game', 'main.py');
      mkdirSync(dirname(movedFile), { recursive: true });
      renameSync(oldFile, movedFile);

      const paths = pathsForRoot(to);
      markPlaced(session.id, readConfig(paths).trailId!, to, {
        pathRebase: { fromRoot: from, toRoot: to },
      });
      const stored = readLedgerSession(session.id)!;

      expect(stored.pathRebases).toEqual([
        { fromRoot: resolve(from), toRoot: resolve(to) },
      ]);
      const result = await materializeLedgerSession(stored, authorFor(paths));
      expect(result.edits).toBe(1);
      expect(readArtifacts(authorFor(paths)).map((artifact) => artifact.path)).toEqual([
        'game/main.py',
      ]);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('the same native session keeps routing to its relocated project', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      const oldFile = seedProjectFile(from, GAME_SOURCE);
      const session = captureSession('s-open-after-relocation', oldFile, GAME_SOURCE);
      await runInit({ cwd: from });

      const movedFile = join(to, 'game', 'main.py');
      mkdirSync(dirname(movedFile), { recursive: true });
      renameSync(oldFile, movedFile);
      const relocated = await claimResolved(to);
      expect(relocated.relocatedSessions).toEqual([
        expect.objectContaining({ id: session.id, to: resolve(to) }),
      ]);

      const resumed = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-open-after-relocation',
        cwd: to,
        workspacePaths: [from, to],
      });
      expect(resumed.id).toBe(session.id);

      const continuedFile = join(to, 'game', 'level.py');
      const continuedSource = 'LEVEL_NAME = "forest"\n';
      writeFileSync(continuedFile, continuedSource, 'utf8');
      appendLedgerRecord(resumed.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'add another level',
      });
      appendLedgerRecord(resumed.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: continuedFile,
        diff: writeDiffFor(continuedSource),
        sha256: sha256OfString(continuedSource),
      });

      const current = readLedgerSession(resumed.id)!;
      expect(sessionProjectContext(current)).toEqual(
        expect.objectContaining({ state: 'tracked', root: resolve(to) }),
      );
      const toPaths = pathsForRoot(to);
      await materializeLedgerSession(current, authorFor(toPaths));
      markPlaced(current.id, readConfig(toPaths).trailId!, to);

      expect(
        readArtifacts(authorFor(toPaths))
          .map((artifact) => artifact.path)
          .sort(),
      ).toEqual(['game/level.py', 'game/main.py']);
      expect(readArtifacts(authorFor(pathsForRoot(from)))).toEqual([]);
      expect(readLedgerSession(current.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(to) }),
      ]);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('ordered A to B to C rebases normalize records from both earlier roots', async () => {
    const first = makeTempDir();
    const second = makeTempDir();
    const third = makeTempDir();
    try {
      await runInit({ cwd: first });
      const firstFile = seedProjectFile(first, GAME_SOURCE);
      const session = captureSession('s-two-relocations', firstFile, GAME_SOURCE);
      await runInit({ cwd: first });

      const secondFile = join(second, 'game', 'main.py');
      mkdirSync(dirname(secondFile), { recursive: true });
      renameSync(firstFile, secondFile);
      expect((await claimResolved(second)).relocatedSessions).toEqual([
        expect.objectContaining({ id: session.id, to: resolve(second) }),
      ]);

      const spriteSource = 'SPRITE_SIZE = 32\n';
      const secondSprite = join(second, 'game', 'sprites.py');
      writeFileSync(secondSprite, spriteSource, 'utf8');
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: secondSprite,
        diff: writeDiffFor(spriteSource),
        sha256: sha256OfString(spriteSource),
      });

      const thirdFile = join(third, 'game', 'main.py');
      const thirdSprite = join(third, 'game', 'sprites.py');
      mkdirSync(dirname(thirdFile), { recursive: true });
      renameSync(secondFile, thirdFile);
      renameSync(secondSprite, thirdSprite);
      expect((await claimResolved(third)).relocatedSessions).toEqual([
        expect.objectContaining({ id: session.id, to: resolve(third) }),
      ]);

      const stored = readLedgerSession(session.id)!;
      expect(stored.pathRebases).toEqual([
        { fromRoot: resolve(first), toRoot: resolve(second) },
        { fromRoot: resolve(second), toRoot: resolve(third) },
      ]);
      expect(sessionEditPaths(stored).sort()).toEqual(
        [thirdFile, thirdSprite].map((file) => resolve(file)).sort(),
      );
      expect(
        readArtifacts(authorFor(pathsForRoot(third)))
          .map((artifact) => artifact.path)
          .sort(),
      ).toEqual(['game/main.py', 'game/sprites.py']);
    } finally {
      cleanup(first);
      cleanup(second);
      cleanup(third);
    }
  });

  test('a repeated nested rebase is stored once and applied once', () => {
    const from = makeTempDir();
    try {
      const to = join(from, 'moved');
      mkdirSync(to, { recursive: true });
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-repeated-nested-rebase',
        cwd: from,
      });
      const pathRebase = { fromRoot: from, toRoot: to };

      markPlaced(session.id, 'trl_nested', to, { pathRebase });
      markPlaced(session.id, 'trl_nested', to, { pathRebase });

      const stored = readLedgerSession(session.id)!;
      expect(stored.pathRebases).toEqual([
        { fromRoot: resolve(from), toRoot: resolve(to) },
      ]);
      expect(effectiveLedgerPath(stored, join(from, 'game', 'main.py'))).toBe(
        join(to, 'game', 'main.py'),
      );
      expect(effectiveLedgerPath(stored, join(from, 'game', 'main.py'), pathRebase)).toBe(
        join(to, 'game', 'main.py'),
      );
      expect(effectiveLedgerPath(stored, join(to, 'game', 'next.py'))).toBe(
        join(to, 'game', 'next.py'),
      );
    } finally {
      cleanup(from);
    }
  });
});

describe('relocation: a different spelling is not a move', () => {
  test('reaching a trail through a symlink does not repoint its recorded path', async () => {
    // The macOS failure this guards: `process.cwd()` reports a directory's realpath
    // (`/private/var/…`) when the caller passed `/var/…`, so `status`/`report` saw
    // "the project moved" and rewrote a perfectly correct recorded path into a
    // different spelling of the same folder — breaking every later path comparison.
    const parent = makeTempDir();
    try {
      const real = join(parent, 'project');
      mkdirSync(real, { recursive: true });
      await runInit({ cwd: real });

      const link = join(parent, 'link-to-project');
      try {
        symlinkSync(real, link, 'junction');
      } catch {
        return; // symlinks need privileges on some Windows setups — nothing to assert
      }

      const paths = pathsForRoot(real);
      const trailId = readConfig(paths).trailId!;
      // Seed the index with the real path, as a placement would.
      markPlaced('led_spelling_probe', trailId, real);
      expect(knownTrailPath(trailId)).toBe(real);

      // Now "arrive" via the symlink — same directory, different spelling.
      const update = noteTrailAt(link);
      expect(update?.moved).toBe(false);
      // The recorded path must be untouched.
      expect(knownTrailPath(trailId)).toBe(real);
    } finally {
      cleanup(parent);
    }
  });
});

describe('relocation: every placement path rebases', () => {
  test('a git-commit-only Tier A match still carries a rebase', async () => {
    const repo = makeTempDir();
    const from = makeTempDir();
    try {
      const git = (...args: string[]) =>
        spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      if (git('init').status !== 0) return;
      git('config', 'user.email', 'tester@example.com');
      git('config', 'user.name', 'Test Student');
      writeFileSync(join(repo, 'notes.md'), 'first\n', 'utf8');
      git('add', '-A');
      if (git('commit', '-m', 'initial').status !== 0) return;
      const sha = git('rev-parse', 'HEAD').stdout.trim();
      if (!sha) return;

      // Captured at the old location, then the whole project moved into the repo.
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-commit-rebase', file, GAME_SOURCE, { gitCommit: sha });
      mkdirSync(join(repo, 'game'), { recursive: true });
      renameSync(file, join(repo, 'game', 'main.py'));

      const match = await matchSessionToRoot(s, repo);
      expect(match?.tier).toBe('A');
      // The regression: a commit match used to return no mapping at all, so the
      // commonest relocation of all still projected `../../..` paths.
      expect(match?.rebase?.fromRoot).toBe(from);
      expect(match?.rebase?.toRoot).toBe(repo);
    } finally {
      cleanup(repo);
      cleanup(from);
    }
  });

  test('`showtail move --to` projects a clean path, not a ../.. escape', async () => {
    // The exact flow the CLI advertises for candidates it declines to auto-place.
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-move-cli', file, GAME_SOURCE);
      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(file, join(to, 'game', 'main.py'));

      await runInit({ cwd: to });
      const editRange = listActionableLedgerRanges({
        includeHidden: true,
        sessionId: s.id,
      }).find((range) => range.edits > 0);
      expect(editRange).toBeDefined();
      await runMove(editRange!.selector, { to });

      const author = authorFor(pathsForRoot(to));
      const artifacts = readArtifacts(author);
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]!.path).toBe('game/main.py');
      expect(artifacts[0]!.path).not.toContain('..');
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });
});

describe('relocation: verify tolerates content-free stubs', () => {
  test('a hash-less stub does not fail verify', async () => {
    // `hook.ts` deliberately omits the hash for a DELETED file, so a shell-driven
    // delete with no captured diff projects a hash-less stub. That used to trip the
    // journal check and fail an honest trail with exit code 3.
    const dir = makeTempDir();
    const gone = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const missing = join(gone, 'nested', 'shell-deleted.py');
      const s = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-stub-verify',
        cwd: dirname(missing),
      });
      appendLedgerRecord(s.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'delete it',
      });
      // No diff AND no sha256 — exactly what a deleted file records.
      appendLedgerRecord(s.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: missing,
        deleted: true,
      });
      cleanup(gone);

      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const result = await materializeLedgerSession(s, author, {
        rebase: { fromRoot: gone, toRoot: dir },
      });
      expect(result.stubs).toBe(1);

      const verified = await verifyProject(paths);
      const journal = verified.checks.find((c) => c.name === 'journal entries are valid');
      expect(journal?.ok).toBe(true);
    } finally {
      cleanup(dir);
      if (existsSync(gone)) cleanup(gone);
    }
  });
});

describe('relocation: track recovers moved work', () => {
  test('preview and track recover files moved out of a still-live old trail', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-placed-live-move', file, GAME_SOURCE);
      await runInit({ cwd: from });

      const oldPaths = pathsForRoot(from);
      expect(readLedgerSession(s.id)?.status).toBe('placed');
      expect(readArtifacts(authorFor(oldPaths))).toHaveLength(1);

      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(file, join(to, 'game', 'main.py'));

      const preview = await pendingWorkForRoot(to);
      expect(preview.sessions).toEqual([]);
      expect(preview.safeRelocations).toEqual([
        expect.objectContaining({
          id: s.id,
          from: resolve(from),
          to: resolve(to),
          tier: 'A',
        }),
      ]);
      expect(preview.relocationCandidates).toEqual([]);

      // Preview is strictly read-only: the old projection and placement remain,
      // and the destination trail does not exist yet.
      expect(readLedgerSession(s.id)?.targets?.[0]?.path).toBe(resolve(from));
      expect(readArtifacts(authorFor(oldPaths))).toHaveLength(1);
      expect(existsSync(join(to, '.showtail'))).toBe(false);

      const tracked = runCli(to, ['track', '--json']);
      expect(tracked.code).toBe(0);
      expect(JSON.parse(tracked.stdout)).toEqual(
        expect.objectContaining({
          claimedSessions: [],
          relocatedSessions: [
            expect.objectContaining({
              id: s.id,
              from: resolve(from),
              to: resolve(to),
              tier: 'A',
            }),
          ],
          relocationCandidates: [],
        }),
      );

      expect(readLedgerSession(s.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(to) }),
      ]);
      expect(readArtifacts(authorFor(pathsForRoot(to)))[0]?.path).toBe('game/main.py');
      expect(readArtifacts(authorFor(oldPaths))).toEqual([]);
      expect(existsSync(join(from, '.showtail', 'config.json'))).toBe(true);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('an exact copy never becomes a relocation candidate', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-placed-copy', file, GAME_SOURCE);
      await runInit({ cwd: from });

      seedProjectFile(to, GAME_SOURCE);
      const preview = await pendingWorkForRoot(to);
      expect(preview.safeRelocations).toEqual([]);
      expect(preview.relocationCandidates).toEqual([]);
      expect(readLedgerSession(s.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(from) }),
      ]);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('a partial move is review-only even with an exact hash match', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      const movedFile = seedProjectFile(from, GAME_SOURCE);
      const keptFile = join(from, 'game', 'sprites.py');
      writeFileSync(keptFile, 'SPRITE_SIZE = 32\n', 'utf8');
      const s = captureSession('s-placed-mixed', movedFile, GAME_SOURCE);
      appendLedgerRecord(s.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: keptFile,
        diff: '+ SPRITE_SIZE = 32',
        sha256: sha256OfString('SPRITE_SIZE = 32\n'),
      });
      await runInit({ cwd: from });

      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(movedFile, join(to, 'game', 'main.py'));
      const preview = await pendingWorkForRoot(to);

      expect(preview.safeRelocations).toEqual([]);
      expect(preview.relocationCandidates).toEqual([
        expect.objectContaining({ id: s.id, tier: 'A', reason: 'mixed' }),
      ]);

      const tracked = runCli(to, ['track', '--json']);
      expect(tracked.code).toBe(0);
      expect(JSON.parse(tracked.stdout)).toEqual(
        expect.objectContaining({
          relocatedSessions: [],
          relocationCandidates: [expect.objectContaining({ id: s.id, reason: 'mixed' })],
        }),
      );
      expect(readLedgerSession(s.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(from) }),
      ]);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('an exact match without a total path rebase is review-only', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-unsafe-rebase', file, GAME_SOURCE);
      await runInit({ cwd: from });

      // Renaming the only file removes every shared trailing segment, so the hash
      // proves the content but cannot prove how sibling paths should translate.
      renameSync(file, join(to, 'renamed.py'));
      const preview = await pendingWorkForRoot(to);

      expect(preview.safeRelocations).toEqual([]);
      expect(preview.relocationCandidates).toEqual([
        expect.objectContaining({ id: s.id, tier: 'A', reason: 'unsafe-rebase' }),
      ]);

      const reported = runCli(to, ['report', '--json', '--verbose-json', '--no-sync']);
      expect(reported.code).toBe(2);
      expect(JSON.parse(reported.stdout)).toEqual(
        expect.objectContaining({
          errorCode: 'RELOCATION_REVIEW_REQUIRED',
          nextAction: 'review-relocation',
          relocationCandidates: [
            expect.objectContaining({ id: s.id, reason: 'unsafe-rebase' }),
          ],
        }),
      );
      expect(existsSync(join(to, '.showtail'))).toBe(false);

      const tracked = runCli(to, ['track', '--json']);
      expect(tracked.code).toBe(0);
      expect(JSON.parse(tracked.stdout)).toEqual(
        expect.objectContaining({
          relocatedSessions: [],
          relocationCandidates: [
            expect.objectContaining({ id: s.id, reason: 'unsafe-rebase' }),
          ],
        }),
      );
      expect(readLedgerSession(s.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(from) }),
      ]);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('a multi-target session is never considered for automatic relocation', async () => {
    const from = makeTempDir();
    const second = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      await runInit({ cwd: second });
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-multi-target-move', file, GAME_SOURCE);
      await runInit({ cwd: from });
      markPlaced(s.id, readConfig(pathsForRoot(second)).trailId!, second);

      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(file, join(to, 'game', 'main.py'));
      const preview = await pendingWorkForRoot(to);

      expect(preview.safeRelocations).toEqual([]);
      expect(preview.relocationCandidates).toEqual([]);
      expect(readLedgerSession(s.id)?.targets).toHaveLength(2);
    } finally {
      cleanup(from);
      cleanup(second);
      cleanup(to);
    }
  });

  test('a one-target session spanning multiple projects stays atomic and untouched', async () => {
    const parent = makeTempDir();
    const from = join(parent, 'first');
    const second = join(parent, 'second');
    const to = join(parent, 'moved');
    mkdirSync(from, { recursive: true });
    mkdirSync(second, { recursive: true });
    mkdirSync(to, { recursive: true });
    try {
      await runInit({ cwd: from });
      await runInit({ cwd: second });
      const firstFile = seedProjectFile(from, GAME_SOURCE);
      const secondFile = join(second, 'game', 'sprites.py');
      mkdirSync(dirname(secondFile), { recursive: true });
      const spriteSource = 'SPRITE_SIZE = 32\n';
      writeFileSync(secondFile, spriteSource, 'utf8');

      const s = captureSession('s-one-target-ambiguous-move', firstFile, GAME_SOURCE);
      const oldPaths = pathsForRoot(from);
      await materializeLedgerSession(s, authorFor(oldPaths));
      markPlaced(s.id, readConfig(oldPaths).trailId!, from);
      appendLedgerRecord(s.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: secondFile,
        diff: writeDiffFor(spriteSource),
        sha256: sha256OfString(spriteSource),
      });
      const oldEventCount = readArtifacts(authorFor(oldPaths)).length;

      const movedFirst = join(to, 'first', 'game', 'main.py');
      const movedSecond = join(to, 'second', 'game', 'sprites.py');
      mkdirSync(dirname(movedFirst), { recursive: true });
      mkdirSync(dirname(movedSecond), { recursive: true });
      renameSync(firstFile, movedFirst);
      renameSync(secondFile, movedSecond);

      const preview = await pendingWorkForRoot(to);
      expect(preview.safeRelocations).toEqual([]);
      expect(preview.relocationCandidates).toEqual([]);

      await runInit({ cwd: to });
      expect(readLedgerSession(s.id)?.status).toBe('placed');
      expect(readLedgerSession(s.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(from) }),
      ]);
      expect(readArtifacts(authorFor(oldPaths))).toHaveLength(oldEventCount);
    } finally {
      cleanup(parent);
    }
  });

  test('claim revalidation creates no trail when a move becomes a copy', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      await runInit({ cwd: from });
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-copy-after-preview', file, GAME_SOURCE);
      await runInit({ cwd: from });

      const moved = join(to, 'game', 'main.py');
      mkdirSync(dirname(moved), { recursive: true });
      renameSync(file, moved);
      expect((await pendingWorkForRoot(to)).safeRelocations).toEqual([
        expect.objectContaining({ id: s.id }),
      ]);

      // The original reappears after preview, so the destination is now only a copy.
      writeFileSync(file, GAME_SOURCE, 'utf8');
      const claimed = await claimPendingWork(to, {
        mode: 'resolved',
        initialization: {
          anchorKind: 'cwd',
          initialization: { mode: 'report', evidence: 'cwd' },
        },
        provisionalAuthor: true,
      });
      expect(claimed.placed).toBe(0);
      expect(claimed.relocatedSessions).toEqual([]);
      expect(existsSync(join(to, '.showtail'))).toBe(false);
      expect(readLedgerSession(s.id)?.targets).toEqual([
        expect.objectContaining({ path: resolve(from) }),
      ]);
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('`track` on the new folder pulls the session in with its real content', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-track', file, GAME_SOURCE);
      mkdirSync(join(to, 'game'), { recursive: true });
      renameSync(file, join(to, 'game', 'main.py'));

      const tracked = runCli(to, ['track', '--json']);
      expect(tracked.code).toBe(0);
      expect(JSON.parse(tracked.stdout)).toEqual(
        expect.objectContaining({
          claimedSessions: [s.id],
          relocatedSessions: [],
        }),
      );

      expect(readLedgerSession(s.id)?.status).toBe('placed');

      const paths = pathsForRoot(to);
      const author = authorFor(paths);
      const artifacts = readArtifacts(author);
      expect(artifacts.length).toBe(1);
      const art = artifacts[0]!;
      // Rebased, so the projected path is clean repo-relative — not a `../../..`
      // escape from the new root.
      expect(art.path).toBe('game/main.py');
      expect(art.path).not.toContain('..');
      // And the real captured content came along.
      expect(art.diffHash).toBeTruthy();
      const stored = readObject(paths, art.diffHash!);
      expect(stored).toContain('class Maze');
      expect(stored).toContain('carve_passages_from');
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('`track` does NOT auto-place a session matched only on similarity', async () => {
    const from = makeTempDir();
    const to = makeTempDir();
    try {
      const file = seedProjectFile(from, GAME_SOURCE);
      const s = captureSession('s-similar', file, GAME_SOURCE);
      mkdirSync(join(to, 'game'), { recursive: true });
      const moved = join(to, 'game', 'main.py');
      renameSync(file, moved);
      writeFileSync(
        moved,
        GAME_SOURCE + '\n\n    def solve(self):\n        pass\n',
        'utf8',
      );

      await runInit({ cwd: to });

      // Tier B is reported for confirmation, never applied: attribution must not
      // shift on a guess.
      expect(readLedgerSession(s.id)?.status).toBe('inbox');
      const preview = await pendingWorkForRoot(to);
      expect(preview.safeRelocations).toEqual([]);
      expect(preview.relocationCandidates).toEqual([
        expect.objectContaining({ id: s.id, tier: 'B', reason: 'similarity' }),
      ]);

      const reported = runCli(to, ['report', '--json', '--verbose-json', '--no-sync']);
      expect(reported.code).toBe(2);
      expect(JSON.parse(reported.stdout)).toEqual(
        expect.objectContaining({
          errorCode: 'RELOCATION_REVIEW_REQUIRED',
          nextAction: 'review-relocation',
          relocationCandidates: [
            expect.objectContaining({ id: s.id, reason: 'similarity' }),
          ],
        }),
      );
    } finally {
      cleanup(from);
      cleanup(to);
    }
  });

  test('`track` still backfills a folder that already has a .showtail/', async () => {
    // The early-return that used to strand orphaned sessions on a re-run — which is
    // exactly the path a student hits after moving an already-tracked project.
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = seedProjectFile(dir, GAME_SOURCE);
      const s = captureSession('s-rerun', file, GAME_SOURCE);
      expect(readLedgerSession(s.id)?.status).toBe('inbox');

      await runInit({ cwd: dir }); // second run takes the "already set up here" branch

      expect(readLedgerSession(s.id)?.status).toBe('placed');
    } finally {
      cleanup(dir);
    }
  });
});

describe('relocation: content-less edits are recorded, not dropped', () => {
  test('an edit with no diff and no readable file becomes a path-only stub', async () => {
    const dir = makeTempDir();
    const gone = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const missing = join(gone, 'nested', 'shell-written.py');
      const s = captureSession('s-stub', missing, GAME_SOURCE, { withDiff: false });
      cleanup(gone); // the file was never captured AND is now unreachable

      const author = authorFor(pathsForRoot(dir));
      const result = await materializeLedgerSession(s, author, {
        rebase: { fromRoot: gone, toRoot: dir },
      });

      expect(result.stubs).toBe(1);
      expect(result.edits).toBe(1);
      const artifacts = readArtifacts(author);
      expect(artifacts.length).toBe(1);
      const art = artifacts[0]!;
      expect(basename(art.path)).toBe('shell-written.py');
      // Content is genuinely unrecoverable — but the hash we captured survives, so
      // the trail still records that this file changed.
      expect(art.diffHash).toBeFalsy();
      expect(art.sha256).toBe(sha256OfString(GAME_SOURCE));
    } finally {
      cleanup(dir);
      if (existsSync(gone)) cleanup(gone);
    }
  });
});
