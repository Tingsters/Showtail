import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { appendLedgerRecord, ensureLedgerSession } from '../src/core/ledger.ts';
import { materializeLedgerSession } from '../src/core/materialize.ts';
import { PLAN_APPROVED_TAG } from '../src/core/plans.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
});

describe('materialize: projecting every record kind', () => {
  test('projects prompt, ai_output, decision, plan, diff-edit and snapshot-edit, idempotently', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's1',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'do the work',
      });
      appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'claude-code',
        text: 'sure, here it is',
        turnKey: p.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'decision',
        tool: 'claude-code',
        text: 'chose option A',
        turnKey: p.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'plan',
        tool: 'claude-code',
        text: 'the approved plan',
        approved: true,
        turnKey: p.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'a.ts'),
        diff: '+ const a = 1;',
        turnKey: p.id,
      });
      // A no-diff edit whose file is present at the root → live snapshot path.
      writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'b.ts'),
        turnKey: p.id,
      });

      const r1 = await materializeLedgerSession(session, author);
      expect(r1.projected).toBe(6);

      const events = readAllEvents(paths);
      const prompt = events.find((e) => e.type === 'prompt')!;
      const ai = events.find((e) => e.type === 'ai_output')!;
      const decision = events.find((e) => e.type === 'decision')!;
      const plan = events.find((e) => e.type === 'plan')!;
      expect(prompt.text).toBe('do the work');
      expect(ai.text).toBe('sure, here it is');
      // Replies/decisions/plans re-link to their prompt's turn.
      expect(ai.turnId).toBe(prompt.id);
      expect(decision.turnId).toBe(prompt.id);
      expect(plan.turnId).toBe(prompt.id);
      expect(plan.tags).toContain(PLAN_APPROVED_TAG);

      const arts = readAllArtifacts(paths);
      expect(arts.some((a) => a.path === 'a.ts' && a.diffHash)).toBe(true);
      expect(arts.some((a) => a.path === 'b.ts' && a.sha256)).toBe(true);

      // Re-materialize: every record dedups, nothing new is projected.
      const r2 = await materializeLedgerSession(session, author);
      expect(r2.projected).toBe(0);
      expect(readAllEvents(paths).filter((e) => e.type === 'ai_output').length).toBe(1);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('a plan with an on-disk plan file links the materialized file, not the text', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'antigravity-cli',
        nativeSessionId: 'agy1',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'antigravity-cli',
        text: 'plan it',
      });
      appendLedgerRecord(session.id, {
        kind: 'plan',
        tool: 'antigravity-cli',
        text: 'transcript plan summary',
        planFileContent: 'FULL PLAN from disk',
        planFileSourceId: 'agy-plan:agy1',
        turnKey: p.id,
      });
      await materializeLedgerSession(session, author);

      const plan = readAllEvents(paths).find((e) => e.type === 'plan')!;
      expect(plan.planPath).toBe('plans/agy-plan_agy1.md');
      const file = join(dir, '.showtail', plan.planPath!);
      expect(readFileSync(file, 'utf8')).toContain('FULL PLAN from disk');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('a revised plan projects with the revised tag', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's2',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'plan it',
      });
      appendLedgerRecord(session.id, {
        kind: 'plan',
        tool: 'claude-code',
        text: 'a rejected plan',
        approved: false,
        turnKey: p.id,
      });
      await materializeLedgerSession(session, author);
      const plan = readAllEvents(paths).find((e) => e.type === 'plan')!;
      expect(plan.tags?.length).toBeGreaterThan(0);
      expect(plan.tags).not.toContain(PLAN_APPROVED_TAG);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
