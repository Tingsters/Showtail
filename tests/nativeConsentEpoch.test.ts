import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  disableToolCapture,
  enableToolCapture,
  readGlobalConfig,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { HistoryStore, digest } from '../src/core/history.ts';
import { syncHistory } from '../src/core/historySync.ts';
import { fixture } from './centralHelpers.ts';

const firstEpoch = '2026-01-01T00:00:00.000Z';
const created = '2026-01-02T12:00:00.000Z';
const resumed = '2026-01-02T12:00:02.000Z';
const cutoff = '2099-01-01T00:00:00.000Z';
type Prompt = { id: string; at: string; text: string };
const prompts: Prompt[] = [
  { id: 'before', at: created, text: 'Before pause.' },
  { id: 'paused', at: '2026-01-02T12:00:01.000Z', text: 'During pause.' },
  { id: 'resumed', at: '2026-01-02T12:00:03.000Z', text: 'After resume.' },
];
function source(tool: 'codex' | 'claude', project: string, items: Prompt[]) {
  if (tool === 'claude')
    return (
      items
        .map((item) =>
          JSON.stringify({
            type: 'user',
            uuid: item.id,
            sessionId: 'epoch-session',
            cwd: project,
            timestamp: item.at,
            message: { content: item.text },
          }),
        )
        .join('\n') + '\n'
    );
  return (
    [
      {
        timestamp: created,
        type: 'session_meta',
        payload: { id: 'epoch-session', cwd: project, source: 'cli' },
      },
      ...items.map((item) => ({
        timestamp: item.at,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: item.id,
          started_at_ms: Date.parse(item.at),
          completed_at_ms: Date.parse(item.at),
          item: {
            type: 'UserMessage',
            id: item.id,
            content: [{ type: 'text', text: item.text }],
          },
        },
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}

test('excluded sources cache only a fingerprint and are reevaluated after append', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: resumed });
    enableToolCapture('claude', resumed);
    const path = sourcePath('claude');
    writeOpenSource(path, source('claude', project, prompts.slice(0, 2)));
    using store = new HistoryStore();
    await syncHistory(store, { tool: 'claude', cutoff });
    const key = `source-cursor:claude-code:${digest(path)}`;
    const saved = store.meta(key)!;
    expect(JSON.parse(saved)).toMatchObject({ since: resumed });
    expect(JSON.parse(saved).version).toBeGreaterThanOrEqual(4);
    expect(saved).not.toContain('Before pause.');
    expect(saved).not.toContain('During pause.');
    expect(store.sessions()).toHaveLength(0);
    expect(store.records()).toHaveLength(0);
    expect(store.query('SELECT count(*) AS n FROM objects').get()).toEqual({ n: 0 });
    expect((await syncHistory(store, { tool: 'claude', cutoff })).skipped).toBe(1);
    expect(store.meta(key)).toBe(saved);
    writeOpenSource(path, source('claude', project, prompts));
    await syncHistory(store, { tool: 'claude', cutoff });
    expect(
      store
        .records()
        .filter((record) => record.kind === 'prompt')
        .map((record) => record.text),
    ).toEqual(['After resume.']);
    expect(store.meta(key)).not.toBe(saved);
  }));
function sourcePath(tool: 'codex' | 'claude') {
  const directory =
    tool === 'codex'
      ? join(process.env.CODEX_HOME!, 'sessions')
      : join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
  mkdirSync(directory, { recursive: true });
  return join(
    directory,
    tool === 'codex' ? 'rollout-epoch-session.jsonl' : 'epoch-session.jsonl',
  );
}
function writeOpenSource(path: string, content: string) {
  writeFileSync(path, content);
  // Windows can defer LastWriteTime while the provider holds its writer open.
  // Native persisted item timestamps, rather than this metadata, govern consent.
  utimesSync(path, new Date(created), new Date(created));
}

for (const tool of ['codex', 'claude'] as const) {
  for (const pause of ['global', 'tool'] as const) {
    test(`${tool}: ${pause} resume collects new work from an open source with stale mtime`, () =>
      fixture(async ({ project }) => {
        writeGlobalConfig({
          version: 2,
          captureEnabled: true,
          captureSince: firstEpoch,
          captureResumedAt: firstEpoch,
        });
        enableToolCapture(tool, firstEpoch);
        const path = sourcePath(tool);
        writeOpenSource(path, source(tool, project, prompts.slice(0, 1)));
        using store = new HistoryStore();
        await syncHistory(store, { tool, cutoff });
        const original = store
          .records()
          .map((record) => ({ id: record.id, hash: record.hash }));
        if (pause === 'global')
          writeGlobalConfig({ ...readGlobalConfig(), captureEnabled: false });
        else disableToolCapture(tool);
        writeOpenSource(path, source(tool, project, prompts.slice(0, 2)));
        await syncHistory(store, { tool, cutoff });
        expect(
          store
            .records()
            .filter((record) => record.kind === 'prompt')
            .map((record) => record.text),
        ).toEqual(['Before pause.']);
        if (pause === 'global')
          writeGlobalConfig({
            ...readGlobalConfig(),
            captureEnabled: true,
            captureResumedAt: resumed,
          });
        else enableToolCapture(tool, resumed);
        writeOpenSource(path, source(tool, project, prompts));
        await syncHistory(store, { tool, cutoff });
        expect(
          store
            .records()
            .filter((record) => record.kind === 'prompt')
            .map((record) => record.text),
        ).toEqual(['Before pause.', 'After resume.']);
        expect(store.sourceReads()[0]).toMatchObject({
          prompts: 1,
          matched: 1,
          missing: 0,
        });
        for (const row of original)
          expect(store.query('SELECT hash FROM records WHERE id=?').get(row.id)).toEqual({
            hash: row.hash,
          });
        const count = store.records().length;
        await syncHistory(store, { tool, cutoff });
        expect(store.records()).toHaveLength(count);
        expect(store.verify().ok).toBe(true);
      }));
  }
  test(`${tool}: an old source can contain eligible new work without backfilling old prompts`, () =>
    fixture(async ({ project }) => {
      writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: resumed });
      enableToolCapture(tool, resumed);
      const path = sourcePath(tool);
      writeOpenSource(path, source(tool, project, prompts));
      using store = new HistoryStore();
      await syncHistory(store, { tool, cutoff });
      expect(
        store
          .records()
          .filter((record) => record.kind === 'prompt')
          .map((record) => record.text),
      ).toEqual(['After resume.']);
      expect(store.sourceReads()[0]).toMatchObject({
        prompts: 1,
        matched: 1,
        missing: 0,
      });
    }));
}
