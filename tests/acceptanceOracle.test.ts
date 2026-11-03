import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import {
  clearAuth,
  provisionAuth,
  scrub,
  snapshot,
  type Scenario,
} from '../scripts/acceptance/common.ts';
import {
  compareNativeRevisions,
  compareNativeSnapshots,
  nativeState,
} from '../scripts/acceptance/oracle.ts';
import { cleanup, makeTempDir } from './helpers.ts';

// These fixtures never start a model, collector, browser, or Showtail executable.
function scenario(): Scenario {
  const root = makeTempDir();
  const workspace = join(root, 'project');
  const home = join(root, 'history');
  const codex = join(root, 'isolated-codex');
  const claude = join(root, 'isolated-claude');
  for (const path of [workspace, home, codex, claude])
    mkdirSync(path, { recursive: true });
  return {
    root,
    workspace,
    home,
    bin: join(root, 'never-execute-showtail'),
    artifactDir: join(root, 'artifacts'),
    env: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude },
    checks: [],
    credentials: [],
  };
}

function jsonl(file: string, rows: unknown[]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

const codexPrompt = (id: string, text: string) => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: { type: 'UserMessage', id, content: [{ type: 'Text', text }] },
  },
});
const codexCompleted = { type: 'event_msg', payload: { type: 'task_complete' } };
const claudePrompt = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: text },
});
const claudeCompleted = (text: string) => ({
  type: 'assistant',
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

test('native provider failures remain distinct from successful task completion', () => {
  const s = scenario();
  try {
    jsonl(join(s.env.CODEX_HOME!, 'sessions', 'parent.jsonl'), [
      codexPrompt('request', 'Create the module.'),
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          error: {
            message: 'Selected model is at capacity.',
            codex_error_info: 'server_overloaded',
          },
        },
      },
    ]);
    expect(nativeState(s, 'codex').errors).toEqual([
      {
        promptId: 'request',
        code: 'server_overloaded',
        message: 'Selected model is at capacity.',
      },
    ]);
  } finally {
    cleanup(s.root);
  }
});

test('acceptance oracle preserves identical Codex submissions as distinct prompts', () => {
  const s = scenario();
  try {
    jsonl(join(s.env.CODEX_HOME!, 'sessions', 'parent.jsonl'), [
      { type: 'session_meta', payload: { id: 'parent', source: 'cli' } },
      codexPrompt('first', 'Build this.\nPreserve the initial prompt.'),
      codexCompleted,
      codexPrompt('second', 'Run the tests again.'),
      codexCompleted,
      codexPrompt('third', 'Run the tests again.'),
      codexCompleted,
    ]);
    const state = nativeState(s, 'codex');
    expect(state.messages.map((message) => message.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(state.messages.map((message) => message.text)).toEqual([
      'Build this.\nPreserve the initial prompt.',
      'Run the tests again.',
      'Run the tests again.',
    ]);
    expect(state.completed).toBe(3);
  } finally {
    cleanup(s.root);
  }
});

test('acceptance oracle counts repeated Claude end_turn messages once per submitted prompt', () => {
  const s = scenario();
  try {
    const file = join(s.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace', 'parent.jsonl');
    jsonl(file, [
      claudePrompt('first', 'Build this.'),
      claudeCompleted('Completed.'),
      claudeCompleted('A later completion update for the same turn.'),
      claudePrompt('second', 'Run the tests again.'),
      claudeCompleted('Tests passed.'),
      claudePrompt('third', 'Run the tests again.'),
    ]);
    const state = nativeState(s, 'claude');
    expect(state.messages.map((message) => message.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    // An acknowledged third prompt is still unfinished. Counting assistant
    // end_turn rows would incorrectly make it appear complete already.
    expect(state.completed).toBe(2);
  } finally {
    cleanup(s.root);
  }
});

test('Codex delegated rollouts keep child work outside the human and completion oracle', () => {
  const s = scenario();
  try {
    const sources = join(s.env.CODEX_HOME!, 'sessions', '2026', '11', '03');
    const parent = join(sources, 'parent.jsonl');
    const child = join(sources, 'child.jsonl');
    const edited = join(s.workspace, 'delegated.mjs');
    jsonl(parent, [
      { type: 'session_meta', payload: { id: 'parent', source: 'cli' } },
      codexPrompt('human-first', 'Delegate this task.'),
      codexCompleted,
      codexPrompt('human-unfinished', 'Review the result.'),
    ]);
    jsonl(child, [
      {
        type: 'session_meta',
        payload: {
          id: 'child',
          source: {
            subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } },
          },
        },
      },
      codexPrompt('agent-input', 'Create delegated.mjs for the parent agent.'),
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'child patch' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'FileChange',
            status: 'completed',
            changes: {
              [edited]: { type: 'add', content: 'export const square = n => n*n;' },
            },
          },
        },
      },
      codexCompleted,
    ]);
    const state = nativeState(s, 'codex');
    expect(state.messages.map((message) => message.id)).toEqual([
      'human-first',
      'human-unfinished',
    ]);
    expect(state.completed).toBe(1);
    expect(state.children).toBeGreaterThan(0);
    expect(state.sourceFiles).toContain(child);
    expect(state.applied).toContain(edited);
    expect(state.calls).toContainEqual({ name: 'apply_patch', input: 'child patch' });
  } finally {
    cleanup(s.root);
  }
});

