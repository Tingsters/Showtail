import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { projectIdentityConflicts } from '../src/commands/projectSemantics.ts';
import {
  allLedgerSessionViews,
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  markLedgerSegmentPlaced,
  markPlaced,
  noteTrailLocation,
  readLedgerIndex,
  readLedgerSession,
  supersedeTrailIdentity,
} from '../src/core/ledger.ts';
import {
  readGlobalConfig,
  trailIdentityMutationLockPath,
  trailIdentitySupersession,
  withTrailIdentityMutationLock,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { pathsForRoot, readConfig, writeConfig, writeJson } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('trail identity supersession', () => {
  let home: string;
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.SHOWTAIL_HOME;
    home = makeTempDir();
    root = makeTempDir();
    process.env.SHOWTAIL_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = previousHome;
    cleanup(root);
    cleanup(home);
  });

  async function retireUnusedDuplicate(
    duplicateTrailId: string,
  ): Promise<{ canonicalTrailId: string }> {
    await runInit({ cwd: root, project: 'Word Sparkle', json: true });
    const canonicalTrailId = readConfig(pathsForRoot(root)).trailId!;
    const index = readLedgerIndex();
    writeJson(join(home, 'ledger', 'index.json'), {
      ...index,
      trails: {
        ...index.trails,
        [duplicateTrailId]: {
          path: root,
          lastSeenAt: new Date().toISOString(),
        },
      },
    });
    supersedeTrailIdentity(duplicateTrailId, canonicalTrailId, root);
    return { canonicalTrailId };
  }

  function waitForFile(path: string): void {
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
      Atomics.wait(waiter, 0, 0, 10);
    }
  }

  test('retires an unused duplicate id at the canonical live path', async () => {
    await runInit({ cwd: root, project: 'Word Sparkle', json: true });
    const canonicalTrailId = readConfig(pathsForRoot(root)).trailId!;
    const duplicateTrailId = 'trl_duplicate_word';
    const now = new Date().toISOString();
    const global = readGlobalConfig();
    writeGlobalConfig({
      ...global,
      knownProjects: [
        ...(global.knownProjects ?? []),
        { trailId: duplicateTrailId, path: root, lastSeenAt: now },
      ],
      projectCatalog: {
        version: 1,
        byTrailId: {
          ...(global.projectCatalog?.version === 1
            ? global.projectCatalog.byTrailId
            : {}),
          [duplicateTrailId]: {
            trailId: duplicateTrailId,
            currentPath: root,
            currentFolderBasename: 'word_sparkle',
            lastSeenAt: now,
          },
        },
      },
    });
    writeJson(join(home, 'ledger', 'index.json'), {
      version: 1,
      byKey: {},
      trails: {
        [duplicateTrailId]: { path: root, lastSeenAt: now },
      },
      sessions: {},
    });

    supersedeTrailIdentity(duplicateTrailId, canonicalTrailId, root);

    expect(trailIdentitySupersession(duplicateTrailId)).toEqual(
      expect.objectContaining({
        canonicalTrailId,
        canonicalPath: root,
        reason: 'same-path-duplicate',
      }),
    );
    expect(readLedgerIndex().trails[duplicateTrailId]).toBeUndefined();
    expect(readLedgerIndex().trails[canonicalTrailId]?.path).toBe(root);
    expect(
      readGlobalConfig().knownProjects?.some(
        (project) => project.trailId === duplicateTrailId,
      ),
    ).toBe(false);
    expect(
      readGlobalConfig().projectCatalog?.byTrailId[duplicateTrailId],
    ).toBeUndefined();
  });

  test('refuses retirement while a range still belongs to the duplicate id', async () => {
    await runInit({ cwd: root, project: 'Word Sparkle', json: true });
    const canonicalTrailId = readConfig(pathsForRoot(root)).trailId!;
    const duplicateTrailId = 'trl_duplicate_in_use';
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'duplicate-still-in-use',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'preserve this range',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    expect(segment?.promptRecordId).toBe(prompt.id);
    markLedgerSegmentPlaced(session.id, segment!.id, duplicateTrailId, root);

    expect(() =>
      supersedeTrailIdentity(duplicateTrailId, canonicalTrailId, root),
    ).toThrow(`still owns ledger session ${session.id}`);
    expect(trailIdentitySupersession(duplicateTrailId)).toBeUndefined();
  });

  test('reports a live project config that resurrects a retired id', async () => {
    const duplicateTrailId = 'trl_retired_live_config';
    const { canonicalTrailId } = await retireUnusedDuplicate(duplicateTrailId);
    const paths = pathsForRoot(root);
    writeConfig(paths, { ...readConfig(paths), trailId: duplicateTrailId });

    expect(projectIdentityConflicts(paths)).toContainEqual(
      expect.objectContaining({
        code: 'RETIRED_TRAIL_ID',
        trailIds: [duplicateTrailId, canonicalTrailId],
        paths: [root],
      }),
    );
  });

  test('keeps retirement durable across a stale global-config write', async () => {
    await runInit({ cwd: root, project: 'Word Sparkle', json: true });
    const canonicalTrailId = readConfig(pathsForRoot(root)).trailId!;
    const duplicateTrailId = 'trl_retired_stale_global';
    const staleGlobal = readGlobalConfig();
    const index = readLedgerIndex();
    writeJson(join(home, 'ledger', 'index.json'), {
      ...index,
      trails: {
        ...index.trails,
        [duplicateTrailId]: {
          path: root,
          lastSeenAt: new Date().toISOString(),
        },
      },
    });
    supersedeTrailIdentity(duplicateTrailId, canonicalTrailId, root);

    writeGlobalConfig({
      ...staleGlobal,
      knownProjects: [
        ...(staleGlobal.knownProjects ?? []),
        {
          trailId: duplicateTrailId,
          path: root,
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    expect(trailIdentitySupersession(duplicateTrailId)?.canonicalTrailId).toBe(
      canonicalTrailId,
    );
    expect(
      readGlobalConfig().knownProjects?.some(
        (project) => project.trailId === duplicateTrailId,
      ),
    ).toBe(false);
  });

  test('rejects retired ids from segment, session, and location writes', async () => {
    const duplicateTrailId = 'trl_retired_write';
    await retireUnusedDuplicate(duplicateTrailId);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'retired-write-rejection',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'do not resurrect this identity',
    });
    const [segment] = ensureLedgerSegments(session).segments;

    expect(() =>
      markLedgerSegmentPlaced(session.id, segment!.id, duplicateTrailId, root),
    ).toThrow('has been retired');
    expect(() => markPlaced(session.id, duplicateTrailId, root)).toThrow(
      'has been retired',
    );
    expect(() => noteTrailLocation(duplicateTrailId, root)).toThrow('has been retired');
    expect(() =>
      supersedeTrailIdentity('trl_new_duplicate', duplicateTrailId, root),
    ).toThrow('has been retired');

    expect(ensureLedgerSegments(session.id).segments[0]?.targets ?? []).toEqual([]);
    expect(readLedgerSession(session.id)?.targets ?? []).toEqual([]);
    expect(readLedgerIndex().trails[duplicateTrailId]).toBeUndefined();
    expect(readLedgerIndex().sessions[session.id] ?? []).not.toContain(duplicateTrailId);
  });

  test('rejects an index write while any retired id would remain indexed', async () => {
    const duplicateTrailId = 'trl_retired_stale_index';
    const { canonicalTrailId } = await retireUnusedDuplicate(duplicateTrailId);
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'retired-index-rejection',
    });
    const index = readLedgerIndex();
    writeJson(join(home, 'ledger', 'index.json'), {
      ...index,
      trails: {
        ...index.trails,
        [duplicateTrailId]: {
          path: root,
          lastSeenAt: new Date().toISOString(),
        },
      },
    });

    expect(() => markPlaced(session.id, canonicalTrailId, root)).toThrow(
      'has been retired',
    );
    expect(readLedgerSession(session.id)?.targets ?? []).toEqual([]);
    expect(readLedgerIndex().trails[duplicateTrailId]?.path).toBe(root);
  });

  test('rejects a target repoint to a live config carrying a retired id', async () => {
    const duplicateTrailId = 'trl_retired_repoint';
    await retireUnusedDuplicate(duplicateTrailId);
    const paths = pathsForRoot(root);
    writeConfig(paths, { ...readConfig(paths), trailId: duplicateTrailId });
    const oldTrailId = 'trl_repoint_source';
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'retired-repoint-rejection',
    });
    markPlaced(session.id, oldTrailId, root);

    expect(() => allLedgerSessionViews()).toThrow('has been retired');
    expect(readLedgerSession(session.id)?.targets).toEqual([
      { trailId: oldTrailId, path: root },
    ]);
    expect(readLedgerIndex().trails[duplicateTrailId]).toBeUndefined();
    expect(readLedgerIndex().sessions[session.id]).toEqual([oldTrailId]);
  });

  test('serializes retirement against a concurrent segment placement', async () => {
    await runInit({ cwd: root, project: 'Word Sparkle', json: true });
    const canonicalTrailId = readConfig(pathsForRoot(root)).trailId!;
    const duplicateTrailId = 'trl_concurrent_retirement';
    const index = readLedgerIndex();
    writeJson(join(home, 'ledger', 'index.json'), {
      ...index,
      trails: {
        ...index.trails,
        [duplicateTrailId]: {
          path: root,
          lastSeenAt: new Date().toISOString(),
        },
      },
    });
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'concurrent-retirement-placement',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'race this placement with retirement',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    const readyPath = join(home, 'placement-child-ready');
    const childScript = `
      const fs = await import('node:fs');
      const ledger = await import('./src/core/ledger.ts');
      fs.writeFileSync(process.env.SHOWTAIL_TEST_READY, 'ready');
      try {
        ledger.markLedgerSegmentPlaced(
          process.env.SHOWTAIL_TEST_SESSION,
          process.env.SHOWTAIL_TEST_SEGMENT,
          process.env.SHOWTAIL_TEST_TRAIL,
          process.env.SHOWTAIL_TEST_ROOT,
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 17;
      }
    `;
    let childError = '';
    let childExit: Promise<number | null> | undefined;

    withTrailIdentityMutationLock(() => {
      const child = spawn(process.execPath, ['--eval', childScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SHOWTAIL_HOME: home,
          SHOWTAIL_TEST_READY: readyPath,
          SHOWTAIL_TEST_SESSION: session.id,
          SHOWTAIL_TEST_SEGMENT: segment!.id,
          SHOWTAIL_TEST_TRAIL: duplicateTrailId,
          SHOWTAIL_TEST_ROOT: root,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        childError += chunk;
      });
      childExit = new Promise((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', resolveExit);
      });
      waitForFile(readyPath);
      supersedeTrailIdentity(duplicateTrailId, canonicalTrailId, root);
    });

    expect(await childExit!).toBe(17);
    expect(childError).toContain('has been retired');
    expect(ensureLedgerSegments(session.id).segments[0]?.targets ?? []).toEqual([]);
    expect(readLedgerSession(session.id)?.targets ?? []).toEqual([]);
    expect(readLedgerIndex().trails[duplicateTrailId]).toBeUndefined();
    expect(readLedgerIndex().sessions[session.id] ?? []).not.toContain(duplicateTrailId);
    expect(trailIdentitySupersession(duplicateTrailId)?.canonicalTrailId).toBe(
      canonicalTrailId,
    );
  });

  test('recovers a stale identity lock before placing an active trail', async () => {
    await runInit({ cwd: root, project: 'Word Sparkle', json: true });
    const trailId = readConfig(pathsForRoot(root)).trailId!;
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'stale-identity-lock',
    });
    const lockPath = trailIdentityMutationLockPath();
    writeFileSync(
      lockPath,
      `${JSON.stringify({ token: 'abandoned', pid: 1, acquiredAt: 'stale' })}\n`,
      'utf8',
    );
    const staleAt = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockPath, staleAt, staleAt);

    markPlaced(session.id, trailId, root);

    expect(existsSync(lockPath)).toBe(false);
    expect(readLedgerSession(session.id)?.targets).toEqual([{ trailId, path: root }]);
    expect(readLedgerIndex().sessions[session.id]).toEqual([trailId]);
  });
});
