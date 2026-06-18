import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir } from './helpers.ts';

/** Read the structured JSON report `showtail report --format json` wrote. */
function readJsonReport(dir: string): any {
  const reportsDir = join(dir, '.showtail', 'reports');
  const file = readdirSync(reportsDir).find((f) => f.endsWith('.json'));
  return JSON.parse(readFileSync(join(reportsDir, file!), 'utf8'));
}

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** Run `showtail <args>` in `cwd`, optionally piping `input` to stdin. */
function run(cwd: string, args: string[], input?: string) {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

function initProject(dir: string) {
  run(dir, ['init', '--project', 'Hook Test']);
}

describe('hook command (end-to-end via stdin)', () => {
  test('user-prompt hook logs a prompt event', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: dir,
        prompt: 'How should I structure the parser?',
      });
      const r = run(dir, ['hook', 'user-prompt'], payload);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(''); // must not pollute Claude's context

      const report = run(dir, ['report', '--format', 'json']);
      expect(report.code).toBe(0);
      // The prompt should now be captured in the trail.
      const trace = run(dir, ['report']);
      expect(trace.code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit hook snapshots the edited file as an artifact', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      writeFileSync(join(dir, 'parser.ts'), 'export const parse = () => {};');
      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: dir,
        tool_name: 'Edit',
        tool_input: { file_path: join(dir, 'parser.ts') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload);
      expect(r.code).toBe(0);

      const trace = run(dir, ['trace', 'parser.ts', '--format', 'json']);
      expect(trace.code).toBe(0);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('session-start hook prints a one-line context note and creates a session', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: dir,
        source: 'startup',
      });
      const r = run(dir, ['hook', 'session-start'], payload);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Showtail is capturing');
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit ignores internal .showtail/.claude paths', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        tool_input: { file_path: join(dir, '.showtail', 'config.json') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload);
      expect(r.code).toBe(0);
      // config.json should not have been recorded as an artifact.
      const trace = run(dir, ['trace', '.showtail/config.json', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('hooks are silent no-ops outside a Showtail project', () => {
    const dir = makeTempDir();
    try {
      // No `showtail init` here.
      const r = run(dir, ['hook', 'user-prompt'], JSON.stringify({ prompt: 'hi' }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      cleanup(dir);
    }
  });

  test('malformed stdin does not crash a hook', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const r = run(dir, ['hook', 'user-prompt'], 'not json at all');
      expect(r.code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('skill status reports ON once project hooks are installed', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(dir, ['skill', 'install', '--project']); // hooks on by default
      const r = run(dir, ['skill', 'status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('auto-capture: ON');
    } finally {
      cleanup(dir);
    }
  });

  test('user-prompt --tool codex tags the prompt as codex', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({ cwd: dir, prompt: 'refactor the parser' });
      const r = run(dir, ['hook', 'user-prompt', '--tool', 'codex'], payload);
      expect(r.code).toBe(0);
      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.turns[0].prompt.tool).toBe('codex');
    } finally {
      cleanup(dir);
    }
  });

  test('stop hook attributes only the current turn, not transcript backlog', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup' }),
      );

      // A persisted Claude Code transcript that already holds a prior
      // conversation (the "backlog"), then the current turn's prompt + reply.
      // Only the current turn's assistant message should be captured; the
      // backlog must not be dumped onto the new prompt.
      const lines = [
        {
          type: 'user',
          uuid: 'old-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'old backlog prompt' },
        },
        {
          type: 'assistant',
          uuid: 'old-a1',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'BACKLOG reply one' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'old-a2',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'BACKLOG reply two' }],
          },
        },
        {
          type: 'user',
          uuid: 'new-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'make the new change' },
        },
        {
          type: 'assistant',
          uuid: 'new-a',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'CURRENT reply applied' }],
          },
        },
      ];
      const transcriptPath = join(dir, 'transcript.jsonl');
      writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

      // The live hook captures the new prompt (opening the turn), then Stop.
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'make the new change' }),
      );
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, transcript_path: transcriptPath }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);

      // Exactly one prompt was logged live, so exactly one turn — carrying only
      // the current turn's single reply, none of the backlog.
      expect(data.turns.length).toBe(1);
      const turn = data.turns[0];
      expect(turn.prompt.text).toBe('make the new change');
      expect(turn.aiOutputs.length).toBe(1);
      expect(turn.aiOutputs[0].text).toBe('CURRENT reply applied');

      // The backlog must not appear anywhere in the report.
      const blob = JSON.stringify(data);
      expect(blob).not.toContain('BACKLOG reply');
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit --tool codex snapshots a file from an apply_patch envelope', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      writeFileSync(join(dir, 'parser.ts'), 'export const x = 1;');
      const payload = JSON.stringify({
        cwd: dir,
        tool_name: 'apply_patch',
        tool_input: {
          input: '*** Begin Patch\n*** Update File: parser.ts\n@@\n-1\n+2\n*** End Patch',
        },
      });
      const r = run(dir, ['hook', 'post-edit', '--tool', 'codex'], payload);
      expect(r.code).toBe(0);
      const trace = run(dir, ['trace', 'parser.ts', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
      expect(data.artifacts[0].tool).toBe('codex');
    } finally {
      cleanup(dir);
    }
  });
});
