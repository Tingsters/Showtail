import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './centralHelpers.ts';
import { getPlugin } from '../src/plugins/registry.ts';
import { HistoryStore } from '../src/core/history.ts';
import { captureTranscript } from '../src/core/historyCapture.ts';
import { threadToTranscript } from '../src/core/codexAppServer.ts';

const timestamp = '2026-11-01T12:00:00.000Z';
for (const tool of [
  'claude-code',
  'codex',
  'copilot-cli',
  'github-copilot',
  'antigravity-cli',
  'antigravity-ide',
]) {
  test(`${tool}: native transcript edits cross project boundaries`, () =>
    fixture(async ({ dir, project }) => {
      const other = join(dir, 'other-project');
      mkdirSync(other);
      writeFileSync(join(other, 'package.json'), '{}');
      const files = [join(project, 'index.ts'), join(other, 'index.ts')];
      let records: unknown[];
      if (tool === 'claude-code')
        records = [
          {
            type: 'user',
            uuid: 'user-1',
            timestamp,
            promptSource: 'typed',
            sessionId: 'multi',
            cwd: project,
            message: { role: 'user', content: 'Change both projects' },
          },
          {
            type: 'assistant',
            uuid: 'assistant-1',
            timestamp,
            message: {
              role: 'assistant',
              content: files.map((file, i) => ({
                type: 'tool_use',
                id: `edit-${i}`,
                name: 'Write',
                input: { file_path: file, content: 'export {};' },
              })),
            },
          },
        ];
      else if (tool === 'codex')
        records = [
          { type: 'session_meta', payload: { id: 'multi', cwd: project } },
          {
            type: 'event_msg',
            timestamp,
            payload: { type: 'user_message', message: 'Change both projects' },
          },
          ...files.map((file, i) => ({
            type: 'response_item',
            timestamp,
            payload: {
              type: 'custom_tool_call',
              name: 'apply_patch',
              call_id: `edit-${i}`,
              input: `*** Begin Patch\n*** Add File: ${file}\n+export {};\n*** End Patch`,
            },
          })),
        ];
      else if (tool === 'copilot-cli')
        records = [
          {
            type: 'session.start',
            timestamp,
            data: { sessionId: 'multi', context: { cwd: project } },
          },
          {
            type: 'user.message',
            id: 'user-1',
            timestamp,
            data: { content: 'Change both projects' },
          },
          ...files.map((file, i) => ({
            type: 'tool.execution_start',
            timestamp,
            data: {
              toolCallId: `edit-${i}`,
              toolName: 'edit',
              arguments: { path: file },
            },
          })),
        ];
      else if (tool === 'github-copilot')
        records = [
          {
            sessionId: 'multi',
            requests: [
              {
                requestId: 'request-1',
                timestamp: Date.parse(timestamp),
                message: { text: 'Change both projects' },
                response: files.map((file) => ({
                  kind: 'textEditGroup',
                  uri: { fsPath: file },
                  edits: [[{ text: 'export {};', range: {} }]],
                })),
              },
            ],
          },
        ];
      else
        records = [
          {
            step_index: 0,
            type: 'USER_INPUT',
            created_at: timestamp,
            content: 'Change both projects',
          },
          ...files.map((file, i) => ({
            step_index: i + 1,
            type: 'CODE_ACTION',
            created_at: timestamp,
            content: `Created file ${pathToFileURL(file).href} with requested content.`,
          })),
        ];
      const path = join(dir, 'native.jsonl');
      writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n'));
      const transcript = await getPlugin(tool)!.migration!.read(
        { path, providerSessionId: 'multi', mtimeMs: Date.now(), cwd: project },
        project,
      );
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool,
        nativeSessionId: 'multi',
        cwd: project,
      });
      captureTranscript(store, session, transcript);
      expect(
        store
          .records()
          .filter((r) => r.kind === 'edit')
          .map((r) => r.file)
          .sort(),
      ).toEqual([...files].sort());
      expect(store.projects()).toHaveLength(2);
      expect(store.verify().ok).toBe(true);
    }));
}

test('Codex app-server central mapping retains absolute cross-project file changes', () =>
  fixture(async ({ dir, project }) => {
    const file = join(dir, 'another-project', 'index.ts');
    const transcript = threadToTranscript(
      'multi',
      [
        {
          item: {
            type: 'fileChange',
            id: 'edit-1',
            status: 'completed',
            changes: [{ path: file, kind: 'add', diff: 'export {};' }],
          },
          completedAtMs: Date.parse(timestamp),
        },
      ],
      { root: project, includeOutsideEdits: true },
    );
    expect(transcript.messages.find((m) => m.role === 'edit')?.edits?.[0]?.file).toBe(
      file,
    );
  }));
