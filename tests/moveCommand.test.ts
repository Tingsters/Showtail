import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  cleanup,
  enableAutoInit,
  envWithHome,
  makeTempDir,
  readJsonReport,
  runCli,
} from './helpers.ts';

function userPrompt(cwd: string, prompt: string, sid = 's1'): string {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt,
    session_id: sid,
  });
}

/** `showtail move --json` (the ledger is global, so cwd is irrelevant — run from `at`). */
function moveList(at: string, env: NodeJS.ProcessEnv): any[] {
  const r = runCli(at, ['move', '--json'], { env });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout).sessions;
}

function promptTexts(dir: string, env: NodeJS.ProcessEnv): string[] {
  rmSync(join(dir, '.showtail', 'reports'), { recursive: true, force: true });
  expect(runCli(dir, ['report', '--format', 'json'], { env }).code).toBe(0);
  return readJsonReport(dir).turns.map((t: any) => t.prompt.text);
}

describe('showtail move', () => {
  test('lists every session and moves a placed one between folders', () => {
    const scratch = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repoA, 'package.json'), '{}\n');
      writeFileSync(join(repoB, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);

      // Capture a folderless session → inbox, grab its id.
      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'relocatable work'),
        env,
      });
      const id = JSON.parse(runCli(scratch, ['inbox', '--json'], { env }).stdout)
        .sessions[0].id;

      // `move <id> --to repoA` places it there.
      expect(runCli(repoA, ['move', id, '--to', repoA], { env }).code).toBe(0);
      expect(promptTexts(repoA, env)).toContain('relocatable work');

      // `move --json` lists it as PLACED in repoA (with its led_ id + path).
      const placed = moveList(repoA, env).find((s) => s.id === id);
      expect(placed).toBeTruthy();
      expect(placed.status).toBe('placed');
      expect(placed.paths.map((p: string) => resolve(p))).toContain(resolve(repoA));

      // Move it to repoB — it leaves repoA and lands in repoB.
      expect(runCli(repoB, ['move', id, '--to', repoB], { env }).code).toBe(0);
      expect(promptTexts(repoB, env)).toContain('relocatable work');
      expect(promptTexts(repoA, env)).not.toContain('relocatable work');

      // The listing now points at repoB.
      const moved = moveList(repoB, env).find((s) => s.id === id);
      expect(moved.paths.map((p: string) => resolve(p))).toContain(resolve(repoB));
    } finally {
      cleanup(scratch);
      cleanup(repoA);
      cleanup(repoB);
      cleanup(home);
    }
  });

  test('the `reattach` alias still moves a session', () => {
    const scratch = makeTempDir();
    const repo = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repo, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);

      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'via alias'),
        env,
      });
      const id = JSON.parse(runCli(scratch, ['inbox', '--json'], { env }).stdout)
        .sessions[0].id;
      expect(runCli(repo, ['reattach', id, '--to', repo], { env }).code).toBe(0);
      expect(promptTexts(repo, env)).toContain('via alias');
    } finally {
      cleanup(scratch);
      cleanup(repo);
      cleanup(home);
    }
  });
});
