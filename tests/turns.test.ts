import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData, renderHtml } from '../src/core/report.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('turns', () => {
  test('groups a prompt with its AI output and code change by turnId', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);

      const { event: prompt } = await logEvent(paths, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      await logEvent(paths, {
        type: 'ai_output',
        text: 'Here is a hello function.',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      writeFileSync(join(dir, 'hello.ts'), 'export const hello = () => "hi";');
      await addArtifact(paths, {
        filePath: 'hello.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        diff: '+ export const hello = () => "hi";',
      });

      const data = buildReportData(paths);
      expect(data.turns).toHaveLength(1);
      const turn = data.turns[0]!;
      expect(turn.prompt.text).toBe('add a hello function');
      expect(turn.aiOutputs).toHaveLength(1);
      expect(turn.codeChanges).toHaveLength(1);
      expect(turn.codeChanges[0]!.diff).toContain('export const hello');
    } finally {
      cleanup(dir);
    }
  });

  test('falls back to timestamp adjacency when turnId is absent', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);

      await logEvent(paths, { type: 'prompt', text: 'first prompt', tool: 'chatgpt' });
      await logEvent(paths, {
        type: 'ai_output',
        text: 'an answer with no turn id',
        tool: 'chatgpt',
      });

      const data = buildReportData(paths);
      expect(data.turns).toHaveLength(1);
      expect(data.turns[0]!.aiOutputs).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('renders collapsible <details> cards with diff coloring and no <script>', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);
      const { event: prompt } = await logEvent(paths, {
        type: 'prompt',
        text: 'write a test',
        tool: 'claude-code',
      });
      writeFileSync(join(dir, 'a.ts'), 'const a = 1;');
      await addArtifact(paths, {
        filePath: 'a.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        diff: '- old line\n+ new line',
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).toContain('<details class="turn">');
      expect(html).toContain('class="badge"');
      expect(html).toContain('class="add"');
      expect(html).toContain('class="del"');
      expect(html).not.toContain('<script>');
    } finally {
      cleanup(dir);
    }
  });
});
