import { expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { listThreads, type CodexRpc } from '../src/core/codexAppServer.ts';
import {
  disableToolCapture,
  enableToolCapture,
  readGlobalConfig,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { HistoryStore } from '../src/core/history.ts';
import { mergeHookEvents } from '../src/core/hookMerge.ts';
import { blockFor } from '../src/core/managedBlock.ts';
import { readClaudeSource } from '../src/core/nativeSourceCursor.ts';
import { migratePassiveIntegration } from '../src/core/passiveMigration.ts';
import { fixture } from './centralHelpers.ts';

const before = '2026-01-01T00:00:00.000Z';
const at = '2026-11-01T12:00:00.000Z';
const prompt = (id: string, text: string, cwd?: string) =>
  JSON.stringify({
    type: 'user',
    uuid: id,
    sessionId: 'thread',
    cwd,
    timestamp: at,
    message: { content: text },
  }) + '\n';

test('connect installs passive callbacks without a reporting skill or standing rules', () =>
  fixture(({ dir, cli }) => {
    const host = join(dir, 'tool-codex');
    mkdirSync(host);
    writeFileSync(
      join(host, 'AGENTS.md'),
      'User rules\n' + blockFor('old Showtail capture') + '\n',
    );
    const result = cli(['connect', 'codex', '--yes', '--no-assistant']);
    expect(result.code).toBe(0);
    expect(readFileSync(join(host, 'AGENTS.md'), 'utf8')).toBe('User rules\n\n');
    expect(existsSync(join(host, 'skills', 'showtail', 'SKILL.md'))).toBe(false);
    const hooks = readFileSync(join(host, 'hooks.json'), 'utf8');
    expect(hooks).toContain('showtail hook stop');
    expect(hooks).not.toContain('UserPromptSubmit');
    const status = JSON.parse(cli(['status', '--json', '--tool', 'codex']).stdout);
    expect(status.schemaVersion).toBe(3);
    expect(status.capture).toMatchObject({
      mode: 'automatic',
      transport: 'hooks',
      assistant: { installed: false },
    });
  }));

test('upgrading paused capture retires old instructions without resuming capture', () =>
  fixture(({ dir, cli }) => {
    writeGlobalConfig({ version: 2, captureEnabled: false, captureSince: before });
    const host = join(dir, 'tool-claude', 'skills', 'showtail');
    mkdirSync(host, { recursive: true });
    writeFileSync(
      join(host, 'SKILL.md'),
      '---\nname: showtail\nallowed-tools: Bash(showtail *)\n---\n' +
        blockFor('Check capture at startup') +
        '\n',
    );
    const result = cli(['setup', '--first-run', '--no-assistant', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      captureEnabled: false,
      skipped: 'capture-paused',
    });
    expect(existsSync(join(host, 'SKILL.md'))).toBe(false);
  }));

test('setup preserves an existing capture cutoff and disconnected tools', () =>
  fixture(({ cli }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    disableToolCapture('claude');
    const result = cli(['setup', '--first-run', '--json']);
    expect(result.code).toBe(0);
    expect(readGlobalConfig().captureResumedAt).toBe(before);
    const status = JSON.parse(cli(['status', '--tool', 'claude', '--json']).stdout);
    expect(status.captureGloballyDisabled).toBe(true);
    expect(status.capture.mode).toBe('paused');
  }));

test('report discovers an unknown native session before resolving its project', () =>
  fixture(({ dir, project, cli, home }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    enableToolCapture('claude', before);
    const source = join(dir, 'tool-claude', 'projects', 'workspace');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'thread.jsonl'),
      prompt('first', 'Build this project', project),
    );
    const result = cli(['report', '--project', project, '--json', '--no-open']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.projectRoot).toBe(project);
    expect(report.reportPath.startsWith(join(home, 'reports'))).toBe(true);
    expect(readFileSync(report.reportPath, 'utf8')).toContain('Build this project');
  }));

test(
  'real hook process is silent and its detached worker drains and exits',
  () =>
    fixture(async ({ dir, home, project, cli }) => {
      writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
      const path = join(dir, 'native.jsonl');
      writeFileSync(path, prompt('first', 'Collect native history', project));
      const started = Date.now();
      const result = cli(
        ['hook', 'stop', '--tool', 'claude'],
        JSON.stringify({ session_id: 'thread', transcript_path: path, cwd: project }),
      );
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(Date.now() - started).toBeLessThan(2000);
      let done = false;
      const queue = join(home, 'observations');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        // Poll the queue rather than repeatedly starting the full CLI. Windows
        // cold startup can exceed a unit test's default five-second budget.
        if (
          existsSync(queue) &&
          !readdirSync(queue).some((name) => name.endsWith('.json')) &&
          !existsSync(join(queue, 'worker.lock'))
        ) {
          done = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect({
        done,
        pending: readdirSync(queue).filter((name) => name.endsWith('.json')).length,
      }).toMatchObject({ done: true });
      using store = new HistoryStore({ readonly: true });
      expect(
        store
          .records()
          .filter((r) => r.kind === 'prompt')
          .map((r) => r.text),
      ).toEqual(['Collect native history']);
    }),
  20_000,
);

test('append cursors replay the current turn and recover from truncation and cross-turn results', () =>
  fixture(({ dir }) => {
    const file = join(dir, 'source.jsonl');
    writeFileSync(file, prompt('one', 'First') + prompt('two', 'Second'));
    const first = readClaudeSource(file);
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        uuid: 'answer',
        timestamp: at,
        message: { content: [{ type: 'text', text: 'Answer' }] },
      }) + '\n',
    );
    const next = readClaudeSource(file, first.checkpoint);
    expect(next.content).not.toContain('First');
    expect(next.content).toContain('Second');
    appendFileSync(
      file,
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'prior-turn',
              content: 'Background result',
            },
          ],
        },
      }) + '\n',
    );
    expect(readClaudeSource(file, next.checkpoint).content).toContain('First');
    writeFileSync(file, prompt('new', 'Rotated'));
    expect(readClaudeSource(file, next.checkpoint).content).toContain('Rotated');
  }));

