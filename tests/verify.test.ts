import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInit } from '../src/commands/init.ts';
import { captureTranscriptToLedger } from '../src/core/ledgerCapture.ts';
import { gitIgnoredPaths } from '../src/core/git.ts';
import { authorSlugs } from '../src/core/authors.ts';
import { redactTrail } from '../src/commands/redact.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent, removeEventsByBatch } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import {
  appendLedgerRecord,
  effectiveLedgerRecords,
  ensureLedgerSegments,
  ensureLedgerSession,
  ledgerRecordProjectionSourceId,
  markLedgerSegmentPlaced,
  readLedgerRecords,
} from '../src/core/ledger.ts';
import { materializeLedgerSegment } from '../src/core/materialize.ts';
import {
  authorPaths,
  pathsForRoot,
  readConfig,
  type AuthorPaths,
  type ShowtailPaths,
} from '../src/core/storage.ts';
import {
  appendJournal,
  journalSegmentPaths,
  readJournal,
  rechainEntries,
  rewriteJournal,
} from '../src/core/journal.ts';
import { verifyProject } from '../src/commands/verify.ts';
import type { JournalEntry } from '../src/types.ts';
import type { HookTranscript } from '../src/plugins/types.ts';
import { authorFor, cleanup, makeTempDir, runCli } from './helpers.ts';

/** Path to an author's first journal segment, ensuring the shard dir exists. */
function journalSegment(author: AuthorPaths): string {
  const dir = join(author.journalDir, author.machineId!);
  mkdirSync(dir, { recursive: true });
  return join(dir, '0001.log');
}

/** The file backing an object address (`sha256:<hex>` → `objects/<2>/<rest>`). */
function objectFile(paths: ShowtailPaths, ref: string): string {
  const hex = ref.slice(ref.indexOf(':') + 1);
  return join(paths.objectsDir, hex.slice(0, 2), hex.slice(2));
}

/** Read a journal segment as its raw lines (what a tamperer would hand-edit). */
function segmentLines(author: AuthorPaths): string[] {
  return readFileSync(journalSegment(author), 'utf8').trimEnd().split('\n');
}

function writeSegmentLines(author: AuthorPaths, lines: string[]): void {
  writeFileSync(journalSegment(author), lines.join('\n') + '\n', 'utf8');
}

function checkByName(result: Awaited<ReturnType<typeof verifyProject>>, name: string) {
  return result.checks.find((c) => c.name === name)!;
}

/** The git-anchor check, by its stable name. */
function historyCheck(result: Awaited<ReturnType<typeof verifyProject>>) {
  return checkByName(result, 'journal history is append-only (git)');
}

