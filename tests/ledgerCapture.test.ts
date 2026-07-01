import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup,
  enableAutoInit,
  envWithHome,
  makeTempDir,
  readJsonReport,
  runCli,
} from './helpers.ts';

function userPrompt(cwd: string, prompt: string, sessionId = 's1'): string {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt,
    session_id: sessionId,
  });
}

/** A Claude Edit payload — yields a captured diff (`- old` / `+ new`). */
function editFile(
  cwd: string,
  file: string,
  oldS: string,
  newS: string,
  sessionId = 's1',
): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    cwd,
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, file), old_string: oldS, new_string: newS },
  });
}

/**
 * Parse `showtail inbox --all --json` run with this env. These tests exercise
 * capture/placement of folderless *scratch* work, which the default view now hides;
 * `--all` reveals it (surfacing is covered separately in inboxSurface.test.ts).
 */
function inbox(cwd: string, env: NodeJS.ProcessEnv): any {
  const r = runCli(cwd, ['inbox', '--all', '--json'], { env });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

/**
 * Generate a FRESH JSON report in `dir` and return it. Clears any prior reports
 * first: a dir may be reported on twice (e.g. before and after a move), and the
 * shared `readJsonReport` returns the first `.json` it finds — so a stale report
 * left in place would be read instead.
 */
function freshReport(dir: string, env: NodeJS.ProcessEnv): any {
  rmSync(join(dir, '.showtail', 'reports'), { recursive: true, force: true });
  expect(runCli(dir, ['report', '--format', 'json'], { env }).code).toBe(0);
  return readJsonReport(dir);
}

/** Every prompt text across a fresh report's turns. */
function promptTexts(dir: string, env: NodeJS.ProcessEnv): string[] {
  return freshReport(dir, env).turns.map((t: any) => t.prompt.text);
}

/** A Claude transcript file with a user prompt + an assistant reply, returned as a path. */
function writeTranscript(
  dir: string,
  sessionId: string,
  prompt: string,
  reply: string,
): string {
  const path = join(dir, 'transcript.jsonl');
  const lines = [
    {
      type: 'user',
      uuid: 'u1',
      sessionId,
      cwd: dir,
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: reply }],
      },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

describe('ledger capture: nothing is dropped', () => {
  test('a folderless (scratch) session lands in the inbox, not on disk', () => {
    const scratch = makeTempDir(); // empty: not a git repo, no dev markers
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const env = envWithHome(home);

      expect(
        runCli(scratch, ['hook', 'user-prompt'], {
          input: userPrompt(scratch, 'build a scratch parser'),
          env,
        }).code,
      ).toBe(0);
      expect(
        runCli(scratch, ['hook', 'post-edit'], {
          input: editFile(scratch, 'parser.ts', 'old', 'new'),
          env,
        }).code,
      ).toBe(0);

      // Nothing was written into the scratch folder...
      expect(existsSync(join(scratch, '.showtail'))).toBe(false);
      // ...but the work is captured and visible in the inbox.
      const data = inbox(scratch, env);
      expect(data.sessions.length).toBe(1);
      expect(data.sessions[0].prompts).toBe(1);
      expect(data.sessions[0].edits).toBe(1);
      expect(data.sessions[0].status).toBe('inbox');
      expect(data.sessions[0].firstPrompt).toContain('scratch parser');
    } finally {
      cleanup(scratch);
      cleanup(home);
    }
  });

  test('cwd-fallback: a prompt in an eligible folder is placed, not left in the inbox', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n'); // marks a dev workspace
      enableAutoInit(home);
      const env = envWithHome(home);

      expect(
        runCli(dir, ['hook', 'user-prompt'], {
          input: userPrompt(dir, 'placed work'),
          env,
        }).code,
      ).toBe(0);

      // Trail created in the folder (existing behavior) with a stable trailId...
      const config = JSON.parse(
        readFileSync(join(dir, '.showtail', 'config.json'), 'utf8'),
      );
      expect(config.trailId).toBeTruthy();
      // ...and the session is placed, so the inbox is empty.
      expect(inbox(dir, env).sessions.length).toBe(0);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});

describe('reattach: placing and correcting attribution', () => {
  test('reattach projects a scratch session into a repo and is idempotent', () => {
    const scratch = makeTempDir();
    const repo = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repo, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);

      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'scratch work to place'),
        env,
      });
      runCli(scratch, ['hook', 'post-edit'], {
        input: editFile(scratch, 'a.ts', 'x', 'y'),
        env,
      });
      const id = inbox(scratch, env).sessions[0].id;

      const first = runCli(repo, ['reattach', id, '--to', repo], { env });
      expect(first.code).toBe(0);
      expect(promptTexts(repo, env)).toContain('scratch work to place');
      // Placed → no longer in the inbox.
      expect(inbox(repo, env).sessions.length).toBe(0);

      // Re-running projects nothing new (dedup by source id).
      const again = runCli(repo, ['reattach', id, '--to', repo], { env });
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('0 record(s) projected');
    } finally {
      cleanup(scratch);
      cleanup(repo);
      cleanup(home);
    }
  });

  test('reattach to a different repo MOVES the work (corrects misattribution)', () => {
    const scratch = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repoA, 'package.json'), '{}\n');
      writeFileSync(join(repoB, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);

      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'movable work'),
        env,
      });
      const id = inbox(scratch, env).sessions[0].id;

      runCli(repoA, ['reattach', id, '--to', repoA], { env });
      expect(promptTexts(repoA, env)).toContain('movable work');

      // Now correct it: move to repoB.
      const move = runCli(repoB, ['reattach', id, '--to', repoB], { env });
      expect(move.code).toBe(0);
      expect(promptTexts(repoB, env)).toContain('movable work');
      // ...and it's gone from repoA.
      expect(promptTexts(repoA, env)).not.toContain('movable work');
    } finally {
      cleanup(scratch);
      cleanup(repoA);
      cleanup(repoB);
      cleanup(home);
    }
  });

  test('a scratch session captures AI replies from the transcript; reattach carries them', () => {
    const scratch = makeTempDir();
    const repo = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repo, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);
      const sid = 'sess-replies';

      // Prompt in a folderless scratch dir → ledger only.
      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'explain the parser', sid),
        env,
      });
      // Stop with a transcript carrying that prompt + an assistant reply.
      const transcriptPath = writeTranscript(
        scratch,
        sid,
        'explain the parser',
        'Here is the parser explanation.',
      );
      expect(
        runCli(scratch, ['hook', 'stop'], {
          input: JSON.stringify({
            hook_event_name: 'Stop',
            cwd: scratch,
            transcript_path: transcriptPath,
            session_id: sid,
          }),
          env,
        }).code,
      ).toBe(0);

      const id = inbox(scratch, env).sessions[0].id;
      runCli(repo, ['reattach', id, '--to', repo], { env });

      // The reattached trail shows the prompt AND the AI reply, linked as one turn.
      const turn = freshReport(repo, env).turns.find(
        (t: any) => t.prompt.text === 'explain the parser',
      );
      expect(turn).toBeTruthy();
      expect(turn.aiOutputs.map((o: any) => o.text).join('\n')).toContain(
        'parser explanation',
      );
    } finally {
      cleanup(scratch);
      cleanup(repo);
      cleanup(home);
    }
  });

  test('cross-plugin: a folderless Codex (apply_patch) session reattaches with its diff', () => {
    const scratch = makeTempDir();
    const repo = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repo, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);
      const sid = 'cdx-1';

      // Codex prompt (folderless) — the ledger is tool-agnostic, keyed by native id.
      runCli(scratch, ['hook', 'user-prompt', '--tool', 'codex'], {
        input: JSON.stringify({
          cwd: scratch,
          session_id: sid,
          prompt: 'codex: add a helper',
        }),
        env,
      });
      // Codex apply_patch edit → a clean per-file diff in the ledger.
      const file = join(scratch, 'helper.ts');
      writeFileSync(file, 'export const x = 1;\n');
      runCli(scratch, ['hook', 'post-edit', '--tool', 'codex'], {
        input: JSON.stringify({
          cwd: scratch,
          session_id: sid,
          tool_name: 'apply_patch',
          tool_input: {
            input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-1\n+2\n*** End Patch`,
          },
        }),
        env,
      });

      const data = inbox(scratch, env);
      expect(data.sessions.length).toBe(1);
      expect(data.sessions[0].prompts).toBe(1);
      expect(data.sessions[0].edits).toBe(1);

      const id = data.sessions[0].id;
      runCli(repo, ['reattach', id, '--to', repo], { env });

      const turn = freshReport(repo, env).turns.find(
        (t: any) => t.prompt.text === 'codex: add a helper',
      );
      expect(turn).toBeTruthy();
      // The codex per-file diff survived capture → ledger → projection.
      expect(turn.codeChanges.length).toBeGreaterThan(0);
      expect(JSON.stringify(turn.codeChanges)).toContain('+ 2');
    } finally {
      cleanup(scratch);
      cleanup(repo);
      cleanup(home);
    }
  });

  test('a placed session whose repo is deleted resurfaces as target-missing', () => {
    const scratch = makeTempDir();
    const repo = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repo, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWithHome(home);

      runCli(scratch, ['hook', 'user-prompt'], {
        input: userPrompt(scratch, 'work that outlives its repo'),
        env,
      });
      const id = inbox(scratch, env).sessions[0].id;
      runCli(repo, ['reattach', id, '--to', repo], { env });
      expect(inbox(repo, env).sessions.length).toBe(0); // placed

      rmSync(repo, { recursive: true, force: true }); // repo deleted

      const data = inbox(scratch, env);
      const surfaced = data.sessions.find((s: any) => s.id === id);
      expect(surfaced).toBeTruthy();
      expect(surfaced.status).toBe('target-missing');
    } finally {
      cleanup(scratch);
      cleanup(repo);
      cleanup(home);
    }
  });
});
