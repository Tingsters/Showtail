import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData, renderMarkdown } from '../src/core/report.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('report', () => {
  test('aggregates events and artifacts into structured data and markdown', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      startSession(paths);

      await logEvent(paths, { type: 'prompt', text: 'How do I structure this parser?' });
      await logEvent(paths, {
        type: 'decision',
        text: 'I chose the simpler regex approach.',
      });
      await logEvent(paths, {
        type: 'reflection',
        text: 'I understand the tokenizer now.',
      });
      await logEvent(paths, { type: 'source', text: 'Used class notes from week 3.' });
      await logEvent(paths, {
        type: 'test',
        text: 'Ran the edge-case suite, all green.',
      });

      writeFileSync(join(dir, 'parser.ts'), 'export const parse = () => {};');
      await addArtifact(paths, { filePath: 'parser.ts' });

      const data = buildReportData(paths);
      expect(data.project).toBe('Parser Project');
      expect(data.prompts).toHaveLength(1);
      expect(data.decisions).toHaveLength(1);
      expect(data.reflections).toHaveLength(1);
      expect(data.sources).toHaveLength(1);
      expect(data.tests).toHaveLength(1);
      expect(data.artifactsCreated).toHaveLength(1);
      expect(data.timeline.length).toBeGreaterThanOrEqual(6);
      expect(data.authorship).toContain('my own');

      const md = renderMarkdown(data);
      expect(md).toContain('# Showtail Report — Parser Project');
      expect(md).toContain('How do I structure this parser?');
      expect(md).toContain('## Authorship statement');
      expect(md).toContain('parser.ts');
    } finally {
      cleanup(dir);
    }
  });

  test('empty project still renders a valid report', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const md = renderMarkdown(buildReportData(paths));
      expect(md).toContain('# Showtail Report');
      expect(md).toContain('No activity recorded yet.');
    } finally {
      cleanup(dir);
    }
  });
});
