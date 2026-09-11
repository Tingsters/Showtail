import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LEDGER_SEGMENTS_VERSION } from '../src/core/ledger.ts';
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

function postEdit(cwd: string, file: string, sid = 's1'): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    cwd,
    session_id: sid,
    tool_name: 'Edit',
    tool_input: { file_path: file },
  });
}

/** `showtail move --json` (the ledger is global, so cwd is irrelevant — run from `at`). */
function movePayload(
  at: string,
  env: NodeJS.ProcessEnv,
): { sessions: any[]; ranges: any[] } {
  const r = runCli(at, ['move', '--json'], { env });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

function moveList(at: string, env: NodeJS.ProcessEnv): any[] {
  return movePayload(at, env).sessions;
}

function onlyLedgerSessionId(home: string): string {
  const index = JSON.parse(readFileSync(join(home, 'ledger', 'index.json'), 'utf8')) as {
    byKey: Record<string, string>;
  };
  const sessionIds = [...new Set(Object.values(index.byKey))];
  expect(sessionIds).toHaveLength(1);
  return sessionIds[0]!;
}

function sessionIdForPrompt(at: string, env: NodeJS.ProcessEnv, prompt: string): string {
  const session = moveList(at, env).find((item) => item.firstPrompt?.includes(prompt));
  expect(session).toBeTruthy();
  return session.id;
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

      // The first prompt creates a local automatic trail; the all-session move
      // listing remains the stable way to retrieve its ledger id.
      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'relocatable work'),
        env,
      });
      const id = sessionIdForPrompt(scratch, env, 'relocatable work');

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
      const id = sessionIdForPrompt(scratch, env, 'via alias');
      expect(runCli(repo, ['reattach', id, '--to', repo], { env }).code).toBe(0);
      expect(promptTexts(repo, env)).toContain('via alias');
    } finally {
      cleanup(scratch);
      cleanup(repo);
      cleanup(home);
    }
  });

  test('keeps the aggregate sessions JSON and adds authoritative range JSON', () => {
    const scratch = makeTempDir();
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const env = envWithHome(home);
      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'json compatibility'),
        env,
      });

      const payload = movePayload(scratch, env);
      const session = payload.sessions.find((item) =>
        item.firstPrompt?.includes('json compatibility'),
      );
      expect(session).toEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^led_/),
          status: expect.any(String),
          paths: expect.any(Array),
          prompts: 1,
          edits: 0,
          firstPrompt: 'json compatibility',
        }),
      );
      expect(payload.ranges).toContainEqual(
        expect.objectContaining({
          id: expect.stringMatching(new RegExp(`^${session.id}:seg_`)),
          sessionId: session.id,
          rangeId: expect.stringMatching(/^seg_/),
          memberSegmentIds: expect.any(Array),
          status: expect.any(String),
          paths: expect.any(Array),
          prompts: 1,
          edits: 0,
          firstPrompt: 'json compatibility',
        }),
      );
    } finally {
      cleanup(scratch);
      cleanup(home);
    }
  });

  test('JSON listing derives missing and stale range sidecars without writing them', () => {
    const scratch = makeTempDir();
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const env = envWithHome(home);
      expect(
        runCli(scratch, ['hook', 'user-prompt'], {
          input: userPrompt(scratch, 'read-only range listing'),
          env,
        }).code,
      ).toBe(0);

      const id = onlyLedgerSessionId(home);
      const sidecar = join(home, 'ledger', 'sessions', id, 'segments.json');
      const globalConfig = join(home, 'config.json');
      const configBefore = readFileSync(globalConfig);
      rmSync(sidecar, { force: true });
      expect(existsSync(sidecar)).toBe(false);

      expect(movePayload(scratch, env).ranges).toContainEqual(
        expect.objectContaining({ sessionId: id, prompts: 1 }),
      );
      expect(existsSync(sidecar)).toBe(false);
      expect(readFileSync(globalConfig)).toEqual(configBefore);

      writeFileSync(
        sidecar,
        JSON.stringify({
          version: LEDGER_SEGMENTS_VERSION,
          recordCount: 0,
          segments: [],
        }) + '\n',
      );
      const staleBefore = readFileSync(sidecar);

      expect(movePayload(scratch, env).ranges).toContainEqual(
        expect.objectContaining({ sessionId: id, prompts: 1 }),
      );
      expect(readFileSync(sidecar)).toEqual(staleBefore);
      expect(readFileSync(globalConfig)).toEqual(configBefore);
    } finally {
      cleanup(scratch);
      cleanup(home);
    }
  });

  test('JSON listing observes a merge-diverged target without repairing session or index', () => {
    const scratch = makeTempDir();
    const project = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(project, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);
      expect(
        runCli(scratch, ['hook', 'user-prompt'], {
          input: userPrompt(scratch, 'merge-diverged listing'),
          env,
        }).code,
      ).toBe(0);
      const id = onlyLedgerSessionId(home);
      expect(runCli(project, ['move', id, '--to', project], { env }).code).toBe(0);

      const projectConfigPath = join(project, '.showtail', 'config.json');
      const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
      writeFileSync(
        projectConfigPath,
        JSON.stringify({ ...projectConfig, trailId: 'trl_merged_read_only' }, null, 2) +
          '\n',
      );

      const sessionPath = join(home, 'ledger', 'sessions', id, 'session.json');
      const indexPath = join(home, 'ledger', 'index.json');
      const globalConfigPath = join(home, 'config.json');
      const sessionBefore = readFileSync(sessionPath);
      const indexBefore = readFileSync(indexPath);
      const configBefore = readFileSync(globalConfigPath);

      const listed = movePayload(project, env).sessions.find(
        (session) => session.id === id,
      );
      expect(listed).toMatchObject({ id, status: 'placed' });
      expect(listed.paths.map((path: string) => resolve(path))).toContain(
        resolve(project),
      );
      expect(readFileSync(sessionPath)).toEqual(sessionBefore);
      expect(readFileSync(indexPath)).toEqual(indexBefore);
      expect(readFileSync(globalConfigPath)).toEqual(configBefore);
    } finally {
      cleanup(scratch);
      cleanup(project);
      cleanup(home);
    }
  });

  test('requires a range selector for multi-turn sessions and moves only that range', () => {
    const workspace = makeTempDir();
    const home = makeTempDir();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    const destination = join(workspace, 'destination');
    try {
      mkdirSync(join(first, '.git'), { recursive: true });
      mkdirSync(join(second, '.git'), { recursive: true });
      mkdirSync(destination, { recursive: true });
      const firstFile = join(first, 'one.ts');
      const secondFile = join(second, 'two.ts');
      writeFileSync(firstFile, 'export const one = 1;\n');
      writeFileSync(secondFile, 'export const two = 2;\n');
      enableAutoInit(home);
      const env = envWithHome(home);
      const sid = 'range-aware-move';

      runCli(first, ['hook', 'user-prompt'], {
        input: userPrompt(first, 'work in the first game', sid),
        env,
      });
      runCli(first, ['hook', 'post-edit'], {
        input: postEdit(first, firstFile, sid),
        env,
      });
      runCli(second, ['hook', 'user-prompt'], {
        input: userPrompt(second, 'work in the second game', sid),
        env,
      });
      runCli(second, ['hook', 'post-edit'], {
        input: postEdit(second, secondFile, sid),
        env,
      });

      const payload = movePayload(workspace, env);
      const session = payload.sessions.find((item) =>
        item.firstPrompt?.includes('work in the first game'),
      );
      const ranges = payload.ranges.filter((range) => range.sessionId === session.id);
      expect(ranges).toHaveLength(2);

      const ambiguous = runCli(
        workspace,
        ['move', session.id, '--to', destination, '--json'],
        { env },
      );
      expect(ambiguous.code).toBe(2);
      expect(ambiguous.stderr).toBe('');
      expect(JSON.parse(ambiguous.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          errorCode: 'SESSION_HAS_MULTIPLE_SEGMENTS',
          nextAction: 'choose-work-range',
          sessionId: session.id,
          rangeIds: expect.arrayContaining(ranges.map((range) => range.id)),
        }),
      );
      expect(existsSync(join(destination, '.showtail'))).toBe(false);

      const firstRange = ranges.find((range) =>
        range.firstPrompt?.includes('work in the first game'),
      );
      expect(firstRange).toBeTruthy();
      expect(
        runCli(workspace, ['move', firstRange.id, '--to', destination], { env }).code,
      ).toBe(0);
      expect(promptTexts(destination, env)).toContain('work in the first game');
      expect(promptTexts(destination, env)).not.toContain('work in the second game');
      const after = movePayload(workspace, env).ranges.filter(
        (range) => range.sessionId === session.id,
      );
      expect(
        after
          .find((range) => range.firstPrompt?.includes('work in the first game'))
          ?.paths.map((path: string) => resolve(path)),
      ).toContain(resolve(destination));
      expect(
        after
          .find((range) => range.firstPrompt?.includes('work in the second game'))
          ?.paths.map((path: string) => resolve(path)),
      ).not.toContain(resolve(destination));
    } finally {
      cleanup(workspace);
      cleanup(home);
    }
  });

  test('move and reattach reject a range whose edits fall outside the destination', () => {
    const workspace = makeTempDir();
    const home = makeTempDir();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    const destination = join(workspace, 'destination');
    try {
      mkdirSync(join(first, '.git'), { recursive: true });
      mkdirSync(join(second, '.git'), { recursive: true });
      mkdirSync(destination, { recursive: true });
      const firstFile = join(first, 'one.ts');
      const secondFile = join(second, 'two.ts');
      writeFileSync(firstFile, 'export const one = 1;\n');
      writeFileSync(secondFile, 'export const two = 2;\n');
      enableAutoInit(home);
      const env = envWithHome(home);
      const sid = 'ambiguous-manual-move';

      runCli(first, ['hook', 'user-prompt'], {
        input: userPrompt(first, 'change both projects', sid),
        env,
      });
      runCli(first, ['hook', 'post-edit'], {
        input: postEdit(first, firstFile, sid),
        env,
      });
      runCli(first, ['hook', 'post-edit'], {
        input: postEdit(first, secondFile, sid),
        env,
      });
      const id = sessionIdForPrompt(workspace, env, 'change both projects');

      for (const command of ['move', 'reattach']) {
        const result = runCli(workspace, [command, id, '--to', destination, '--json'], {
          env,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(
          expect.objectContaining({
            ok: false,
            errorCode: 'EDIT_OUTSIDE_PROJECT',
            nextAction: 'choose-project-root',
            sessionId: id,
          }),
        );
        expect(existsSync(join(destination, '.showtail'))).toBe(false);
      }

      expect(moveList(workspace, env)).toContainEqual(
        expect.objectContaining({ id, status: 'inbox', paths: [] }),
      );
    } finally {
      cleanup(workspace);
      cleanup(home);
    }
  });
});
