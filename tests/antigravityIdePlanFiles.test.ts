import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityIdePlanFiles } from '../src/core/antigravityIdeTranscript.ts';
import { antigravityIdePlugin } from '../src/plugins/antigravity-ide.ts';

const tempDirs: string[] = [];
const prevHome = process.env.ANTIGRAVITY_HOME;

/** Point antigravityIdeBrainDir() at a fresh temp home and return it. */
function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'st-agy-ide-plan-'));
  tempDirs.push(home);
  process.env.ANTIGRAVITY_HOME = home;
  return home;
}

/** Seed `<home>/antigravity-ide/brain/<sid>/implementation_plan.md` with `content`. */
function seedPlan(home: string, sid: string, content: string): string {
  const dir = join(home, 'antigravity-ide', 'brain', sid);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'implementation_plan.md');
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

describe('antigravityIdePlanFiles', () => {
  test('returns the seeded implementation_plan.md for the given session id', () => {
    const home = useTempHome();
    const sid = 'convo-ide-123';
    const file = seedPlan(home, sid, '# Implementation Plan\n- step');

    const result = antigravityIdePlanFiles(sid);

    expect(result).toHaveLength(1);
    const plan = result[0]!;
    expect(plan.content).toContain('step');
    expect(plan.sourceId).toBe(`agy-plan:${sid}`);
    expect(plan.nativeSessionId).toBe(sid);
    expect(plan.absPath).toBe(file);
    expect(plan.absPath.endsWith('implementation_plan.md')).toBe(true);
  });

  test('returns [] when no implementation_plan.md exists for that session id', () => {
    useTempHome(); // brain dir home exists but no plan for this sid
    expect(antigravityIdePlanFiles('no-such-convo')).toEqual([]);
  });

  test('returns [] for an empty / whitespace-only plan file', () => {
    const home = useTempHome();
    seedPlan(home, 'blank', '   \n\t  \n');
    expect(antigravityIdePlanFiles('blank')).toEqual([]);
  });

  test('returns [] for undefined session id when no brain dirs exist', () => {
    useTempHome(); // empty home — no antigravity-ide/brain at all
    expect(antigravityIdePlanFiles(undefined)).toEqual([]);
  });

  test('the plugin hook adapter resolves the session id from the payload', () => {
    const home = useTempHome();
    const sid = 'convo-via-plugin';
    seedPlan(home, sid, '# Implementation Plan\n- via plugin');
    const planFiles = antigravityIdePlugin.connect!.hooks!.planFiles!;
    const result = planFiles({ session_id: sid }, home);
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceId).toBe(`agy-plan:${sid}`);
    expect(result[0]!.content).toContain('via plugin');
  });
});
