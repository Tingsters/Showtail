import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { runImportCodex } from '../src/commands/importCodex.ts';
import { runImportUndo } from '../src/commands/import.ts';
import { summarizeRollouts, codexSessionsDir } from '../src/core/codexTranscript.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { buildReportData, renderHtml } from '../src/core/report.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/**
 * Build a synthetic Codex rollout for `dir` (project cwd). Two prompts, one
 * reply, one apply_patch edit (absolute envelope path).
 */
function makeRollout(dir: string): string {
  const lines: unknown[] = [
    {
      timestamp: '2026-06-22T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sess-imp-1', cwd: dir },
    },
    {
      timestamp: '2026-06-22T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Add a foo function.' },
    },
    {
      timestamp: '2026-06-22T10:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'apply_patch',
        input:
          '*** Begin Patch\n*** Add File: ' +
          join(dir, 'src', 'foo.ts') +
          '\n+export const foo = () => {};\n*** End Patch\n',
      },
    },
    // Codex's update_plan tool — a plan/todo list (arguments is a JSON string).
    {
      timestamp: '2026-06-22T10:00:02.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'call_plan_imp',
        arguments: JSON.stringify({
          plan: [
            { step: 'Add the foo function', status: 'completed' },
            { step: 'Add a test', status: 'pending' },
          ],
        }),
      },
    },
    {
      timestamp: '2026-06-22T10:00:03.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Added foo.' },
    },
    {
      timestamp: '2026-06-22T10:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Now add a test.' },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('codex import (end to end via --file)', () => {
  test('imports prompts/responses/edits back-dated; dedupes; undo removes the batch', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'rollout.jsonl');
      writeFileSync(fixture, makeRollout(dir), 'utf8');

      await runImportCodex(undefined, { file: fixture, withResponses: true, cwd: dir });

      const cx = () => readAllEvents(paths).filter((e) => e.tool === 'codex');
      const cxArtifacts = () => readAllArtifacts(paths).filter((a) => a.tool === 'codex');
      const imported = cx();
      expect(imported.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(imported.filter((e) => e.type === 'ai_output').length).toBe(1);
      // The edit imports as a back-dated artifact carrying its apply_patch diff.
      const artifacts = cxArtifacts();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]!.path).toBe('src/foo.ts');
      expect(artifacts[0]!.diffHash).toBeTruthy();
      expect(artifacts[0]!.timestamp.startsWith('2026-06-22')).toBe(true);
      // The update_plan becomes a `plan` event with no approval badge (Codex is headless).
      const plans = imported.filter((e) => e.type === 'plan');
      expect(plans.length).toBe(1);
      expect(plans[0]!.tags ?? []).not.toContain('plan-approved');
      expect(plans[0]!.tags ?? []).not.toContain('plan-revised');
      expect(plans[0]!.text).toContain('Add the foo function');

      // The report renders the plan card with no approval badge (Codex is headless),
      // and renders the imported edit's diff as an expandable code change.
      const html = renderHtml(buildReportData(paths));
      const planSummary =
        /<details class="plan">\s*<summary>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? '';
      expect(planSummary).toContain('📋 Plan');
      expect(planSummary).not.toContain('Approved');
      expect(planSummary).not.toContain('Revised');
      expect(html).toContain('<details class="code">');
      expect(html).toContain('src/foo.ts'); // the file link
      expect(html).toContain('dline add'); // the +export line rendered as an added diff row
      expect(imported.every((e) => e.batchId)).toBe(true);
      expect(imported.every((e) => e.tags?.includes('imported'))).toBe(true);
      expect(imported.every((e) => e.timestamp.startsWith('2026-06-22'))).toBe(true);

      const count = imported.length;
      const artifactCount = artifacts.length;

      // Re-importing the same rollout adds nothing (events + artifacts deduped).
      await runImportCodex(undefined, { file: fixture, withResponses: true, cwd: dir });
      expect(cx().length).toBe(count);
      expect(cxArtifacts().length).toBe(artifactCount);

      // Undo removes the whole batch — events and the imported edit artifacts.
      await runImportUndo({ cwd: dir });
      expect(cx().length).toBe(0);
      expect(cxArtifacts().length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('without --with-responses, only prompts and edits are imported', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'rollout.jsonl');
      writeFileSync(fixture, makeRollout(dir), 'utf8');

      await runImportCodex(undefined, { file: fixture, cwd: dir });

      const cx = readAllEvents(paths).filter((e) => e.tool === 'codex');
      expect(cx.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(cx.filter((e) => e.type === 'ai_output').length).toBe(0);
      // The edit still imports as an artifact even without --with-responses.
      expect(readAllArtifacts(paths).filter((a) => a.tool === 'codex').length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });
});

describe('summarizeRollouts (discovery by recorded cwd)', () => {
  test('finds this project rollout under ~/.codex/sessions and tracks import state', async () => {
    const dir = makeTempDir();
    const codexHome = makeTempDir();
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      // Place the rollout where Codex would (YYYY/MM/DD), recording cwd === dir.
      const day = join(codexSessionsDir(), '2026', '06', '22');
      mkdirSync(day, { recursive: true });
      const name =
        'rollout-2026-06-22T10-00-00-019ef1c4-1899-7a90-bb9f-b09bca10e91c.jsonl';
      writeFileSync(join(day, name), makeRollout(dir), 'utf8');

      let summaries = summarizeRollouts(author);
      expect(summaries.length).toBe(1);
      const s = summaries[0]!;
      expect(s.info.sessionId).toBe('019ef1c4-1899-7a90-bb9f-b09bca10e91c');
      expect(s.promptCount).toBe(2);
      expect(s.editCount).toBe(1);
      expect(s.firstPrompt).toBe('Add a foo function.');
      expect(s.lastPrompt).toBe('Now add a test.');
      expect(s.importState).toBe('none');

      // After importing the whole session, it reads as fully imported.
      await runImportCodex(undefined, {
        file: join(day, name),
        withResponses: true,
        cwd: dir,
      });
      summaries = summarizeRollouts(author);
      expect(summaries[0]!.importState).toBe('full');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      cleanup(dir);
      cleanup(codexHome);
    }
  });
});
