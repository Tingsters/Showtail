import { expect, test } from 'bun:test';
import { HistoryStore } from '../src/core/history.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { renderHtml, renderMarkdown } from '../src/core/report.ts';
import { fixture } from './centralHelpers.ts';

test('standalone shell observations are reviewable without becoming applied edits', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'claude-code', cwd: project });
    store.append(session.id, { kind: 'prompt', text: 'Create a parser.' });
    const call = store.append(session.id, {
      kind: 'tool_call',
      toolName: 'Bash',
      text: 'Write parser, then run tests.\n\nThe tests failed.',
      isError: true,
    }).record!;
    const data = buildHistoryReport(store, { kind: 'all' });
    data.fileObservations = [
      {
        recordId: 'observation',
        path: 'parser<script>.ts',
        sha256: 'a'.repeat(64),
        observedAt: '2026-01-01T12:00:00.000Z',
        basis: 'shell-write-attempt',
        toolOutcome: 'failed',
        toolCallId: call.id,
      },
    ];
    const html = renderHtml(data);
    const markdown = renderMarkdown(data);
    expect(html).toContain('<h2>File observations</h2>');
    expect(html).toContain('parser&lt;script&gt;.ts');
    expect(html).not.toContain('parser<script>.ts');
    expect(html).toContain('failed shell attempt');
    expect(html).toContain(`href="#st-tool-${call.id}"`);
    expect(html).toContain(`id="st-tool-${call.id}"`);
    expect(markdown).toContain('## File observations');
    expect(markdown).toContain('may include later or manual changes');
    expect(markdown).toContain('SHA-256: `' + 'a'.repeat(64) + '`');
    expect(data.summary.artifacts).toBe(0);
    expect(data.turns[0]!.codeChanges).toEqual([]);
    expect(data.turns).toHaveLength(1);
  }));

test('observations already attached to a native edit do not create duplicate visual work', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'codex', cwd: project });
    store.append(session.id, { kind: 'prompt', text: 'Build the parser.' });
    const data = buildHistoryReport(store, { kind: 'all' });
    data.fileObservations = [
      {
        recordId: 'observation',
        editId: 'native-edit',
        path: 'parser.ts',
        sha256: 'a'.repeat(64),
        observedAt: '2026-01-01T12:00:00.000Z',
      },
    ];
    expect(renderHtml(data)).not.toContain('<h2>File observations</h2>');
    expect(renderMarkdown(data)).not.toContain('## File observations');
  }));

test('workspace deltas retain reviewable diffs without asserting authorship or applied revisions', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'claude-code', cwd: project });
    store.append(session.id, { kind: 'prompt', text: 'Inspect the workspace.' });
    const data = buildHistoryReport(store, { kind: 'all' });
    data.fileObservations = [
      {
        recordId: 'shared-workspace',
        path: 'other-agent.mjs',
        observedAt: '2026-01-01T12:00:00.000Z',
        basis: 'workspace-delta',
        diff: '@@ -0,0 +1 @@\n+export const text = "<script>";',
      },
    ];
    const html = renderHtml(data);
    const markdown = renderMarkdown(data);
    for (const rendered of [html, markdown]) {
      expect(rendered).toContain('during shell activity');
      expect(rendered).toContain('author unverified');
      expect(rendered).toContain('Observed workspace diff');
      expect(rendered).not.toContain('SHA-256:');
    }
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('text = "<script>"');
    expect(markdown).toContain('```diff');
    expect(data.summary.artifacts).toBe(0);
    expect(data.turns[0]!.codeChanges).toEqual([]);
  }));

test('unlinked native observations do not invent shell activity or applied edits', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'claude-code', cwd: project });
    store.append(session.id, { kind: 'prompt', text: 'Update the parser.' });
    const data = buildHistoryReport(store, { kind: 'all' });
    data.fileObservations = [
      {
        recordId: 'unlinked-native-observation',
        path: 'parser.ts',
        sha256: 'a'.repeat(64),
        observedAt: '2026-01-01T12:00:00.000Z',
        basis: 'native-edit',
      },
    ];
    for (const rendered of [renderHtml(data), renderMarkdown(data)]) {
      expect(rendered).toContain('after tool activity');
      expect(rendered).not.toContain('shell attempt');
      expect(rendered).not.toContain('after shell activity');
    }
    expect(data.summary.artifacts).toBe(0);
    expect(data.turns[0]!.codeChanges).toEqual([]);
    expect(data.turns).toHaveLength(1);
  }));
