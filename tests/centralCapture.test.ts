import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fixture, tree } from './centralHelpers.ts';
import { HistoryStore } from '../src/core/history.ts';
import {
  captureTranscript,
  commitCapture,
  drainPending,
  runHistoryHook,
} from '../src/core/historyCapture.ts';
import {
  disableToolCapture,
  enableToolCapture,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { buildHistoryReport, writeHistoryReport } from '../src/core/historyReport.ts';
import { redactHistory } from '../src/core/historyRedact.ts';
import { PLUGINS } from '../src/plugins/registry.ts';
import type { HookTranscript } from '../src/plugins/types.ts';

const since = '2000-01-01T00:00:00.000Z';
const stamp = '2026-11-01T12:00:00.000Z';
function enable(): void {
  writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
}

describe('central capture across providers', () => {
  for (const tool of [
    'claude-code',
    'codex',
    'copilot-cli',
    'antigravity-cli',
    'antigravity-ide',
    'github-copilot',
  ]) {
    test(`${tool}: native prompt and edit payloads land centrally`, () =>
      fixture(async ({ project }) => {
        enable();
        const file = join(project, 'helper.ts');
        writeFileSync(file, 'export const answer = 42;');
        const before = tree(project);
        const base: Record<string, any> = {
          cwd: project,
          session_id: 'native-session',
          sessionId: 'native-session',
          timestamp: stamp,
          prompt: 'Add a helper',
          turn_id: 'request-1',
        };
        if (tool === 'copilot-cli') delete base.session_id;
        if (tool === 'github-copilot' || tool === 'antigravity-ide')
          Object.assign(base, {
            showtailExtension: 'showtail-vscode-extension-hook/v1',
            projectCwd: project,
            workspacePaths: [project],
          });
        await runHistoryHook('user-prompt', base, tool);
        let edited: Record<string, any> = {
          ...base,
          timestamp: '2026-11-01T12:00:01.000Z',
          tool_name: 'Write',
          tool_input: { file_path: file, content: 'export const answer = 42;' },
        };
        if (tool === 'codex')
          edited = {
            ...edited,
            tool_name: 'apply_patch',
            tool_input: {
              command: `*** Begin Patch\n*** Add File: ${file}\n+export const answer = 42;\n*** End Patch`,
            },
          };
        if (tool === 'copilot-cli')
          Object.assign(edited, {
            toolName: 'edit',
            toolArgs: JSON.stringify({ path: file, old_str: '0', new_str: '42' }),
          });
        if (tool === 'antigravity-cli') edited.tool_name = 'write_file';
        if (tool === 'github-copilot' || tool === 'antigravity-ide')
          Object.assign(edited, { editedFiles: [file] });
        await runHistoryHook('post-edit', edited, tool);
        using store = new HistoryStore();
        expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(1);
        expect(store.records().some((r) => r.kind === 'edit' && r.file === file)).toBe(
          true,
        );
        expect(store.sessions()[0]!.tool).toBe(tool);
        expect(store.verify().ok).toBe(true);
        expect(tree(project)).toEqual(before);
        expect(existsSync(join(project, '.showtail'))).toBe(false);
      }));
  }
  for (const plugin of PLUGINS) {
    test(`${plugin.id}: complete normalized conversations preserve every record kind`, () =>
      fixture(({ project }) => {
        using store = new HistoryStore();
        const session = store.ensureSession({
          tool: plugin.id,
          nativeSessionId: 'conversation',
          cwd: project,
          startedAt: stamp,
        });
        const transcript: HookTranscript = {
          messages: [
            {
              role: 'user',
              text: 'Build a parser',
              requestId: 'turn-1',
              sourceId: 'prompt',
              timestamp: stamp,
            },
            {
              role: 'assistant',
              text: 'I will add a parser.',
              sourceId: 'reply',
              isFinal: true,
              timestamp: stamp,
            },
            {
              role: 'decision',
              text: 'Use a small grammar',
              sourceId: 'decision',
              timestamp: stamp,
            },
            {
              role: 'plan',
              text: '# Plan\nAdd a grammar',
              approved: true,
              sourceId: 'plan',
              timestamp: stamp,
            },
            {
              role: 'edit',
              text: '',
              edits: [{ file: join(project, 'parser.ts'), diff: '+ parse()' }],
              sourceId: 'edit',
              timestamp: stamp,
            },
            {
              role: 'tool_call',
              text: '$ test parser',
              toolName: 'Bash',
              sourceId: 'tool',
              timestamp: stamp,
            },
            {
              role: 'recap',
              text: 'Parser completed',
              durationMs: 1200,
              inputTokens: 50,
              sourceId: 'recap',
              timestamp: stamp,
            },
          ],
          events: [
            {
              sequence: 0,
              type: 'user_text',
              text: 'Build a parser',
              sourceId: 'prompt',
              timestamp: stamp,
            },
            {
              sequence: 1,
              type: 'tool_result',
              sourceId: 'tool-result',
              content: 'PRIVATE TOOL OUTPUT',
              toolName: 'Bash',
              timestamp: stamp,
            },
          ],
        };
        captureTranscript(store, session, transcript);
        expect(captureTranscript(store, session, transcript)).toBe(0);
        const report = buildHistoryReport(store, { kind: 'all' });
        const turn = report.turns[0]!;
        expect(report.turns).toHaveLength(1);
        expect(turn.aiOutputs).toHaveLength(1);
        expect(turn.decisions).toHaveLength(1);
        expect(turn.plans).toHaveLength(1);
        expect(turn.codeChanges[0]!.diff).toBe('+ parse()');
        expect(turn.toolCalls).toHaveLength(1);
        expect(turn.recap?.inputTokens).toBe(50);
        expect(JSON.stringify(turn.events)).not.toContain('PRIVATE TOOL OUTPUT');
        expect(store.verify().ok).toBe(true);
      }));
  }
  test('completed responses cannot regress to partial transcript content', () =>
    fixture(() => {
      using store = new HistoryStore();
      const session = store.ensureSession({ tool: 'codex', nativeSessionId: 'final' });
      store.append(session.id, {
        kind: 'ai_output',
        sourceId: 'reply',
        text: 'Complete',
        transcriptFinal: true,
      });
      store.append(session.id, {
        kind: 'ai_output',
        sourceId: 'reply',
        text: 'Partial',
        transcriptFinal: false,
      });
      expect(store.records()[0]!.text).toBe('Complete');
      expect(store.records()).toHaveLength(1);
    }));
  test('edited native prompts supersede their earlier text without creating another turn', () =>
    fixture(() => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'codex',
        nativeSessionId: 'edited-prompt',
      });
      captureTranscript(store, session, {
        messages: [
          { role: 'user', text: 'First wording', sourceId: 'prompt-1', timestamp: stamp },
        ],
      });
      const originalTurn = store.records()[0]!.turnId;
      captureTranscript(store, session, {
        messages: [
          {
            role: 'user',
            text: 'Revised wording',
            sourceId: 'prompt-1',
            timestamp: stamp,
          },
        ],
      });
      expect(store.records().map((r) => r.text)).toEqual(['Revised wording']);
      expect(store.records()[0]!.turnId).toBe(originalTurn);
      expect(store.records({ kind: 'all' }, { includeSuperseded: true })).toHaveLength(2);
      expect(store.verify().ok).toBe(true);
    }));
  test('uncaptured older prompts cannot claim a matching live prompt after resume', () =>
    fixture(() => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'claude-code',
        nativeSessionId: 'repeat-after-pause',
      });
      store.append(session.id, {
        kind: 'prompt',
        text: 'Try again',
        sourceId: 'hook:new-prompt',
        ts: stamp,
      });
      captureTranscript(
        store,
        store.session(session.id)!,
        {
          messages: [
            {
              role: 'user',
              text: 'Try again',
              sourceId: 'old-native-prompt',
              timestamp: since,
            },
            {
              role: 'assistant',
              text: 'Reply while capture was off',
              sourceId: 'old-reply',
            },
            {
              role: 'user',
              text: 'Try again',
              sourceId: 'new-native-prompt',
              timestamp: stamp,
            },
          ],
        },
        { since: stamp },
      );
      expect(store.records().map((r) => r.text)).toEqual(['Try again']);
      expect(store.bySource(session.id, 'old-native-prompt')).toBeUndefined();
      expect(store.bySource(session.id, 'new-native-prompt')).toBeDefined();
    }));
  test('reconnect boundaries exclude uncaptured work from stopped intervals', () =>
    fixture(() => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'claude-code',
        nativeSessionId: 'paused',
      });
      captureTranscript(
        store,
        session,
        {
          messages: [
            {
              role: 'user',
              text: 'While stopped',
              sourceId: 'old',
              timestamp: '2026-01-01T00:00:00Z',
            },
            {
              role: 'assistant',
              text: 'Do not recover',
              sourceId: 'old-reply',
              timestamp: '2026-01-01T00:00:01Z',
            },
            { role: 'user', text: 'After resume', sourceId: 'new', timestamp: stamp },
          ],
        },
        { since: '2026-10-01T00:00:00Z' },
      );
      expect(store.records().map((r) => r.text)).toEqual(['After resume']);
    }));
  test('database contention queues redacted records and replay is idempotent', () =>
    fixture(({ project, home }) => {
      enable();
      using store = new HistoryStore();
      store.db.exec('BEGIN IMMEDIATE');
      try {
        commitCapture({
          version: 1,
          id: 'queued-batch',
          session: { tool: 'claude-code', nativeSessionId: 'queued', cwd: project },
          records: [
            {
              kind: 'prompt',
              sourceId: 'queued-prompt',
              text: 'password=SuperPrivateValue123',
            },
          ],
          automatic: { cliName: 'claude', globalEpoch: since },
        });
        const queued = readFileSync(join(home, 'pending', 'queued-batch.json'), 'utf8');
        expect(queued).not.toContain('SuperPrivateValue123');
      } finally {
        store.db.exec('ROLLBACK');
      }
      expect(drainPending(store)).toBe(1);
      expect(drainPending(store)).toBe(0);
      expect(store.records()).toHaveLength(1);
      expect(store.verify().ok).toBe(true);
    }));
  test('stale queued work cannot cross a disconnect/reconnect epoch', () =>
    fixture(({ project, home }) => {
      enable();
      enableToolCapture('claude', since);
      using store = new HistoryStore();
      store.db.exec('BEGIN IMMEDIATE');
      try {
        commitCapture({
          version: 1,
          id: 'old-epoch',
          session: { tool: 'claude-code', nativeSessionId: 'old', cwd: project },
          records: [{ kind: 'prompt', sourceId: 'old', text: 'Old queued prompt' }],
          automatic: { cliName: 'claude', enabledAt: since, globalEpoch: since },
        });
      } finally {
        store.db.exec('ROLLBACK');
      }
      disableToolCapture('claude');
      enableToolCapture('claude', stamp);
      expect(drainPending(store)).toBe(0);
      expect(store.records()).toHaveLength(0);
      expect(readdirSync(join(home, 'pending'))).toHaveLength(0);
    }));
  test('queued work cannot cross a global pause and resume', () =>
    fixture(({ project }) => {
      enable();
      using store = new HistoryStore();
      store.db.exec('BEGIN IMMEDIATE');
      try {
        commitCapture({
          version: 1,
          id: 'global-epoch',
          session: { tool: 'claude-code', nativeSessionId: 'global-old', cwd: project },
          records: [{ kind: 'prompt', sourceId: 'old', text: 'Queued before pause' }],
          automatic: { cliName: 'claude', globalEpoch: since },
        });
      } finally {
        store.db.exec('ROLLBACK');
      }
      writeGlobalConfig({ version: 2, captureEnabled: false, captureSince: since });
      writeGlobalConfig({
        version: 2,
        captureEnabled: true,
        captureSince: since,
        captureResumedAt: stamp,
      });
      expect(drainPending(store)).toBe(0);
      expect(store.records()).toHaveLength(0);
    }));
  test('declared redaction readdresses content, preserves JSON, and records an audit', () =>
    fixture(() => {
      using store = new HistoryStore();
      const session = store.ensureSession({ tool: 'cli', nativeSessionId: 'redaction' });
      store.append(session.id, { kind: 'prompt', text: 'Remove privatephrase' });
      store.append(session.id, {
        kind: 'conversation_event',
        conversationEvent: { sequence: 0, type: 'user_text', text: 'privatephrase' },
      });
      expect(redactHistory(store, { pattern: 'privatephrase' }).applied).toBe(false);
      expect(
        redactHistory(store, { pattern: 'privatephrase', apply: true }).applied,
      ).toBe(true);
      expect(JSON.stringify(store.records())).not.toContain('privatephrase');
      expect(store.records().some((r) => r.kind === 'audit')).toBe(true);
      expect(store.verify().ok).toBe(true);
    }));
  test('report paths cannot follow a symlink out of the store', () =>
    fixture(({ project, home }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'symlink',
        cwd: project,
      });
      store.append(session.id, { kind: 'prompt', text: 'Review my work' });
      symlinkSync(
        project,
        join(home, 'reports'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const before = tree(project);
      expect(() => writeHistoryReport(store, { kind: 'all' })).toThrow(
        'STORE_PATH_ESCAPE',
      );
      expect(tree(project)).toEqual(before);
    }));
});

