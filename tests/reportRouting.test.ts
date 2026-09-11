import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { reconcileReportRouting } from '../src/commands/reportRouting.ts';
import { readAllEvents } from '../src/core/events.ts';
import {
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  listActionableLedgerRanges,
  markPlaced,
  readLedgerSession,
} from '../src/core/ledger.ts';
import { materializeLedgerSession } from '../src/core/materialize.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import {
  authorFor,
  cleanup,
  envWithHome,
  makeTempDir,
  readJsonReport,
  runCli,
} from './helpers.ts';

describe('report-time mixed chat routing', () => {
  let previousHome: string | undefined;
  let home: string;
  const roots: string[] = [];

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

  async function project(): Promise<string> {
    const root = makeTempDir();
    roots.push(root);
    mkdirSync(join(root, '.git'), { recursive: true });
    await runInit({ cwd: root, json: true });
    return root;
  }

  async function expectExplicitReportTargetToStaySelected(
    selector: 'project' | 'path',
  ): Promise<void> {
    const editRoot = await project();
    const reportRoot = await project();
    const editFile = join(editRoot, 'game.ts');
    writeFileSync(editFile, 'export const game = true;\n');

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: `explicit-report-target-${selector}`,
      cwd: reportRoot,
      workspacePaths: [reportRoot],
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'start from the stale workspace projection',
    });

    // Reproduce the old whole-chat placement before later edits supplied the
    // stronger project evidence that report-time reconciliation now honors.
    await materializeLedgerSession(session, authorFor(pathsForRoot(reportRoot)));
    const reportTrailId = JSON.parse(
      readFileSync(join(reportRoot, '.showtail', 'config.json'), 'utf8'),
    ).trailId as string;
    markPlaced(session.id, reportTrailId, reportRoot);

    const editPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'edit the active game',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: editFile,
      diff: '+export const game = true;',
      turnKey: editPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'generate the report for the explicitly selected project',
      context: { cwd: reportRoot, workspacePaths: [reportRoot], scope: 'session' },
    });

    const args =
      selector === 'project'
        ? ['report', '--project', reportTrailId, '--json', '--no-open']
        : ['report', reportRoot, '--json', '--no-open'];
    const command = runCli(reportRoot, args, { env: envWithHome(home) });

    expect(command.code).toBe(0);
    expect(command.stderr).toBe('');
    const payload = JSON.parse(command.stdout);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        root: reportRoot,
        trailId: reportTrailId,
        reportPath: expect.stringContaining(join(reportRoot, '.showtail', 'reports')),
      }),
    );
    expect(payload.routing.reroutedRanges).toBe(2);
    expect(readdirSync(join(editRoot, '.showtail', 'reports'))).toEqual([]);
    expect(readdirSync(join(reportRoot, '.showtail', 'reports')).length).toBeGreaterThan(
      0,
    );
  }

  test('report does not claim a context-free editor turn from its ambient workspace', async () => {
    const reportRoot = await project();
    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'ambient-single-turn-report',
      cwd: null,
      workspacePaths: [reportRoot],
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'write an unrelated generic loop',
    });

    const command = runCli(
      reportRoot,
      [
        'report',
        reportRoot,
        '--format',
        'json',
        '--json',
        '--verbose-json',
        '--no-sync',
        '--no-open',
      ],
      { env: envWithHome(home) },
    );

    expect(command.code).toBe(0);
    expect(command.stderr).toBe('');
    const payload = JSON.parse(command.stdout);
    expect(payload.claimedSessions).toEqual([]);
    expect(payload.claimedSegments).toEqual([]);
    expect(readAllEvents(pathsForRoot(reportRoot))).toEqual([]);
    const stored = readLedgerSession(session.id)!;
    expect(stored.status).toBe('inbox');
    expect(stored.targets ?? []).toEqual([]);
    expect(ensureLedgerSegments(stored).segments[0]?.status).toBe('inbox');
    expect(ensureLedgerSegments(stored).segments[0]?.targets ?? []).toEqual([]);
  });

  test('splits later project turns and removes only the inherited unresolved prefix', async () => {
    const first = await project();
    const second = await project();
    const firstFile = join(first, 'fairy.ts');
    const secondFile = join(second, 'word.ts');
    writeFileSync(firstFile, 'export const fairy = true;\n');
    writeFileSync(secondFile, 'export const word = true;\n');

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'mixed-report-routing',
      cwd: first,
      workspacePaths: [first],
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'plan Fairy Sparkle',
    });
    const firstPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Fairy Sparkle here',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: firstFile,
      diff: '+export const fairy = true;',
      turnKey: firstPrompt.id,
    });

    // Reproduce a trail created before the native chat later moved to project B.
    await materializeLedgerSession(session, authorFor(pathsForRoot(first)));
    markPlaced(
      session.id,
      JSON.parse(readFileSync(join(first, '.showtail', 'config.json'), 'utf8')).trailId,
      first,
    );
    const oldReport = join(first, '.showtail', 'reports', 'existing-report.html');
    mkdirSync(join(first, '.showtail', 'reports'), { recursive: true });
    writeFileSync(oldReport, 'keep me');

    const secondPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'now build Word Sparkle',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: secondFile,
      diff: '+export const word = true;',
      turnKey: secondPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'generate the Showtail report for this game',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });

    const firstRun = await reconcileReportRouting(second);
    const secondRun = await reconcileReportRouting(second);

    expect(firstRun.warnings).toEqual([]);
    expect(firstRun.cleanedPendingRanges).toEqual([
      expect.objectContaining({ reason: 'no-project-evidence' }),
    ]);
    expect(secondRun.cleanedPendingRanges).toEqual([]);
    expect(secondRun.reroutedRanges).toEqual([]);
    expect(readFileSync(oldReport, 'utf8')).toBe('keep me');

    const promptsAt = (root: string): string[] =>
      readAllEvents(pathsForRoot(root))
        .filter((event) => event.type === 'prompt')
        .map((event) => event.text);
    expect(promptsAt(first)).toEqual(['build Fairy Sparkle here']);
    expect(promptsAt(second)).toHaveLength(2);
    expect(promptsAt(second)).toEqual(
      expect.arrayContaining([
        'now build Word Sparkle',
        'generate the Showtail report for this game',
      ]),
    );

    const pending = listActionableLedgerRanges({
      sessionId: session.id,
      pendingOnly: true,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.firstPrompt).toBe('plan Fairy Sparkle');
    expect(existsSync(join(second, '.showtail', 'config.json'))).toBe(true);
  });

  test('explicit report path wins over a stale editor workspace and reports only that game', () => {
    const first = makeTempDir();
    const second = makeTempDir();
    roots.push(first, second);
    mkdirSync(join(first, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const firstFile = join(first, 'fairy.ts');
    const secondFile = join(second, 'word.ts');
    writeFileSync(firstFile, 'export const fairy = true;\n');
    writeFileSync(secondFile, 'export const word = true;\n');

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'stale-workspace-explicit-report',
      cwd: first,
      workspacePaths: [first],
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'brainstorm Fairy Sparkle',
    });
    const firstPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'build Fairy Sparkle',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: firstFile,
      diff: '+export const fairy = true;',
      turnKey: firstPrompt.id,
    });
    const secondPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'now build Word Sparkle',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: secondFile,
      diff: '+export const word = true;',
      turnKey: secondPrompt.id,
    });
    appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'generate a Showtail report for Word Sparkle',
      context: { cwd: first, workspacePaths: [first], scope: 'session' },
    });

    const command = runCli(
      first,
      [
        'report',
        second,
        '--format',
        'json',
        '--json',
        '--verbose-json',
        '--no-sync',
        '--no-open',
      ],
      { env: envWithHome(home) },
    );
    expect(command.code).toBe(0);
    expect(command.stderr).toBe('');
    const payload = JSON.parse(command.stdout);
    expect(payload.root).toBe(second);
    expect(payload.reportPath).toContain(join(second, '.showtail', 'reports'));
    expect(payload.claimedSessions).toEqual([session.id]);
    expect(payload.claimedSegments).toHaveLength(2);
    expect(payload.pendingRanges).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        firstPrompt: 'brainstorm Fairy Sparkle',
      }),
    ]);

    const reportPrompts = readJsonReport(second).turns.map(
      (turn: { prompt: { text: string } }) => turn.prompt.text,
    );
    expect(reportPrompts).toHaveLength(2);
    expect(reportPrompts).toEqual(
      expect.arrayContaining([
        'now build Word Sparkle',
        'generate a Showtail report for Word Sparkle',
      ]),
    );
    expect(reportPrompts).not.toContain('build Fairy Sparkle');
    expect(reportPrompts).not.toContain('brainstorm Fairy Sparkle');
    expect(
      readAllEvents(pathsForRoot(first))
        .filter((event) => event.type === 'prompt')
        .map((event) => event.text),
    ).toEqual(['build Fairy Sparkle']);
  });

  test('extension-style --project report cannot redirect report generation to an edit-backed project', async () => {
    await expectExplicitReportTargetToStaySelected('project');
  });

  test('explicit positional report path cannot redirect report generation to an edit-backed project', async () => {
    await expectExplicitReportTargetToStaySelected('path');
  });

  test('refuses to reroute a range between live copies sharing one trail id', async () => {
    const source = await project();
    const destination = await project();
    const sourceFile = join(source, 'source.ts');
    const destinationFile = join(destination, 'destination.ts');
    writeFileSync(sourceFile, 'export const source = true;\n');
    writeFileSync(destinationFile, 'export const destination = true;\n');

    const sourceConfigPath = join(source, '.showtail', 'config.json');
    const destinationConfigPath = join(destination, '.showtail', 'config.json');
    const sourceConfig = JSON.parse(readFileSync(sourceConfigPath, 'utf8'));
    const destinationConfig = JSON.parse(readFileSync(destinationConfigPath, 'utf8'));
    writeFileSync(
      destinationConfigPath,
      JSON.stringify({ ...destinationConfig, trailId: sourceConfig.trailId }, null, 2) +
        '\n',
    );

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'copied-trail-routing-refusal',
      cwd: source,
      workspacePaths: [source],
    });
    const sourcePrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'keep this turn in the source copy',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: sourceFile,
      diff: '+export const source = true;',
      turnKey: sourcePrompt.id,
    });
    const destinationPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'this later turn resolves to the destination copy',
    });
    await materializeLedgerSession(session, authorFor(pathsForRoot(source)));
    markPlaced(session.id, sourceConfig.trailId, source);

    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: destinationFile,
      diff: '+export const destination = true;',
      turnKey: destinationPrompt.id,
    });

    const destinationRange = listActionableLedgerRanges({
      includeHidden: true,
      sessionId: session.id,
    }).find((range) => range.firstPrompt === destinationPrompt.text);
    expect(destinationRange?.targetPaths).toEqual([source]);
    const sourceEventsBefore = readAllEvents(pathsForRoot(source));
    const destinationEventsBefore = readAllEvents(pathsForRoot(destination));

    await expect(reconcileReportRouting(destination)).rejects.toMatchObject({
      errorCode: 'DUPLICATE_TRAIL_ID',
      nextAction: 'repair-copied-trail',
      details: {
        selector: destinationRange?.selector,
        trailId: sourceConfig.trailId,
        sourceRoot: source,
        destinationRoot: destination,
      },
    });
    expect(readAllEvents(pathsForRoot(source))).toEqual(sourceEventsBefore);
    expect(readAllEvents(pathsForRoot(destination))).toEqual(destinationEventsBefore);

    const after = listActionableLedgerRanges({
      includeHidden: true,
      sessionId: session.id,
    }).find((range) => range.selector === destinationRange?.selector);
    expect(after?.targetPaths).toEqual([source]);
    expect(readLedgerSession(session.id)?.targets).toEqual([
      { trailId: sourceConfig.trailId, path: source },
    ]);
  });
});
