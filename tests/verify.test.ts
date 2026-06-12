import { describe, expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot, sessionFile } from '../src/core/storage.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function checkByName(result: Awaited<ReturnType<typeof verifyProject>>, name: string) {
  return result.checks.find((c) => c.name === name)!;
}

describe('verify', () => {
  test('a clean project passes every check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);
      await logEvent(paths, { type: 'prompt', text: 'Help me plan the project' });
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(paths, { filePath: 'README.md' });

      const result = await verifyProject(paths);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a changed artifact fails the hash check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(paths, { filePath: 'README.md' });

      writeFileSync(join(dir, 'README.md'), '# Project (edited after snapshot)');
      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'artifact hashes match current files').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a corrupt JSONL line fails the validity check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const session = startSession(paths);
      // Write a broken line directly into the session log.
      appendFileSync(sessionFile(paths, session.id), 'this is not json\n');

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'session logs are valid JSONL').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('an event missing required fields fails the validity check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const session = startSession(paths);
      appendFileSync(
        sessionFile(paths, session.id),
        JSON.stringify({ id: 'x', type: 'banana', actor: 'student' }) + '\n',
      );

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'session logs are valid JSONL').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