test('Claude subagent files retain tool activity without adding human prompts or completions', () => {
  const s = scenario();
  try {
    const project = join(s.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    jsonl(join(project, 'parent.jsonl'), [claudePrompt('human', 'Delegate this task.')]);
    const child = join(project, 'parent', 'subagents', 'agent-one.jsonl');
    jsonl(child, [
      claudePrompt('delegated-input', 'Write the requested file.'),
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: 'child.mjs', content: 'done' },
            },
          ],
        },
      },
      claudeCompleted('Child completed.'),
    ]);
    const state = nativeState(s, 'claude');
    expect(state.messages.map((message) => message.id)).toEqual(['human']);
    expect(state.completed).toBe(0);
    expect(state.children).toBeGreaterThan(0);
    expect(state.sourceFiles).toContain(child);
    expect(state.calls.some((call) => call.name === 'Write')).toBe(true);
  } finally {
    cleanup(s.root);
  }
});

test('workspace snapshot includes .github and similarly named files while excluding .git metadata', () => {
  const s = scenario();
  try {
    const tracked = ['source.mjs', '.gitignore', '.github/copilot-instructions.md'];
    for (const file of [...tracked, '.git/config', '.git/hooks/pre-commit']) {
      mkdirSync(dirname(join(s.workspace, file)), { recursive: true });
      writeFileSync(join(s.workspace, file), 'original');
    }
    const before = snapshot(s.workspace);
    expect(
      Object.keys(before)
        .map((file) => file.replace(/\\/g, '/'))
        .sort(),
    ).toEqual(tracked.sort());
    writeFileSync(
      join(s.workspace, '.github/copilot-instructions.md'),
      'Injected instructions',
    );
    expect(snapshot(s.workspace)).not.toEqual(before);
    // Hooks can still be protected by taking their own explicit snapshot.
    const hooks = snapshot(join(s.workspace, '.git', 'hooks'));
    writeFileSync(join(s.workspace, '.git/hooks/pre-commit'), 'Changed hook');
    expect(snapshot(join(s.workspace, '.git', 'hooks'))).not.toEqual(hooks);
  } finally {
    cleanup(s.root);
  }
});

test('provisioned fake OAuth credentials are redacted and disposed without touching the source', () => {
  const s = scenario();
  const source = join(s.root, 'source-auth');
  const fakeBin = join(s.root, 'fake-bin');
  const oldCodexHome = process.env.CODEX_HOME;
  const oldPath = process.env.PATH;
  const oldWindowsPath = process.env.Path;
  const fake = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: `acceptance_access_${randomUUID()}`,
      refresh_token: `acceptance_refresh_${randomUUID()}`,
      id_token: `acceptance_identity_${randomUUID()}`,
    },
  };
  const bytes = JSON.stringify(fake);
  try {
    mkdirSync(source);
    mkdirSync(fakeBin);
    const executable = join(
      fakeBin,
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
    writeFileSync(executable, '#!/bin/sh\nexit 91\n');
    if (process.platform !== 'win32') chmodSync(executable, 0o700);
    writeFileSync(join(source, 'auth.json'), bytes);
    process.env.CODEX_HOME = source;
    process.env.PATH = fakeBin + delimiter + (oldPath ?? oldWindowsPath ?? '');
    if (process.platform === 'win32') process.env.Path = process.env.PATH;
    provisionAuth(s, 'codex');
    expect(s.env.SHOWTAIL_CODEX_BIN).toBe(executable);
    expect(readFileSync(join(s.env.CODEX_HOME!, 'auth.json'), 'utf8')).toBe(bytes);
    const redacted = scrub(bytes);
    for (const value of Object.values(fake.tokens)) expect(redacted).not.toContain(value);
    expect(redacted).toContain('[REDACTED]');
    clearAuth(s);
    expect(existsSync(join(s.env.CODEX_HOME!, 'auth.json'))).toBe(false);
    expect(readFileSync(join(source, 'auth.json'), 'utf8')).toBe(bytes);
    // Late-arriving logs must stay safe after the disposable auth file is gone.
    for (const value of Object.values(fake.tokens))
      expect(scrub(value)).toBe('[REDACTED]');
  } finally {
    clearAuth(s);
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (process.platform === 'win32') {
      if (oldWindowsPath === undefined) delete process.env.Path;
      else process.env.Path = oldWindowsPath;
    }
    cleanup(s.root);
  }
});

