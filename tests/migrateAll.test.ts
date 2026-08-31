import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBulkMigration } from '../src/commands/migrateAll.ts';
import { runInit } from '../src/commands/init.ts';
import { logEvent, readSessionEvents } from '../src/core/events.ts';
import { sessionForNativeSession } from '../src/core/sessions.ts';
import { pathsForRoot, readSessions } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
const previousShowtailHome = process.env.SHOWTAIL_HOME;

afterEach(() => {
  if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
  if (previousShowtailHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = previousShowtailHome;
});

function transcript(root: string, sessionId: string, start: number): string {
  const at = (offset: number) => new Date(start + offset).toISOString();
  return [
    {
      type: 'user',
      uuid: `${sessionId}-user`,
      timestamp: at(1_000),
      cwd: root,
      sessionId,
      promptSource: 'typed',
      message: { role: 'user', content: `Run ${sessionId}.` },
    },
    {
      type: 'assistant',
      uuid: `${sessionId}-tool`,
      timestamp: at(2_000),
      cwd: root,
      sessionId,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            id: `${sessionId}-bash`,
            name: 'Bash',
            input: { command: 'true' },
          },
        ],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

describe('bulk migration', () => {
  test('scans home and migrates every eligible project independently', async () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    process.env.SHOWTAIL_HOME = globalHome;
    try {
      const roots = [join(home, 'projects', 'one'), join(home, 'projects', 'two')];
      for (let i = 0; i < roots.length; i += 1) {
        const root = roots[i]!;
        mkdirSync(root, { recursive: true });
        await runInit({ cwd: root });
        const author = authorFor(pathsForRoot(root));
        const nativeId = `bulk-${i + 1}`;
        const session = sessionForNativeSession(author, nativeId, {
          tool: 'claude-code',
        });
        const start = Date.parse(session.startedAt);
        await logEvent(author, {
          type: 'prompt',
          text: `Run ${nativeId}.`,
          tool: 'claude-code',
          timestamp: new Date(start + 1_000).toISOString(),
          sessionId: session.id,
        });
        const transcriptDir = join(
          process.env.CLAUDE_CONFIG_DIR!,
          'projects',
          `project-${i + 1}`,
        );
        mkdirSync(transcriptDir, { recursive: true });
        writeFileSync(
          join(transcriptDir, `${nativeId}.jsonl`),
          transcript(root, nativeId, start),
        );
      }

      const result = await runBulkMigration({ home, yes: true });
      expect(result.status).toBe('completed');
      expect(
        result.projects.filter((project) => project.status === 'migrated'),
      ).toHaveLength(2);
      for (const root of roots) {
        const author = authorFor(pathsForRoot(root));
        const sessionId = readSessions(author)[0]!.id;
        expect(
          readSessionEvents(author, sessionId).some(
            (event) => event.type === 'tool_call',
          ),
        ).toBe(true);
      }
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });
});
