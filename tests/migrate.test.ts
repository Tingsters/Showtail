import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { readAllConversationEventsWithSession } from '../src/core/conversationEvents.ts';
import { readEnrichments } from '../src/core/enrichments.ts';
import {
  latestBatchId,
  logEvent,
  readSessionEvents,
  removeJournalBatch,
} from '../src/core/events.ts';
import { readJournal } from '../src/core/journal.ts';
import { migrateProject } from '../src/core/migration.ts';
import { sessionForNativeSession } from '../src/core/sessions.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { authorFor, cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
});

function claudeTranscript(root: string, sessionId: string, start: number): string {
  const at = (offset: number) => new Date(start + offset).toISOString();
  return [
    {
      type: 'user',
      uuid: 'legacy-user-1',
      timestamp: at(1_000),
      cwd: root,
      sessionId,
      promptSource: 'typed',
      message: { role: 'user', content: 'Run the legacy demo.' },
    },
    {
      type: 'assistant',
      uuid: 'legacy-assistant-1',
      timestamp: at(2_000),
      cwd: root,
      sessionId,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'I will run it now.' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'legacy-assistant-2',
      timestamp: at(3_000),
      cwd: root,
      sessionId,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            id: 'legacy-bash-1',
            name: 'Bash',
            input: { command: 'python3 demo.py' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'legacy-result-1',
      timestamp: at(4_000),
      cwd: root,
      sessionId,
      toolUseResult: { stdout: 'ok\n', stderr: '', exitCode: 0 },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'legacy-bash-1', content: 'ok\n' }],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

describe('append-only transcript migration', () => {
  test('enriches a legacy session without rewriting or duplicating its events', async () => {
    const dir = makeTempDir();
    const claudeHome = makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const nativeId = 'legacy-native-session';
      const session = sessionForNativeSession(author, nativeId, { tool: 'claude-code' });
      const start = Date.parse(session.startedAt);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'Run the legacy demo.',
        tool: 'claude-code',
        timestamp: new Date(start + 1_000).toISOString(),
        sessionId: session.id,
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'I will run it now.',
        tool: 'claude-code',
        timestamp: new Date(start + 2_000).toISOString(),
        sessionId: session.id,
      });
      const originalPrompt = readJournal(author).find((entry) => entry.id === prompt.id)!;
      const originalBytes = JSON.stringify(originalPrompt);

      const transcriptDir = join(claudeHome, 'projects', 'legacy');
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, `${nativeId}.jsonl`),
        claudeTranscript(dir, nativeId, start) + '\n',
      );

      const result = await migrateProject(author);
      expect(
        result.sessions.find((row) => row.showtailSessionId === session.id)?.status,
      ).toBe('migrated');
      expect(result.batchId).toMatch(/^mig_/);
      const events = readSessionEvents(author, session.id);
      expect(events.filter((event) => event.type === 'prompt')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'ai_output')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
      expect(events.find((event) => event.type === 'ai_output')?.model).toBe(
        'claude-sonnet-5',
      );
      expect(
        readAllConversationEventsWithSession(paths).some(
          (row) => row.event.type === 'tool_result' && row.event.exitCode === 0,
        ),
      ).toBe(true);
      expect(readEnrichments(author)).toHaveLength(1);
      expect(latestBatchId(author)).toBeUndefined();
      expect((await verifyProject(paths)).ok).toBe(true);
      expect(
        JSON.stringify(readJournal(author).find((entry) => entry.id === prompt.id)),
      ).toBe(originalBytes);

      const rerun = await migrateProject(author);
      expect(
        rerun.sessions.find((row) => row.showtailSessionId === session.id)?.status,
      ).toBe('unchanged');
      expect(
        readSessionEvents(author, session.id).filter((e) => e.type === 'tool_call'),
      ).toHaveLength(1);

      const removed = removeJournalBatch(author, result.batchId!, 'migration-undo');
      expect(removed).toBeGreaterThan(0);
      expect(
        readSessionEvents(author, session.id).filter((e) => e.type === 'tool_call'),
      ).toHaveLength(0);
      expect(readEnrichments(author)).toHaveLength(0);
      expect((await verifyProject(paths)).ok).toBe(true);
      expect(readFileSync(join(transcriptDir, `${nativeId}.jsonl`), 'utf8')).toContain(
        'legacy-bash-1',
      );
    } finally {
      cleanup(dir);
      cleanup(claudeHome);
    }
  });

  test('dry-run reports recoverable detail without writing a batch', async () => {
    const dir = makeTempDir();
    const claudeHome = makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const nativeId = 'dry-run-native';
      const session = sessionForNativeSession(author, nativeId, { tool: 'claude-code' });
      const start = Date.parse(session.startedAt);
      await logEvent(author, {
        type: 'prompt',
        text: 'Run the legacy demo.',
        tool: 'claude-code',
        timestamp: new Date(start + 1_000).toISOString(),
        sessionId: session.id,
      });
      const transcriptDir = join(claudeHome, 'projects', 'dry');
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, `${nativeId}.jsonl`),
        claudeTranscript(dir, nativeId, start),
      );
      const before = readJournal(author).length;
      const result = await migrateProject(author, { dryRun: true });
      expect(result.batchId).toBeNull();
      expect(result.sessions[0]?.status).toBe('planned');
      expect(readJournal(author)).toHaveLength(before);
    } finally {
      cleanup(dir);
      cleanup(claudeHome);
    }
  });

  test('CLI migrates and undoes a provider batch in JSON mode', async () => {
    const dir = makeTempDir();
    const claudeHome = makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const nativeId = 'cli-native';
      const session = sessionForNativeSession(author, nativeId, { tool: 'claude-code' });
      const start = Date.parse(session.startedAt);
      await logEvent(author, {
        type: 'prompt',
        text: 'Run the legacy demo.',
        tool: 'claude-code',
        timestamp: new Date(start + 1_000).toISOString(),
        sessionId: session.id,
      });
      const transcriptDir = join(claudeHome, 'projects', 'cli');
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, `${nativeId}.jsonl`),
        claudeTranscript(dir, nativeId, start),
      );
      const env = { ...spawnEnv(), CLAUDE_CONFIG_DIR: claudeHome };
      const migrated = runCli(dir, ['migrate', 'claude', '--yes', '--json'], { env });
      expect(migrated.code).toBe(0);
      const output = JSON.parse(migrated.stdout);
      expect(
        output.sessions.some((row: { status: string }) => row.status === 'migrated'),
      ).toBe(true);
      expect(output.batchId).toMatch(/^mig_/);

      const undone = runCli(dir, ['migrate', 'undo', '--yes', '--json'], { env });
      expect(undone.code).toBe(0);
      expect(JSON.parse(undone.stdout)).toMatchObject({ batchId: output.batchId });
      expect(JSON.parse(undone.stdout).removed).toBeGreaterThan(0);
    } finally {
      cleanup(dir);
      cleanup(claudeHome);
    }
  });
});
