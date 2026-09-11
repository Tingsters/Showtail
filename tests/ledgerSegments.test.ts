import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { catchUpFromTranscripts } from '../src/core/catchUp.ts';
import { parseCopilotSession } from '../src/core/copilotChatTranscript.ts';
import { latestBatchId, readAllEvents } from '../src/core/events.ts';
import { addScratchPath } from '../src/core/globalConfig.ts';
import { readJournal } from '../src/core/journal.ts';
import {
  LEDGER_SEGMENTS_VERSION,
  appendLedgerRecord,
  dismissLedgerRange,
  effectiveLedgerSegmentPath,
  ensureLedgerSegments,
  ensureLedgerSession,
  ledgerSegmentProjectContexts,
  listActionableLedgerRanges,
  markLedgerSegmentPlaced,
  markPlaced,
  placeLedgerRange,
  readLedgerRecords,
  resolveLedgerRangeSelector,
  sessionProjectContext,
  setLedgerTurnProjectMetadata,
  setLedgerTranscriptPath,
  type LedgerSegment,
} from '../src/core/ledger.ts';
import { captureTranscriptToLedger } from '../src/core/ledgerCapture.ts';
import {
  ledgerSegmentBatchId,
  materializeLedgerSegment,
  materializeLedgerSession,
} from '../src/core/materialize.ts';
import { reprojectLedgerSegment } from '../src/core/projectionRouting.ts';
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

