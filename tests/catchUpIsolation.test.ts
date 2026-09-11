import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { catchUpFromTranscripts } from '../src/core/catchUp.ts';
import {
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  ledgerSegmentProjectContexts,
  markLedgerSegmentPlaced,
  readLedgerSession,
  setLedgerTranscriptPath,
} from '../src/core/ledger.ts';
import { materializeLedgerSegment } from '../src/core/materialize.ts';
import { pathsForRoot, readConfig, samePath } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

let home: string;
let previousHome: string | undefined;
const roots: string[] = [];

async function initializedProject(name: string): Promise<string> {
  const root = makeTempDir();
  roots.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  await runInit({ cwd: root, project: name });
  return root;
}

beforeEach(() => {
  previousHome = process.env.SHOWTAIL_HOME;
  home = makeTempDir();
  process.env.SHOWTAIL_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = previousHome;
  for (const root of roots.splice(0)) cleanup(root);
  cleanup(home);
});

describe('report catch-up project isolation', () => {
  test('leaves B placed when reporting A discovers a late B+C ambiguity', async () => {
    const projectA = await initializedProject('Project A');
    const projectB = await initializedProject('Project B');
    const projectC = await initializedProject('Project C');
    const fileA = join(projectA, 'a.ts');
    const fileB = join(projectB, 'b.ts');
    const fileC = join(projectC, 'c.ts');
    writeFileSync(fileA, 'export const a = true;\n');
    writeFileSync(fileB, 'export const b = true;\n');
    writeFileSync(fileC, 'export const c = true;\n');

    const session = ensureLedgerSession({
      tool: 'claude-code',
      nativeSessionId: 'mixed-project-catch-up-isolation',
      cwd: projectA,
    });
    const promptA = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'work in A',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'claude-code',
      file: fileA,
      diff: '+ a',
      turnKey: promptA.id,
    });
    const promptB = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'work in B',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'claude-code',
      file: fileB,
      diff: '+ b',
      turnKey: promptB.id,
    });

    const pathsA = pathsForRoot(projectA);
    const pathsB = pathsForRoot(projectB);
    const [segmentA, segmentB] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segmentA!, authorFor(pathsA));
    markLedgerSegmentPlaced(
      session.id,
      segmentA!.id,
      readConfig(pathsA).trailId!,
      projectA,
    );
    await materializeLedgerSegment(session, segmentB!, authorFor(pathsB));
    markLedgerSegmentPlaced(
      session.id,
      segmentB!.id,
      readConfig(pathsB).trailId!,
      projectB,
    );

    const base = Date.now() + 1_000;
    const transcript = join(projectA, 'mixed-project-catch-up.jsonl');
    writeFileSync(
      transcript,
      [
        {
          type: 'user',
          uuid: 'isolation-user-a',
          timestamp: new Date(base).toISOString(),
          cwd: projectA,
          message: { role: 'user', content: 'work in A' },
        },
        {
          type: 'assistant',
          uuid: 'isolation-assistant-a',
          timestamp: new Date(base + 1).toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            content: [
              {
                type: 'tool_use',
                id: 'isolation-edit-a',
                name: 'Edit',
                input: { file_path: fileA },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'isolation-user-b',
          timestamp: new Date(base + 2).toISOString(),
          cwd: projectB,
          message: { role: 'user', content: 'work in B' },
        },
        {
          type: 'assistant',
          uuid: 'isolation-assistant-b',
          timestamp: new Date(base + 3).toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            content: [
              {
                type: 'tool_use',
                id: 'isolation-edit-b',
                name: 'Edit',
                input: { file_path: fileB },
              },
              {
                type: 'tool_use',
                id: 'isolation-edit-c',
                name: 'Edit',
                input: { file_path: fileC },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    setLedgerTranscriptPath(session.id, transcript);

    const result = await catchUpFromTranscripts(authorFor(pathsA));
    const currentSession = readLedgerSession(session.id)!;
    const document = ensureLedgerSegments(currentSession);
    const currentB = document.segments.find((segment) => segment.id === segmentB!.id)!;
    const routeB = ledgerSegmentProjectContexts(currentSession, document).get(
      currentB.id,
    );

    if (!routeB || routeB.state !== 'ambiguous') {
      throw new Error('Expected the late B+C turn to become ambiguous');
    }
    expect(routeB.candidates.some((candidate) => samePath(candidate, projectB))).toBe(
      true,
    );
    expect(routeB.candidates.some((candidate) => samePath(candidate, projectC))).toBe(
      true,
    );

    expect(currentB.status).toBe('placed');
    expect(currentB.targets).toHaveLength(1);
    expect(currentB.targets?.[0]?.trailId).toBe(readConfig(pathsB).trailId);
    expect(samePath(currentB.targets![0]!.path, resolve(projectB))).toBe(true);

    expect(currentSession.status).toBe('placed');
    expect(currentSession.targets).toHaveLength(2);
    expect(
      currentSession.targets?.some(
        (target) =>
          target.trailId === readConfig(pathsA).trailId &&
          samePath(target.path, projectA),
      ),
    ).toBe(true);
    expect(
      currentSession.targets?.some(
        (target) =>
          target.trailId === readConfig(pathsB).trailId &&
          samePath(target.path, projectB),
      ),
    ).toBe(true);
    expect(result.pendingAmbiguousRanges).toEqual([]);
    expect(result.reroutedRanges).toEqual([]);
  });
});
