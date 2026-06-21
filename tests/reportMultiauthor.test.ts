import { describe, expect, test } from 'bun:test';
import { runInit } from '../src/commands/init.ts';
import { logEvent } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import { buildReportData, renderMarkdown } from '../src/core/report.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir, seedAuthor } from './helpers.ts';

describe('multi-author reports', () => {
  test('team report aggregates contributors; per-author report filters to one', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Group Project' });
      const paths = pathsForRoot(dir);

      // The local student (tester) plus a teammate (bob), each with their own turn.
      const tester = authorFor(paths);
      const sT = startSession(tester);
      await logEvent(tester, {
        type: 'prompt',
        text: 'tester builds the parser',
        tool: 'claude-code',
        sessionId: sT.id,
      });

      const bob = seedAuthor(paths, 'bob@school.edu');
      const sB = startSession(bob);
      await logEvent(bob, {
        type: 'prompt',
        text: 'bob writes the tests',
        tool: 'claude-code',
        sessionId: sB.id,
      });

      // --- Team report (default scope) ---
      const team = buildReportData(paths);
      expect(team.scope).toBeNull();
      expect(team.contributors.map((c) => c.slug).sort()).toEqual([
        'bob-at-school-edu',
        'tester-at-example-com',
      ]);
      expect(team.turns).toHaveLength(2);
      expect(team.summary.sessions).toBe(2);
      // Turns are attributed to their authors.
      expect(team.turns.map((t) => t.actorSlug).sort()).toEqual([
        'bob-at-school-edu',
        'tester-at-example-com',
      ]);
      const md = renderMarkdown(team);
      expect(md).toContain('## Contributors');
      expect(md).toContain('working together'); // team authorship statement

      // --- Per-author report (bob) ---
      const bobReport = buildReportData(paths, { authorSlug: 'bob-at-school-edu' });
      expect(bobReport.scope?.slug).toBe('bob-at-school-edu');
      expect(bobReport.turns).toHaveLength(1);
      expect(bobReport.turns[0]!.prompt.text).toBe('bob writes the tests');
      expect(bobReport.contributors).toHaveLength(1);
      // A single-student report omits the contributors section.
      expect(renderMarkdown(bobReport)).not.toContain('## Contributors');
    } finally {
      cleanup(dir);
    }
  });
});