describe('central user-level connections and imports', () => {
  for (const tool of [
    'claude',
    'codex',
    'copilot-cli',
    'antigravity-cli',
    'antigravity-ide',
    'copilot',
  ]) {
    test(`${tool}: connect and disconnect preserve every project byte`, () =>
      fixture(({ project, cli }) => {
        const before = tree(project);
        const connected = cli([
          'connect',
          tool,
          '--yes',
          ...(tool === 'copilot' ? ['--no-extension'] : []),
        ]);
        expect(connected.code).toBe(0);
        expect(tree(project)).toEqual(before);
        expect(cli(['disconnect', tool]).code).toBe(0);
        expect(tree(project)).toEqual(before);
        const state = JSON.parse(cli(['status', '--json', '--tool', tool]).stdout);
        expect(state.captureGloballyDisabled).toBe(true);
        expect(cli(['connect', tool, '--project']).code).not.toBe(0);
      }));
  }
  for (const tool of ['chatgpt', 'gemini'])
    test(`${tool}: saved conversations import centrally and dedupe`, () =>
      fixture(({ dir, project, cli }) => {
        const file = join(dir, 'conversation.txt');
        writeFileSync(
          file,
          tool === 'chatgpt'
            ? 'You said:\nBuild a parser\n\nChatGPT said:\nHere is a parser.'
            : 'You said:\nBuild a parser\n\nGemini said:\nHere is a parser.',
        );
        const before = tree(project);
        const first = cli(['import', tool, '--file', file, '--json']);
        expect(first.code).toBe(0);
        expect(JSON.parse(first.stdout).imported).toBeGreaterThan(0);
        expect(
          JSON.parse(cli(['import', tool, '--file', file, '--json']).stdout).imported,
        ).toBe(0);
        expect(tree(project)).toEqual(before);
      }));
});