test('revision oracle rejects a collapsed intermediate Codex revision even when the final file is represented', () => {
  const s = scenario();
  try {
    const file = join(s.workspace, 'answer.mjs');
    const item = (id: string, change: unknown) => ({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'FileChange',
          id,
          status: 'completed',
          changes: { [file]: change },
        },
      },
    });
    jsonl(join(s.env.CODEX_HOME!, 'sessions', 'parent.jsonl'), [
      { type: 'session_meta', payload: { id: 'parent', source: 'cli' } },
      item('first-edit', { type: 'add', content: 'export const answer = 1;\n' }),
      // Forked rollouts can contain a copied ancestor metadata frame after the
      // physical child session's own metadata. It must not replace its identity.
      { type: 'session_meta', payload: { id: 'copied-ancestor', source: 'cli' } },
      item('second-edit', {
        type: 'update',
        unified_diff:
          '@@ -1 +1 @@\n-export const answer = 1;\n+export const answer = 2;\n',
      }),
      {
        ...item('failed-edit', { type: 'add', content: 'failed' }),
        payload: {
          type: 'item_completed',
          item: {
            type: 'FileChange',
            id: 'failed-edit',
            status: 'failed',
            changes: { [file]: { type: 'add', content: 'failed' } },
          },
        },
      },
    ]);
    const native = nativeState(s, 'codex');
    expect(native.appliedRevisions.map((revision) => revision.nativeId)).toEqual([
      'first-edit',
      'second-edit',
    ]);
    expect(
      native.appliedRevisions.every((revision) => revision.nativeSessionId === 'parent'),
    ).toBe(true);
    const captured = [
      {
        kind: 'edit',
        native_id: 'parent',
        source_id: `codex:edit:first-edit#${file}`,
        file,
        diff: '+ export const answer = 1;',
      },
      {
        kind: 'edit',
        native_id: 'parent',
        source_id: `codex:edit:second-edit#${file}`,
        file,
        diff: '- export const answer = 1;\n+ export const answer = 2;',
      },
    ];
    expect(compareNativeRevisions(native.appliedRevisions, captured).missing).toEqual([]);
    const collapsed = compareNativeRevisions(native.appliedRevisions, captured.slice(1));
    expect(collapsed.matched).toBe(1);
    expect(collapsed.missing.map((revision) => revision.nativeId)).toEqual([
      'first-edit',
    ]);
    expect(
      compareNativeRevisions(
        native.appliedRevisions,
        captured.map((record) => ({ ...record, diff: '+ incorrect;' })),
      ).matched,
    ).toBe(0);
    expect(
      compareNativeRevisions(
        native.appliedRevisions,
        captured.map((record) => ({ ...record, native_id: 'wrong-session' })),
      ).matched,
    ).toBe(0);
    expect(
      compareNativeRevisions(
        native.appliedRevisions,
        captured.map((record) => ({ ...record, tags: ['observed-file-state'] })),
      ).matched,
    ).toBe(0);
  } finally {
    cleanup(s.root);
  }
});

test('Claude Bash workspace snapshots remain distinct from authoritative applied revisions', () => {
  const s = scenario();
  try {
    const file = join(s.workspace, 'answer.mjs');
    const result = (id: string, lines: string[], created: boolean, failed = false) => ({
      type: 'user',
      sessionId: 'parent',
      timestamp: '2026-11-03T02:00:00.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed }] },
      toolUseResult: {
        bashEditDiff: { files: [{ filePath: file, created, hunks: [{ lines }] }] },
      },
    });
    jsonl(join(s.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace', 'parent.jsonl'), [
      result('first-edit', ['+export const answer = 1;'], true),
      result(
        'second-edit',
        ['-export const answer = 1;', '+export const answer = 2;'],
        false,
      ),
      result('failed-edit', ['+failed'], true, true),
    ]);
    const native = nativeState(s, 'claude');
    expect(native.appliedRevisions).toEqual([]);
    expect(native.bashSnapshots.map((revision) => revision.nativeId)).toEqual([
      'first-edit',
      'second-edit',
    ]);
    const captured = [
      {
        kind: 'edit',
        native_id: 'parent',
        source_id: `first-edit:edits#${file}`,
        file,
        diff: `--- ${file}\n+++ ${file}\n@@ -0,0 +1,1 @@\n+export const answer = 1;`,
      },
      {
        kind: 'edit',
        native_id: 'parent',
        source_id: `second-edit:edits#${file}`,
        file,
        diff: `--- ${file}\n+++ ${file}\n@@ -1,1 +1,1 @@\n-export const answer = 1;\n+export const answer = 2;`,
      },
    ];
    // Even an edit-shaped ledger row must not turn this workspace observation
    // into proof that the corresponding Bash call applied those exact changes.
    expect(compareNativeRevisions(native.bashSnapshots, captured).matched).toBe(0);
    const observed = captured.map((record) => ({
      ...record,
      kind: 'audit',
      tags: ['observed-workspace-delta'],
    }));
    expect(compareNativeSnapshots(native.bashSnapshots, observed).matched).toBe(2);
    expect(
      compareNativeSnapshots(native.bashSnapshots, observed.slice(1)).missing.map(
        (revision) => revision.nativeId,
      ),
    ).toEqual(['first-edit']);
    expect(
      compareNativeSnapshots(
        native.bashSnapshots,
        observed.map((record) => ({
          ...record,
          diff: undefined,
          tags: ['observed-file-state'],
        })),
      ).matched,
    ).toBe(0);
  } finally {
    cleanup(s.root);
  }
});

