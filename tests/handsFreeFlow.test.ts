import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  readLedgerSession,
  sessionProjectContext,
} from '../src/core/ledger.ts';
import { readArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { sha256OfString } from '../src/core/hash.ts';
import { materializeLedgerSession } from '../src/core/materialize.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, envWithHome, makeTempDir, runCli } from './helpers.ts';

const MOVED_GAME_SOURCE = [
  '"""A small game created while pairing with an AI."""',
  '',
  'class FairyGame:',
  '    def collect_sparkle(self):',
  '        self.score += 1',
  '',
].join('\n');

function writeDiff(content: string): string {
  return content
    .split('\n')
    .map((line) => `+ ${line}`)
    .join('\n');
}

describe('hands-free project-local flow', () => {
  let previousHome: string | undefined;
  let cleanupDirs: string[];

  beforeEach(() => {
    previousHome = process.env.SHOWTAIL_HOME;
    cleanupDirs = [];
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = previousHome;
    for (const dir of cleanupDirs.reverse()) cleanup(dir);
  });

  function temp(): string {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    return dir;
  }

  test('report [path] creates the trail, claims matching work, and writes locally', () => {
    const project = temp();
    const caller = temp();
    const globalHome = temp();
    process.env.SHOWTAIL_HOME = globalHome;

    const ledger = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'report-claim',
      cwd: project,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'build the local report flow',
    });

    const result = runCli(
      caller,
      ['report', project, '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        root: project,
        created: true,
        evidence: 'explicit',
        claimedSessions: [ledger.id],
        pendingAmbiguous: [],
      }),
    );
    expect(existsSync(payload.reportPath)).toBe(true);
    expect(payload.reportPath).toContain(join(project, '.showtail', 'reports'));

    const config = JSON.parse(
      readFileSync(join(project, '.showtail', 'config.json'), 'utf8'),
    );
    expect(config.initialization).toEqual({ mode: 'report', evidence: 'explicit' });
    expect(readLedgerSession(ledger.id)?.status).toBe('placed');
    expect(
      readAllEvents(pathsForRoot(project)).some(
        (event) =>
          event.type === 'prompt' && event.text === 'build the local report flow',
      ),
    ).toBe(true);
  });

  test('report with no matching work returns code 4 and creates nothing', () => {
    const project = temp();
    const globalHome = temp();

    const result = runCli(project, ['report', '--json', '--verbose-json', '--no-sync'], {
      env: envWithHome(globalHome),
    });
    expect(result.code).toBe(4);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        ok: false,
        code: 4,
        errorCode: 'NO_MATCHING_WORK',
        nextAction: 'run-setup',
        root: project,
        created: false,
        claimedSessions: [],
        capture: expect.objectContaining({
          autoInit: false,
        }),
      }),
    );
    expect(existsSync(join(project, '.showtail'))).toBe(false);
  });

  test('report refuses multi-project ledger work instead of guessing', () => {
    const first = temp();
    const second = temp();
    const globalHome = temp();
    mkdirSync(join(first, '.git'));
    mkdirSync(join(second, '.git'));
    const firstFile = join(first, 'one.ts');
    const secondFile = join(second, 'two.ts');
    writeFileSync(firstFile, 'export const one = 1;\n');
    writeFileSync(secondFile, 'export const two = 2;\n');
    process.env.SHOWTAIL_HOME = globalHome;

    const ledger = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'ambiguous-report',
      cwd: first,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'change both projects',
    });
    appendLedgerRecord(ledger.id, {
      kind: 'edit',
      tool: 'codex',
      file: firstFile,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'edit',
      tool: 'codex',
      file: secondFile,
    });

    const result = runCli(first, ['report', '--json', '--verbose-json', '--no-sync'], {
      env: envWithHome(globalHome),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(
      expect.objectContaining({
        errorCode: 'AMBIGUOUS_PROJECT',
        nextAction: 'review-inbox',
      }),
    );
    expect(payload.pendingAmbiguous).toEqual([
      expect.objectContaining({ id: ledger.id }),
    ]);
    expect(payload.candidates).toEqual(expect.arrayContaining([first, second]));
    expect(existsSync(join(first, '.showtail'))).toBe(false);
    expect(existsSync(join(second, '.showtail'))).toBe(false);
  });

  test('human ambiguous report lists every candidate root', () => {
    const first = temp();
    const second = temp();
    const globalHome = temp();
    mkdirSync(join(first, '.git'));
    mkdirSync(join(second, '.git'));
    const firstFile = join(first, 'one.ts');
    const secondFile = join(second, 'two.ts');
    writeFileSync(firstFile, 'export const one = 1;\n');
    writeFileSync(secondFile, 'export const two = 2;\n');
    process.env.SHOWTAIL_HOME = globalHome;

    const ledger = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'ambiguous-report-human',
      cwd: first,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'change both projects',
    });
    appendLedgerRecord(ledger.id, { kind: 'edit', tool: 'codex', file: firstFile });
    appendLedgerRecord(ledger.id, { kind: 'edit', tool: 'codex', file: secondFile });

    const result = runCli(first, ['report', '--no-sync'], {
      env: envWithHome(globalHome),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Candidate project roots:');
    expect(result.stderr).toContain(first);
    expect(result.stderr).toContain(second);
    expect(result.stderr).toContain('showtail inbox');
    expect(existsSync(join(first, '.showtail'))).toBe(false);
    expect(existsSync(join(second, '.showtail'))).toBe(false);
  });

  test('reporting from a common parent surfaces ambiguous child projects', () => {
    const umbrella = temp();
    const globalHome = temp();
    const first = join(umbrella, 'first');
    const second = join(umbrella, 'second');
    mkdirSync(join(first, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const firstFile = join(first, 'one.ts');
    const secondFile = join(second, 'two.ts');
    writeFileSync(firstFile, 'export const one = 1;\n');
    writeFileSync(secondFile, 'export const two = 2;\n');
    process.env.SHOWTAIL_HOME = globalHome;

    const ledger = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'ambiguous-parent-report',
      cwd: first,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'change both child projects',
    });
    appendLedgerRecord(ledger.id, { kind: 'edit', tool: 'codex', file: firstFile });
    appendLedgerRecord(ledger.id, { kind: 'edit', tool: 'codex', file: secondFile });

    const result = runCli(umbrella, ['report', '--json', '--verbose-json', '--no-sync'], {
      env: envWithHome(globalHome),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload.errorCode).toBe('AMBIGUOUS_PROJECT');
    expect(payload.candidates).toEqual(expect.arrayContaining([first, second]));
    expect(payload).toEqual(
      expect.objectContaining({
        claimedSegments: [],
        relocatedSegments: [],
        segmentRelocationCandidates: [],
        pendingAmbiguousRanges: expect.any(Array),
        pendingRanges: [],
        reroutedRanges: [],
      }),
    );
    expect(existsSync(join(umbrella, '.showtail'))).toBe(false);
  });

  test('an explicit missing report path returns the complete routing shape', () => {
    const workspace = temp();
    const missing = join(workspace, 'missing-game');

    const result = runCli(workspace, [
      'report',
      missing,
      '--json',
      '--verbose-json',
      '--no-open',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        ok: false,
        errorCode: 'PATH_NOT_FOUND',
        claimedSegments: [],
        relocatedSegments: [],
        segmentRelocationCandidates: [],
        pendingAmbiguousRanges: [],
        pendingRanges: [],
        reroutedRanges: [],
      }),
    );
    expect(existsSync(missing)).toBe(false);
  });

  test('report recovers an exactly moved placed session while the old trail remains', async () => {
    const oldProject = temp();
    const newProject = temp();
    const globalHome = temp();
    process.env.SHOWTAIL_HOME = globalHome;
    const oldFile = join(oldProject, 'games', 'fairy_sparkle.py');
    const newFile = join(newProject, 'fairy_sparkle.py');
    mkdirSync(join(oldProject, 'games'), { recursive: true });
    writeFileSync(oldFile, MOVED_GAME_SOURCE, 'utf8');

    const ledger = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'report-recovers-live-target-move',
      cwd: oldProject,
      workspacePaths: [oldProject],
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'make me a game about fairies and sparkles',
    });
    appendLedgerRecord(ledger.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: oldFile,
      diff: writeDiff(MOVED_GAME_SOURCE),
      sha256: sha256OfString(MOVED_GAME_SOURCE),
    });

    const first = runCli(
      oldProject,
      ['report', '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(first.code).toBe(0);
    expect(readLedgerSession(ledger.id)?.status).toBe('placed');

    renameSync(oldFile, newFile);
    const moved = runCli(
      newProject,
      ['report', '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(moved.code).toBe(0);
    expect(moved.stderr).toBe('');
    const payload = JSON.parse(moved.stdout);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        root: newProject,
        created: true,
        claimedSessions: [],
        relocatedSessions: [
          expect.objectContaining({
            id: ledger.id,
            from: oldProject,
            to: newProject,
            tier: 'A',
          }),
        ],
        relocationCandidates: [],
      }),
    );
    expect(existsSync(join(oldProject, '.showtail', 'config.json'))).toBe(true);
    expect(existsSync(join(newProject, '.showtail', 'config.json'))).toBe(true);
    expect(readLedgerSession(ledger.id)?.targets).toEqual([
      expect.objectContaining({ path: newProject }),
    ]);
    expect(
      readAllEvents(pathsForRoot(oldProject)).some(
        (event) => event.text === 'make me a game about fairies and sparkles',
      ),
    ).toBe(false);
    expect(
      readAllEvents(pathsForRoot(newProject)).some(
        (event) => event.text === 'make me a game about fairies and sparkles',
      ),
    ).toBe(true);
    expect(readFileSync(payload.markdownPath, 'utf8')).toContain('fairy_sparkle.py');

    const relocated = readLedgerSession(ledger.id)!;
    expect(relocated.pathRebases).toHaveLength(1);
    expect(sessionProjectContext(relocated)).toEqual(
      expect.objectContaining({ state: 'tracked', root: newProject }),
    );

    // The same still-open native chat can retain its old workspace hint while VS
    // Code reports the new folder. Historical paths must normalize to the move,
    // not make the complete session ambiguous or revive its old projection.
    const resumed = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'report-recovers-live-target-move',
      cwd: newProject,
      workspacePaths: [oldProject, newProject],
    });
    expect(resumed.id).toBe(ledger.id);
    const continuedSource = `${MOVED_GAME_SOURCE}\nLEVEL_NAME = "moon garden"\n`;
    writeFileSync(newFile, continuedSource, 'utf8');
    appendLedgerRecord(resumed.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'add a moon garden level',
    });
    appendLedgerRecord(resumed.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: newFile,
      diff: writeDiff(continuedSource),
      sha256: sha256OfString(continuedSource),
    });

    const continued = readLedgerSession(resumed.id)!;
    expect(sessionProjectContext(continued)).toEqual(
      expect.objectContaining({ state: 'tracked', root: newProject }),
    );
    const newPaths = pathsForRoot(newProject);
    const materialized = await materializeLedgerSession(continued, authorFor(newPaths));
    expect(materialized.completed).toBe(true);
    expect(materialized.prompts).toBe(1);
    expect(materialized.edits).toBe(1);
    expect(
      readArtifacts(authorFor(newPaths)).some((item) => item.path === 'fairy_sparkle.py'),
    ).toBe(true);
    expect(
      readAllEvents(pathsForRoot(oldProject)).some(
        (event) => event.text === 'add a moon garden level',
      ),
    ).toBe(false);
    expect(
      readAllEvents(newPaths).some((event) => event.text === 'add a moon garden level'),
    ).toBe(true);

    const beforeRepeat = readAllEvents(pathsForRoot(newProject)).length;
    const repeated = runCli(
      newProject,
      ['report', '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout).relocatedSessions).toEqual([]);
    expect(readAllEvents(pathsForRoot(newProject))).toHaveLength(beforeRepeat);
  });

  test('report never steals a copied file while its original still exists', () => {
    const oldProject = temp();
    const newProject = temp();
    const globalHome = temp();
    process.env.SHOWTAIL_HOME = globalHome;
    const oldFile = join(oldProject, 'game.py');
    const copiedFile = join(newProject, 'game.py');
    writeFileSync(oldFile, MOVED_GAME_SOURCE, 'utf8');

    const ledger = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'report-does-not-steal-copy',
      cwd: oldProject,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'build the original game',
    });
    appendLedgerRecord(ledger.id, {
      kind: 'edit',
      tool: 'codex',
      file: oldFile,
      diff: writeDiff(MOVED_GAME_SOURCE),
      sha256: sha256OfString(MOVED_GAME_SOURCE),
    });
    expect(
      runCli(oldProject, ['report', '--json', '--verbose-json', '--no-sync'], {
        env: envWithHome(globalHome),
      }).code,
    ).toBe(0);
    writeFileSync(copiedFile, MOVED_GAME_SOURCE, 'utf8');

    const copied = runCli(
      newProject,
      ['report', '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(copied.code).toBe(4);
    expect(JSON.parse(copied.stdout)).toEqual(
      expect.objectContaining({
        errorCode: 'NO_MATCHING_WORK',
        relocatedSessions: [],
        relocationCandidates: [],
      }),
    );
    expect(existsSync(join(newProject, '.showtail'))).toBe(false);
    expect(readLedgerSession(ledger.id)?.targets).toEqual([
      expect.objectContaining({ path: oldProject }),
    ]);
  });

  test('report leaves a partially moved session for explicit review', () => {
    const oldProject = temp();
    const newProject = temp();
    const globalHome = temp();
    process.env.SHOWTAIL_HOME = globalHome;
    const movedOldPath = join(oldProject, 'game.py');
    const retainedPath = join(oldProject, 'notes.md');
    const movedNewPath = join(newProject, 'game.py');
    writeFileSync(movedOldPath, MOVED_GAME_SOURCE, 'utf8');
    writeFileSync(retainedPath, 'game notes\n', 'utf8');

    const ledger = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'report-reviews-partial-move',
      cwd: oldProject,
    });
    appendLedgerRecord(ledger.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'build the game and its notes',
    });
    appendLedgerRecord(ledger.id, {
      kind: 'edit',
      tool: 'codex',
      file: movedOldPath,
      diff: writeDiff(MOVED_GAME_SOURCE),
      sha256: sha256OfString(MOVED_GAME_SOURCE),
    });
    appendLedgerRecord(ledger.id, {
      kind: 'edit',
      tool: 'codex',
      file: retainedPath,
      diff: '+ game notes',
      sha256: sha256OfString('game notes\n'),
    });
    expect(
      runCli(oldProject, ['report', '--json', '--verbose-json', '--no-sync'], {
        env: envWithHome(globalHome),
      }).code,
    ).toBe(0);
    renameSync(movedOldPath, movedNewPath);

    const mixed = runCli(
      newProject,
      ['report', '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(mixed.code).toBe(2);
    expect(JSON.parse(mixed.stdout)).toEqual(
      expect.objectContaining({
        errorCode: 'RELOCATION_REVIEW_REQUIRED',
        nextAction: 'review-relocation',
        relocatedSessions: [],
        relocationCandidates: [
          expect.objectContaining({ id: ledger.id, reason: 'mixed' }),
        ],
      }),
    );
    expect(existsSync(join(newProject, '.showtail'))).toBe(false);
    expect(readLedgerSession(ledger.id)?.targets).toEqual([
      expect.objectContaining({ path: oldProject }),
    ]);

    const tracked = runCli(newProject, ['track', '--json'], {
      env: envWithHome(globalHome),
    });
    expect(tracked.code).toBe(0);
    expect(existsSync(join(newProject, '.showtail', 'config.json'))).toBe(true);

    const existingEmpty = runCli(
      newProject,
      ['report', '--json', '--verbose-json', '--no-sync'],
      {
        env: envWithHome(globalHome),
      },
    );
    expect(existingEmpty.code).toBe(2);
    expect(JSON.parse(existingEmpty.stdout)).toEqual(
      expect.objectContaining({
        errorCode: 'RELOCATION_REVIEW_REQUIRED',
        nextAction: 'review-relocation',
        relocationCandidates: [
          expect.objectContaining({ id: ledger.id, reason: 'mixed' }),
        ],
      }),
    );
    expect(readLedgerSession(ledger.id)?.targets).toEqual([
      expect.objectContaining({ path: oldProject }),
    ]);
  });
});
