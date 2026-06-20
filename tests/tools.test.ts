import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData, buildToolBlocks, renderMarkdown } from '../src/core/report.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import type { Event } from '../src/types.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function evt(tool: string, ts: string): Event {
  return {
    id: 'e' + ts,
    timestamp: ts,
    type: 'prompt',
    text: 't',
    tool: tool as Event['tool'],
    actor: 'student',
  };
}

describe('cross-tool attribution', () => {
  test('logEvent defaults tool to cli and honors an explicit tool', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const a = await logEvent(paths, { type: 'prompt', text: 'hi' });
      const b = await logEvent(paths, {
        type: 'ai_output',
        text: 'here is x',
        tool: 'github-copilot',
      });
      expect(a.event.tool).toBe('cli');
      expect(b.event.tool).toBe('github-copilot');
    } finally {
      cleanup(dir);
    }
  });

  test('addArtifact records the tool', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      writeFileSync(join(dir, 'a.txt'), 'x');
      const { artifact: art } = await addArtifact(paths, {
        filePath: 'a.txt',
        tool: 'github-copilot',
      });
      expect(art.tool).toBe('github-copilot');
    } finally {
      cleanup(dir);
    }
  });

  test('buildToolBlocks collapses contiguous tools and marks switches', () => {
    const blocks = buildToolBlocks([
      evt('claude-code', '2026-06-12T10:00:00.000Z'),
      evt('claude-code', '2026-06-12T10:05:00.000Z'),
      evt('github-copilot', '2026-06-12T10:10:00.000Z'),
      evt('codex', '2026-06-12T10:15:00.000Z'),
      evt('claude-code', '2026-06-12T10:20:00.000Z'),
    ]);
    expect(blocks.map((b) => b.tool)).toEqual([
      'claude-code',
      'github-copilot',
      'codex',
      'claude-code',
    ]);
    expect(blocks[0]!.count).toBe(2);
    expect(blocks[0]!.from).toBe('2026-06-12T10:00:00.000Z');
    expect(blocks[0]!.to).toBe('2026-06-12T10:05:00.000Z');
  });

  test('report shows a Tools-used section and per-event tool badges', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Mixed' });
      const paths = pathsForRoot(dir);
      await logEvent(paths, { type: 'prompt', text: 'q1', tool: 'github-copilot' });
      await logEvent(paths, { type: 'ai_output', text: 'd1', tool: 'claude-code' });
      await logEvent(paths, { type: 'prompt', text: 'q2', tool: 'codex' });

      const data = buildReportData(paths);
      const tools = data.tools.map((t) => t.tool).sort();
      expect(tools).toContain('claude-code');
      expect(tools).toContain('github-copilot');
      expect(tools).toContain('codex');

      const md = renderMarkdown(data);
      expect(md).toContain('## Tools used');
      expect(md).toContain('GitHub Copilot');
      expect(md).toContain('Claude Code');
      expect(md).toContain('OpenAI Codex');
    } finally {
      cleanup(dir);
    }
  });
});