test('revision oracle correlates each successful Claude structured Write/Edit result by native tool ID', () => {
  const s = scenario();
  try {
    const file = join(s.workspace, 'answer.mjs');
    const call = (id: string, name: string) => ({
      type: 'assistant',
      sessionId: 'parent',
      cwd: s.workspace,
      message: { content: [{ type: 'tool_use', id, name, input: { file_path: file } }] },
    });
    const result = (id: string, data: unknown, failed = false) => ({
      type: 'user',
      sessionId: 'parent',
      cwd: s.workspace,
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed }] },
      toolUseResult: data,
    });
    jsonl(join(s.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace', 'parent.jsonl'), [
      call('write-one', 'Write'),
      result('write-one', {
        type: 'create',
        filePath: file,
        content: 'export const answer = 1;\n',
        structuredPatch: [],
      }),
      call('edit-two', 'Edit'),
      result('edit-two', {
        type: 'update',
        filePath: file,
        structuredPatch: [
          { lines: ['-export const answer = 1;', '+export const answer = 2;'] },
        ],
      }),
      call('failed-edit', 'Edit'),
      result(
        'failed-edit',
        { type: 'update', filePath: file, structuredPatch: [{ lines: ['+failed'] }] },
        true,
      ),
    ]);
    const native = nativeState(s, 'claude');
    expect(native.appliedRevisions.map((revision) => revision.nativeId)).toEqual([
      'write-one',
      'edit-two',
    ]);
    const captured = [
      {
        kind: 'edit',
        native_id: 'parent',
        source_id: `write-one:edits#${file}`,
        file,
        diff: '+export const answer = 1;',
      },
      {
        kind: 'edit',
        native_id: 'parent',
        source_id: `edit-two:edits#${file}`,
        file,
        diff: '-export const answer = 1;\n+export const answer = 2;',
      },
    ];
    expect(compareNativeRevisions(native.appliedRevisions, captured)).toEqual({
      expected: 2,
      matched: 2,
      missing: [],
    });
    const actualWriteRendering = {
      ...captured[0]!,
      source_id: `write-one#${file}`,
      diff: `--- ${file}\n+++ ${file}\n-\n+export const answer = 1;\n+`,
    };
    expect(
      compareNativeRevisions(native.appliedRevisions.slice(0, 1), [actualWriteRendering])
        .matched,
    ).toBe(1);
    expect(
      compareNativeRevisions(native.appliedRevisions.slice(0, 1), [
        { ...actualWriteRendering, diff: `--- ${file}\n+++ ${file}\n-\n+incorrect;\n+` },
      ]).matched,
    ).toBe(0);
    expect(
      compareNativeRevisions(native.appliedRevisions, captured.slice(1)).missing.map(
        (revision) => revision.nativeId,
      ),
    ).toEqual(['write-one']);
  } finally {
    cleanup(s.root);
  }
});

test('Claude context oracle inspects actual persisted request blobs instead of passing on empty evidence', () => {
  const s = scenario();
  try {
    jsonl(join(s.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace', 'parent.jsonl'), [
      {
        type: 'api-request-blob',
        sessionId: 'parent',
        message: {
          role: 'system',
          content: [{ type: 'text', text: 'Run showtail status before every task.' }],
        },
      },
      {
        type: 'api-request-blob',
        sessionId: 'parent',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Available skill descriptions.' }],
        },
      },
    ]);
    const native = nativeState(s, 'claude');
    expect(native.contexts).toHaveLength(2);
    expect(
      native.contexts.every((context) => !/\bshowtail\s+status\b/.test(context)),
    ).toBe(false);
    expect(native.messages).toEqual([]);
  } finally {
    cleanup(s.root);
  }
});
