import { expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { enableToolCapture, writeGlobalConfig } from '../src/core/globalConfig.ts';
import { digest, HistoryStore } from '../src/core/history.ts';
import { readClaudeSource } from '../src/core/nativeSourceCursor.ts';
import { fixture } from './centralHelpers.ts';
import { readViewer } from './viewerHelpers.ts';

const since = '2026-11-01T00:00:00.000Z';
const at = '2026-11-01T00:00:01.000Z';
const sdkPrompt = (uuid: string, text: string, cwd: string) => ({
  type: 'user',
  uuid,
  sessionId: 'sdk-thread',
  promptSource: 'sdk',
  isSidechain: false,
  timestamp: at,
  cwd,
  message: { role: 'user', content: text },
});
const reply = {
  type: 'assistant',
  uuid: 'reply-one',
  sessionId: 'sdk-thread',
  timestamp: at,
  message: { model: 'claude-test', content: [{ type: 'text', text: 'Completed.' }] },
};
const serialize = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

test('Claude SDK transport preserves the actual headless prompt and still rejects injected context', () =>
  fixture(({ project }) => {
    const content = serialize([
      sdkPrompt(
        'initial',
        'Create headless.mjs.\nPreserve this initial prompt.',
        project,
      ),
      { ...sdkPrompt('meta', 'Injected metadata.', project), isMeta: true },
      {
        ...sdkPrompt('summary', 'A context-compaction summary.', project),
        isCompactSummary: true,
      },
      {
        ...sdkPrompt('child', 'Delegated agent input.', project),
        isSidechain: true,
      },
      {
        ...sdkPrompt('system', 'Injected system context.', project),
        promptSource: 'system',
      },
      sdkPrompt(
        'wrapper',
        '<system-reminder>Injected context</system-reminder>',
        project,
      ),
      reply,
    ]);
    const messages = parseClaudeTranscript(content, project).messages;
    expect(messages.filter((message) => message.role === 'user')).toEqual([
      expect.objectContaining({
        text: 'Create headless.mjs.\nPreserve this initial prompt.',
        sourceId: 'initial',
      }),
    ]);
    expect(messages.some((message) => message.text.includes('Injected'))).toBe(false);
    const children = parseClaudeTranscript(content, project, {
      includeSidechains: true,
    }).messages;
    expect(children.find((message) => message.sourceId === 'child')?.origin).toBe(
      'agent',
    );
  }));

test('Claude SDK prompts establish append cursor boundaries and preserve identical later submissions', () =>
  fixture(({ dir, project }) => {
    const file = join(dir, 'sdk-native.jsonl');
    writeFileSync(file, serialize([sdkPrompt('first', 'Build this.', project), reply]));
    const first = readClaudeSource(file);
    appendFileSync(
      file,
      serialize([
        sdkPrompt('second', 'Run the tests again.', project),
        { ...reply, uuid: 'reply-two' },
        sdkPrompt('third', 'Run the tests again.', project),
        { ...reply, uuid: 'reply-three' },
      ]),
    );
    const appended = readClaudeSource(file, first.checkpoint);
    expect(
      parseClaudeTranscript(appended.content, project)
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.sourceId),
    ).toEqual(['first', 'second', 'third']);
    const latestTurn = readClaudeSource(file, appended.checkpoint);
    expect(latestTurn.content).not.toContain('"uuid":"first"');
    expect(latestTurn.content).not.toContain('"uuid":"second"');
    expect(latestTurn.content).toContain('"uuid":"third"');
  }));

test('real sync and report creation retain an eligible Claude headless SDK prompt', () =>
  fixture(({ dir, home, project, cli }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const sources = join(dir, 'tool-claude', 'projects', 'workspace');
    mkdirSync(sources, { recursive: true });
    const file = join(sources, 'sdk-thread.jsonl');
    const prompt = 'Create headless.mjs exporting double(n).';
    const original = serialize([sdkPrompt('initial', prompt, project), reply]);
    writeFileSync(file, original);
    const first = cli(['sync', '--tool', 'claude', '--json']);
    expect(first.code).toBe(0);
    using store = new HistoryStore({ readonly: true });
    expect(
      store
        .records()
        .filter((record) => record.kind === 'prompt')
        .map((record) => record.text),
    ).toEqual([prompt]);
    const report = cli(['report', '--all', '--json', '--no-sync', '--no-open']);
    expect(report.code).toBe(0);
    const reportPath = JSON.parse(report.stdout).reportPath as string;
    expect(reportPath.startsWith(join(home, 'reports'))).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toContain(prompt);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(cli(['sync', '--tool', 'claude', '--json']).code).toBe(0);
    expect(store.records().filter((record) => record.kind === 'prompt')).toHaveLength(1);
    expect(store.verify().ok).toBe(true);
  }));

test('upgrading a cached Claude SDK source recovers its missing prompt without changing original records', () =>
  fixture(({ dir, project, cli }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const sources = join(dir, 'tool-claude', 'projects', 'workspace');
    mkdirSync(sources, { recursive: true });
    const file = join(sources, 'sdk-thread.jsonl');
    const prompt = 'Create the headless module.';
    const original = serialize([sdkPrompt('initial', prompt, project), reply]);
    writeFileSync(file, original);
    let originalRecord: { id: string; hash: string };
    {
      using previous = new HistoryStore();
      const session = previous.ensureSession({
        tool: 'claude-code',
        nativeSessionId: 'sdk-thread',
        cwd: project,
        transcriptPath: file,
        automaticSince: since,
      });
      const captured = previous.append(session.id, {
        kind: 'ai_output',
        text: 'Completed.',
        sourceId: 'reply-one',
        ts: at,
      }).record!;
      originalRecord = { id: captured.id, hash: captured.hash };
      // Reader version 3 successfully cached this source while dropping all SDK
      // prompts. Its bytes/mtime are unchanged when the upgraded reader runs.
      const stat = statSync(file);
      previous.setMeta(
        `source-cursor:claude-code:${digest(file)}`,
        JSON.stringify({
          version: 3,
          size: stat.size,
          mtime: stat.mtimeMs,
          ino: stat.ino,
          since,
        }),
      );
    }
    expect(cli(['sync', '--tool', 'claude', '--json']).code).toBe(0);
    using upgraded = new HistoryStore({ readonly: true });
    expect(
      upgraded
        .records()
        .filter((record) => record.kind === 'prompt')
        .map((record) => record.text),
    ).toEqual([prompt]);
    expect(
      upgraded.query('SELECT hash FROM records WHERE id=?').get(originalRecord.id),
    ).toEqual({ hash: originalRecord.hash });
    const report = JSON.parse(
      cli(['report', '--all', '--json', '--no-sync', '--no-open']).stdout,
    );
    const data = JSON.parse(
      readFileSync(join(dirname(report.reportPath), 'report.json'), 'utf8'),
    );
    expect(
      data.turns.map((turn: { prompt: { text: string } }) => turn.prompt.text),
    ).toEqual([prompt]);
    expect([
      ...readViewer(readFileSync(report.reportPath, 'utf8')).texts.values(),
    ]).toContain('Completed.');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(upgraded.verify().ok).toBe(true);
  }));
