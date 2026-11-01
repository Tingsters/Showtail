import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pendingWorkForRoot } from '../src/commands/init.ts';
import {
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  listLedgerSegmentViews,
} from '../src/core/ledger.ts';
import { cleanup, makeTempDir } from './helpers.ts';

let home: string;
let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.SHOWTAIL_HOME;
  home = makeTempDir();
  root = makeTempDir();
  process.env.SHOWTAIL_HOME = home;
  fs.mkdirSync(join(root, '.git'));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = previousHome;
  cleanup(root);
  cleanup(home);
});

test('listing many turns reads session records a bounded number of times', async () => {
  const session = ensureLedgerSession({
    tool: 'claude',
    nativeSessionId: 'long-chat',
    cwd: root,
  });
  const file = join(root, 'app.ts');
  fs.writeFileSync(file, 'present');
  for (let i = 0; i < 30; i++) {
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'claude',
      text: `turn ${i}`,
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'claude',
      file,
      diff: '+ change',
      turnKey: prompt.id,
    });
  }
  ensureLedgerSegments(session);
  const recordsPath = join(home, 'ledger', 'sessions', session.id, 'records.jsonl');
  const reads = spyOn(fs, 'readFileSync');
  const recordReads = () =>
    reads.mock.calls.filter(([path]) => path === recordsPath).length;
  try {
    const views = listLedgerSegmentViews({ includeHidden: true, persist: false });
    expect(views).toHaveLength(30);
    expect(views.every((view) => view.prompts === 1 && view.edits === 1)).toBe(true);
    expect(
      views.every((view) => view.editPaths.length === 1 && view.editPaths[0] === file),
    ).toBe(true);
    expect(recordReads()).toBeGreaterThan(0);
    expect(recordReads()).toBeLessThanOrEqual(3);

    reads.mockClear();
    const pending = await pendingWorkForRoot(root);
    expect(pending.ranges).toHaveLength(30);
    // Preview includes direct work and relocation discovery; neither should
    // reparse the transcript for each turn or each already-present edit.
    expect(recordReads()).toBeGreaterThan(0);
    expect(recordReads()).toBeLessThanOrEqual(8);

    const unrelated = makeTempDir();
    try {
      fs.mkdirSync(join(unrelated, '.git'));
      reads.mockClear();
      expect((await pendingWorkForRoot(unrelated)).ranges).toHaveLength(0);
      // Unrelated pending turns must share the compatibility snapshot too.
      expect(recordReads()).toBeGreaterThan(0);
      expect(recordReads()).toBeLessThanOrEqual(8);
    } finally {
      cleanup(unrelated);
    }
  } finally {
    reads.mockRestore();
  }
});

test('later scans see appended turns and corrections without persisting sidecars', () => {
  const session = ensureLedgerSession({
    tool: 'claude',
    nativeSessionId: 'growing-chat',
    cwd: root,
  });
  const prompt = appendLedgerRecord(session.id, {
    kind: 'prompt',
    tool: 'claude',
    text: 'first',
  });
  const oldFile = join(root, 'old.ts');
  const newFile = join(root, 'new.ts');
  const original = appendLedgerRecord(session.id, {
    kind: 'edit',
    tool: 'claude',
    file: oldFile,
    turnKey: prompt.id,
    sourceId: 'edit-1',
  });
  ensureLedgerSegments(session);
  const sidecarPath = join(home, 'ledger', 'sessions', session.id, 'segments.json');
  const before = fs.readFileSync(sidecarPath, 'utf8');
  expect(
    listLedgerSegmentViews({ includeHidden: true, persist: false })[0]?.editPaths,
  ).toEqual([oldFile]);

  appendLedgerRecord(session.id, {
    kind: 'edit',
    tool: 'claude',
    file: newFile,
    turnKey: prompt.id,
    sourceId: original.sourceId,
    supersedesRecordId: original.id,
  });
  appendLedgerRecord(session.id, { kind: 'prompt', tool: 'claude', text: 'second' });
  const views = listLedgerSegmentViews({ includeHidden: true, persist: false });
  expect(views).toHaveLength(2);
  expect(views.find((view) => view.firstPrompt === 'first')).toEqual(
    expect.objectContaining({ edits: 1, editPaths: [newFile] }),
  );
  expect(views.find((view) => view.firstPrompt === 'second')?.editPaths).toEqual([]);
  expect(fs.readFileSync(sidecarPath, 'utf8')).toBe(before);
});
