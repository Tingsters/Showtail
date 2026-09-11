import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { claimPendingWork, pendingWorkForRoot, runInit } from '../src/commands/init.ts';
import { readAllEvents } from '../src/core/events.ts';
import { sha256OfString } from '../src/core/hash.ts';
import {
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  ledgerSegmentProjectContext,
  markLedgerSegmentPlaced,
  readLedgerSession,
} from '../src/core/ledger.ts';
import { materializeLedgerSegment } from '../src/core/materialize.ts';
import { pathsForRoot, readConfig } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

let home: string;
let previousHome: string | undefined;
const roots: string[] = [];

function project(): string {
  const root = makeTempDir();
  mkdirSync(join(root, '.git'), { recursive: true });
  roots.push(root);
  return root;
}

function seedFile(root: string, relative: string, content: string): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function writeDiffFor(content: string): string {
  return content
    .split('\n')
    .map((line) => `+ ${line}`)
    .join('\n');
}

function appendTurn(
  sessionId: string,
  text: string,
  file: string,
  content: string,
  staleContextRoot?: string,
): void {
  const prompt = appendLedgerRecord(sessionId, {
    kind: 'prompt',
    tool: 'github-copilot',
    text,
    ...(staleContextRoot
      ? {
          context: {
            cwd: staleContextRoot,
            workspacePaths: [staleContextRoot],
            scope: 'session' as const,
          },
        }
      : {}),
  });
  appendLedgerRecord(sessionId, {
    kind: 'edit',
    tool: 'github-copilot',
    file,
    diff: writeDiffFor(content),
    sha256: sha256OfString(content),
    turnKey: prompt.id,
  });
}

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

