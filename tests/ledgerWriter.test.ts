import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup,
  enableAutoInit,
  envWithHome,
  makeTempDir,
  readJsonReport,
  runCli,
} from './helpers.ts';

/** Env with the experimental sole-writer (full-inversion) mode turned on. */
function writerEnv(home: string): NodeJS.ProcessEnv {
  return { ...envWithHome(home), SHOWTAIL_LEDGER_WRITER: '1' };
}

function transcript(dir: string, sid: string, prompt: string, reply: string): string {
  const path = join(dir, 'transcript.jsonl');
  const lines = [
    {
      type: 'user',
      uuid: 'u1',
      sessionId: sid,
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

describe('sole-writer mode: the repo trail is a projection of the ledger', () => {
  test('prompt + edit + reply all reach the trail via materialize, not the live handlers', () => {
    const repo = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(repo, 'package.json'), '{}\n'); // eligible dev folder
      enableAutoInit(home);
      const env = writerEnv(home);
      const sid = 'sess-writer';

      // Prompt → projected into the repo.
      expect(
        runCli(repo, ['hook', 'user-prompt'], {
          input: JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            cwd: repo,
            prompt: 'build the parser',
            session_id: sid,
          }),
          env,
        }).code,
      ).toBe(0);

      // Edit → projected.
      writeFileSync(join(repo, 'parser.ts'), 'export const x = 1;\n');
      expect(
        runCli(repo, ['hook', 'post-edit'], {
          input: JSON.stringify({
            hook_event_name: 'PostToolUse',
            cwd: repo,
            session_id: sid,
            tool_name: 'Edit',
            tool_input: {
              file_path: join(repo, 'parser.ts'),
              old_string: 'a',
              new_string: 'b',
            },
          }),
          env,
        }).code,
      ).toBe(0);

      // Stop with a transcript → the AI reply is projected too.
      expect(
        runCli(repo, ['hook', 'stop'], {
          input: JSON.stringify({
            hook_event_name: 'Stop',
            cwd: repo,
            transcript_path: transcript(
              repo,
              sid,
              'build the parser',
              'Parser built for you.',
            ),
            session_id: sid,
          }),
          env,
        }).code,
      ).toBe(0);

      // The trail (a pure projection) holds the whole turn: prompt + reply + edit.
      expect(runCli(repo, ['report', '--format', 'json'], { env }).code).toBe(0);
      const turn = readJsonReport(repo).turns.find(
        (t: any) => t.prompt.text === 'build the parser',
      );
      expect(turn).toBeTruthy();
      expect(turn.aiOutputs.map((o: any) => o.text).join('\n')).toContain('Parser built');
      expect(turn.codeChanges.length).toBeGreaterThan(0);
      expect(turn.codeChanges.some((c: any) => c.path === 'parser.ts')).toBe(true);

      // Placed, so nothing is left in the inbox.
      expect(
        JSON.parse(runCli(repo, ['inbox', '--json'], { env }).stdout).sessions.length,
      ).toBe(0);
    } finally {
      cleanup(repo);
      cleanup(home);
    }
  });
});
