/**
 * `showtail redact` — the after-the-fact recovery path for a secret the
 * write-time scrubber missed.
 *
 * The interesting property under test is not "the string is gone" but the pair
 * of guarantees around it: a recorded pass must leave a trail that still
 * verifies, *and* it must not become a way to launder an ordinary hand edit. The
 * last test in this file is the one that matters — it pins the marker as a
 * disclosure, never an excuse.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { redactTrail, runRedact } from '../src/commands/redact.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { logEvent } from '../src/core/events.ts';
import { readJournal } from '../src/core/journal.ts';
import { objectExists } from '../src/core/objects.ts';
import {
  pathsForRoot,
  readConfig,
  writeConfig,
  type AuthorPaths,
  type ShowtailPaths,
} from '../src/core/storage.ts';
import type { JournalEntry } from '../src/types.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/**
 * A credential the curated rule library genuinely does not know: a DigitalOcean
 * personal access token, pasted as bare prose so no `token:`/`key=` assignment
 * rule catches it either. This is the exact failure the command exists for.
 */
const LEAKED = 'dop_v1_2b1c9f8e7d6a5b4c3d2e1f0a9b8c7d6e';
const LEAK_PATTERN = 'dop_v1_[0-9a-f]{32}';

/** Every file under a directory, as `relative path -> contents`. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(dir, full), readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/** Whether any file in the object store still contains `needle`. */
function storeContains(paths: ShowtailPaths, needle: string): boolean {
  for (const [, content] of snapshot(paths.objectsDir)) {
    if (content.includes(needle)) return true;
  }
  return false;
}

/** The `redaction` marker entries in one author's journal. */
function markers(author: AuthorPaths): JournalEntry[] {
  return readJournal(author).filter((e) => e.kind === 'redaction');
}

/** Path to an author's first journal segment. */
function journalSegment(author: AuthorPaths): string {
  return join(author.journalDir, author.machineId!, '0001.log');
}

function segmentLines(author: AuthorPaths): string[] {
  return readFileSync(journalSegment(author), 'utf8').trimEnd().split('\n');
}

function checkByName(result: Awaited<ReturnType<typeof verifyProject>>, name: string) {
  return result.checks.find((c) => c.name === name)!;
}

describe('showtail redact --pattern', () => {
  test('scrubs a leaked value from a stored object and deletes the old object', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'set up my droplet' });
      await logEvent(author, {
        type: 'prompt',
        text: `deploy this for me, my access is ${LEAKED} thanks`,
      });

      // Precondition: the write-time rules missed it, so it really is on disk.
      const leakedEntry = readJournal(author).find((e) =>
        e.textPreview?.includes(LEAKED),
      )!;
      const oldRef = leakedEntry.refs![0]!;
      expect(storeContains(paths, LEAKED)).toBe(true);
      expect(leakedEntry.redacted).toBeUndefined();

      const pass = redactTrail(paths, {
        mode: 'pattern',
        pattern: LEAK_PATTERN,
        dryRun: false,
      });
      expect(pass.values).toBe(1);
      expect(pass.objects).toBe(1);
      expect(pass.entries).toBe(1);
      expect(pass.labels).toEqual(['pattern']);

      // The value is gone from every stored object, and the address it used to
      // live at is gone with it — not merely unreferenced.
      expect(storeContains(paths, LEAKED)).toBe(false);
      expect(objectExists(paths, oldRef)).toBe(false);

      // The entry now points at the cleaned content and says so.
      const rewritten = readJournal(author).find((e) => e.id === leakedEntry.id)!;
      expect(rewritten.refs![0]).not.toBe(oldRef);
      expect(rewritten.textPreview).toContain('‹redacted: pattern›');
      expect(rewritten.textPreview).not.toContain(LEAKED);
      expect(rewritten.redacted).toBe(1);
      // The untouched entry keeps its original address (nothing else churned).
      expect(readJournal(author)[0]!.refs).toEqual(
        readJournal(author).filter((e) => e.kind !== 'redaction')[0]!.refs,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('the journal re-chains, so verify still passes afterwards', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first' });
      await logEvent(author, { type: 'prompt', text: `here it is: ${LEAKED}` });
      await logEvent(author, { type: 'prompt', text: 'third' });
      await logEvent(author, { type: 'ai_output', text: 'done' });

      redactTrail(paths, { mode: 'pattern', pattern: LEAK_PATTERN, dryRun: false });

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      expect(checkByName(result, 'stored content matches its address').ok).toBe(true);
      expect(checkByName(result, 'journal entries are valid').ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('--pattern is a preview until --yes: a dry run writes nothing at all', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: `ship it with ${LEAKED}` });

      const before = snapshot(paths.base);
      // No `--yes`: the CLI path must default to a preview even though the
      // caller asked for a real pattern.
      await runRedact({ cwd: dir, pattern: LEAK_PATTERN });
      const after = snapshot(paths.base);

      expect([...after.keys()]).toEqual([...before.keys()]);
      for (const [file, content] of before) expect(after.get(file)).toBe(content);
      expect(storeContains(paths, LEAKED)).toBe(true);
      expect(markers(author).length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('the pass is recorded as a marker and surfaces in verify', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: `use ${LEAKED} to deploy` });

      const pass = redactTrail(paths, {
        mode: 'pattern',
        pattern: LEAK_PATTERN,
        dryRun: false,
      });

      const recorded = markers(author);
      expect(recorded.length).toBe(1);
      expect(recorded[0]!.id).toBe(pass.markerId!);
      expect(recorded[0]!.redaction).toEqual({
        reason: 'redact',
        mode: 'pattern',
        entries: 1,
        values: 1,
        labels: ['pattern'],
        objects: 1,
      });

      // A marker that carried the removed value — or the pattern used to find
      // it — would hand the secret straight back to the reader.
      const raw = readFileSync(journalSegment(author), 'utf8');
      expect(raw).not.toContain(LEAKED);
      expect(raw).not.toContain(LEAK_PATTERN);

      const result = await verifyProject(paths);
      const chain = checkByName(result, 'journal chain is unbroken');
      expect(chain.ok).toBe(true);
      expect(chain.details.join('\n')).toContain('chain intact');
      expect(chain.details.join('\n')).toContain('1 recorded redaction pass');
      expect(result.ok).toBe(true);

      // The marker is a journal line, not an event: it must not leak into the
      // report as a phantom prompt.
      const events = readJournal(author).filter((e) => e.kind !== 'redaction');
      expect(events.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });
});