describe('segment-aware pending work claims', () => {
  test('does not claim a context-free editor turn from ambient workspace metadata', async () => {
    const destination = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'ambient-single-turn-workspace',
      cwd: null,
      workspacePaths: [destination],
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'explain a generic while loop',
    });
    const [segment] = ensureLedgerSegments(session).segments;

    expect(ledgerSegmentProjectContext(session, segment!)).toEqual({
      state: 'none',
      root: null,
      evidence: null,
      candidates: [],
    });
    expect((await pendingWorkForRoot(destination)).ranges).toEqual([]);

    const claimed = await claimResolved(destination);
    expect(claimed.placed).toBe(0);
    expect(claimed.claimedSegments).toEqual([]);
    expect(existsSync(join(destination, '.showtail'))).toBe(false);
    expect(ensureLedgerSegments(readLedgerSession(session.id)!).segments[0]?.status).toBe(
      'inbox',
    );
  });

  test('keeps the single-turn cwd fallback for terminal tools', async () => {
    const destination = project();
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'terminal-single-turn-cwd',
      cwd: destination,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'explain the project from this terminal',
    });
    const [segment] = ensureLedgerSegments(session).segments;

    expect(ledgerSegmentProjectContext(session, segment!).state).toBe('none');
    expect((await pendingWorkForRoot(destination)).ranges).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        rangeId: segment!.id,
      }),
    ]);

    const claimed = await claimResolved(destination);
    expect(claimed.placed).toBe(1);
    expect(readAllEvents(pathsForRoot(destination)).map((event) => event.text)).toEqual([
      'explain the project from this terminal',
    ]);
  });

  test('claims A and later B independently from one mixed native chat', async () => {
    const first = project();
    const second = project();
    const firstContent = 'export const fairy = "sparkle";\n';
    const secondContent = 'export const word = "sparkle";\n';
    const firstFile = seedFile(first, join('src', 'fairy.ts'), firstContent);
    const secondFile = seedFile(second, join('src', 'word.ts'), secondContent);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'mixed-chat-claims',
      cwd: first,
      workspacePaths: [first],
    });
    appendTurn(session.id, 'build Fairy Sparkle', firstFile, firstContent, first);
    appendTurn(session.id, 'now build Word Sparkle', secondFile, secondContent, first);
    const [firstSegment, secondSegment] = ensureLedgerSegments(session).segments;
    const firstId = `${session.id}:${firstSegment!.id}`;
    const secondId = `${session.id}:${secondSegment!.id}`;

    const firstPreview = await pendingWorkForRoot(first);
    expect(firstPreview.ranges).toEqual([
      expect.objectContaining({
        id: firstId,
        sessionId: session.id,
        rangeId: firstSegment!.id,
        segmentIds: [firstSegment!.id],
      }),
    ]);
    expect(firstPreview.sessions).toEqual([expect.objectContaining({ id: session.id })]);
    expect(firstPreview.safeSegmentRelocations).toEqual([]);

    const firstClaim = await claimResolved(first);
    expect(firstClaim.placed).toBe(1);
    expect(firstClaim.claimedSegments).toEqual([
      expect.objectContaining({
        id: firstId,
        sessionId: session.id,
        rangeId: firstSegment!.id,
        segmentIds: [firstSegment!.id],
      }),
    ]);
    expect(firstClaim.claimedSessions).toEqual([session.id]);
    expect(readAllEvents(pathsForRoot(first)).map((event) => event.text)).toEqual([
      'build Fairy Sparkle',
    ]);
    expect(existsSync(join(second, '.showtail'))).toBe(false);

    const afterFirst = ensureLedgerSegments(readLedgerSession(session.id)!);
    expect(afterFirst.segments.find((item) => item.id === firstSegment!.id)?.status).toBe(
      'placed',
    );
    expect(
      afterFirst.segments.find((item) => item.id === secondSegment!.id)?.status,
    ).toBe('inbox');

    const staleFolderRetry = await claimPendingWork(first, {
      mode: 'explicit',
      provisionalAuthor: true,
    });
    expect(staleFolderRetry.placed).toBe(0);
    expect(staleFolderRetry.claimedSegments).toEqual([]);

    const secondPreview = await pendingWorkForRoot(second);
    expect(secondPreview.ranges).toEqual([
      expect.objectContaining({
        id: secondId,
        sessionId: session.id,
        rangeId: secondSegment!.id,
        segmentIds: [secondSegment!.id],
      }),
    ]);
    expect(secondPreview.sessions).toEqual([expect.objectContaining({ id: session.id })]);

    const secondClaim = await claimResolved(second);
    expect(secondClaim.placed).toBe(1);
    expect(secondClaim.claimedSegments).toEqual([
      expect.objectContaining({
        id: secondId,
        sessionId: session.id,
        rangeId: secondSegment!.id,
        segmentIds: [secondSegment!.id],
      }),
    ]);
    expect(secondClaim.claimedSessions).toEqual([session.id]);
    expect(readAllEvents(pathsForRoot(first)).map((event) => event.text)).toEqual([
      'build Fairy Sparkle',
    ]);
    expect(readAllEvents(pathsForRoot(second)).map((event) => event.text)).toEqual([
      'now build Word Sparkle',
    ]);
  });

  test('does not assign a context-free prefix to the chat sole edit witness', async () => {
    const destination = project();
    const file = seedFile(destination, 'word.ts', 'export const word = true;\n');
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'unsafe-sole-witness-prefix',
    });
    for (const text of ['locate Fairy Sparkle', 'move the fairy game']) {
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text,
      });
    }
    appendTurn(session.id, 'build Word Sparkle', file, 'export const word = true;\n');
    const document = ensureLedgerSegments(session);

    const preview = await pendingWorkForRoot(destination);
    expect(preview.ranges).toEqual([
      expect.objectContaining({
        rangeId: document.segments[2]!.id,
        segmentIds: [document.segments[2]!.id],
      }),
    ]);

    const claimed = await claimResolved(destination);
    expect(claimed.claimedSegments).toHaveLength(1);
    expect(readAllEvents(pathsForRoot(destination)).map((event) => event.text)).toEqual([
      'build Word Sparkle',
    ]);
    const pending = ensureLedgerSegments(readLedgerSession(session.id)!).segments.filter(
      (segment) => segment.status === 'inbox',
    );
    expect(pending.map((segment) => segment.id)).toEqual([
      document.segments[0]!.id,
      document.segments[1]!.id,
    ]);
  });

  test('explicit claims ignore an edit path superseded into another project', async () => {
    const fairy = project();
    const word = project();
    const fairyContent = 'print("fairy")\n';
    const wordContent = 'print("word")\n';
    const fairyFile = seedFile(fairy, 'fairy_sparkle.py', fairyContent);
    const wordFile = seedFile(word, 'word_sparkle.py', wordContent);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'corrected-explicit-claim',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Word Sparkle',
    });
    const obsolete = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: fairyFile,
      diff: writeDiffFor(fairyContent),
      sha256: sha256OfString(fairyContent),
      turnKey: prompt.id,
      sourceId: 'copilot:edit:corrected-explicit-claim:game',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: wordFile,
      diff: writeDiffFor(wordContent),
      sha256: sha256OfString(wordContent),
      turnKey: prompt.id,
      sourceId: obsolete.sourceId,
      supersedesRecordId: obsolete.id,
    });
    const [segment] = ensureLedgerSegments(session).segments;

    const wrongClaim = await claimPendingWork(fairy, {
      mode: 'explicit',
      provisionalAuthor: true,
    });
    expect(wrongClaim.placed).toBe(0);
    expect(wrongClaim.claimedSegments).toEqual([]);
    expect(existsSync(join(fairy, '.showtail'))).toBe(false);

    const preview = await pendingWorkForRoot(word);
    expect(preview.ranges).toEqual([
      expect.objectContaining({
        id: `${session.id}:${segment!.id}`,
        rangeId: segment!.id,
        segmentIds: [segment!.id],
      }),
    ]);
    const claimed = await claimResolved(word);
    expect(claimed.placed).toBe(1);
    expect(readAllEvents(pathsForRoot(word)).map((event) => event.text)).toEqual([
      'build Word Sparkle',
    ]);
  });

  test('does not claim one atomic turn that edits A and B', async () => {
    const first = project();
    const second = project();
    const firstContent = 'export const first = true;\n';
    const secondContent = 'export const second = true;\n';
    const firstFile = seedFile(first, join('src', 'first.ts'), firstContent);
    const secondFile = seedFile(second, join('src', 'second.ts'), secondContent);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'atomic-multi-root-turn',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'change both games in one turn',
    });
    for (const [file, content] of [
      [firstFile, firstContent],
      [secondFile, secondContent],
    ] as const) {
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'github-copilot',
        file,
        diff: writeDiffFor(content),
        sha256: sha256OfString(content),
        turnKey: prompt.id,
      });
    }
    const [segment] = ensureLedgerSegments(session).segments;
    const id = `${session.id}:${segment!.id}`;

    const preview = await pendingWorkForRoot(first);
    expect(preview.ranges).toEqual([]);
    expect(preview.safeSegmentRelocations).toEqual([]);
    expect(preview.segmentRelocationCandidates).toEqual([]);
    expect(preview.pendingAmbiguousRanges).toEqual([
      expect.objectContaining({
        id,
        sessionId: session.id,
        rangeId: segment!.id,
        segmentIds: [segment!.id],
        candidates: expect.arrayContaining([resolve(first), resolve(second)]),
      }),
    ]);
    expect(preview.pendingAmbiguous).toEqual([
      expect.objectContaining({
        id: session.id,
        candidates: expect.arrayContaining([resolve(first), resolve(second)]),
      }),
    ]);

    const claimed = await claimResolved(first);
    expect(claimed.placed).toBe(0);
    expect(claimed.claimedSegments).toEqual([]);
    expect(claimed.relocatedSegments).toEqual([]);
    expect(claimed.pendingAmbiguousRanges).toEqual([
      expect.objectContaining({ id, sessionId: session.id }),
    ]);
    expect(existsSync(join(first, '.showtail'))).toBe(false);
    expect(existsSync(join(second, '.showtail'))).toBe(false);
    expect(ensureLedgerSegments(readLedgerSession(session.id)!).segments[0]?.status).toBe(
      'inbox',
    );
  });

  test('relocates only A from a placed A+B chat and leaves B untouched', async () => {
    const first = project();
    const moved = project();
    const second = project();
    await runInit({ cwd: first });
    await runInit({ cwd: second });

    const firstContent = 'export const fairyLevel = 7;\n';
    const secondContent = 'export const wordLevel = 9;\n';
    const firstFile = seedFile(first, join('src', 'fairy.ts'), firstContent);
    const secondFile = seedFile(second, join('src', 'word.ts'), secondContent);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'mixed-chat-segment-relocation',
    });
    appendTurn(session.id, 'build the fairy game', firstFile, firstContent);
    appendTurn(session.id, 'build the word game', secondFile, secondContent);
    const [firstSegment, secondSegment] = ensureLedgerSegments(session).segments;
    const firstPaths = pathsForRoot(first);
    const secondPaths = pathsForRoot(second);

    await materializeLedgerSegment(session, firstSegment!, authorFor(firstPaths));
    markLedgerSegmentPlaced(
      session.id,
      firstSegment!.id,
      readConfig(firstPaths).trailId!,
      first,
    );
    await materializeLedgerSegment(session, secondSegment!, authorFor(secondPaths));
    markLedgerSegmentPlaced(
      session.id,
      secondSegment!.id,
      readConfig(secondPaths).trailId!,
      second,
    );
    const secondEventsBefore = readAllEvents(secondPaths).map((event) => event.text);

    const movedFile = join(moved, 'src', 'fairy.ts');
    mkdirSync(dirname(movedFile), { recursive: true });
    renameSync(firstFile, movedFile);

    const preview = await pendingWorkForRoot(moved);
    const firstId = `${session.id}:${firstSegment!.id}`;
    expect(preview.ranges).toEqual([]);
    expect(preview.safeSegmentRelocations).toEqual([
      expect.objectContaining({
        id: firstId,
        sessionId: session.id,
        rangeId: firstSegment!.id,
        segmentIds: [firstSegment!.id],
        from: resolve(first),
        to: resolve(moved),
        tier: 'A',
      }),
    ]);
    expect(preview.safeRelocations).toEqual([]);
    expect(preview.segmentRelocationCandidates).toEqual([]);

    const claimed = await claimResolved(moved);
    expect(claimed.placed).toBe(1);
    expect(claimed.claimedSegments).toEqual([]);
    expect(claimed.relocatedSegments).toEqual([
      expect.objectContaining({
        id: firstId,
        sessionId: session.id,
        rangeId: firstSegment!.id,
        segmentIds: [firstSegment!.id],
        from: resolve(first),
        to: resolve(moved),
        tier: 'A',
      }),
    ]);
    expect(claimed.relocatedSessions).toEqual([]);

    expect(readAllEvents(firstPaths).map((event) => event.text)).toEqual([]);
    expect(readAllEvents(pathsForRoot(moved)).map((event) => event.text)).toEqual([
      'build the fairy game',
    ]);
    expect(readAllEvents(secondPaths).map((event) => event.text)).toEqual(
      secondEventsBefore,
    );
    expect(secondEventsBefore).toEqual(['build the word game']);
    expect(existsSync(join(first, '.showtail', 'config.json'))).toBe(true);

    const stored = ensureLedgerSegments(readLedgerSession(session.id)!);
    expect(stored.segments.find((item) => item.id === firstSegment!.id)?.targets).toEqual(
      [expect.objectContaining({ path: resolve(moved) })],
    );
    expect(
      stored.segments.find((item) => item.id === secondSegment!.id)?.targets,
    ).toEqual([expect.objectContaining({ path: resolve(second) })]);
    expect(
      stored.segments.find((item) => item.id === secondSegment!.id)?.pathRebases,
    ).toBeUndefined();
  });

  test('relocation ignores an obsolete edit replaced by a correction', async () => {
    const obsoleteRoot = project();
    const source = project();
    const moved = project();
    await runInit({ cwd: source });

    const obsoleteContent = 'print("fairy")\n';
    const correctedContent = 'print("word")\n';
    const obsoleteFile = seedFile(obsoleteRoot, 'fairy_sparkle.py', obsoleteContent);
    const sourceFile = seedFile(source, join('src', 'word_sparkle.py'), correctedContent);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'corrected-relocation-discovery',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'move Word Sparkle',
    });
    const obsolete = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: obsoleteFile,
      diff: writeDiffFor(obsoleteContent),
      sha256: sha256OfString(obsoleteContent),
      turnKey: prompt.id,
      sourceId: 'copilot:edit:corrected-relocation-discovery:game',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: sourceFile,
      diff: writeDiffFor(correctedContent),
      sha256: sha256OfString(correctedContent),
      turnKey: prompt.id,
      sourceId: obsolete.sourceId,
      supersedesRecordId: obsolete.id,
    });
    const [segment] = ensureLedgerSegments(session).segments;
    const sourcePaths = pathsForRoot(source);
    await materializeLedgerSegment(session, segment!, authorFor(sourcePaths));
    markLedgerSegmentPlaced(
      session.id,
      segment!.id,
      readConfig(sourcePaths).trailId!,
      source,
    );

    const movedFile = join(moved, 'src', 'word_sparkle.py');
    mkdirSync(dirname(movedFile), { recursive: true });
    renameSync(sourceFile, movedFile);

    const preview = await pendingWorkForRoot(moved);
    expect(preview.safeSegmentRelocations).toEqual([
      expect.objectContaining({
        id: `${session.id}:${segment!.id}`,
        rangeId: segment!.id,
        segmentIds: [segment!.id],
        from: resolve(source),
        to: resolve(moved),
        tier: 'A',
      }),
    ]);
    expect(preview.segmentRelocationCandidates).toEqual([]);
  });
});
