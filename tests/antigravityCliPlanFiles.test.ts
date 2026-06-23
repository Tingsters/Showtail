import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityCliPlanFiles } from '../src/core/antigravityCliTranscript.ts';
import { antigravityCliPlugin } from '../src/plugins/antigravity-cli.ts';

const tempDirs: string[] = [];
const prevHome = process.env.ANTIGRAVITY_HOME;

/** Point antigravityCliBrainDir() at a fresh temp home and return it. */
function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'st-agy-plan-'));
  tempDirs.push(home);
  process.env.ANTIGRAVITY_HOME = home;
  return home;
}

/** Seed `<home>/antigravity-cli/brain/<sid>/plan.md` with `content`. */
function seedPlan(home: string, sid: string, content: string): string {
  const dir = join(home, 'antigravity-cli', 'brain', sid);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'plan.md');
  writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (prevHome === undefined) delete process.env.ANTIGRAVITY_HOME;
  else process.env.ANTIGRAVITY_HOME = prevHome;
});

describe('antigravityCliPlanFiles', () => {
  test('returns the seeded plan.md for the given session id', () => {
    const home = useTempHome();
    const sid = 'convo-123';
    const file = seedPlan(home, sid, '# Plan\n- step');

    const result = antigravityCliPlanFiles(sid);

    expect(result).toHaveLength(1);
    const plan = result[0]!;
    expect(plan.content).toContain('step');
    expect(plan.sourceId).toBe(`agy-plan:${sid}`);
    expect(plan.nativeSessionId).toBe(sid);
    expect(plan.absPath).toBe(file);
    expect(plan.absPath.endsWith('plan.md')).toBe(true);
  });

  test('returns [] when no plan.md exists for that session id', () => {
    useTempHome(); // brain dir exists but no plan for this sid
    expect(antigravityCliPlanFiles('no-such-convo')).toEqual([]);
  });

  test('returns [] for an empty / whitespace-only plan.md', () => {
    const home = useTempHome();
    seedPlan(home, 'blank', '   \n\t  \n');
    expect(antigravityCliPlanFiles('blank')).toEqual([]);
  });

  test('returns [] for undefined session id when no brain dirs exist', () => {
    useTempHome(); // empty home — no antigravity-cli/brain at all
    expect(antigravityCliPlanFiles(undefined)).toEqual([]);
  });

  test('the plugin hook adapter resolves the session id from the payload', () => {
    const home = useTempHome();
    const sid = 'convo-via-plugin';
    seedPlan(home, sid, '# Plan\n- via plugin');
    const planFiles = antigravityCliPlugin.connect!.hooks!.planFiles!;
    const result = planFiles({ conversationId: sid }, home);
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceId).toBe(`agy-plan:${sid}`);
    expect(result[0]!.content).toContain('via plugin');
  });
});