describe('ledger turn segmentation', () => {
  test('persists a versioned sidecar without rewriting raw records', () => {
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'native-chat',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build it',
      sourceId: 'copilot:user:native-chat:request-1',
    });
    const before = readFileSync(
      join(home, 'ledger', 'sessions', session.id, 'records.jsonl'),
      'utf8',
    );

    const first = ensureLedgerSegments(session);
    expect(first.version).toBe(LEDGER_SEGMENTS_VERSION);
    expect(first.segments).toHaveLength(1);
    expect(first.segments[0]?.promptRecordId).toBe(prompt.id);

    // A late Copilot edit can lack turnKey in old ledgers. Its request id still
    // rejoins the prompt segment instead of becoming a new/neighboring turn.
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(project(), 'game.ts'),
      diff: '+ game',
      sourceId: 'copilot:edit:native-chat:request-1#game.ts',
    });
    const refreshed = ensureLedgerSegments(session);
    expect(refreshed.segments).toHaveLength(1);
    expect(refreshed.segments[0]?.recordIds).toHaveLength(2);
    expect(
      readFileSync(join(home, 'ledger', 'sessions', session.id, 'segments.json'), 'utf8'),
    ).toContain(`"version": ${LEDGER_SEGMENTS_VERSION}`);
    expect(
      readFileSync(
        join(home, 'ledger', 'sessions', session.id, 'records.jsonl'),
        'utf8',
      ).startsWith(before),
    ).toBe(true);
    expect(readLedgerRecords(session.id).map((record) => record.id)).toEqual(
      refreshed.segments[0]?.recordIds ?? [],
    );
  });

  test('migrates a v1 sidecar without losing turn placement metadata', () => {
    const root = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'legacy-segments',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'legacy turn',
    });
    const current = ensureLedgerSegments(session);
    current.segments[0]!.status = 'placed';
    current.segments[0]!.targets = [{ trailId: 'trl_legacy', path: root }];
    const sidecar = join(home, 'ledger', 'sessions', session.id, 'segments.json');
    writeFileSync(sidecar, JSON.stringify({ ...current, version: 1 }), 'utf8');

    const migrated = ensureLedgerSegments(session);
    expect(migrated.version).toBe(LEDGER_SEGMENTS_VERSION);
    expect(migrated.segments[0]).toEqual(
      expect.objectContaining({
        status: 'placed',
        targets: [{ trailId: 'trl_legacy', path: root }],
      }),
    );
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).version).toBe(
      LEDGER_SEGMENTS_VERSION,
    );
  });

  test('workspace and cwd alone cannot route a new zero-edit native editor turn', () => {
    const stale = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'workspace-only-native-chat',
      cwd: stale,
      workspacePaths: [stale],
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'give me a report',
      context: { cwd: stale, workspacePaths: [stale], scope: 'session' },
    });

    const [route] = ledgerSegmentProjectContexts(session).values();
    expect(route).toEqual({ state: 'none', root: null, evidence: null, candidates: [] });
    expect(sessionProjectContext(session)).toEqual(route!);
  });

  test('persists explicit attachments and a validated control target on the exact request', async () => {
    const attached = project();
    const selected = project();
    await runInit({ cwd: selected });
    const selectedTrail = readConfig(pathsForRoot(selected)).trailId!;
    const attachedFile = join(attached, 'src', 'game.ts');
    const ignoredImplicit = join(selected, 'active.ts');
    const marker = {
      showtailProjectControl: 'showtail-project-control/v1',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      action: 'report',
      trailId: selectedTrail,
      root: selected,
      mode: 'corroborated',
      evidence: ['complete-name', 'edit-focus'],
      reportPath: join(selected, '.showtail', 'reports', 'report.html'),
    };
    const native = {
      sessionId: 'bound-native-chat',
      requests: [
        {
          requestId: 'request-bound',
          timestamp: Date.parse('2026-09-10T10:00:00.000Z'),
          message: { text: 'report my game' },
          agent: { extensionId: { value: 'GitHub.copilot-chat' } },
          variableData: {
            variables: [
              { kind: 'file', id: 'file:///game.ts', value: { fsPath: attachedFile } },
              {
                kind: 'file',
                id: 'vscode.implicit.selection',
                value: { uri: { fsPath: ignoredImplicit } },
              },
              {
                kind: 'file',
                id: 'auto-file',
                automaticallyAdded: true,
                value: { fsPath: ignoredImplicit },
              },
            ],
          },
          response: [{ value: 'Done.' }],
          result: {
            metadata: {
              toolCallRounds: [
                {
                  toolCalls: [
                    {
                      id: 'call-control',
                      name: 'showtail_project_control',
                      arguments: JSON.stringify({
                        action: 'report',
                        selector: 'my game',
                      }),
                    },
                  ],
                },
              ],
              toolCallResults: {
                'call-control': { content: [{ value: JSON.stringify(marker) }] },
              },
            },
          },
        },
      ],
    };
    const parsed = parseCopilotSession(native, attached);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'bound-native-chat',
      cwd: selected,
      workspacePaths: [selected],
    });
    expect(
      captureTranscriptToLedger(session, parsed, 'github-copilot', [], {
        backfill: true,
      }),
    ).toBe(true);

    const [segment] = ensureLedgerSegments(session).segments;
    expect(segment).toEqual(
      expect.objectContaining({
        nativeRequestId: 'request-bound',
        attachments: [{ kind: 'file', path: attachedFile }],
        controlTarget: expect.objectContaining({
          schemaVersion: 1,
          nativeSessionId: 'bound-native-chat',
          nativeRequestId: 'request-bound',
          claimId: marker.claimId,
          trailId: selectedTrail,
          root: selected,
        }),
      }),
    );
    // The explicit attachment outranks the report destination for work routing.
    expect(ledgerSegmentProjectContexts(session).get(segment!.id)).toEqual(
      expect.objectContaining({
        state: 'candidate',
        root: attached,
        evidence: 'attachment',
      }),
    );
  });

  test('a validated control target routes zero-edit followups but never conflicting edits', async () => {
    const edited = project();
    const selected = project();
    await runInit({ cwd: selected });
    const trailId = readConfig(pathsForRoot(selected)).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'control-followup',
      cwd: edited,
      workspacePaths: [edited],
    });
    const reportPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'make the report',
      sourceId: 'copilot:user:control-followup:request-report',
    });
    setLedgerTurnProjectMetadata(session.id, reportPrompt.id, {
      nativeRequestId: 'request-report',
      controlTarget: {
        claimId: '123e4567-e89b-42d3-a456-426614174001',
        action: 'report',
        trailId,
        root: selected,
        mode: 'authoritative',
        evidence: ['explicit-picker'],
      },
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'open it',
      sourceId: 'copilot:user:control-followup:request-open',
      context: { cwd: edited, workspacePaths: [edited], scope: 'session' },
    });
    const editPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'change another project',
      sourceId: 'copilot:user:control-followup:request-edit',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(edited, 'game.ts'),
      diff: '+ edit',
      turnKey: editPrompt.id,
    });
    setLedgerTurnProjectMetadata(session.id, editPrompt.id, {
      nativeRequestId: 'request-edit',
      controlTarget: {
        claimId: '123e4567-e89b-42d3-a456-426614174002',
        action: 'verify',
        trailId,
        root: selected,
        mode: 'authoritative',
        evidence: ['explicit-picker'],
      },
    });

    const document = ensureLedgerSegments(session);
    const routes = [...ledgerSegmentProjectContexts(session, document).values()];
    expect(routes[0]).toEqual(
      expect.objectContaining({ state: 'tracked', root: selected, evidence: 'control' }),
    );
    expect(routes[1]).toEqual(
      expect.objectContaining({
        state: 'tracked',
        root: selected,
        evidence: 'control',
        inheritedFrom: document.segments[0]!.id,
      }),
    );
    expect(routes[2]).toEqual(
      expect.objectContaining({ state: 'candidate', root: edited }),
    );
    expect(document.segments[2]?.controlTarget?.trailId).toBe(trailId);
    expect(sessionProjectContext(session)).toEqual(
      expect.objectContaining({
        state: 'ambiguous',
        candidates: expect.arrayContaining([edited, selected]),
      }),
    );
  });

  test('a stale session workspace cannot pull an editless report turn away from the preceding project', () => {
    const first = project();
    const second = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'stale-workspace',
      cwd: first,
      workspacePaths: [first],
    });
    const firstPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'work in A',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(first, 'a.ts'),
      diff: '+ a',
      turnKey: firstPrompt.id,
    });
    const secondPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'now work in B',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(second, 'b.ts'),
      diff: '+ b',
      turnKey: secondPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'generate my Showtail report',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });

    const document = ensureLedgerSegments(session);
    const contexts = [...ledgerSegmentProjectContexts(session, document).values()];
    expect(
      contexts.map((context) => (context.state === 'candidate' ? context.root : null)),
    ).toEqual([first, second, second]);
    expect(contexts[2]).toEqual(
      expect.objectContaining({ inheritedFrom: document.segments[1]?.id }),
    );
  });

  test('status-style derivation does not create a sidecar', () => {
    const session = ensureLedgerSession({
      tool: 'claude-code',
      nativeSessionId: 'read-only-status',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'unresolved',
    });
    const sidecar = join(home, 'ledger', 'sessions', session.id, 'segments.json');
    expect(existsSync(sidecar)).toBe(false);
    expect(
      listActionableLedgerRanges({ includeHidden: true, persist: false }),
    ).toHaveLength(1);
    expect(listActionableLedgerRanges({ persist: false })).toHaveLength(0);
    expect(
      listActionableLedgerRanges({ includeHidden: true, persist: false })[0]
        ?.hiddenReason,
    ).toBe('not-in-project');
    expect(existsSync(sidecar)).toBe(false);
  });

  test('does not borrow a project witness from another native chat', () => {
    const root = project();
    const standalone = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'standalone-projectless-chat',
    });
    for (const text of ['think about a game', 'add more ideas']) {
      appendLedgerRecord(standalone.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text,
      });
    }

    const projectChat = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'separate-project-chat',
    });
    const prompt = appendLedgerRecord(projectChat.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build this project',
    });
    appendLedgerRecord(projectChat.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(root, 'game.ts'),
      diff: '+ game',
      turnKey: prompt.id,
    });

    expect(
      listActionableLedgerRanges({ sessionId: standalone.id, pendingOnly: true }),
    ).toHaveLength(0);
    expect(
      listActionableLedgerRanges({
        includeHidden: true,
        sessionId: standalone.id,
        pendingOnly: true,
      })[0]?.hiddenReason,
    ).toBe('not-in-project');
  });

  test('derives a mixed-chat project witness without writing a sidecar', () => {
    const root = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'read-only-mixed-chat',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'plan Fairy Sparkle first',
    });
    const projectPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'now build it here',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(root, 'game.ts'),
      diff: '+ game',
      turnKey: projectPrompt.id,
    });
    const sidecar = join(home, 'ledger', 'sessions', session.id, 'segments.json');

    expect(existsSync(sidecar)).toBe(false);
    const pending = listActionableLedgerRanges({
      sessionId: session.id,
      pendingOnly: true,
      persist: false,
    });
    expect(
      pending.find((range) => range.firstPrompt === 'plan Fairy Sparkle first')
        ?.hiddenReason,
    ).toBeNull();
    expect(existsSync(sidecar)).toBe(false);
  });

  test('surfaces unresolved prefix and following ranges beside placed project work', async () => {
    const root = project();
    await runInit({ cwd: root });
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'project-related-unresolved-ranges',
    });
    for (const text of ['design Fairy Sparkle', 'choose the game rules']) {
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text,
      });
    }
    const projectPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build the game here',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(root, 'game.ts'),
      diff: '+ game',
      turnKey: projectPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'this final turn has no project evidence',
      context: { cwd: null, workspacePaths: [], scope: 'turn' },
    });

    const document = ensureLedgerSegments(session);
    const projectSegment = document.segments[2]!;
    markLedgerSegmentPlaced(
      session.id,
      projectSegment.id,
      readConfig(pathsForRoot(root)).trailId!,
      root,
    );

    const pending = listActionableLedgerRanges({
      sessionId: session.id,
      pendingOnly: true,
    });
    expect(pending).toHaveLength(2);
    expect(
      pending.find((range) => range.firstPrompt === 'design Fairy Sparkle')
        ?.memberSegmentIds,
    ).toHaveLength(2);
    expect(
      pending.find(
        (range) => range.firstPrompt === 'this final turn has no project evidence',
      )?.memberSegmentIds,
    ).toHaveLength(1);
    expect(pending.every((range) => range.route.state === 'none')).toBe(true);
    expect(pending.every((range) => range.hiddenReason === null)).toBe(true);

    addScratchPath(root);
    expect(
      listActionableLedgerRanges({ sessionId: session.id, pendingOnly: true }),
    ).toHaveLength(0);
    expect(
      listActionableLedgerRanges({
        includeHidden: true,
        sessionId: session.id,
        pendingOnly: true,
      }).every((range) => range.hiddenReason === 'not-in-project'),
    ).toBe(true);
  });

  test('refuses to overwrite a sidecar from a newer schema', () => {
    const session = ensureLedgerSession({
      tool: 'claude-code',
      nativeSessionId: 'newer-segment-schema',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'future data',
    });
    const sidecar = join(home, 'ledger', 'sessions', session.id, 'segments.json');
    writeFileSync(sidecar, JSON.stringify({ version: 99, recordCount: 1, segments: [] }));

    expect(() => ensureLedgerSegments(session)).toThrow('uses schema 99');
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).version).toBe(99);
  });

  test('collapses an unresolved prefix and applies range actions to every member', () => {
    const destination = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'unresolved-prefix',
    });
    for (const text of ['start a game', 'make it colorful', 'add a score']) {
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text,
      });
    }

    const [range] = listActionableLedgerRanges({ includeHidden: true });
    expect(range?.memberSegmentIds).toHaveLength(3);
    expect(resolveLedgerRangeSelector(range!.selector)?.memberSegmentIds).toEqual(
      range?.memberSegmentIds,
    );

    dismissLedgerRange(session.id, range!);
    expect(
      ensureLedgerSegments(session).segments.every((segment) => segment.dismissedAt),
    ).toBe(true);

    placeLedgerRange(session.id, range!, 'trl_destination', destination);
    expect(
      ensureLedgerSegments(session).segments.every(
        (segment) => segment.status === 'placed' && segment.targets?.length === 1,
      ),
    ).toBe(true);
  });

  test('keeps one edit-bearing multi-root turn as its own range', () => {
    const first = project();
    const second = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'multi-root-turn',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'change both projects',
    });
    for (const file of [join(first, 'a.ts'), join(second, 'b.ts')]) {
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'github-copilot',
        file,
        diff: '+ changed',
        turnKey: prompt.id,
      });
    }
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'what happened?',
    });

    const ranges = listActionableLedgerRanges({ includeHidden: true });
    expect(ranges).toHaveLength(2);
    const mixed = ranges.find((range) => range.edits === 2)!;
    expect(mixed.memberSegmentIds).toHaveLength(1);
    expect(mixed.route).toEqual(expect.objectContaining({ state: 'ambiguous' }));
  });
});

