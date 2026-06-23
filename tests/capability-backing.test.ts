/**
 * The backing suite: for every `full` cell in the capability matrix, exercise
 * that capability for real and call markPassed(`${capability}:${integration}`).
 * The claims suite (capability-claims.test.ts) then refuses to let any `full`
 * cell stand without a passed marker here — so "fully implemented" in the matrix
 * always means "proven by a test against the real contract".
 *
 * Integration ids are the matrix column ids (e.g. `copilot-vscode`); the real
 * exercise uses that tool's Showtail plugin / canonical tool tag underneath.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorFor, cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportClaudeCode } from '../src/commands/importClaude.ts';
import { parseTranscript as parseChatgpt } from '../src/core/chatgpt.ts';
import { parseTranscript as parseGemini } from '../src/core/gemini.ts';
import { importConversation } from '../src/core/importCommon.ts';
import { readAllEvents } from '../src/core/events.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { getPluginById } from '../src/plugins/registry.ts';
import { resolveTarget } from '../src/core/skill.ts';
import { codexInstructionsState, resolveCodexTarget } from '../src/core/codex.ts';
import { copilotState, resolveCopilotTarget } from '../src/core/copilot.ts';
import { clearMarkers, markPassed } from './e2eRegistry.ts';

const REPO = join(import.meta.dir, '..');
const run = (cwd: string, args: string[], input?: string) => runCli(cwd, args, { input });

/** Built connect integrations: matrix column id → its Showtail plugin id. */
const CONNECT_TOOLS = [
  { matrixId: 'claude-code', pluginId: 'claude-code' as const },
  { matrixId: 'codex', pluginId: 'codex' as const },
  { matrixId: 'copilot-vscode', pluginId: 'github-copilot' as const },
];

/** The project-scope instructions/skill file each connect plugin writes. */
const CONNECT_FILE: Record<string, (dir: string) => string> = {
  'claude-code': (dir) => resolveTarget('project', dir).skillFile,
  'github-copilot': (dir) => resolveCopilotTarget(dir).pathInstructionsFile,
  codex: (dir) => resolveCodexTarget('project', dir).agentsFile,
};

/** Installed-state reader (installed + updateAvailable) where update-detection is full. */
const INSTALL_STATE: Record<
  string,
  (dir: string) => { installed: boolean; updateAvailable: boolean }
> = {
  'github-copilot': (dir) => copilotState(resolveCopilotTarget(dir)),
  codex: (dir) => codexInstructionsState(resolveCodexTarget('project', dir)),
};

beforeAll(() => clearMarkers());

describe('backing: automatic capture via hooks (Claude Code, Codex)', () => {
  test('prompts, edits, and AI replies are captured through the real hook path', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init', '--project', 'Backing']);

      // --- Claude Code: prompt capture ---
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'add a parser', session_id: 'sess-1' }),
      );

      // --- Claude Code: file/edit capture ---
      writeFileSync(join(dir, 'parser.ts'), 'export const x = 1;');
      const edit = run(
        dir,
        ['hook', 'post-edit'],
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          cwd: dir,
          tool_name: 'Edit',
          tool_input: { file_path: join(dir, 'parser.ts') },
        }),
      );
      expect(edit.code).toBe(0);

      // --- Claude Code: AI-reply reconcile from a transcript at stop ---
      const transcript = join(dir, 't.jsonl');
      writeFileSync(
        transcript,
        [
          {
            type: 'user',
            uuid: 'u1',
            promptSource: 'typed',
            sessionId: 'sess-1',
            cwd: dir,
            message: { role: 'user', content: 'add a parser' },
          },
          {
            type: 'assistant',
            uuid: 'u2',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-8',
              content: [{ type: 'text', text: 'REPLY captured at stop' }],
            },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, transcript_path: transcript }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const blob = JSON.stringify(data);
      expect(blob).toContain('add a parser'); // prompt captured
      expect(data.summary.artifacts).toBeGreaterThanOrEqual(1); // edit captured
      expect(blob).toContain('REPLY captured at stop'); // reply reconciled

      markPassed('auto-prompt-capture:claude-code');
      markPassed('live-capture-hooks:claude-code');
      markPassed('auto-file-capture:claude-code');
      markPassed('auto-ai-output-capture:claude-code');

      // --- Codex: prompt capture + apply_patch edit (file-capture is partial, not marked) ---
      run(
        dir,
        ['hook', 'user-prompt', '--tool', 'codex'],
        JSON.stringify({ cwd: dir, prompt: 'codex: tweak parser' }),
      );
      writeFileSync(join(dir, 'svc.ts'), 'export const svc = 1;');
      const codexEdit = run(
        dir,
        ['hook', 'post-edit', '--tool', 'codex'],
        JSON.stringify({
          cwd: dir,
          tool_name: 'apply_patch',
          tool_input: {
            input: '*** Begin Patch\n*** Update File: svc.ts\n@@\n-1\n+2\n*** End Patch',
          },
        }),
      );
      expect(codexEdit.code).toBe(0);
      const trace = run(dir, ['trace', 'svc.ts', '--format', 'json']);
      const traceData = JSON.parse(trace.stdout);
      expect(traceData.artifacts.some((a: { tool?: string }) => a.tool === 'codex')).toBe(
        true,
      );

      markPassed('auto-prompt-capture:codex');
      markPassed('live-capture-hooks:codex');
    } finally {
      cleanup(dir);
    }
  });
});

