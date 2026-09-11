import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  extractTranscriptEdits,
  importAntigravityIdeEdits,
  importAntigravityIdeTranscript,
  runImportAntigravityIde,
} from '../src/commands/importAntigravityIde.ts';
import { runInit } from '../src/commands/init.ts';
import { importedArtifactSourceIds, readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllConversationEventsWithSession } from '../src/core/conversationEvents.ts';
import { readAllEvents } from '../src/core/events.ts';
import {
  disableToolCapture,
  enableToolCapture,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { readLedgerRecords, unplacedSessions } from '../src/core/ledger.ts';
import { pathsForRoot, readConfig } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/** A minimal IDE transcript: one prompt, one reply, one CODE_ACTION editing `editPath`. */
function makeTranscript(editPath: string): string {
  return makeRoutingTranscript([editPath]);
}

function makeRoutingTranscript(
  editPaths: string[],
  options: { includePrompt?: boolean } = {},
): string {
  const includePrompt = options.includePrompt !== false;
  const lines: string[] = [];
  if (includePrompt) {
    lines.push(
      JSON.stringify({
        type: 'USER_INPUT',
        step_index: 0,
        created_at: '2026-06-24T06:45:00Z',
        content: 'make a file',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-06-24T06:45:02Z',
        content: 'Done.',
      }),
    );
  }
  for (const [index, editPath] of editPaths.entries()) {
    lines.push(
      JSON.stringify({
        type: 'CODE_ACTION',
        step_index: index + 2,
        created_at: '2026-06-24T06:45:06Z',
        content: `Created file file:///${editPath.replace(/\\/g, '/')} with requested content.`,
      }),
    );
  }
  return lines.join('\n') + '\n';
}

/** Keep the fixed transcript dates inside the watcher capture window. */
function setAutomaticImportTracking(enabled: boolean): void {
  writeGlobalConfig({
    version: 1,
    autoInit: enabled,
    captureSince: '2026-06-01T00:00:00.000Z',
  });
}

const RESUME_CUTOFF = '2026-06-24T06:45:00.000Z';

function makeResumeWindowTranscript(editPaths: {
  before: string;
  missing: string;
  invalid: string;
  current: string;
}): string {
  const editLine = (
    stepIndex: number,
    path: string,
    createdAt?: string,
  ): Record<string, unknown> => ({
    type: 'CODE_ACTION',
    step_index: stepIndex,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    content: `Created file file:///${path.replace(/\\/g, '/')} with requested content.`,
  });
  return (
    [
      {
        type: 'USER_INPUT',
        step_index: 0,
        created_at: '2026-06-24T06:44:50.000Z',
        content: 'old project A prompt',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-06-24T06:44:51.000Z',
        content: 'Old project A response.',
      },
      editLine(2, editPaths.before, '2026-06-24T06:44:52.000Z'),
      {
        type: 'USER_INPUT',
        step_index: 3,
        content: 'missing timestamp prompt',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 4,
        content: 'Missing timestamp response.',
      },
      editLine(5, editPaths.missing),
      {
        type: 'USER_INPUT',
        step_index: 6,
        created_at: 'not-a-timestamp',
        content: 'invalid timestamp prompt',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 7,
        created_at: 'not-a-timestamp',
        content: 'Invalid timestamp response.',
      },
      editLine(8, editPaths.invalid, 'not-a-timestamp'),
      {
        type: 'USER_INPUT',
        step_index: 9,
        created_at: RESUME_CUTOFF,
        content: 'resume project B at the cutoff',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 10,
        created_at: '2026-06-24T06:45:01.000Z',
        content: 'Current project B response.',
        tool_calls: [
          {
            id: 'current-read',
            name: 'read_file',
            args: { path: editPaths.current },
          },
        ],
      },
      editLine(11, editPaths.current, '2026-06-24T06:45:02.000Z'),
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  );
}

describe('extractTranscriptEdits (CODE_ACTION file:// URIs)', () => {
  test('pulls the edited path + a stable sourceId from a CODE_ACTION line', () => {
    const raw =
      JSON.stringify({
        type: 'CODE_ACTION',
        step_index: 4,
        created_at: '2026-06-24T06:45:06Z',
        content: 'Created file file:///C:/proj/src/a.py with requested content.',
      }) + '\n';
    const edits = extractTranscriptEdits(raw, 'conv1');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toBe('C:/proj/src/a.py');
    expect(edits[0]!.timestamp).toBe('2026-06-24T06:45:06Z');
    expect(edits[0]!.sourceId).toBe('agy:edit:conv1:4:C:/proj/src/a.py');
  });

  test("skips the IDE's own .system_generated state (task logs, not student work)", () => {
    const raw =
      JSON.stringify({
        type: 'CODE_ACTION',
        step_index: 7,
        content:
          'Wrote file:///C:/Users/x/.gemini/antigravity-ide/brain/abc/.system_generated/tasks/task-3.log',
      }) + '\n';
    expect(extractTranscriptEdits(raw, 'conv1')).toEqual([]);
  });

  test('ignores non-CODE_ACTION lines and malformed JSON', () => {
    const raw = [
      '{ not json',
      JSON.stringify({ type: 'USER_INPUT', content: 'file:///C:/x.py' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'no file here' }),
    ].join('\n');
    expect(extractTranscriptEdits(raw, 'c')).toEqual([]);
  });
});

describe('importAntigravityIdeEdits', () => {
  test('records edited files as artifacts tagged antigravity-ide, idempotently', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const edits = [
        {
          path: `${dir}/src/a.ts`,
          diff: 'Created file …/src/a.ts with requested content.',
          sourceId: 'agy:edit:conv1:4:a',
          timestamp: '2026-06-24T06:45:06Z',
        },
      ];
      expect(importAntigravityIdeEdits(author, edits, { root: dir, batchId: 'b1' })).toBe(
        1,
      );
      // Re-importing the same edit adds nothing (dedup by sourceId).
      expect(importAntigravityIdeEdits(author, edits, { root: dir, batchId: 'b2' })).toBe(
        0,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('runImportAntigravityIde --auto routes by edited-file paths', () => {
  test('edits route to their nearest enclosing .showtail/ trail (idempotently)', async () => {
    const proj = makeTempDir();
    try {
      await runInit({ cwd: proj });
      // Edit sits deep under the project — no closer `.showtail/`, so it routes up
      // to the project root, exactly like any other tool's capture.
      const editPath = `${proj.replace(/\\/g, '/')}/deeply/nested/app.py`;
      const file = join(proj, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file });

      const paths = pathsForRoot(proj);
      const events = readAllEvents(paths);
      expect(
        events.some((e) => e.type === 'prompt' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      expect(
        events.some((e) => e.type === 'ai_output' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      // The edited file was recorded as an artifact tagged antigravity-ide.
      expect(importedArtifactSourceIds(authorFor(paths)).size).toBeGreaterThan(0);

      // Idempotent: a second auto-run on the same transcript adds nothing.
      const before = readAllEvents(paths).length;
      await runImportAntigravityIde(undefined, { auto: true, file });
      expect(readAllEvents(paths).length).toBe(before);
      expect(
        unplacedSessions({ includeHidden: true }).filter(
          (session) => session.tool === 'antigravity-ide',
        ),
      ).toHaveLength(0);
    } finally {
      cleanup(proj);
    }
  });

  test('machine-wide disconnect blocks --auto before reads but preserves explicit import', async () => {
    const proj = makeTempDir();
    try {
      await runInit({ cwd: proj });
      const paths = pathsForRoot(proj);
      writeGlobalConfig({
        version: 1,
        autoInit: true,
        captureSince: '2026-06-01T00:00:00.000Z',
        captureDisabledTools: ['antigravity-ide'],
      });

      await expect(
        runImportAntigravityIde(undefined, {
          auto: true,
          list: true,
          file: join(proj, 'missing-transcript.jsonl'),
          cwd: proj,
        }),
      ).resolves.toBeUndefined();
      expect(readAllEvents(paths)).toHaveLength(0);
      expect(
        unplacedSessions({ includeHidden: true }).filter(
          (session) => session.tool === 'antigravity-ide',
        ),
      ).toHaveLength(0);

      const editPath = `${proj.replace(/\\/g, '/')}/app.py`;
      const fixture = join(proj, 'manual-transcript.jsonl');
      writeFileSync(fixture, makeTranscript(editPath), 'utf8');
      await runImportAntigravityIde(undefined, {
        file: fixture,
        withResponses: true,
        cwd: proj,
      });
      expect(
        readAllEvents(paths).some(
          (event) => event.tool === 'antigravity-ide' && event.type === 'prompt',
        ),
      ).toBe(true);
    } finally {
      cleanup(proj);
    }
  });

  test('resume cutoff filters old and untrusted timestamps before routing or auto-init', async () => {
    const projectA = makeTempDir();
    const ignoredRoot = makeTempDir();
    const projectB = makeTempDir();
    const launcher = makeTempDir();
    try {
      setAutomaticImportTracking(true);
      enableToolCapture('antigravity-ide', RESUME_CUTOFF);
      for (const root of [projectA, ignoredRoot, projectB]) {
        mkdirSync(join(root, '.git'), { recursive: true });
        mkdirSync(join(root, 'src'), { recursive: true });
      }

      const currentEdit = join(projectB, 'src', 'current.py');
      const file = join(launcher, 'resume-window.jsonl');
      writeFileSync(
        file,
        makeResumeWindowTranscript({
          before: join(projectA, 'src', 'before.py'),
          missing: join(ignoredRoot, 'src', 'missing.py'),
          invalid: join(ignoredRoot, 'src', 'invalid.py'),
          current: currentEdit,
        }),
        'utf8',
      );

      await runImportAntigravityIde(undefined, {
        auto: true,
        file,
        withResponses: true,
        cwd: launcher,
      });

      const projectBPaths = pathsForRoot(projectB);
      expect(existsSync(projectBPaths.config)).toBe(true);
      expect(existsSync(join(projectA, '.showtail'))).toBe(false);
      expect(existsSync(join(ignoredRoot, '.showtail'))).toBe(false);
      expect(existsSync(join(launcher, '.showtail'))).toBe(false);

      const events = readAllEvents(projectBPaths).filter(
        (event) => event.tool === 'antigravity-ide',
      );
      expect(
        events.filter((event) => event.type === 'prompt').map((event) => event.text),
      ).toEqual(['resume project B at the cutoff']);
      expect(
        events.filter((event) => event.type === 'ai_output').map((event) => event.text),
      ).toEqual(['Current project B response.']);
      expect(
        readAllArtifacts(projectBPaths)
          .filter((artifact) => artifact.tool === 'antigravity-ide')
          .map((artifact) => artifact.path),
      ).toEqual(['src/current.py']);

      const structured = readAllConversationEventsWithSession(projectBPaths).map(
        (row) => row.event,
      );
      expect(structured.map((event) => event.type)).toEqual([
        'user_text',
        'tool_use',
        'assistant_text',
      ]);
      expect(structured.every((event) => event.timestamp !== undefined)).toBe(true);
      expect(structured.map((event) => event.text).filter(Boolean)).toEqual([
        'resume project B at the cutoff',
        'Current project B response.',
      ]);
      expect(
        unplacedSessions({ includeHidden: true }).filter(
          (session) => session.tool === 'antigravity-ide',
        ),
      ).toHaveLength(0);
    } finally {
      cleanup(projectA);
      cleanup(ignoredRoot);
      cleanup(projectB);
      cleanup(launcher);
    }
  });

  test('disconnect and reconnect after the transcript read aborts before ledger creation', async () => {
    const project = makeTempDir();
    const launcher = makeTempDir();
    try {
      setAutomaticImportTracking(true);
      enableToolCapture('antigravity-ide', '2026-06-01T00:00:00.000Z');
      mkdirSync(join(project, '.git'), { recursive: true });
      mkdirSync(join(project, 'src'), { recursive: true });
      const file = join(launcher, 'consent-race.jsonl');
      writeFileSync(file, makeTranscript(join(project, 'src', 'app.py')), 'utf8');

      let cwdReads = 0;
      await runImportAntigravityIde(undefined, {
        auto: true,
        file,
        withResponses: true,
        get cwd() {
          cwdReads += 1;
          if (cwdReads === 2) {
            disableToolCapture('antigravity-ide');
            enableToolCapture('antigravity-ide', '2026-06-24T06:45:03.000Z');
          }
          return launcher;
        },
      });

      expect(cwdReads).toBe(2);
      expect(existsSync(join(project, '.showtail'))).toBe(false);
      expect(existsSync(join(launcher, '.showtail'))).toBe(false);
      expect(
        unplacedSessions({ includeHidden: true }).filter(
          (session) => session.tool === 'antigravity-ide',
        ),
      ).toHaveLength(0);
    } finally {
      cleanup(project);
      cleanup(launcher);
    }
  });

  test('explicit import remains unfiltered after a capture resume cutoff', async () => {
    const project = makeTempDir();
    try {
      await runInit({ cwd: project });
      enableToolCapture('antigravity-ide', RESUME_CUTOFF);
      const file = join(project, 'manual-resume-window.jsonl');
      const beforeEdit = join(project, 'src', 'before.py').replace(/\\/g, '/');
      const missingEdit = join(project, 'src', 'missing.py').replace(/\\/g, '/');
      writeFileSync(
        file,
        [
          {
            type: 'USER_INPUT',
            step_index: 0,
            created_at: '2026-06-24T06:44:50.000Z',
            content: 'manual prompt before the cutoff',
          },
          {
            type: 'PLANNER_RESPONSE',
            step_index: 1,
            created_at: '2026-06-24T06:44:51.000Z',
            content: 'Manual response before the cutoff.',
          },
          {
            type: 'CODE_ACTION',
            step_index: 2,
            created_at: '2026-06-24T06:44:52.000Z',
            content: `Created file file:///${beforeEdit} with requested content.`,
          },
          {
            type: 'USER_INPUT',
            step_index: 3,
            content: 'manual prompt without a timestamp',
          },
          {
            type: 'PLANNER_RESPONSE',
            step_index: 4,
            content: 'Manual response without a timestamp.',
          },
          {
            type: 'CODE_ACTION',
            step_index: 5,
            content: `Created file file:///${missingEdit} with requested content.`,
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
        'utf8',
      );

      await runImportAntigravityIde(undefined, {
        file,
        withResponses: true,
        cwd: project,
      });

      const paths = pathsForRoot(project);
      const events = readAllEvents(paths).filter(
        (event) => event.tool === 'antigravity-ide',
      );
      expect(events.filter((event) => event.type === 'prompt')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'ai_output')).toHaveLength(2);
      expect(events.map((event) => event.text)).toEqual(
        expect.arrayContaining([
          'manual prompt before the cutoff',
          'manual prompt without a timestamp',
        ]),
      );
      expect(
        readAllArtifacts(paths)
          .filter((artifact) => artifact.tool === 'antigravity-ide')
          .map((artifact) => artifact.path)
          .sort(),
      ).toEqual(['src/before.py', 'src/missing.py']);
    } finally {
      cleanup(project);
    }
  });

  test('creates one deterministic temp project when automatic tracking is on', async () => {
    const project = makeTempDir();
    const launcher = makeTempDir();
    try {
      setAutomaticImportTracking(true);
      const first = join(project, 'src', 'app.py');
      const second = join(project, 'tests', 'test_app.py');
      mkdirSync(join(project, 'src'), { recursive: true });
      mkdirSync(join(project, 'tests'), { recursive: true });
      const file = join(launcher, 'candidate.jsonl');
      writeFileSync(file, makeRoutingTranscript([first, second]), 'utf8');

      await runImportAntigravityIde(undefined, {
        auto: true,
        file,
        withResponses: true,
        cwd: launcher,
      });

      const paths = pathsForRoot(project);
      expect(existsSync(paths.config)).toBe(true);
      expect(existsSync(join(project, 'src', '.showtail'))).toBe(false);
      expect(existsSync(join(project, 'tests', '.showtail'))).toBe(false);
      expect(existsSync(join(launcher, '.showtail'))).toBe(false);
      expect(readConfig(paths).initialization).toEqual(
        expect.objectContaining({
          mode: 'automatic',
          evidence: 'edit',
          ledgerSessionId: expect.stringMatching(/^led_/),
        }),
      );
      const events = readAllEvents(paths).filter((e) => e.tool === 'antigravity-ide');
      expect(events.filter((e) => e.type === 'prompt')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'ai_output')).toHaveLength(1);
      expect(
        readAllArtifacts(paths)
          .filter((artifact) => artifact.tool === 'antigravity-ide')
          .map((artifact) => artifact.path)
          .sort(),
      ).toEqual(['src/app.py', 'tests/test_app.py']);
      expect(
        unplacedSessions({ includeHidden: true }).filter(
          (session) => session.tool === 'antigravity-ide',
        ),
      ).toHaveLength(0);
    } finally {
      cleanup(project);
      cleanup(launcher);
    }
  });

  test('keeps mixed tracked roots in one idempotent inbox session', async () => {
    const first = makeTempDir();
    const second = makeTempDir();
    const launcher = makeTempDir();
    try {
      setAutomaticImportTracking(true);
      await runInit({ cwd: first });
      await runInit({ cwd: second });
      const firstFile = join(first, 'src', 'one.py');
      const secondFile = join(second, 'src', 'two.py');
      mkdirSync(join(first, 'src'), { recursive: true });
      mkdirSync(join(second, 'src'), { recursive: true });
      const file = join(launcher, 'mixed.jsonl');
      writeFileSync(file, makeRoutingTranscript([firstFile, secondFile]), 'utf8');
      const firstPaths = pathsForRoot(first);
      const secondPaths = pathsForRoot(second);
      const firstEvents = readAllEvents(firstPaths).length;
      const secondEvents = readAllEvents(secondPaths).length;

      await runImportAntigravityIde(undefined, {
        auto: true,
        file,
        withResponses: true,
        cwd: launcher,
      });

      expect(readAllEvents(firstPaths)).toHaveLength(firstEvents);
      expect(readAllEvents(secondPaths)).toHaveLength(secondEvents);
      expect(readAllArtifacts(firstPaths)).toHaveLength(0);
      expect(readAllArtifacts(secondPaths)).toHaveLength(0);
      const inbox = unplacedSessions({ includeHidden: true }).filter(
        (session) => session.tool === 'antigravity-ide',
      );
      expect(inbox).toHaveLength(1);
      const records = readLedgerRecords(inbox[0]!.id);
      expect(records.filter((record) => record.kind === 'prompt')).toHaveLength(1);
      const editRecords = records.filter((record) => record.kind === 'edit');
      expect(editRecords).toHaveLength(2);
      expect(editRecords.every((record) => isAbsolute(record.file ?? ''))).toBe(true);
      expect(editRecords.map((record) => record.file?.replace(/\\/g, '/'))).toEqual(
        expect.arrayContaining([
          firstFile.replace(/\\/g, '/'),
          secondFile.replace(/\\/g, '/'),
        ]),
      );

      const before = records.length;
      await runImportAntigravityIde(undefined, {
        auto: true,
        file,
        withResponses: true,
        cwd: launcher,
      });
      const after = unplacedSessions({ includeHidden: true }).filter(
        (session) => session.tool === 'antigravity-ide',
      );
      expect(after).toHaveLength(1);
      expect(readLedgerRecords(after[0]!.id)).toHaveLength(before);
      expect(readAllEvents(firstPaths)).toHaveLength(firstEvents);
      expect(readAllEvents(secondPaths)).toHaveLength(secondEvents);
    } finally {
      cleanup(first);
      cleanup(second);
      cleanup(launcher);
    }
  });

  test('a nested repository is not imported into a broad parent trail', async () => {
    const parent = makeTempDir();
    try {
      await runInit({ cwd: parent });
      const repo = join(parent, 'school', 'calculator');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const editPath = `${repo.replace(/\\/g, '/')}/calculator.py`;
      const file = join(parent, 'nested-repo.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');
      const parentPaths = pathsForRoot(parent);
      const before = readAllEvents(parentPaths).length;

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: parent });

      expect(readAllEvents(parentPaths)).toHaveLength(before);
      expect(existsSync(join(repo, '.showtail'))).toBe(false);
      const inbox = unplacedSessions({ includeHidden: true }).filter(
        (session) => session.tool === 'antigravity-ide',
      );
      expect(inbox).toHaveLength(1);
    } finally {
      cleanup(parent);
    }
  });

  test('a valid temp candidate stays in the inbox when automatic tracking is off', async () => {
    const bare = makeTempDir();
    try {
      setAutomaticImportTracking(false);
      const editPath = `${bare.replace(/\\/g, '/')}/x/y.py`;
      mkdirSync(join(bare, 'x'), { recursive: true });
      const file = join(bare, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: bare });

      expect(existsSync(join(bare, '.showtail'))).toBe(false);
      expect(existsSync(join(bare, 'x', '.showtail'))).toBe(false);
      const inbox = unplacedSessions({ includeHidden: true }).filter(
        (s) => s.tool === 'antigravity-ide',
      );
      expect(inbox).toHaveLength(1);
      const kinds = readLedgerRecords(inbox[0]!.id).map((r) => r.kind);
      expect(kinds).toContain('prompt');
      expect(kinds).toContain('ai_output');
      expect(kinds).toContain('edit');
    } finally {
      cleanup(bare);
    }
  });

  test('re-running --auto on a folderless conversation adds nothing (idempotent inbox)', async () => {
    const bare = makeTempDir();
    try {
      setAutomaticImportTracking(false);
      const editPath = `${bare.replace(/\\/g, '/')}/x/y.py`;
      mkdirSync(join(bare, 'x'), { recursive: true });
      const file = join(bare, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: bare });
      const inbox1 = unplacedSessions({ includeHidden: true }).filter(
        (s) => s.tool === 'antigravity-ide',
      );
      expect(inbox1).toHaveLength(1);
      const before = readLedgerRecords(inbox1[0]!.id).length;

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: bare });
      const inbox2 = unplacedSessions({ includeHidden: true }).filter(
        (s) => s.tool === 'antigravity-ide',
      );
      expect(inbox2).toHaveLength(1); // still one session (keyed by conversation id)
      expect(readLedgerRecords(inbox2[0]!.id).length).toBe(before); // no dup records
    } finally {
      cleanup(bare);
    }
  });

  test('a conversation routed into a real project trail does NOT also hit the inbox', async () => {
    const proj = makeTempDir();
    try {
      await runInit({ cwd: proj });
      const editPath = `${proj.replace(/\\/g, '/')}/app.py`;
      const file = join(proj, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file });

      expect(
        unplacedSessions({ includeHidden: true }).filter(
          (s) => s.tool === 'antigravity-ide',
        ),
      ).toHaveLength(0);
    } finally {
      cleanup(proj);
    }
  });

  test('does not create a candidate trail without a meaningful prompt', async () => {
    const project = makeTempDir();
    try {
      setAutomaticImportTracking(true);
      const editPath = join(project, 'src', 'generated.py');
      mkdirSync(join(project, 'src'), { recursive: true });
      const file = join(project, 'edit-only.jsonl');
      writeFileSync(
        file,
        makeRoutingTranscript([editPath], { includePrompt: false }),
        'utf8',
      );

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: project });

      expect(existsSync(join(project, '.showtail'))).toBe(false);
      expect(existsSync(join(project, 'src', '.showtail'))).toBe(false);
      const inbox = unplacedSessions({ includeHidden: true }).filter(
        (session) => session.tool === 'antigravity-ide',
      );
      expect(inbox).toHaveLength(1);
      const records = readLedgerRecords(inbox[0]!.id);
      expect(records.filter((record) => record.kind === 'prompt')).toHaveLength(0);
      expect(records.filter((record) => record.kind === 'edit')).toHaveLength(1);
    } finally {
      cleanup(project);
    }
  });
});

describe('importAntigravityIdeTranscript still imports the conversation', () => {
  test('prompts + replies land tagged antigravity-ide', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const res = await importAntigravityIdeTranscript(
        author,
        {
          sessionId: 'c1',
          messages: [
            { role: 'user', text: 'hi', sourceId: 'agy:user:c1:0' },
            { role: 'assistant', text: 'hello', sourceId: 'agy:asst:c1:1' },
          ],
        },
        { withResponses: true },
      );
      expect(res.prompts).toBe(1);
      expect(res.responses).toBe(1);
      expect(res.edits).toBe(0); // edits come from the raw-transcript scan, not here
      const events = readAllEvents(pathsForRoot(dir));
      expect(
        events.some((e) => e.type === 'prompt' && e.tool === 'antigravity-ide'),
      ).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
