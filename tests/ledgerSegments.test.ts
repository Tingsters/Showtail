import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureInitialized, runInit } from '../src/commands/init.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { catchUpFromTranscripts } from '../src/core/catchUp.ts';
import { parseCopilotSession } from '../src/core/copilotChatTranscript.ts';
import { latestBatchId, readAllEvents } from '../src/core/events.ts';
import { addScratchPath, noteKnownProject } from '../src/core/globalConfig.ts';
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
  markLedgerSegmentInbox,
  markLedgerSegmentPlaced,
  markPlaced,
  placeLedgerRange,
  readLedgerRecords,
  resolveLedgerRangeSelector,
  sessionProjectContext,
  setLedgerSegmentMigration,
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
import {
  ProjectionIdentityConflictError,
  ProjectionTargetIdentityMismatchError,
  removeLedgerSegmentProjection,
  reprojectLedgerSegment,
} from '../src/core/projectionRouting.ts';
import { pathsForRoot, readConfig } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir, seedAuthor } from './helpers.ts';

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

  test('raw Showtail report output cannot override edit-backed project ownership', async () => {
    const word = project();
    const wrong = project();
    await runInit({ cwd: word, project: 'Word Sparkle' });
    await runInit({ cwd: wrong, project: 'Showtail' });
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'wrong-showtail-output',
      cwd: wrong,
      workspacePaths: [wrong],
    });
    const wordPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Word Sparkle',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(word, 'word.ts'),
      diff: '+ word',
      turnKey: wordPrompt.id,
    });
    const reportPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'generate the report',
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: reportPrompt.id,
      conversationEvent: {
        sequence: 1,
        type: 'tool_use',
        toolUseId: 'report-wrong-project',
        toolName: 'run_in_terminal',
        input: { command: `showtail report "${wrong}"` },
      },
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: reportPrompt.id,
      conversationEvent: {
        sequence: 2,
        type: 'tool_result',
        toolUseId: 'report-wrong-project',
        exitCode: 0,
        content: `Showtail project: ${wrong} (trail evidence).\nWrote report: ${join(wrong, '.showtail', 'reports', 'report.html')}`,
      },
    });

    const document = ensureLedgerSegments(session);
    const routes = [...ledgerSegmentProjectContexts(session, document).values()];
    expect(routes[0]).toEqual(
      expect.objectContaining({ state: 'tracked', root: word, evidence: 'trail' }),
    );
    expect(routes[1]).toEqual(
      expect.objectContaining({
        state: 'tracked',
        root: word,
        evidence: 'trail',
        inheritedFrom: document.segments[0]!.id,
      }),
    );
  });

  test('routes a zero-edit turn only from a successful durable filesystem mutation', () => {
    const source = project();
    const destination = project();
    const movedFile = join(destination, 'moved.ts');
    writeFileSync(movedFile, 'moved\n', 'utf8');
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'successful-move-routing',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'move the file',
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: prompt.id,
      conversationEvent: {
        sequence: 1,
        type: 'tool_use',
        toolUseId: 'move-file',
        toolName: 'move_file',
        input: {
          source: join(source, 'old.ts'),
          destination: movedFile,
        },
      },
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: prompt.id,
      conversationEvent: {
        sequence: 2,
        type: 'tool_result',
        toolUseId: 'move-file',
        content: { success: true, destination: movedFile },
      },
    });

    const [route] = ledgerSegmentProjectContexts(session).values();
    expect(route).toEqual(
      expect.objectContaining({
        state: 'candidate',
        root: destination,
        evidence: 'tool',
      }),
    );
  });

  test('a failed terminal call cannot route from a model-invented path', async () => {
    const wrong = project();
    await runInit({ cwd: wrong });
    const missing = join(wrong, 'invented.ts');
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'failed-terminal-path',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'inspect the missing game',
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: prompt.id,
      conversationEvent: {
        sequence: 1,
        type: 'tool_use',
        toolUseId: 'failed-read',
        toolName: 'run_in_terminal',
        input: { command: `Get-Content -LiteralPath '${missing}'` },
      },
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: prompt.id,
      conversationEvent: {
        sequence: 2,
        type: 'tool_result',
        toolUseId: 'failed-read',
        isError: true,
        exitCode: 1,
        content: `Cannot find path '${missing}' because it does not exist.`,
      },
    });

    const [route] = ledgerSegmentProjectContexts(session).values();
    expect(route).toEqual({ state: 'none', root: null, evidence: null, candidates: [] });
  });

  test('a successful read is observation, not project ownership', async () => {
    const observed = project();
    await runInit({ cwd: observed });
    const file = join(observed, 'game.ts');
    writeFileSync(file, 'export const game = true;\n', 'utf8');
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'read-only-tool-path',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'inspect that other game',
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: prompt.id,
      conversationEvent: {
        sequence: 1,
        type: 'tool_use',
        toolUseId: 'read-file',
        toolName: 'read_file',
        input: { filePath: file },
      },
    });
    appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: prompt.id,
      conversationEvent: {
        sequence: 2,
        type: 'tool_result',
        toolUseId: 'read-file',
        content: 'export const game = true;',
      },
    });

    const [route] = ledgerSegmentProjectContexts(session).values();
    expect(route).toEqual({ state: 'none', root: null, evidence: null, candidates: [] });
  });

  test('session project context ignores a superseded wrong-root edit', () => {
    const wrong = project();
    const correct = project();
    const session = ensureLedgerSession({
      tool: 'claude-code',
      nativeSessionId: 'session-correction-routing',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'build the correct game',
    });
    const misplaced = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'claude-code',
      file: join(wrong, 'game.ts'),
      diff: '+ wrong',
      sourceId: 'claude-edit:session-correction-routing:game.ts',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'claude-code',
      file: join(correct, 'game.ts'),
      diff: '+ correct',
      sourceId: misplaced.sourceId,
      supersedesRecordId: misplaced.id,
    });

    expect(readLedgerRecords(session.id).map((record) => record.id)).toContain(
      misplaced.id,
    );
    expect(sessionProjectContext(session)).toEqual(
      expect.objectContaining({ state: 'candidate', root: correct, evidence: 'git' }),
    );
  });

  test('routing ignores an edit superseded away from the wrong turn', () => {
    const word = project();
    const fairy = project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'correction-routing',
    });
    const wordPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Word Sparkle',
      sourceId: 'copilot:user:correction-routing:request-word',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(word, 'word.ts'),
      diff: '+ word',
      turnKey: wordPrompt.id,
      sourceId: 'copilot:edit:correction-routing:request-word#word.ts',
    });
    const fairyPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'now build Fairy Sparkle',
      sourceId: 'copilot:user:correction-routing:request-fairy',
    });
    const misplaced = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(fairy, 'fairy.ts'),
      diff: '+ fairy',
      turnKey: wordPrompt.id,
      sourceId: 'copilot:edit:correction-routing:request-fairy#fairy.ts',
    });
    const corrected = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(fairy, 'fairy.ts'),
      diff: '+ fairy',
      turnKey: fairyPrompt.id,
      sourceId: misplaced.sourceId,
      supersedesRecordId: misplaced.id,
    });

    const document = ensureLedgerSegments(session);
    expect(document.segments[0]?.recordIds).toContain(misplaced.id);
    expect(document.segments[1]?.recordIds).toContain(corrected.id);

    const routes = [...ledgerSegmentProjectContexts(session, document).values()];
    expect(routes[0]).toEqual(
      expect.objectContaining({ state: 'candidate', root: word, evidence: 'git' }),
    );
    expect(routes[1]).toEqual(
      expect.objectContaining({ state: 'candidate', root: fairy, evidence: 'git' }),
    );

    const ranges = listActionableLedgerRanges({
      includeHidden: true,
      sessionId: session.id,
    });
    expect(
      ranges.find((range) => range.memberSegmentIds.includes(document.segments[0]!.id))
        ?.edits,
    ).toBe(1);
    expect(
      ranges.find((range) => range.memberSegmentIds.includes(document.segments[1]!.id))
        ?.edits,
    ).toBe(1);
  });

  test('routing ignores mutation evidence superseded away from the wrong turn', () => {
    const word = project();
    const fairy = project();
    const fairyFile = join(fairy, 'fairy.ts');
    writeFileSync(fairyFile, 'export const fairy = true;\n', 'utf8');
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'tool-correction-routing',
    });
    const wordPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Word Sparkle',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(word, 'word.ts'),
      diff: '+ word',
      turnKey: wordPrompt.id,
    });
    const inheritedPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'explain that change',
    });
    const misplacedUse = appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: inheritedPrompt.id,
      sourceId: 'conversation:tool-correction:use',
      conversationEvent: {
        sequence: 1,
        type: 'tool_use',
        toolUseId: 'move-fairy-file',
        toolName: 'move_file',
        input: { destination: fairyFile },
      },
    });
    const misplacedResult = appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: inheritedPrompt.id,
      sourceId: 'conversation:tool-correction:result',
      conversationEvent: {
        sequence: 2,
        type: 'tool_result',
        toolUseId: 'move-fairy-file',
        content: { success: true, destination: fairyFile },
      },
    });
    const fairyPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'now work on Fairy Sparkle',
    });
    const correctedUse = appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: fairyPrompt.id,
      sourceId: misplacedUse.sourceId,
      supersedesRecordId: misplacedUse.id,
      conversationEvent: misplacedUse.conversationEvent,
    });
    const correctedResult = appendLedgerRecord(session.id, {
      kind: 'conversation_event',
      tool: 'github-copilot',
      turnKey: fairyPrompt.id,
      sourceId: misplacedResult.sourceId,
      supersedesRecordId: misplacedResult.id,
      conversationEvent: misplacedResult.conversationEvent,
    });

    const document = ensureLedgerSegments(session);
    expect(document.segments[1]?.recordIds).toEqual(
      expect.arrayContaining([misplacedUse.id, misplacedResult.id]),
    );
    expect(document.segments[2]?.recordIds).toEqual(
      expect.arrayContaining([correctedUse.id, correctedResult.id]),
    );

    const routes = [...ledgerSegmentProjectContexts(session, document).values()];
    expect(routes[1]).toEqual(
      expect.objectContaining({
        state: 'candidate',
        root: word,
        inheritedFrom: document.segments[0]!.id,
      }),
    );
    expect(routes[2]).toEqual(
      expect.objectContaining({ state: 'candidate', root: fairy, evidence: 'tool' }),
    );
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

  test('blocks same-path different-id reprojection before touching the destination', async () => {
    const root = await initializedProject();
    const paths = pathsForRoot(root);
    const canonicalTrailId = readConfig(paths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'same-path-identity-conflict',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'keep this Word Sparkle turn',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(root, 'word.ts'),
      diff: '+ word',
      turnKey: prompt.id,
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(paths));
    markLedgerSegmentPlaced(session.id, segment!.id, 'trl_transient_duplicate', root);
    const journalBefore = readJournal(authorFor(paths));

    await expect(
      reprojectLedgerSegment(session, segment!, authorFor(paths), canonicalTrailId, root),
    ).rejects.toBeInstanceOf(ProjectionIdentityConflictError);

    expect(readJournal(authorFor(paths))).toEqual(journalBefore);
    expect(ensureLedgerSegments(session).segments[0]?.targets).toEqual([
      { trailId: 'trl_transient_duplicate', path: root },
    ]);
    expect(
      readJournal(authorFor(paths)).some(
        (entry) => entry.redaction?.reason === 'routing-reprojection',
      ),
    ).toBe(false);
  });

  test('segment cleanup preserves a neighboring turn added after target discovery', async () => {
    const root = makeTempDir();
    roots.push(root);
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'concurrent-neighbor-before-cleanup',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'remove only the first turn',
    });
    await ensureInitialized(root, {
      anchorKind: 'cwd',
      initialization: {
        mode: 'automatic',
        evidence: 'cwd',
        ledgerSessionId: session.id,
      },
    });
    const paths = pathsForRoot(root);
    const author = seedAuthor(paths, 'reviewer@example.com');
    const trailId = readConfig(paths).trailId!;
    const [first] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, first!, author);
    markLedgerSegmentPlaced(session.id, first!.id, trailId, root);
    let insertedNeighbor = false;

    const removed = await removeLedgerSegmentProjection(session, first!.id, undefined, {
      onBeforeProjectionCleanup: async (segmentId, target) => {
        expect(segmentId).toBe(first!.id);
        expect(target).toEqual({ trailId, path: root });
        if (insertedNeighbor) return;
        insertedNeighbor = true;
        appendLedgerRecord(session.id, {
          kind: 'prompt',
          tool: 'codex',
          text: 'preserve the concurrent second turn',
        });
        const second = ensureLedgerSegments(session).segments.find(
          (candidate) => candidate.id !== first!.id,
        )!;
        await materializeLedgerSegment(session, second, author);
        markLedgerSegmentPlaced(session.id, second.id, trailId, root);
      },
    });

    expect(removed).toEqual([root]);
    expect(existsSync(paths.config)).toBe(true);
    expect(readAllEvents(paths).map((event) => event.text)).toEqual([
      'preserve the concurrent second turn',
    ]);
    const [firstAfter, secondAfter] = ensureLedgerSegments(session).segments;
    expect(firstAfter).toEqual(expect.objectContaining({ status: 'inbox', targets: [] }));
    expect(secondAfter).toEqual(
      expect.objectContaining({
        status: 'placed',
        targets: [{ trailId, path: root }],
      }),
    );
  });

  test('segment cleanup follows a source trail moved during its consent check', async () => {
    const oldRoot = await initializedProject();
    const newRoot = project();
    cleanup(newRoot);
    const oldPaths = pathsForRoot(oldRoot);
    const trailId = readConfig(oldPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'source-moved-during-cleanup',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'remove this from the moved source',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(oldPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, trailId, oldRoot);
    let armed = false;
    let moved = false;

    const removed = await removeLedgerSegmentProjection(session, segment!.id, undefined, {
      onBeforeProjectionCleanup: () => {
        armed = true;
      },
      continueCapture: () => {
        if (armed && !moved) {
          renameSync(oldRoot, newRoot);
          noteKnownProject(newRoot, trailId);
          moved = true;
        }
        return true;
      },
    });

    expect(moved).toBe(true);
    expect(removed).toEqual([newRoot]);
    expect(readAllEvents(pathsForRoot(newRoot))).toEqual([]);
    expect(ensureLedgerSegments(session).segments[0]).toEqual(
      expect.objectContaining({ status: 'inbox', targets: [] }),
    );
  });

  test('segment cleanup retries a same-turn record captured at the commit boundary', async () => {
    const root = makeTempDir();
    roots.push(root);
    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'late-public-cleanup-member',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'remove the original record',
    });
    await ensureInitialized(root, {
      anchorKind: 'cwd',
      initialization: {
        mode: 'automatic',
        evidence: 'cwd',
        ledgerSessionId: session.id,
      },
    });
    const paths = pathsForRoot(root);
    const author = seedAuthor(paths, 'reviewer@example.com');
    const trailId = readConfig(paths).trailId!;
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, author);
    markLedgerSegmentPlaced(session.id, segment!.id, trailId, root);
    let armed = false;
    let injected = false;
    let continuationCount = 0;

    const removed = await removeLedgerSegmentProjection(session, segment!.id, undefined, {
      onBeforeProjectionCleanup: () => {
        armed = true;
      },
      continueCapture: () => {
        if (armed && !injected) {
          continuationCount += 1;
          if (continuationCount === 2) {
            const child = `
                const ledger = await import('./src/core/ledger.ts');
                const materialize = await import('./src/core/materialize.ts');
                const storage = await import('./src/core/storage.ts');
                const late = ledger.appendLedgerRecord(${JSON.stringify(session.id)}, {
                  kind: 'ai_output',
                  tool: 'codex',
                  text: 'late record at cleanup commit',
                  turnKey: ${JSON.stringify(prompt.id)},
                });
                const childSession = ledger.readLedgerSession(${JSON.stringify(session.id)});
                const childSegment = ledger.ensureLedgerSegments(childSession).segments.find(
                  (candidate) => candidate.recordIds.includes(late.id),
                );
                const childAuthor = storage.authorPaths(
                  storage.pathsForRoot(${JSON.stringify(root)}),
                  ${JSON.stringify(author.slug)},
                  ${JSON.stringify(author.machineId)},
                );
                await materialize.materializeLedgerSegment(
                  childSession,
                  childSegment,
                  childAuthor,
                );
              `;
            const result = spawnSync(process.execPath, ['--eval', child], {
              cwd: process.cwd(),
              encoding: 'utf8',
              env: { ...process.env, SHOWTAIL_HOME: home },
            });
            if (result.status !== 0) {
              throw new Error(result.stderr || result.stdout || 'late capture failed');
            }
            injected = true;
          }
        }
        return true;
      },
    });

    expect(injected).toBe(true);
    expect(removed).toEqual([root]);
    expect(readLedgerRecords(session.id).map((record) => record.text)).toEqual([
      'remove the original record',
      'late record at cleanup commit',
    ]);
    expect(readAllEvents(paths)).toEqual([]);
    expect(ensureLedgerSegments(session).segments[0]).toEqual(
      expect.objectContaining({ status: 'inbox', targets: [] }),
    );
  });

  test('preserves an unresolved placement when its path now has another trail id', async () => {
    const root = await initializedProject();
    const paths = pathsForRoot(root);
    const originalTrailId = readConfig(paths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'cleanup-config-identity-drift',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'keep this unresolved projection visible',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(paths));
    markLedgerSegmentPlaced(session.id, segment!.id, originalTrailId, root);
    const replacementConfig = {
      ...JSON.parse(readFileSync(paths.config, 'utf8')),
      trailId: 'trl_replacement_identity',
    };
    writeFileSync(
      paths.config,
      `${JSON.stringify(replacementConfig, null, 2)}\n`,
      'utf8',
    );

    await expect(
      removeLedgerSegmentProjection(session, segment!.id),
    ).rejects.toBeInstanceOf(ProjectionTargetIdentityMismatchError);

    expect(readAllEvents(paths).map((event) => event.text)).toEqual([
      'keep this unresolved projection visible',
    ]);
    expect(ensureLedgerSegments(session).segments[0]).toEqual(
      expect.objectContaining({
        status: 'placed',
        targets: [{ trailId: originalTrailId, path: root }],
      }),
    );
  });

  test('revalidates target identity after asynchronous cleanup preparation', async () => {
    const root = await initializedProject();
    const paths = pathsForRoot(root);
    const originalTrailId = readConfig(paths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'cleanup-config-identity-race',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'do not delete replacement trail data',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(paths));
    markLedgerSegmentPlaced(session.id, segment!.id, originalTrailId, root);
    const replacementTrailId = 'trl_replacement_during_cleanup';

    await expect(
      removeLedgerSegmentProjection(session, segment!.id, undefined, {
        onBeforeProjectionCleanup: () => {
          const config = JSON.parse(readFileSync(paths.config, 'utf8')) as Record<
            string,
            unknown
          >;
          config.trailId = replacementTrailId;
          writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        },
      }),
    ).rejects.toBeInstanceOf(ProjectionTargetIdentityMismatchError);

    expect(readConfig(paths).trailId).toBe(replacementTrailId);
    expect(readAllEvents(paths).map((event) => event.text)).toEqual([
      'do not delete replacement trail data',
    ]);
    expect(ensureLedgerSegments(session).segments[0]).toEqual(
      expect.objectContaining({
        status: 'placed',
        targets: [{ trailId: originalTrailId, path: root }],
      }),
    );
  });

  test('explicitly repairs a stale same-path source without redacting canonical data', async () => {
    const root = await initializedProject();
    const paths = pathsForRoot(root);
    const canonicalTrailId = readConfig(paths).trailId!;
    const duplicateTrailId = 'trl_stale_duplicate';
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'stale-same-path-repair',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'restore the Word Sparkle creation turn',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: join(root, 'word.ts'),
      diff: '+ word',
      turnKey: prompt.id,
    });
    const [segment] = ensureLedgerSegments(session).segments;
    markLedgerSegmentPlaced(session.id, segment!.id, duplicateTrailId, root);
    const now = new Date().toISOString();
    setLedgerSegmentMigration(session.id, segment!.id, {
      phase: 'destination-materialized',
      destination: { trailId: canonicalTrailId, path: root },
      sourceTargets: [{ trailId: duplicateTrailId, path: root }],
      startedAt: now,
      updatedAt: now,
    });

    const repaired = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(paths),
      canonicalTrailId,
      root,
      { allowStaleSamePathSource: true },
    );

    expect(repaired.phase).toBe('complete');
    expect(readAllEvents(paths).map((event) => event.text)).toEqual([
      'restore the Word Sparkle creation turn',
    ]);
    expect(ensureLedgerSegments(session).segments[0]?.targets).toEqual([
      { trailId: canonicalTrailId, path: root },
    ]);
    expect(
      readJournal(authorFor(paths)).some(
        (entry) => entry.redaction?.reason === 'routing-reprojection',
      ),
    ).toBe(false);

    const journalAfterRepair = readJournal(authorFor(paths));
    const retry = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(paths),
      canonicalTrailId,
      root,
    );
    expect(retry).toEqual(expect.objectContaining({ phase: 'complete', movedFrom: [] }));
    expect(readJournal(authorFor(paths))).toEqual(journalAfterRepair);
  });

  test('repairs placement drift after a completed migration', async () => {
    const fairy = await initializedProject();
    const word = await initializedProject();
    const fairyPaths = pathsForRoot(fairy);
    const wordPaths = pathsForRoot(word);
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const wordTrailId = readConfig(wordPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'completed-migration-placement-drift',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Fairy Sparkle',
    });
    const [segment] = ensureLedgerSegments(session).segments;

    const initial = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );
    expect(initial.phase).toBe('complete');
    expect(initial.movedFrom).toEqual([]);

    // Simulate an older router projecting the turn and resetting its sole
    // placement to Word after the migration to Fairy had already completed.
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentInbox(session.id, segment!.id, { clearTargets: true });
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
    expect(ensureLedgerSegments(session).segments[0]?.targets).toEqual([
      { trailId: wordTrailId, path: word },
    ]);

    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(fairyPaths),
        fairyTrailId,
        fairy,
        {
          onPhase: (phase) => {
            if (phase === 'planned') throw new Error('interrupt drift repair');
          },
        },
      ),
    ).rejects.toThrow('interrupt drift repair');
    expect(ensureLedgerSegments(session).segments[0]?.migration).toEqual(
      expect.objectContaining({
        phase: 'planned',
        destination: { trailId: fairyTrailId, path: fairy },
        sourceTargets: [{ trailId: wordTrailId, path: word }],
      }),
    );
    expect(
      ensureLedgerSegments(session).segments[0]?.migration?.completedAt,
    ).toBeUndefined();

    const repaired = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );

    expect(repaired.phase).toBe('complete');
    expect(repaired.movedFrom).toEqual([word]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'build Fairy Sparkle',
    ]);
    expect(readAllEvents(wordPaths)).toEqual([]);
    const completed = ensureLedgerSegments(session).segments[0]!;
    expect(completed.targets).toEqual([{ trailId: fairyTrailId, path: fairy }]);
    expect(completed.migration).toEqual(
      expect.objectContaining({
        phase: 'complete',
        destination: { trailId: fairyTrailId, path: fairy },
        sourceTargets: [{ trailId: wordTrailId, path: word }],
      }),
    );

    const journalAfterRepair = readJournal(authorFor(fairyPaths));
    const retry = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );
    expect(retry).toEqual(expect.objectContaining({ phase: 'complete', movedFrom: [] }));
    expect(readJournal(authorFor(fairyPaths))).toEqual(journalAfterRepair);
  });

  test('removes an untracked source copy recorded by a completed migration', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'completed-migration-untracked-source',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'move this turn from Word to Fairy',
    });
    const [segment] = ensureLedgerSegments(session).segments;

    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
    await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );

    // A stale writer can crash after replaying to Word but before restoring its
    // placement metadata. The durable migration sources must still find the copy.
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    expect(readAllEvents(wordPaths).map((event) => event.text)).toEqual([
      'move this turn from Word to Fairy',
    ]);
    expect(ensureLedgerSegments(session).segments[0]?.targets).toEqual([
      { trailId: fairyTrailId, path: fairy },
    ]);

    const repaired = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );

    expect(repaired.movedFrom).toEqual([word]);
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'move this turn from Word to Fairy',
    ]);
  });

  test('carries an abandoned materialized destination into the next migration', async () => {
    const first = await initializedProject();
    const abandoned = await initializedProject();
    const destination = await initializedProject();
    const firstPaths = pathsForRoot(first);
    const abandonedPaths = pathsForRoot(abandoned);
    const destinationPaths = pathsForRoot(destination);
    const firstTrailId = readConfig(firstPaths).trailId!;
    const abandonedTrailId = readConfig(abandonedPaths).trailId!;
    const destinationTrailId = readConfig(destinationPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'abandoned-materialized-destination',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'keep one copy after changing destinations',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(firstPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, firstTrailId, first);

    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(abandonedPaths),
        abandonedTrailId,
        abandoned,
        {
          onPhase: (phase) => {
            if (phase === 'destination-materialized') {
              throw new Error('choose a different destination');
            }
          },
        },
      ),
    ).rejects.toThrow('choose a different destination');
    expect(readAllEvents(abandonedPaths).map((event) => event.text)).toEqual([
      'keep one copy after changing destinations',
    ]);
    expect(ensureLedgerSegments(session).segments[0]?.targets).toEqual([
      { trailId: firstTrailId, path: first },
    ]);

    const moved = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(destinationPaths),
      destinationTrailId,
      destination,
    );

    expect(new Set(moved.movedFrom)).toEqual(new Set([first, abandoned]));
    expect(readAllEvents(firstPaths)).toEqual([]);
    expect(readAllEvents(abandonedPaths)).toEqual([]);
    expect(readAllEvents(destinationPaths).map((event) => event.text)).toEqual([
      'keep one copy after changing destinations',
    ]);
    const completed = ensureLedgerSegments(session).segments[0]!;
    expect(completed.migration?.sourceTargets).toHaveLength(2);
    expect(
      new Set(completed.migration?.sourceTargets.map((target) => target.trailId)),
    ).toEqual(new Set([firstTrailId, abandonedTrailId]));
  });

  test('records a source target added after destination materialization', async () => {
    const fairy = await initializedProject();
    const word = await initializedProject();
    const fairyPaths = pathsForRoot(fairy);
    const wordPaths = pathsForRoot(word);
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const wordTrailId = readConfig(wordPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'post-materialization-source',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'capture a late competing placement',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    const now = new Date().toISOString();
    setLedgerSegmentMigration(session.id, segment!.id, {
      phase: 'planned',
      destination: { trailId: fairyTrailId, path: fairy },
      sourceTargets: [],
      startedAt: now,
      updatedAt: now,
    });

    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
      {
        onPhase: async (phase) => {
          if (phase !== 'destination-materialized') return;
          await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
          markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
        },
      },
    );

    expect(completed.phase).toBe('complete');
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(ensureLedgerSegments(session).segments[0]?.migration?.sourceTargets).toEqual([
      { trailId: wordTrailId, path: word },
    ]);
  });

  test('rematerializes effective records appended at the destination phase boundary', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'late-record-during-reprojection',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'start the Fairy turn',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);

    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
      {
        onPhase: (phase) => {
          if (phase !== 'destination-materialized') return;
          appendLedgerRecord(session.id, {
            kind: 'ai_output',
            tool: 'github-copilot',
            text: 'finish the Fairy turn',
            turnKey: prompt.id,
          });
        },
      },
    );

    expect(completed.phase).toBe('complete');
    expect(completed.materialized.replies).toBe(1);
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'start the Fairy turn',
      'finish the Fairy turn',
    ]);
  });

  test('preserves a post-proof source record when capture stops before destination catch-up', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'post-proof-cleanup-interruption',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'first proven record',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
    let continueCapture = true;
    let injected = false;

    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(fairyPaths),
        fairyTrailId,
        fairy,
        {
          continueCapture: () => continueCapture,
          onSourceCleanup: async (stage, attempt) => {
            if (stage === 'before' && attempt === 0 && !injected) {
              injected = true;
              appendLedgerRecord(session.id, {
                kind: 'ai_output',
                tool: 'github-copilot',
                text: 'late unproven record',
                turnKey: prompt.id,
              });
              await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
            }
            if (stage === 'after' && attempt === 0) {
              expect(readAllEvents(wordPaths).map((event) => event.text)).toEqual([
                'late unproven record',
              ]);
              expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
                'first proven record',
              ]);
              continueCapture = false;
            }
          },
        },
      ),
    ).rejects.toThrow();

    expect(readAllEvents(wordPaths).map((event) => event.text)).toEqual([
      'late unproven record',
    ]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'first proven record',
    ]);
    expect(ensureLedgerSegments(session).segments[0]?.migration?.phase).toBe(
      'destination-materialized',
    );

    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );
    expect(completed.phase).toBe('complete');
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'first proven record',
      'late unproven record',
    ]);
  });

  test('repeats destination-first cleanup when source membership advances', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'post-proof-cleanup-retry',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'first stable record',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
    const cleanupStages: string[] = [];

    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
      {
        onSourceCleanup: async (stage, attempt) => {
          cleanupStages.push(`${stage}:${attempt}`);
          if (stage === 'before' && attempt === 0) {
            appendLedgerRecord(session.id, {
              kind: 'ai_output',
              tool: 'github-copilot',
              text: 'record captured after the proof',
              turnKey: prompt.id,
            });
            await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
          }
          if (stage === 'after' && attempt === 0) {
            expect(readAllEvents(wordPaths).map((event) => event.text)).toEqual([
              'record captured after the proof',
            ]);
            expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
              'first stable record',
            ]);
          }
        },
      },
    );

    expect(completed.phase).toBe('complete');
    expect(cleanupStages).toEqual(['before:0', 'after:0', 'before:1', 'after:1']);
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'first stable record',
      'record captured after the proof',
    ]);
  });

  test('removes obsolete source records handled by the destination proof', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'proof-includes-obsolete-source-ids',
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'keep the corrected answer',
    });
    const obsolete = appendLedgerRecord(session.id, {
      kind: 'ai_output',
      tool: 'github-copilot',
      text: 'obsolete answer',
      turnKey: prompt.id,
      sourceId: 'copilot:asst:proof-includes-obsolete-source-ids:request-1',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
    appendLedgerRecord(session.id, {
      kind: 'ai_output',
      tool: 'github-copilot',
      text: 'corrected answer',
      turnKey: prompt.id,
      sourceId: obsolete.sourceId,
      supersedesRecordId: obsolete.id,
    });

    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );

    expect(completed.phase).toBe('complete');
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'keep the corrected answer',
      'corrected answer',
    ]);
  });

  test('reopens a completed migration when its callback restores a source copy', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'complete-callback-source-drift',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'do not report stale completion',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
    let restoredSource = false;

    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(fairyPaths),
        fairyTrailId,
        fairy,
        {
          onPhase: async (phase) => {
            if (phase !== 'complete' || restoredSource) return;
            restoredSource = true;
            await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
            markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
          },
        },
      ),
    ).rejects.toThrow('changed after completing');

    const reopened = ensureLedgerSegments(session).segments[0]!;
    expect(reopened.migration).toEqual(
      expect.objectContaining({ phase: 'destination-materialized' }),
    );
    expect(reopened.migration?.completedAt).toBeUndefined();
    expect(new Set(reopened.targets?.map((target) => target.trailId))).toEqual(
      new Set([wordTrailId, fairyTrailId]),
    );
    expect(readAllEvents(wordPaths).map((event) => event.text)).toEqual([
      'do not report stale completion',
    ]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'do not report stale completion',
    ]);

    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );
    expect(completed.phase).toBe('complete');
    expect(readAllEvents(wordPaths)).toEqual([]);
  });

  test('revalidates completion when resuming after obsolete cleanup', async () => {
    const word = await initializedProject();
    const fairy = await initializedProject();
    const wordPaths = pathsForRoot(word);
    const fairyPaths = pathsForRoot(fairy);
    const wordTrailId = readConfig(wordPaths).trailId!;
    const fairyTrailId = readConfig(fairyPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'resumed-complete-callback-source-drift',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'revalidate resumed completion',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
    markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);

    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(fairyPaths),
        fairyTrailId,
        fairy,
        {
          onPhase: (phase) => {
            if (phase === 'obsolete-projections-removed') {
              throw new Error('pause after obsolete cleanup');
            }
          },
        },
      ),
    ).rejects.toThrow('pause after obsolete cleanup');
    expect(ensureLedgerSegments(session).segments[0]?.migration?.phase).toBe(
      'obsolete-projections-removed',
    );

    let restoredSource = false;
    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(fairyPaths),
        fairyTrailId,
        fairy,
        {
          onPhase: async (phase) => {
            if (phase !== 'complete' || restoredSource) return;
            restoredSource = true;
            await materializeLedgerSegment(session, segment!, authorFor(wordPaths));
            markLedgerSegmentPlaced(session.id, segment!.id, wordTrailId, word);
          },
        },
      ),
    ).rejects.toThrow('changed after completing');

    expect(ensureLedgerSegments(session).segments[0]?.migration).toEqual(
      expect.objectContaining({ phase: 'destination-materialized' }),
    );
    const completed = await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(fairyPaths),
      fairyTrailId,
      fairy,
    );
    expect(completed.phase).toBe('complete');
    expect(readAllEvents(wordPaths)).toEqual([]);
    expect(readAllEvents(fairyPaths).map((event) => event.text)).toEqual([
      'revalidate resumed completion',
    ]);
  });

  test('a competing destination cannot be overwritten after obsolete cleanup', async () => {
    const source = await initializedProject();
    const firstDestination = await initializedProject();
    const winningDestination = await initializedProject();
    const sourcePaths = pathsForRoot(source);
    const firstPaths = pathsForRoot(firstDestination);
    const winningPaths = pathsForRoot(winningDestination);
    const sourceTrailId = readConfig(sourcePaths).trailId!;
    const firstTrailId = readConfig(firstPaths).trailId!;
    const winningTrailId = readConfig(winningPaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'competing-obsolete-phase-destinations',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'keep the destination chosen by the newer migration',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(sourcePaths));
    markLedgerSegmentPlaced(session.id, segment!.id, sourceTrailId, source);
    let winningResult: Awaited<ReturnType<typeof reprojectLedgerSegment>> | undefined;

    await expect(
      reprojectLedgerSegment(
        session,
        segment!,
        authorFor(firstPaths),
        firstTrailId,
        firstDestination,
        {
          onPhase: async (phase) => {
            if (phase !== 'obsolete-projections-removed') return;
            winningResult = await reprojectLedgerSegment(
              session,
              segment!,
              authorFor(winningPaths),
              winningTrailId,
              winningDestination,
            );
          },
        },
      ),
    ).rejects.toThrow('migration changed');

    expect(winningResult?.phase).toBe('complete');
    expect(readAllEvents(sourcePaths)).toEqual([]);
    expect(readAllEvents(firstPaths)).toEqual([]);
    expect(readAllEvents(winningPaths).map((event) => event.text)).toEqual([
      'keep the destination chosen by the newer migration',
    ]);
    expect(ensureLedgerSegments(session).segments[0]).toEqual(
      expect.objectContaining({
        targets: [{ trailId: winningTrailId, path: winningDestination }],
        migration: expect.objectContaining({
          phase: 'complete',
          destination: { trailId: winningTrailId, path: winningDestination },
        }),
      }),
    );
  });

  test('canonicalizes one moved source trail by identity', async () => {
    const destination = await initializedProject();
    const oldSourcePath = await initializedProject();
    const currentSourcePath = project();
    const destinationPaths = pathsForRoot(destination);
    const destinationTrailId = readConfig(destinationPaths).trailId!;
    const oldSourcePaths = pathsForRoot(oldSourcePath);
    const sourceTrailId = readConfig(oldSourcePaths).trailId!;
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'source-target-path-canonicalization',
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'follow the source trail to its current path',
    });
    const [segment] = ensureLedgerSegments(session).segments;
    await materializeLedgerSegment(session, segment!, authorFor(oldSourcePaths));
    markLedgerSegmentPlaced(session.id, segment!.id, sourceTrailId, oldSourcePath);
    const now = new Date().toISOString();
    setLedgerSegmentMigration(session.id, segment!.id, {
      phase: 'planned',
      destination: { trailId: destinationTrailId, path: destination },
      sourceTargets: [{ trailId: sourceTrailId, path: oldSourcePath }],
      startedAt: now,
      updatedAt: now,
    });
    cleanup(currentSourcePath);
    renameSync(oldSourcePath, currentSourcePath);
    markLedgerSegmentPlaced(session.id, segment!.id, sourceTrailId, currentSourcePath);

    await reprojectLedgerSegment(
      session,
      segment!,
      authorFor(destinationPaths),
      destinationTrailId,
      destination,
    );

    expect(ensureLedgerSegments(session).segments[0]?.migration?.sourceTargets).toEqual([
      { trailId: sourceTrailId, path: currentSourcePath },
    ]);
    expect(readAllEvents(pathsForRoot(currentSourcePath))).toEqual([]);
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