test('migration removes only owned content in registered roots and backs up callbacks', () =>
  fixture(({ project, home }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'codex', cwd: project });
    store.append(session.id, { kind: 'prompt', text: 'Work here' });
    writeFileSync(
      join(project, 'AGENTS.md'),
      'User rules\n' + blockFor('old Showtail') + '\n',
    );
    const dir = join(project, '.codex');
    mkdirSync(dir);
    const hooks = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: 'showtail hook user-prompt --tool codex' },
              { type: 'command', command: 'user-observer' },
            ],
          },
        ],
      },
    };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(hooks));
    const result = migratePassiveIntegration('codex');
    expect(result.retired).toBe(1);
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('User rules\n\n');
    const after = readFileSync(join(dir, 'hooks.json'), 'utf8');
    expect(after).toContain('user-observer');
    expect(after).not.toContain('showtail hook');
    expect(
      readdirSync(join(home, 'maintenance', 'passive-capture')).length,
    ).toBeGreaterThanOrEqual(2);
    expect(migratePassiveIntegration('codex').retired).toBe(0);
    expect(store.verify().ok).toBe(true);
  }));

test('migration replaces an owned cached Claude plugin and preserves unrelated plugin registrations', () =>
  fixture(({ dir, project }) => {
    const claude = process.env.CLAUDE_CONFIG_DIR!;
    const installed = join(dir, 'plugin', '.claude-plugin');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'plugin.json'),
      JSON.stringify({
        name: 'showtail',
        repository: 'https://github.com/Tingsters/Showtail',
      }),
    );
    mkdirSync(join(claude, 'plugins'), { recursive: true });
    writeFileSync(
      join(claude, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: { 'showtail@showtail': [{ installPath: join(dir, 'plugin') }] },
      }),
    );
    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'showtail@showtail': true, 'other@other': true },
        permissions: { allow: ['Read'] },
      }),
    );
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'claude-code', cwd: project });
    store.append(session.id, { kind: 'prompt', text: 'Known project' });
    const local = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      local,
      JSON.stringify({
        enabledPlugins: { 'showtail@showtail': true, 'other@other': true },
      }),
    );
    migratePassiveIntegration('claude');
    expect(JSON.parse(readFileSync(local, 'utf8')).enabledPlugins).toEqual({
      'showtail@showtail': false,
      'other@other': true,
    });
    expect(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'))).toMatchObject(
      {
        enabledPlugins: { 'showtail@showtail': false, 'other@other': true },
        permissions: { allow: ['Read'] },
      },
    );
  }));

test('reconnecting removes obsolete prompt callbacks while preserving mixed user hooks', () => {
  const result = mergeHookEvents(
    {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: 'showtail hook user-prompt' },
              { type: 'command', command: 'user-hook' },
            ],
          },
        ],
      },
    },
    { Stop: [{ hooks: [{ type: 'command', command: 'showtail hook stop' }] }] },
  );
  expect(JSON.stringify(result)).not.toContain('user-prompt');
  expect(JSON.stringify(result)).toContain('user-hook');
});

test('Codex discovery reads active and archived threads with all source kinds without metadata repair', async () => {
  const calls: { method: string; params: any }[] = [];
  const rpc: CodexRpc = {
    async request(method, params: any) {
      calls.push({ method, params });
      return {
        data: [{ id: params.archived ? 'archived' : params.cursor ? 'second' : 'first' }],
        nextCursor: !params.archived && !params.cursor ? 'next' : null,
      };
    },
    close() {},
  };
  expect((await listThreads(rpc)).map((t) => t.id)).toEqual([
    'first',
    'second',
    'archived',
  ]);
  expect(
    calls.every(
      (c) =>
        c.method === 'thread/list' &&
        c.params.useStateDbOnly === true &&
        c.params.sourceKinds.includes('subAgent'),
    ),
  ).toBe(true);
});

test('Claude recovers structured Bash diffs rather than requiring shell-edit hooks', () => {
  const content = [
    {
      type: 'assistant',
      timestamp: at,
      message: {
        content: [
          { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'edit file' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at,
      toolUseResult: {
        bashEditDiff: {
          files: [
            {
              filePath: '/project/index.ts',
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ['-old', '+new'],
                },
              ],
            },
          ],
          moreFiles: true,
        },
      },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'success' }],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
  const result = parseClaudeTranscript(content, '/project', {
    includeOutsideEdits: true,
  });
  expect(result.messages.find((m) => m.role === 'edit')?.edits?.[0]?.diff).toContain(
    '+new',
  );
  expect(result.warnings).toContain('BASH_DIFF_PARTIAL');
});