describe('showtail redact --rescan', () => {
  test('picks up a settings.redact.custom pattern added after capture', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const internal = 'ACME-STUDENT-88213';
      await logEvent(author, { type: 'prompt', text: `look up ${internal} for me` });
      expect(storeContains(paths, internal)).toBe(true);

      // The student (or their school) adds the rule only after the fact.
      const config = readConfig(paths);
      config.settings.redact = { custom: ['ACME-STUDENT-\\d{5}'] };
      writeConfig(paths, config);

      const pass = redactTrail(paths, { mode: 'rescan', dryRun: false });
      expect(pass.values).toBe(1);
      expect(pass.labels).toEqual(['custom']);
      expect(storeContains(paths, internal)).toBe(false);

      const entry = readJournal(author).find((e) => e.kind !== 'redaction')!;
      expect(entry.textPreview).toContain('‹redacted: custom›');
      expect((await verifyProject(paths)).ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a rescan of an already-clean trail changes nothing and records nothing', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      await logEvent(authorFor(paths), {
        type: 'prompt',
        text: 'a perfectly ordinary ask',
      });

      const before = snapshot(paths.base);
      const pass = redactTrail(paths, { mode: 'rescan', dryRun: false });
      expect(pass.values).toBe(0);
      expect(pass.markerId).toBeUndefined();
      const after = snapshot(paths.base);
      for (const [file, content] of before) expect(after.get(file)).toBe(content);
      expect([...after.keys()]).toEqual([...before.keys()]);
    } finally {
      cleanup(dir);
    }
  });
});

describe('the redaction marker is a disclosure, not an excuse', () => {
  test('an unexplained journal edit is still reported as a break', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: `oops ${LEAKED}` });
      await logEvent(author, { type: 'prompt', text: 'third prompt' });

      // A genuine, recorded pass first — so a marker really is sitting in the
      // journal when the hand edit happens.
      redactTrail(paths, { mode: 'pattern', pattern: LEAK_PATTERN, dryRun: false });
      expect(markers(author).length).toBe(1);
      expect((await verifyProject(paths)).ok).toBe(true);

      // Now the thing the marker must never launder: doctoring a line by hand.
      const lines = segmentLines(author);
      const doctored = JSON.parse(lines[0]!) as Record<string, unknown>;
      doctored.textPreview = 'a much better prompt I never actually sent';
      lines[0] = JSON.stringify(doctored);
      writeFileSync(journalSegment(author), lines.join('\n') + '\n', 'utf8');

      const result = await verifyProject(paths);
      const chain = checkByName(result, 'journal chain is unbroken');
      expect(chain.ok).toBe(false);
      expect(result.ok).toBe(false);
      const text = chain.details.join('\n');
      expect(text).toContain('the journal was edited after it was written');
      // The pass is still listed, but explicitly does not account for the break.
      expect(text).toContain('1 recorded redaction pass');
      expect(text).toContain('unexplained');
    } finally {
      cleanup(dir);
    }
  });

  test('a hand-appended marker cannot cover a hand-edited line', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });
      await logEvent(author, { type: 'prompt', text: 'third prompt' });

      // The forgery: edit a line, then bolt a plausible-looking marker on the
      // end and hope `verify` reads it as "this was a redaction, it's fine".
      const lines = segmentLines(author);
      const doctored = JSON.parse(lines[1]!) as Record<string, unknown>;
      doctored.textPreview = 'the prompt I wish I had sent';
      lines[1] = JSON.stringify(doctored);
      lines.push(
        JSON.stringify({
          v: 1,
          kind: 'redaction',
          id: 'red_forged',
          ts: new Date().toISOString(),
          type: 'redaction',
          actorSlug: author.slug,
          redaction: { mode: 'pattern', entries: 1, values: 1, labels: ['pattern'] },
        }),
      );
      writeFileSync(journalSegment(author), lines.join('\n') + '\n', 'utf8');

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('redact usage', () => {
  test('rejects a run with neither --rescan nor --pattern', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      expect(runRedact({ cwd: dir })).rejects.toThrow(/--rescan|--pattern/);
    } finally {
      cleanup(dir);
    }
  });

  test('rejects an invalid --pattern regex', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      expect(runRedact({ cwd: dir, pattern: '([unclosed', yes: true })).rejects.toThrow(
        /not a valid regular expression/,
      );
      expect(existsSync(join(dir, '.showtail'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