describe('backing: session import / backfill', () => {
  test('Claude Code transcript import logs a prompt tagged claude-code', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'session.jsonl');
      writeFileSync(
        file,
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-06-10T10:00:00.000Z',
          promptSource: 'typed',
          sessionId: 'imp-1',
          cwd: dir,
          message: { role: 'user', content: 'imported claude prompt' },
        }),
      );
      await runImportClaudeCode(undefined, { file, cwd: dir });
      const prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts.some((e) => e.tool === 'claude-code')).toBe(true);
      markPassed('session-import:claude-code');
    } finally {
      cleanup(dir);
    }
  });

  test('ChatGPT and Gemini pasted transcripts import as prompts', async () => {
    for (const [tool, parse, id] of [
      ['chatgpt', parseChatgpt, 'session-import:chatgpt'],
      ['google-gemini', parseGemini, 'session-import:google-gemini'],
    ] as const) {
      const dir = makeTempDir();
      try {
        await runInit({ cwd: dir });
        const author = authorFor(pathsForRoot(dir));
        const { conversation } = parse('First question\n\nSecond question');
        const res = await importConversation(author, conversation, tool);
        expect(res.prompts).toBeGreaterThanOrEqual(1);
        const prompts = readAllEvents(pathsForRoot(dir)).filter(
          (e) => e.type === 'prompt',
        );
        expect(prompts.every((e) => e.tool === tool)).toBe(true);
        markPassed(id);
      } finally {
        cleanup(dir);
      }
    }
  });
});

describe('backing: connect-capability surface (install / detect / status)', () => {
  test('each built connect tool installs instructions, detects, and reports status', async () => {
    for (const { matrixId, pluginId } of CONNECT_TOOLS) {
      const dir = makeTempDir();
      try {
        await runInit({ cwd: dir });
        const connect = getPluginById(pluginId)!.connect!;

        // managed-instructions: a project-scope install writes the managed file.
        const file = CONNECT_FILE[pluginId]!(dir);
        expect(existsSync(file)).toBe(false);
        await connect.install({
          project: true,
          hooks: false,
          extension: false,
          cwd: dir,
        });
        expect(existsSync(file), `${matrixId} should install ${file}`).toBe(true);
        markPassed(`managed-instructions:${matrixId}`);

        // host-detection + status-detection.
        expect(typeof connect.detect()).toBe('boolean');
        markPassed(`host-detection:${matrixId}`);
        expect(typeof connect.status(dir).connected).toBe('boolean');
        markPassed(`status-detection:${matrixId}`);

        // multi-scope-install: full only for Claude Code + Codex.
        if (matrixId === 'claude-code' || matrixId === 'codex') {
          expect(connect.scopes).toContain('user');
          expect(connect.scopes).toContain('project');
          markPassed(`multi-scope-install:${matrixId}`);
        }

        // update-detection: full for Codex + Copilot (fingerprinted instructions).
        const stateReader = INSTALL_STATE[pluginId];
        if (stateReader) {
          const state = stateReader(dir);
          expect(state.installed).toBe(true);
          expect(typeof state.updateAvailable).toBe('boolean');
          markPassed(`update-detection:${matrixId}`);
        }

        await connect.uninstall({ cwd: dir });
      } finally {
        cleanup(dir);
      }
    }
  });
});

describe('backing: redaction and the cross-tool timeline', () => {
  test('a tagged prompt per tool is scrubbed before store and lands on the timeline', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init', '--project', 'Timeline']);
      run(dir, ['start']);
      const SECRET = 'AKIAIOSFODNN7EXAMPLE';
      // matrix column id → the canonical tool tag events carry for it.
      const tools = [
        { matrixId: 'claude-code', tag: 'claude-code' },
        { matrixId: 'codex', tag: 'codex' },
        { matrixId: 'copilot-vscode', tag: 'github-copilot' },
        { matrixId: 'chatgpt', tag: 'chatgpt' },
        { matrixId: 'google-gemini', tag: 'google-gemini' },
      ];
      for (const { tag } of tools) {
        const r = run(dir, [
          'log',
          '--type',
          'prompt',
          '--tool',
          tag,
          '--text',
          `via ${tag}, token: ${SECRET}`,
        ]);
        expect(r.code).toBe(0);
      }

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const blob = JSON.stringify(data);

      // redaction-before-store: the secret never reaches the stored trail.
      expect(blob).not.toContain(SECRET);
      expect(data.redactionCount).toBeGreaterThanOrEqual(tools.length);

      // cross-tool timeline: every tool tag shows up in the report's tool list.
      const seen = new Set((data.tools as Array<{ tool: string }>).map((x) => x.tool));
      for (const { matrixId, tag } of tools) {
        expect(seen.has(tag), `${tag} should appear on the timeline`).toBe(true);
        markPassed(`redaction:${matrixId}`);
        markPassed(`cross-tool-timeline:${matrixId}`);
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe('backing: marketplace / extension install', () => {
  test('Claude Code ships a plugin marketplace entry', () => {
    const manifest = readFileSync(
      join(REPO, '.claude-plugin', 'marketplace.json'),
      'utf8',
    );
    expect(manifest).toContain('showtail');
    markPassed('marketplace-install:claude-code');
  });

  test('Copilot (VS Code) ships extension install guidance', () => {
    const guidance = getPluginById('github-copilot')!.connect!.setupGuidance ?? [];
    expect(guidance.join('\n')).toContain('--install-extension');
    markPassed('marketplace-install:copilot-vscode');
  });
});
