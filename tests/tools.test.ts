import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData, buildToolBlocks, renderMarkdown } from '../src/core/report.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { toolCaptureStatus, toolStatuses } from '../src/core/tools.ts';
import { writeGlobalConfig } from '../src/core/globalConfig.ts';
import { connectPlugins } from '../src/plugins/registry.ts';
import type { Event } from '../src/types.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

function evt(tool: string, ts: string): Event {
  return {
    id: 'e' + ts,
    timestamp: ts,
    type: 'prompt',
    text: 't',
    tool: tool as Event['tool'],
    actorSlug: 'tester-at-example-com',
  };
}

describe('cross-tool attribution', () => {
  test('logEvent defaults tool to cli and honors an explicit tool', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const a = await logEvent(author, { type: 'prompt', text: 'hi' });
      const b = await logEvent(author, {
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
      const author = authorFor(paths);
      writeFileSync(join(dir, 'a.txt'), 'x');
      const { artifact: art } = await addArtifact(author, {
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
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'q1', tool: 'github-copilot' });
      await logEvent(author, { type: 'ai_output', text: 'd1', tool: 'claude-code' });
      await logEvent(author, { type: 'prompt', text: 'q2', tool: 'codex' });

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

describe('tool capture status', () => {
  test('reports automatic, manual, and disconnected modes', () => {
    expect(
      toolCaptureStatus('codex', [
        { tool: 'codex', label: 'OpenAI Codex', connected: true, hooksActive: true },
      ]),
    ).toEqual({
      tool: 'codex',
      mode: 'automatic',
      connected: true,
      hooksActive: true,
    });
    expect(
      toolCaptureStatus('codex', [
        { tool: 'codex', label: 'OpenAI Codex', connected: true, hooksActive: false },
      ]),
    ).toEqual({
      tool: 'codex',
      mode: 'manual',
      connected: true,
      hooksActive: false,
    });
    expect(toolCaptureStatus('not-a-tool', [])).toEqual({
      tool: 'not-a-tool',
      mode: 'disconnected',
      connected: false,
      hooksActive: false,
    });
  });

  test('treats only active native integrations as automatic and resolves aliases', () => {
    expect(
      toolCaptureStatus('copilot', [
        {
          tool: 'copilot',
          label: 'GitHub Copilot',
          connected: true,
          captureActive: true,
        },
      ]),
    ).toEqual({
      tool: 'copilot',
      mode: 'automatic',
      connected: true,
      hooksActive: false,
    });
    expect(
      toolCaptureStatus('copilot', [
        { tool: 'copilot', label: 'GitHub Copilot', connected: true },
      ]),
    ).toEqual({
      tool: 'copilot',
      mode: 'manual',
      connected: true,
      hooksActive: false,
    });
    expect(
      toolCaptureStatus('claude-code', [
        { tool: 'claude', label: 'Claude Code', connected: true, hooksActive: true },
      ]),
    ).toEqual({
      tool: 'claude',
      mode: 'automatic',
      connected: true,
      hooksActive: true,
    });

    expect(
      toolCaptureStatus('antigravity-ide', [
        {
          tool: 'antigravity-ide',
          label: 'Antigravity IDE',
          connected: true,
          hooksActive: false,
          captureActive: true,
        },
      ]),
    ).toEqual({
      tool: 'antigravity-ide',
      mode: 'automatic',
      connected: true,
      hooksActive: false,
    });
  });

  test('filters tool status by CLI name, id, or alias', () => {
    const dir = makeTempDir();
    try {
      expect(toolStatuses(dir, 'claude-code').map((status) => status.tool)).toEqual([
        'claude',
      ]);
      expect(toolStatuses(dir, 'not-a-tool')).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('a global stop overrides stale state for every hook-backed plugin', () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    const hookPlugins = connectPlugins().filter((plugin) => plugin.connect.hooks);
    const originalStatus = new Map(
      hookPlugins.map((plugin) => [plugin, plugin.connect.status] as const),
    );
    try {
      process.env.SHOWTAIL_HOME = home;
      writeGlobalConfig({
        version: 1,
        captureDisabledTools: hookPlugins.map((plugin) => plugin.cliName),
      });
      for (const plugin of hookPlugins) {
        plugin.connect.status = () => {
          throw new Error(`status probe must not run for disabled ${plugin.cliName}`);
        };
      }

      const statuses = new Map(toolStatuses(cwd).map((status) => [status.tool, status]));
      for (const plugin of hookPlugins) {
        expect(statuses.get(plugin.cliName)).toEqual(
          expect.objectContaining({
            tool: plugin.cliName,
            connected: false,
            hooksActive: false,
            captureActive: false,
          }),
        );
      }
    } finally {
      for (const [plugin, status] of originalStatus) plugin.connect.status = status;
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(cwd);
      cleanup(home);
    }
  });
});