describe('segment projection and migration', () => {
  async function initializedProject(): Promise<string> {
    const root = project();
    await runInit({ cwd: root });
    return root;
  }

  test('links a separately recovered Copilot edit to its request prompt', async () => {
    const root = await initializedProject();
    const paths = pathsForRoot(root);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'request-linkage',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'edit the game',
      sourceId: 'copilot:user:request-linkage:req-1',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(root, 'game.ts'),
      diff: '+ game',
      sourceId: 'copilot:edit:request-linkage:req-1#game.ts',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(paths));

    const prompt = readAllEvents(paths).find((event) => event.type === 'prompt')!;
    expect(readAllArtifacts(paths)[0]?.turnId).toBe(prompt.id);
  });

  test('materializes one segment without validating or leaking a neighboring project', async () => {
    const first = await initializedProject();
    const second = await initializedProject();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'isolated-materialize',
    });
    const promptA = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'A only',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(first, 'a.ts'),
      diff: '+ a',
      turnKey: promptA.id,
    });
    const promptB = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'B only',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(second, 'b.ts'),
      diff: '+ b',
      turnKey: promptB.id,
    });
    const [segmentA, segmentB] = ensureLedgerSegments(session).segments;

    await expect(
      materializeLedgerSegment(session, segmentA!, authorFor(pathsForRoot(first))),
    ).resolves.toEqual(expect.objectContaining({ projected: 2 }));
    expect(readAllEvents(pathsForRoot(first)).map((event) => event.text)).toEqual([
      'A only',
    ]);
    expect(
      readJournal(authorFor(pathsForRoot(first))).every(
        (entry) => entry.batch === ledgerSegmentBatchId(session.id, segmentA!.id),
      ),
    ).toBe(true);
    expect(latestBatchId(authorFor(pathsForRoot(first)))).toBeUndefined();
    await expect(
      materializeLedgerSession(session, authorFor(pathsForRoot(first))),
    ).rejects.toThrow();
    expect(segmentB?.id).toBeTruthy();
  });

  test('reprojects one legacy-contaminated turn destination-first and preserves its neighbor', async () => {
    const first = await initializedProject();
    const second = await initializedProject();
    const firstPaths = pathsForRoot(first);
    const secondPaths = pathsForRoot(second);
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'legacy-cross-project',
    });
    const promptA = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build fairy',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(first, 'fairy.ts'),
      diff: '+ fairy',
      turnKey: promptA.id,
    });
    const promptB = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build word game',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(second, 'word.ts'),
      diff: '+ word',
      turnKey: promptB.id,
    });

    // Simulate a pre-segmentation projection of the complete chat into A.
    const segments = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segments[0]!, authorFor(firstPaths));
    await materializeLedgerSegment(session, segments[1]!, authorFor(firstPaths), {
      rebase: { fromRoot: second, toRoot: first },
    });
    markPlaced(session.id, readConfig(firstPaths).trailId!, first);
    expect(readAllEvents(firstPaths).map((event) => event.text)).toEqual([
      'build fairy',
      'build word game',
    ]);

    const segmentB = ensureLedgerSegments(session).segments[1]!;
    let crashed = false;
    await expect(
      reprojectLedgerSegment(
        session,
        segmentB,
        authorFor(secondPaths),
        readConfig(secondPaths).trailId!,
        second,
        {
          onPhase: (phase) => {
            if (!crashed && phase === 'destination-materialized') {
              crashed = true;
              throw new Error('simulated crash');
            }
          },
        },
      ),
    ).rejects.toThrow('simulated crash');

    // Destination-first interruption duplicates temporarily; it never loses B.
    expect(readAllEvents(firstPaths).map((event) => event.text)).toContain(
      'build word game',
    );
    expect(readAllEvents(secondPaths).map((event) => event.text)).toContain(
      'build word game',
    );

    const completed = await reprojectLedgerSegment(
      session,
      segmentB,
      authorFor(secondPaths),
      readConfig(secondPaths).trailId!,
      second,
    );
    expect(completed.phase).toBe('complete');
    expect(readAllEvents(firstPaths).map((event) => event.text)).toEqual(['build fairy']);
    expect(readAllEvents(secondPaths).map((event) => event.text)).toEqual([
      'build word game',
    ]);
    expect(
      readJournal(authorFor(firstPaths)).some(
        (entry) => entry.redaction?.reason === 'routing-reprojection',
      ),
    ).toBe(true);

    // Retry is source-id idempotent and leaves neighboring placement metadata.
    await reprojectLedgerSegment(
      session,
      segmentB,
      authorFor(secondPaths),
      readConfig(secondPaths).trailId!,
      second,
    );
    expect(readAllEvents(firstPaths).map((event) => event.text)).toEqual(['build fairy']);
  });

  test('a relocation rebase applies to A without changing B', () => {
    const oldA = project();
    const newA = project();
    const projectB = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'independent-rebases',
    });
    const promptA = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'A',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(oldA, 'a.ts'),
      diff: '+ a',
      turnKey: promptA.id,
    });
    const promptB = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'B',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(projectB, 'b.ts'),
      diff: '+ b',
      turnKey: promptB.id,
    });
    const [segmentA, segmentB] = ensureLedgerSegments(session).segments;
    const bFile = readLedgerRecords(session.id).find(
      (record) => record.turnKey === promptB.id && record.file,
    )!.file!;

    markLedgerSegmentPlaced(session.id, segmentA!.id, 'trl_a2', newA, {
      pathRebase: { fromRoot: oldA, toRoot: newA },
    });
    const refreshed = ensureLedgerSegments(session);
    const updatedA = refreshed.segments.find((segment) => segment.id === segmentA!.id)!;
    const updatedB = refreshed.segments.find((segment) => segment.id === segmentB!.id)!;
    expect(effectiveLedgerSegmentPath(updatedA, join(oldA, 'a.ts'))).toBe(
      join(newA, 'a.ts'),
    );
    expect(effectiveLedgerSegmentPath(updatedB, bFile)).toBe(bFile);
  });

  test('catch-up reports only the turn whose late edit changes projects', async () => {
    const first = await initializedProject();
    const second = await initializedProject();
    const firstPaths = pathsForRoot(first);
    const session = ensureLedgerSession({
      tool: 'claude-code',
      nativeSessionId: 'segmented-catch-up',
      cwd: first,
    });
    const promptA = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'work in A',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'claude-code',
      file: join(first, 'a.ts'),
      diff: '+ a',
      turnKey: promptA.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'work in B',
    });
    const initialSegments = ensureLedgerSegments(session).segments;
    for (const segment of initialSegments) {
      await materializeLedgerSegment(session, segment, authorFor(firstPaths));
    }
    markPlaced(session.id, readConfig(firstPaths).trailId!, first);

    const base = Date.now() + 1_000;
    const transcript = join(first, 'segmented-catch-up.jsonl');
    writeFileSync(
      transcript,
      [
        {
          type: 'user',
          uuid: 'late-user-a',
          timestamp: new Date(base).toISOString(),
          cwd: first,
          message: { role: 'user', content: 'work in A' },
        },
        {
          type: 'assistant',
          uuid: 'late-assistant-a',
          timestamp: new Date(base + 1).toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            content: [
              {
                type: 'tool_use',
                id: 'late-edit-a',
                name: 'Edit',
                input: { file_path: join(first, 'a.ts') },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'late-user-b',
          timestamp: new Date(base + 2).toISOString(),
          cwd: first,
          message: { role: 'user', content: 'work in B' },
        },
        {
          type: 'assistant',
          uuid: 'late-assistant-b',
          timestamp: new Date(base + 3).toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            content: [
              {
                type: 'tool_use',
                id: 'late-edit-b',
                name: 'Edit',
                input: { file_path: join(second, 'b.ts') },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    setLedgerTranscriptPath(session.id, transcript);

    const result = await catchUpFromTranscripts(authorFor(firstPaths));
    const segmentB = ensureLedgerSegments(session).segments[1]!;
    expect(result.reroutedSessions).toEqual([]);
    expect(result.reroutedRanges).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        segmentId: segmentB.id,
        root: second,
      }),
    ]);
    // Destination-first handoff keeps the old copy until the caller creates B's
    // trail and invokes reprojectLedgerSegment.
    expect(readAllEvents(firstPaths).map((event) => event.text)).toEqual([
      'work in A',
      'work in B',
    ]);
  });
});
