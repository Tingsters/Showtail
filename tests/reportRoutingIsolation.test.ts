import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { reconcileReportRouting } from '../src/commands/reportRouting.ts';
import {
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  markLedgerSegmentPlaced,
  noteTrailLocation,
  readLedgerSession,
} from '../src/core/ledger.ts';
import { pathsForRoot, readConfig } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

let home: string;
let previousHome: string | undefined;
let root: string;
const roots: string[] = [];

beforeEach(() => {
  previousHome = process.env.SHOWTAIL_HOME;
  home = makeTempDir();
  root = makeTempDir();
  roots.push(root);
  process.env.SHOWTAIL_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = previousHome;
  for (const projectRoot of roots.splice(0)) cleanup(projectRoot);
  cleanup(home);
});

describe('report routing project identity', () => {
  test('does not reconcile an old trail after its path is reused by a new trail', async () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    await runInit({ cwd: root, project: 'Original project', json: true });
    const paths = pathsForRoot(root);
    const originalTrailId = readConfig(paths).trailId!;
    const editedFile = join(root, 'game.ts');
    writeFileSync(editedFile, 'export const game = true;\n');

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'reused-path-report-routing',
      cwd: root,
      workspacePaths: [root],
    });
    const projectPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build the original game',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: editedFile,
      diff: '+ game',
      turnKey: projectPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'unresolved work from the original project',
      context: { cwd: null, workspacePaths: [], scope: 'turn' },
    });

    const originalDocument = ensureLedgerSegments(session);
    for (const segment of originalDocument.segments) {
      markLedgerSegmentPlaced(session.id, segment.id, originalTrailId, root);
    }
    const before = structuredClone(ensureLedgerSegments(session));

    // The old project is gone and an unrelated trail now occupies the same path.
    rmSync(paths.base, { recursive: true, force: true });
    await runInit({ cwd: root, project: 'Replacement project', json: true });
    const replacementTrailId = readConfig(paths).trailId!;
    expect(replacementTrailId).not.toBe(originalTrailId);

    const result = await reconcileReportRouting(root);
    const currentSession = readLedgerSession(session.id)!;

    expect(ensureLedgerSegments(currentSession)).toEqual(before);
    expect(currentSession.status).toBe('placed');
    expect(currentSession.targets).toEqual([{ trailId: originalTrailId, path: root }]);
    expect(result).toEqual({
      reroutedRanges: [],
      cleanedPendingRanges: [],
      warnings: [],
    });
  });

  test('does not trust a stale known path after that path gets a new trail', async () => {
    const replacement = makeTempDir();
    roots.push(replacement);
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(replacement, '.git'), { recursive: true });
    await runInit({ cwd: root, project: 'Moved original', json: true });
    const originalPaths = pathsForRoot(root);
    const replacementPaths = pathsForRoot(replacement);
    const originalTrailId = readConfig(originalPaths).trailId!;
    const editedFile = join(root, 'game.ts');
    writeFileSync(editedFile, 'export const game = true;\n');

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'stale-known-path-report-routing',
      cwd: root,
      workspacePaths: [root],
    });
    const projectPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build the project before it moves',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: editedFile,
      diff: '+ game',
      turnKey: projectPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'unresolved work before the move',
      context: { cwd: null, workspacePaths: [], scope: 'turn' },
    });

    const originalDocument = ensureLedgerSegments(session);
    for (const segment of originalDocument.segments) {
      markLedgerSegmentPlaced(session.id, segment.id, originalTrailId, root);
    }

    // First establish a legitimate moved-path index entry for the old trail.
    cpSync(originalPaths.base, replacementPaths.base, { recursive: true });
    rmSync(originalPaths.base, { recursive: true, force: true });
    expect(noteTrailLocation(originalTrailId, replacement).moved).toBe(true);

    // Then remove that moved trail and initialize unrelated work at the same path.
    rmSync(replacementPaths.base, { recursive: true, force: true });
    await runInit({ cwd: replacement, project: 'Replacement project', json: true });
    expect(readConfig(replacementPaths).trailId).not.toBe(originalTrailId);
    const before = structuredClone(ensureLedgerSegments(session));

    const result = await reconcileReportRouting(replacement);
    const currentSession = readLedgerSession(session.id)!;

    expect(ensureLedgerSegments(currentSession)).toEqual(before);
    expect(currentSession.status).toBe('placed');
    expect(currentSession.targets).toEqual([{ trailId: originalTrailId, path: root }]);
    expect(existsSync(originalPaths.base)).toBe(false);
    expect(result).toEqual({
      reroutedRanges: [],
      cleanedPendingRanges: [],
      warnings: [],
    });
  });
});