/** Run git in `dir`, throwing on failure — a fixture must never quietly no-op. */
function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`);
  }
  return (res.stdout ?? '').trim();
}

/**
 * A temp project that is a real git repo. Identity and signing are set locally
 * so the fixture doesn't depend on (or touch) the developer's global git config,
 * and `core.autocrlf=false` keeps the journal's line endings out of the diff.
 */
function makeGitProject(): string {
  const dir = makeTempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'tester@example.com');
  git(dir, 'config', 'user.name', 'Test Student');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

/** Commit everything in the working tree; returns the new commit's full SHA. */
function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Overwrite a shard with entries re-linked into a valid chain (the attack). */
function rewriteSegment(author: AuthorPaths, entries: JournalEntry[]): void {
  writeSegmentLines(
    author,
    rechainEntries(entries).map((e) => JSON.stringify(e)),
  );
}

describe('verify', () => {
  test('a clean project passes every check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      await logEvent(author, { type: 'prompt', text: 'Help me plan the project' });
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(author, { filePath: 'README.md' });

      const result = await verifyProject(paths);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  // The inversion this suite exists to guard: a student who keeps working on
  // their code after the last snapshot is doing exactly the right thing, and
  // must never be told their trail failed verification.
  test('a source file edited after its snapshot still passes (informational only)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(author, { filePath: 'README.md' });

      writeFileSync(
        join(dir, 'README.md'),
        '# Project (kept working after the snapshot)',
      );
      const result = await verifyProject(paths);
      expect(result.ok).toBe(true);
      const snapshots = checkByName(result, 'file snapshots are accounted for');
      expect(snapshots.ok).toBe(true);
      expect(snapshots.details.join('\n')).toContain('edited since their last snapshot');
    } finally {
      cleanup(dir);
    }
  });

  test('a corrupt journal line fails the validity check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      // Write a broken line directly into the journal.
      appendFileSync(journalSegment(author), 'this is not json\n');

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'journal entries are valid').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('an event missing required fields fails the validity check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      appendFileSync(
        journalSegment(author),
        JSON.stringify({ id: 'x', type: 'banana', actorSlug: author.slug }) + '\n',
      );

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'journal entries are valid').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('fails when multiple trail IDs claim the same current project path', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const trailId = readConfig(paths).trailId!;
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({
          version: 1,
          knownProjects: [
            {
              trailId: 'trl_duplicate_same_path',
              path: dir,
              lastSeenAt: '2026-09-11T00:00:01.000Z',
            },
          ],
        }) + '\n',
      );

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(result.semanticConflicts).toContainEqual(
        expect.objectContaining({
          code: 'SAME_PATH_TRAIL_ID_CONFLICT',
          trailIds: expect.arrayContaining([trailId, 'trl_duplicate_same_path']),
        }),
      );
      const semantic = checkByName(
        result,
        'ledger routing and projection are semantically consistent',
      );
      expect(semantic.ok).toBe(false);
      expect(semantic.details.join('\n')).toContain('SAME_PATH_TRAIL_ID_CONFLICT');
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('returns a failed semantic check instead of throwing for invalid config', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      writeFileSync(paths.config, '{ broken', 'utf8');

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(result.semanticConflicts).toEqual([]);
      expect(checkByName(result, 'config.json is present and valid').ok).toBe(false);
      expect(
        checkByName(result, 'ledger routing and projection are semantically consistent'),
      ).toMatchObject({
        ok: false,
        details: [expect.stringContaining('Semantic consistency could not be checked')],
      });
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('CLI JSON returns the verification envelope for invalid config', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      writeFileSync(paths.config, '{ broken', 'utf8');

      const result = runCli(dir, ['verify', '--json']);
      expect(result.code).toBe(3);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: false,
        root: paths.root,
        trailId: null,
        semantic: { conflicts: 0 },
      });
      expect(payload).not.toHaveProperty('errorCode');
      expect(payload.checks).toContainEqual(
        expect.objectContaining({
          name: 'config.json is present and valid',
          ok: false,
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('fails when a placed ledger turn is missing from the trail projection', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const trailId = readConfig(paths).trailId!;
      const ledger = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'verify-missing-projection',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'this prompt should have been projected',
        sourceId: 'copilot:user:test-session:request_first',
      });
      appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'codex',
        text: 'this reply should have been projected',
        turnKey: prompt.id,
        sourceId: 'copilot:asst:test-session:request_second',
      });
      const segment = ensureLedgerSegments(ledger).segments[0]!;
      markLedgerSegmentPlaced(ledger.id, segment.id, trailId, dir);

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(result.semanticConflicts).toContainEqual(
        expect.objectContaining({
          code: 'MISSING_LEDGER_PROJECTION',
          sessionId: ledger.id,
          segmentId: segment.id,
          count: 2,
        }),
      );
      expect(result.semanticConflicts).toContainEqual(
        expect.objectContaining({
          code: 'COLLAPSED_NATIVE_REQUEST_IDS',
          sessionId: ledger.id,
          segmentId: segment.id,
          count: 2,
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('requires only the final projection of a corrected ledger record', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const trailId = readConfig(paths).trailId!;
      const ledger = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'verify-corrected-projection',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'capture the completed response',
        sourceId: 'verify-revision-prompt',
      });
      const draft = appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'codex',
        text: 'partial response',
        turnKey: prompt.id,
        sourceId: 'verify-revision-response',
        transcriptFinal: false,
      });
      const final = appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'codex',
        text: 'completed response',
        turnKey: prompt.id,
        sourceId: draft.sourceId,
        supersedesRecordId: draft.id,
        transcriptFinal: true,
      });
      const segment = ensureLedgerSegments(ledger).segments[0]!;
      markLedgerSegmentPlaced(ledger.id, segment.id, trailId, dir);

      await logEvent(author, {
        type: 'prompt',
        text: prompt.text!,
        tool: 'codex',
        sourceId: ledgerRecordProjectionSourceId(ledger.id, prompt),
      });
      await logEvent(author, {
        type: 'ai_output',
        text: final.text!,
        tool: 'codex',
        sourceId: ledgerRecordProjectionSourceId(ledger.id, final),
      });

      const result = await verifyProject(paths);
      expect(result.ok).toBe(true);
      expect(result.semanticConflicts).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('fails when a superseded ledger projection remains in the journal', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const trailId = readConfig(paths).trailId!;
      const ledger = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'verify-obsolete-projection',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'capture the completed response',
        sourceId: 'verify-obsolete-prompt',
      });
      const draft = appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'codex',
        text: 'partial response',
        turnKey: prompt.id,
        sourceId: 'verify-obsolete-response',
        transcriptFinal: false,
      });
      const final = appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'codex',
        text: 'completed response',
        turnKey: prompt.id,
        sourceId: draft.sourceId,
        supersedesRecordId: draft.id,
        transcriptFinal: true,
      });
      const segment = ensureLedgerSegments(ledger).segments[0]!;
      markLedgerSegmentPlaced(ledger.id, segment.id, trailId, dir);

      for (const record of [prompt, draft, final]) {
        await logEvent(author, {
          type: record.kind === 'prompt' ? 'prompt' : 'ai_output',
          text: record.text!,
          tool: 'codex',
          sourceId: ledgerRecordProjectionSourceId(ledger.id, record),
        });
      }

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(result.semanticConflicts).toContainEqual(
        expect.objectContaining({
          code: 'OBSOLETE_LEDGER_PROJECTION',
          sessionId: ledger.id,
          segmentId: segment.id,
          sourceIds: [ledgerRecordProjectionSourceId(ledger.id, draft)],
          count: 1,
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('fails when an expected ledger projection appears more than once', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const trailId = readConfig(paths).trailId!;
      const ledger = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'verify-duplicate-projection',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'record this once',
        sourceId: 'verify-duplicate-prompt',
      });
      const segment = ensureLedgerSegments(ledger).segments[0]!;
      markLedgerSegmentPlaced(ledger.id, segment.id, trailId, dir);
      const sourceId = ledgerRecordProjectionSourceId(ledger.id, prompt);

      for (let i = 0; i < 2; i += 1) {
        await logEvent(author, {
          type: 'prompt',
          text: prompt.text!,
          tool: 'codex',
          sourceId,
        });
      }

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(result.semanticConflicts).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_LEDGER_PROJECTION',
          sessionId: ledger.id,
          segmentId: segment.id,
          sourceIds: [sourceId],
          count: 1,
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('reports an unresolved correction fork and clears it after reconciliation', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const trailId = readConfig(paths).trailId!;
      const ledger = ensureLedgerSession({
        tool: 'github-copilot',
        nativeSessionId: 'verify-correction-fork',
      });
      const promptSourceId = 'copilot:user:verify-correction-fork:request_1';
      const replySourceId = 'copilot:asst:verify-correction-fork:request_1';
      const prompt = appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text: 'give me the completed answer',
        sourceId: promptSourceId,
      });
      const partial = appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'partial answer',
        turnKey: prompt.id,
        sourceId: replySourceId,
        transcriptFinal: false,
      });
      const staleFinal = appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'stale final answer',
        turnKey: prompt.id,
        sourceId: replySourceId,
        supersedesRecordId: partial.id,
        transcriptFinal: true,
      });
      const wrongTurnPrompt = appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text: 'open a different report',
        sourceId: 'copilot:user:verify-correction-fork:request_2',
      });
      appendLedgerRecord(ledger.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'invalid fork answer',
        turnKey: wrongTurnPrompt.id,
        sourceId: replySourceId,
        supersedesRecordId: partial.id,
        transcriptFinal: true,
      });
      const segment = ensureLedgerSegments(ledger).segments.find(
        (candidate) => candidate.promptRecordId === prompt.id,
      )!;
      markLedgerSegmentPlaced(ledger.id, segment.id, trailId, dir);
      await materializeLedgerSegment(ledger, segment, author);

      const unresolved = await verifyProject(paths);
      expect(unresolved.semanticConflicts).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_LEDGER_CORRECTION',
          sessionId: ledger.id,
          segmentId: segment.id,
          sourceIds: [replySourceId],
          count: 1,
        }),
      );

      const transcript: HookTranscript = {
        sessionId: 'verify-correction-fork',
        messages: [
          {
            role: 'user',
            text: 'give me the completed answer',
            sourceId: promptSourceId,
            requestId: 'request_1',
          },
          {
            role: 'assistant',
            text: 'correct final answer',
            sourceId: replySourceId,
            requestId: 'request_1',
            isFinal: true,
          },
        ],
      };
      captureTranscriptToLedger(ledger, transcript, 'github-copilot', [], {
        backfill: true,
      });
      await materializeLedgerSegment(ledger, segment.id, author);

      const repaired = await verifyProject(paths);
      expect(repaired.semanticConflicts).toEqual([]);
      expect(repaired.ok).toBe(true);
      expect(
        effectiveLedgerRecords(readLedgerRecords(ledger.id)).find(
          (record) => record.kind === 'ai_output',
        ),
      ).toMatchObject({
        text: 'correct final answer',
        supersedesRecordId: staleFinal.id,
      });
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });
});

describe('verify: tamper detection', () => {
  test('a hand-edited stored object no longer matches its address', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const { event } = await logEvent(author, {
        type: 'prompt',
        text: 'Write the sorting function for me',
      });
      expect(event.text).toContain('sorting');

      // Rewrite the stored prompt text to invent a prompt that was never sent.
      const ref = readJournal(author).find((e) => e.refs)!.refs![0]!;
      writeFileSync(objectFile(paths, ref), 'Explain how quicksort works', 'utf8');

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      const objects = checkByName(result, 'stored content matches its address');
      expect(objects.ok).toBe(false);
      expect(objects.details.join('\n')).toContain('tampered');
      expect(objects.details.join('\n')).toContain(ref);
    } finally {
      cleanup(dir);
    }
  });

  test('a deleted object is reported as missing from the store', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'A prompt worth hiding' });
      const ref = readJournal(author).find((e) => e.refs)!.refs![0]!;
      rmSync(objectFile(paths, ref));

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      const objects = checkByName(result, 'stored content matches its address');
      expect(objects.ok).toBe(false);
      expect(objects.details.join('\n')).toContain('missing');
    } finally {
      cleanup(dir);
    }
  });

  test('a hand-edited journal line breaks the hash chain', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });
      await logEvent(author, { type: 'prompt', text: 'third prompt' });

      // Doctor the middle line in place — the classic "I said something smarter".
      const lines = segmentLines(author);
      expect(lines.length).toBe(3);
      const doctored = JSON.parse(lines[1]!) as Record<string, unknown>;
      doctored.textPreview = 'a much better prompt I never actually sent';
      lines[1] = JSON.stringify(doctored);
      writeSegmentLines(author, lines);

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      const chain = checkByName(result, 'journal chain is unbroken');
      expect(chain.ok).toBe(false);
      // The break surfaces at the entry *after* the edited one.
      expect(chain.details.join('\n')).toContain('entry 3');
    } finally {
      cleanup(dir);
    }
  });

  test('deleting a journal line breaks the hash chain', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'embarrassing prompt' });
      await logEvent(author, { type: 'prompt', text: 'third prompt' });

      const lines = segmentLines(author);
      writeSegmentLines(author, [lines[0]!, lines[2]!]);

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('import undo re-chains the journal and still verifies', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'my own prompt' });
      await logEvent(author, {
        type: 'prompt',
        text: 'imported prompt',
        batchId: 'batch-1',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'imported reply',
        batchId: 'batch-1',
      });
      await logEvent(author, { type: 'prompt', text: 'another of my own' });

      expect(removeEventsByBatch(author, 'batch-1')).toBe(2);
      // Two events left, plus the marker the undo records so that a rewrite
      // git can see is a rewrite the trail declared.
      const left = readJournal(author);
      expect(left.filter((e) => e.kind !== 'redaction').length).toBe(2);
      const marker = left.find((e) => e.kind === 'redaction');
      expect(marker?.redaction).toMatchObject({
        reason: 'import-undo',
        entries: 2,
        batch: 'batch-1',
      });

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a trail written before chaining is informational, not a failure', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });

      // Strip every `prev`: exactly what an older Showtail's journal looks like.
      writeSegmentLines(
        author,
        segmentLines(author).map((line) => {
          const { prev: _dropped, ...rest } = JSON.parse(line) as Record<string, unknown>;
          return JSON.stringify(rest);
        }),
      );

      const result = await verifyProject(paths);
      const chain = checkByName(result, 'journal chain is unbroken');
      expect(chain.ok).toBe(true);
      expect(chain.details.join('\n')).toContain('older Showtail');
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('verify --json', () => {
  test('emits parseable JSON and exits 0 on a clean trail', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      await logEvent(authorFor(paths), { type: 'prompt', text: 'hello' });

      const res = runCli(dir, ['verify', '--json', '--verbose-json']);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.checks)).toBe(true);
      for (const check of parsed.checks) {
        expect(typeof check.name).toBe('string');
        expect(typeof check.ok).toBe('boolean');
        expect(Array.isArray(check.details)).toBe(true);
      }
      expect(parsed.checks.map((c: { name: string }) => c.name)).toContain(
        'journal chain is unbroken',
      );
      expect(parsed.checks.map((c: { name: string }) => c.name)).toContain(
        'stored content matches its address',
      );
      expect(parsed.semantic).toEqual({ conflicts: 0, details: [] });
    } finally {
      cleanup(dir);
    }
  });

  test('still exits 3 when a check fails', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'the real prompt' });
      const ref = readJournal(author).find((e) => e.refs)!.refs![0]!;
      writeFileSync(objectFile(paths, ref), 'a prompt I never sent', 'utf8');

      const res = runCli(dir, ['verify', '--json']);
      expect(res.code).toBe(3);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      const failed = parsed.checks.filter((c: { ok: boolean }) => !c.ok);
      expect(failed.map((c: { name: string }) => c.name)).toContain(
        'stored content matches its address',
      );
    } finally {
      cleanup(dir);
    }
  });
});

/**
 * The git anchor. Everything above proves the trail is *internally* consistent,
 * which anything that can write the folder can arrange: `rechainEntries` is
 * exported, and a re-chained journal is by construction indistinguishable from
 * one that was never touched. Git is the record that doesn't live in the folder.
 *
 * Each failure case below is written so it PASSES every in-folder check — the
 * chain assertions are load-bearing, not decoration. If a test here ever failed
 * for a chain break instead of the history check, it would be proving nothing.
 */
describe('verify: git history as the outside anchor', () => {
  test('a committed trail verifies, and its history is append-only', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });
      commitAll(dir, 'work so far');
      await logEvent(author, { type: 'prompt', text: 'third prompt' });
      commitAll(dir, 'more work');

      const result = await verifyProject(paths);
      const history = historyCheck(result);
      expect(history.ok).toBe(true);
      expect(history.details.join('\n')).toContain('Append-only across 2 commit(s)');
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('editing an entry and re-chaining is caught once it is committed', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'write the whole function for me' });
      await logEvent(author, { type: 'prompt', text: 'now add error handling' });
      await logEvent(author, { type: 'prompt', text: 'and tests' });
      commitAll(dir, 'my work');

      // The attack the in-folder chain cannot see: rewrite the first entry, then
      // re-link every entry after it so the chain is valid again.
      const entries = readJournal(author);
      entries[0]!.textPreview = 'I solved this on my own';
      rewriteSegment(author, entries);
      const sha = commitAll(dir, 'tidy up the trail');

      const result = await verifyProject(paths);
      // The point of the fixture: every in-folder check is happy.
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      const history = historyCheck(result);
      expect(history.ok).toBe(false);
      const text = history.details.join('\n');
      expect(text).toContain(sha.slice(0, 10));
      expect(text).toContain('UNEXPLAINED');
      expect(text).toContain('rewrite(s) unexplained');
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('truncating entries off the end of a shard is caught once committed', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'a prompt worth hiding' });
      await logEvent(author, { type: 'prompt', text: 'another worth hiding' });
      commitAll(dir, 'my work');

      // Drop the tail: the remaining chain is still perfectly valid.
      writeSegmentLines(author, segmentLines(author).slice(0, 1));
      const sha = commitAll(dir, 'clean up');

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      const history = historyCheck(result);
      expect(history.ok).toBe(false);
      expect(history.details.join('\n')).toContain(sha.slice(0, 10));
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a rewrite is caught in the working tree, before it is ever committed', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });
      commitAll(dir, 'my work');

      const entries = readJournal(author);
      entries[0]!.textPreview = 'a prompt I never sent';
      rewriteSegment(author, entries);

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      const history = historyCheck(result);
      expect(history.ok).toBe(false);
      expect(history.details.join('\n')).toContain('uncommitted');
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a recorded redaction pass explains the rewrite it causes', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      // A token the write-time rules genuinely miss (see redactCommand.test.ts),
      // so there is something left for an after-the-fact pass to remove.
      await logEvent(author, {
        type: 'prompt',
        text: 'deploy with dop_v1_2b1c9f8e7d6a5b4c3d2e1f0a9b8c7d6e',
      });
      commitAll(dir, 'my work');

      const pass = redactTrail(paths, {
        mode: 'pattern',
        pattern: 'dop_v1_[0-9a-f]{32}',
        dryRun: false,
      });
      expect(pass.values).toBeGreaterThan(0);
      commitAll(dir, 'scrub a leaked key');

      const result = await verifyProject(paths);
      const history = historyCheck(result);
      const text = history.details.join('\n');
      expect(text).toContain('declared: redaction pass');
      expect(text).not.toContain('UNEXPLAINED');
      expect(history.ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('an import undo explains the rewrite it causes', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'my own prompt' });
      await logEvent(author, {
        type: 'prompt',
        text: 'imported prompt',
        batchId: 'batch-1',
      });
      await logEvent(author, { type: 'prompt', text: 'another of my own' });
      commitAll(dir, 'my work, plus an import');

      expect(removeEventsByBatch(author, 'batch-1')).toBe(1);
      commitAll(dir, 'undo that import');

      const result = await verifyProject(paths);
      const history = historyCheck(result);
      expect(history.details.join('\n')).toContain('declared: import undo');
      expect(history.ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a repair marker explains a guarded cleanup without calling it redaction', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const first = await logEvent(author, { type: 'prompt', text: 'duplicate prompt' });
      await logEvent(author, { type: 'prompt', text: 'prompt to keep' });
      commitAll(dir, 'captured work');

      expect(rewriteJournal(author, (entry) => entry.id !== first.event.id)).toBe(1);
      appendJournal(author, {
        v: 1,
        kind: 'redaction',
        id: 'red_repair_test',
        ts: '2026-09-08T20:00:00.000Z',
        type: 'redaction',
        actorSlug: author.slug,
        redaction: {
          reason: 'repair',
          entries: 1,
          values: 0,
          labels: ['duplicate-capture'],
        },
      });

      const result = await verifyProject(paths);
      const chain = checkByName(result, 'journal chain is unbroken').details.join('\n');
      const history = historyCheck(result).details.join('\n');
      expect(chain).toContain('recorded trail repair');
      expect(chain).not.toContain('recorded redaction pass');
      expect(history).toContain('declared: trail repair');
      expect(history).not.toContain('UNEXPLAINED');
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a routing reprojection explains moving captured records to the corrected project', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const misplaced = await logEvent(author, {
        type: 'prompt',
        text: 'build the other game',
      });
      await logEvent(author, { type: 'prompt', text: 'keep this game here' });
      commitAll(dir, 'captured work before routing settled');

      expect(rewriteJournal(author, (entry) => entry.id !== misplaced.event.id)).toBe(1);
      appendJournal(author, {
        v: 1,
        kind: 'redaction',
        id: 'red_routing_reprojection_test',
        ts: '2026-09-10T20:00:00.000Z',
        type: 'redaction',
        actorSlug: author.slug,
        redaction: {
          reason: 'routing-reprojection',
          entries: 1,
          values: 0,
          labels: [],
          batch: 'segment-test',
        },
      });

      const result = await verifyProject(paths);
      const chain = checkByName(result, 'journal chain is unbroken').details.join('\n');
      const history = historyCheck(result).details.join('\n');
      expect(chain).toContain('recorded routing reprojection');
      expect(chain).not.toContain('recorded batch undo');
      expect(chain).not.toContain('recorded redaction pass');
      expect(history).toContain('declared: routing reprojection');
      expect(history).not.toContain('UNEXPLAINED');
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('one marker does not excuse two rewrites', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'my own prompt' });
      await logEvent(author, {
        type: 'prompt',
        text: 'imported prompt',
        batchId: 'batch-1',
      });
      commitAll(dir, 'my work');

      // A genuine, declared rewrite first — so a marker really is in the journal.
      expect(removeEventsByBatch(author, 'batch-1')).toBe(1);
      commitAll(dir, 'undo that import');

      // Then an undeclared one. The marker above must not launder it.
      const entries = readJournal(author);
      entries[0]!.textPreview = 'a much better prompt';
      rewriteSegment(author, entries);
      const sha = commitAll(dir, 'tidy up');

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      const history = historyCheck(result);
      expect(history.ok).toBe(false);
      expect(history.details.join('\n')).toContain(`${sha.slice(0, 10)}`);
      expect(history.details.join('\n')).toContain('1 of 2 rewrite(s) unexplained');
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a shallow clone is reported as unverifiable, not passed', async () => {
    const dir = makeGitProject();
    const host = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      commitAll(dir, 'my work');
      await logEvent(author, { type: 'prompt', text: 'second prompt' });
      commitAll(dir, 'more work');

      // What `actions/checkout` does by default: a depth-1 clone, in which the
      // journal's history is simply absent.
      const clone = join(host, 'submission');
      // A `file://` URL, not a plain path: git ignores --depth for a local-path
      // clone. `pathToFileURL` gets the spelling right on Windows too.
      const url = pathToFileURL(realpathSync(dir)).href;
      git(host, 'clone', '-q', '--depth', '1', url, clone);
      expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true');

      const result = await verifyProject(pathsForRoot(clone));
      const history = historyCheck(result);
      const text = history.details.join('\n');
      expect(text).toContain('NOT VERIFIED');
      expect(text).toContain('shallow clone');
      expect(text).toContain('fetch-depth: 0');
      // Not a failure — a shallow checkout is the grader's config, not the
      // student's doing — but it must never read as "history verified".
      expect(text).not.toContain('Append-only across');
      expect(history.ok).toBe(true);
      // And say so in a field, not only in prose. `details` is human text that
      // consumers are told not to parse, so without this a tool built on
      // `verify --json` cannot tell "checked and clean" from "checked nothing".
      expect(history.skipped).toBe('shallow-clone');
    } finally {
      cleanup(host);
      cleanup(dir);
    }
  });

  test('a verified-clean history carries no `skipped` marker', async () => {
    // The other side of the test above: when the check really did read git
    // history and found it append-only, `skipped` must be absent — otherwise the
    // field would be useless for telling the two apart.
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'a prompt' });
      commitAll(dir, 'my work');

      const history = historyCheck(await verifyProject(pathsForRoot(dir)));
      expect(history.ok).toBe(true);
      expect(history.details.join('\n')).toContain('Append-only across');
      expect(history.skipped).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  test('a trail with no git repo is informational and still passes', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      await logEvent(authorFor(paths), { type: 'prompt', text: 'first prompt' });

      const result = await verifyProject(paths);
      const history = historyCheck(result);
      expect(history.ok).toBe(true);
      expect(history.details.join('\n')).toContain('not in a git repository');
      expect(history.skipped).toBe('no-git');
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('an uncommitted trail in a git repo is informational, not a failure', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      await logEvent(authorFor(paths), { type: 'prompt', text: 'first prompt' });
      // The student committed their code but not the trail — the common case
      // this check exists to nudge, and the one it must not punish.
      writeFileSync(join(dir, '.gitignore'), '.showtail/\n');
      writeFileSync(join(dir, 'README.md'), '# Project');
      commitAll(dir, 'code only — .showtail/ left out');

      const result = await verifyProject(paths);
      const history = historyCheck(result);
      // A `.showtail/` rule doesn't merely leave the trail uncommitted, it makes
      // it uncommittable — so say that, and name the rule, rather than nudging
      // toward a `git add` that would silently do nothing.
      const text = history.details.join('\n');
      expect(text).toContain('IGNORING');
      expect(text).toContain('.gitignore: .showtail/');
      expect(text).toContain('cannot be verified by anyone');
      expect(history.skipped).toBe('journal-ignored');
      expect(history.ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('a project *.log rule must not silently swallow the journal', () => {
  // Journal segments are named `journal/<machine>/0001.log`, and the Node,
  // Python and Java .gitignore templates all ship a `*.log` line. Before the
  // trail's own .gitignore negated it, that combination committed a trail with
  // its config and object store but NO journal — so the educator received a
  // trail containing none of the student's prompts, and the git-history check
  // had nothing to read. Showtail's own repo has such a rule.

  test('the journal is committable in a project that ignores *.log', async () => {
    const dir = makeGitProject();
    try {
      writeFileSync(join(dir, '.gitignore'), '*.log\n');
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      await logEvent(authorFor(paths), { type: 'prompt', text: 'a prompt' });

      const segments = journalSegmentPaths(authorPaths(paths, authorSlugs(paths)[0]!));
      expect(segments.length).toBeGreaterThan(0);
      // git must not be ignoring them, and `git add -A` must actually track them.
      expect(await gitIgnoredPaths(dir, segments)).toEqual([]);
      commitAll(dir, 'work + trail');
      const tracked = git(dir, 'ls-files', '.showtail');
      expect(tracked).toContain('journal');

      // And with the journal genuinely in git, the anchor verifies for real
      // rather than reporting that it had nothing to read.
      const history = historyCheck(await verifyProject(pathsForRoot(dir)));
      expect(history.skipped).toBeUndefined();
      expect(history.details.join('\n')).toContain('Append-only across');
    } finally {
      cleanup(dir);
    }
  });

  test('an already-ignored journal is diagnosed, not reported as uncommitted', async () => {
    // A trail created before the negation existed: `verify` must name the ignore
    // rule. "Not committed yet" would send someone hunting for a missing
    // `git add` instead of the rule that is actually blocking it.
    const dir = makeGitProject();
    try {
      writeFileSync(join(dir, '.gitignore'), '*.log\n');
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      // Undo the repair to recreate the old on-disk state.
      writeFileSync(join(paths.base, '.gitignore'), 'state.json\nreports/\ndiag/\n');
      await logEvent(authorFor(paths), { type: 'prompt', text: 'a prompt' });
      commitAll(dir, 'work + trail');

      const history = historyCheck(await verifyProject(pathsForRoot(dir)));
      expect(history.skipped).toBe('journal-ignored');
      const text = history.details.join('\n');
      expect(text).toContain('IGNORING');
      expect(text).toContain('.gitignore: *.log');
      expect(text).toContain('showtail track .');
      // Still not a failure: the student did nothing wrong.
      expect(history.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('`showtail track .` repairs a trail whose journal is ignored', async () => {
    const dir = makeGitProject();
    try {
      writeFileSync(join(dir, '.gitignore'), '*.log\n');
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      writeFileSync(join(paths.base, '.gitignore'), 'state.json\nreports/\ndiag/\n');
      await logEvent(authorFor(paths), { type: 'prompt', text: 'a prompt' });
      const segments = journalSegmentPaths(authorPaths(paths, authorSlugs(paths)[0]!));
      expect((await gitIgnoredPaths(dir, segments)).length).toBeGreaterThan(0);

      await runInit({ cwd: dir }); // re-running is the repair path
      expect(await gitIgnoredPaths(dir, segments)).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
