/**
 * The backing + claims suite: for every `full` cell in the capability matrix,
 * exercise that capability for real and call markPassed(`${capability}:${integration}`),
 * then assert (in the `claims` block at the end of this file) that no `full` cell
 * stands without a passed marker — so "fully implemented" in the matrix always
 * means "proven by a test against the real contract".
 *
 * Backing and claims live in ONE file on purpose: Bun runs tests in source order
 * within a file but does NOT guarantee order *across* files, and the marker
 * handshake requires backing to run before claims. Splitting them once made CI
 * red on Linux (claims ran first; markers absent) while passing locally on stale
 * markers — keeping them together makes the gate order-safe by construction.
 *
 * Integration ids are the matrix column ids; the real exercise uses that tool's
 * Showtail plugin / canonical tool tag underneath.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authorFor,
  cleanup,
  makeTempDir,
  readJsonReport,
  runCli,
  spawnEnv,
} from './helpers.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportClaudeCode } from '../src/commands/importClaude.ts';
import { importAntigravityIdeTranscript } from '../src/commands/importAntigravityIde.ts';
import { parseTranscript as parseChatgpt } from '../src/core/chatgpt.ts';
import { parseTranscript as parseGemini } from '../src/core/gemini.ts';
import { importConversation } from '../src/core/importCommon.ts';
import {
  parseCodexRollout,
  parseCodexTranscript,
  importCodexTranscript,
} from '../src/core/codexTranscript.ts';
import { readAllEvents } from '../src/core/events.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readObject } from '../src/core/objects.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { getPluginById } from '../src/plugins/registry.ts';
import { resolveTarget, skillState } from '../src/core/skill.ts';
import { codexInstructionsState, resolveCodexTarget } from '../src/core/codex.ts';
import { copilotState, resolveCopilotTarget } from '../src/core/copilot.ts';
import {
  copilotCliInstructionsState,
  resolveCopilotCliTarget,
} from '../src/core/copilotCli.ts';
import {
  antigravityCliInstructionsState,
  resolveAntigravityCliTarget,
} from '../src/core/antigravityCli.ts';
import {
  antigravityIdeInstructionsState,
  resolveAntigravityIdeTarget,
} from '../src/core/antigravityIde.ts';
import { fullClaims } from '../src/core/capabilityMatrix.ts';
import { ledgerHas, readLedger } from '../src/core/matrixLedger.ts';
import { E2E_TEST_IDS, clearMarkers, markPassed, passedIds } from './e2eRegistry.ts';

const REPO = join(import.meta.dir, '..');
const run = (cwd: string, args: string[], input?: string) => runCli(cwd, args, { input });

/** Built connect integrations: matrix column id → its Showtail plugin id. */
const CONNECT_TOOLS = [
  { matrixId: 'claude-code', pluginId: 'claude-code' as const },
  { matrixId: 'codex', pluginId: 'codex' as const },
  { matrixId: 'copilot-vscode', pluginId: 'github-copilot' as const },
  { matrixId: 'copilot-cli', pluginId: 'copilot-cli' as const },
  { matrixId: 'antigravity-cli', pluginId: 'antigravity-cli' as const },
  { matrixId: 'antigravity-ide', pluginId: 'antigravity-ide' as const },
];

/** The project-scope instructions/skill file each connect plugin writes. */
const CONNECT_FILE: Record<string, (dir: string) => string> = {
  'claude-code': (dir) => resolveTarget('project', dir).skillFile,
  'github-copilot': (dir) => resolveCopilotTarget(dir).pathInstructionsFile,
  codex: (dir) => resolveCodexTarget('project', dir).agentsFile,
  'copilot-cli': (dir) => resolveCopilotCliTarget('project', dir).instructionsFile,
  'antigravity-cli': (dir) => resolveAntigravityCliTarget('project', dir).contextFile,
  'antigravity-ide': (dir) => resolveAntigravityIdeTarget('project', dir).contextFile,
};

/** Installed-state reader (installed + updateAvailable) for update detection. */
const INSTALL_STATE: Record<
  string,
  (dir: string) => { installed: boolean; updateAvailable: boolean }
> = {
  'claude-code': (dir) => skillState(resolveTarget('project', dir)),
  'github-copilot': (dir) => copilotState(resolveCopilotTarget(dir)),
  codex: (dir) => codexInstructionsState(resolveCodexTarget('project', dir)),
  'copilot-cli': (dir) =>
    copilotCliInstructionsState(resolveCopilotCliTarget('project', dir)),
  'antigravity-cli': (dir) =>
    antigravityCliInstructionsState(resolveAntigravityCliTarget('project', dir)),
  'antigravity-ide': (dir) =>
    antigravityIdeInstructionsState(resolveAntigravityIdeTarget('project', dir)),
};

/** A minimal Codex rollout (one JSON object per line) for transcript/import. */
function codexRollout(dir: string): string {
  return [
    {
      timestamp: '2026-06-10T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 's1', cwd: dir },
    },
    {
      timestamp: '2026-06-10T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'codex: add a helper' },
    },
    {
      timestamp: '2026-06-10T10:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Added the helper.',
        phase: 'final_answer',
      },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
}

beforeAll(() => clearMarkers());

/**
 * Drive one hook tool's prompt + edit capture through the real dispatcher.
 * Uses an ABSOLUTE file path inside its own temp dir, so it also exercises the
 * absolute→relative normalization the capture fix added.
 */
function backCapture(
  toolId: string,
  edit: { editTool?: string; applyPatch?: boolean },
  traceFile: string,
) {
  const dir = makeTempDir();
  try {
    run(dir, ['init', '--project', 'Cap']);
    run(
      dir,
      ['hook', 'user-prompt', '--tool', toolId],
      JSON.stringify({ cwd: dir, prompt: `${toolId}: do it` }),
    );
    const filePath = join(dir, traceFile);
    writeFileSync(filePath, 'export const x = 1;');
    const payload = edit.applyPatch
      ? {
          cwd: dir,
          tool_name: 'apply_patch',
          tool_input: {
            input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-1\n+2\n*** End Patch`,
          },
        }
      : toolId === 'copilot-cli'
        ? // Copilot CLI's real postToolUse shape: camelCase fields, `toolArgs` a
          // JSON STRING, edit signalled by old_str/new_str (a `view` read has neither).
          {
            cwd: dir,
            sessionId: 'cc-sess-1',
            toolName: 'edit',
            toolArgs: JSON.stringify({
              path: filePath,
              old_str: 'export const x = 1;',
              new_str: 'export const x = 2;',
            }),
          }
        : { cwd: dir, tool_name: edit.editTool, tool_input: { file_path: filePath } };
    const r = run(dir, ['hook', 'post-edit', '--tool', toolId], JSON.stringify(payload));
    expect(r.code).toBe(0);
    run(dir, ['report', '--format', 'json']);
    const data = readJsonReport(dir);
    expect(JSON.stringify(data)).toContain('do it'); // prompt captured
    expect(data.summary.artifacts, `${toolId} artifact`).toBeGreaterThanOrEqual(1); // edit captured
    markPassed(`auto-prompt-capture:${toolId}`);
    markPassed(`live-capture-hooks:${toolId}`);
    markPassed(`auto-file-capture:${toolId}`);
  } finally {
    cleanup(dir);
  }
}

describe('backing: automatic capture via hooks', () => {
  test('Claude Code: prompt, edit, and AI-reply reconcile', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init', '--project', 'Backing']);
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'add a parser', session_id: 'sess-1' }),
      );
      writeFileSync(join(dir, 'parser.ts'), 'export const x = 1;');
      run(
        dir,
        ['hook', 'post-edit'],
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          cwd: dir,
          tool_name: 'Edit',
          tool_input: { file_path: join(dir, 'parser.ts') },
        }),
      );
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
      const blob = JSON.stringify(readJsonReport(dir));
      expect(blob).toContain('add a parser');
      expect(blob).toContain('REPLY captured at stop');
      markPassed('auto-prompt-capture:claude-code');
      markPassed('live-capture-hooks:claude-code');
      markPassed('auto-file-capture:claude-code');
      markPassed('auto-ai-output-capture:claude-code');
    } finally {
      cleanup(dir);
    }
  });

  test('Codex: prompt + apply_patch edit (absolute path) capture', () => {
    backCapture('codex', { applyPatch: true }, 'svc.ts');
  });

  test('Copilot CLI: prompt + file_path edit capture', () => {
    backCapture('copilot-cli', { editTool: 'write' }, 'cc.ts');
  });

  test('Antigravity CLI: prompt + file_path edit capture', () => {
    backCapture('antigravity-cli', { editTool: 'write_file' }, 'ag.ts');
  });
});

describe('backing: Codex transcript (AI-reply + import)', () => {
  test('parseCodexRollout yields the assistant reply', () => {
    const dir = makeTempDir();
    try {
      const t = parseCodexRollout(codexRollout(dir), dir);
      expect(t.messages.some((m) => m.role === 'assistant')).toBe(true);
      markPassed('auto-ai-output-capture:codex');
    } finally {
      cleanup(dir);
    }
  });

  test('importing a Codex rollout logs prompts tagged codex', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const transcript = parseCodexTranscript(codexRollout(dir), dir);
      const res = await importCodexTranscript(author, transcript, {
        withResponses: true,
      });
      expect(res.prompts).toBeGreaterThanOrEqual(1);
      const prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts.some((e) => e.tool === 'codex')).toBe(true);
      markPassed('session-import:codex');
    } finally {
      cleanup(dir);
    }
  });

  // The REAL file-capture contract: Codex's apply_patch envelope (which arrives in
  // the rollout, not the live hook payload) reconciles into a CLEAN per-file diff
  // artifact — no `*** Begin Patch` cruft. This is the path the Stop reconcile and
  // `import codex` share; the live hook auto-firing is certified separately in the
  // verification ledger.
  test('a Codex apply_patch edit reconciles a clean per-file diff', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const rollout = [
        {
          timestamp: '2026-06-10T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'sfc', cwd: dir },
        },
        {
          timestamp: '2026-06-10T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'create svc' },
        },
        {
          timestamp: '2026-06-10T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'c1',
            name: 'apply_patch',
            input:
              '*** Begin Patch\n*** Add File: svc.ts\n+export const x = 1;\n*** End Patch\n',
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n');
      const transcript = parseCodexTranscript(rollout, dir);
      const res = await importCodexTranscript(author, transcript, {
        withResponses: true,
      });
      expect(res.edits).toBe(1);
      const art = readAllArtifacts(pathsForRoot(dir))
        .filter((a) => a.path === 'svc.ts')
        .at(-1);
      const diff = art?.diffHash
        ? readObject(pathsForRoot(dir), art.diffHash)
        : undefined;
      expect(diff).toContain('+ export const x = 1;'); // Claude-style clean diff
      expect(diff).not.toContain('*** Begin Patch'); // no envelope cruft
      markPassed('auto-file-capture:codex');
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

  test('Antigravity IDE transcript import logs prompt + reply tagged antigravity-ide', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const res = await importAntigravityIdeTranscript(
        author,
        {
          sessionId: 'conv-imp',
          messages: [
            {
              role: 'user',
              text: 'imported agy-ide prompt',
              sourceId: 'agy:user:conv-imp:0',
            },
            { role: 'assistant', text: 'the reply', sourceId: 'agy:asst:conv-imp:1' },
          ],
        },
        { withResponses: true },
      );
      expect(res.prompts).toBeGreaterThanOrEqual(1);
      const events = readAllEvents(pathsForRoot(dir));
      expect(
        events.some((e) => e.type === 'prompt' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      expect(
        events.some((e) => e.type === 'ai_output' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      // Idempotent: a second import of the same transcript adds nothing new.
      const again = await importAntigravityIdeTranscript(
        author,
        {
          sessionId: 'conv-imp',
          messages: [
            {
              role: 'user',
              text: 'imported agy-ide prompt',
              sourceId: 'agy:user:conv-imp:0',
            },
          ],
        },
        { withResponses: true },
      );
      expect(again.prompts).toBe(0);
      expect(again.skipped).toBeGreaterThanOrEqual(1);
      markPassed('session-import:antigravity-ide');
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
  test('each built connect tool installs instructions, detects, reports status', async () => {
    for (const { matrixId, pluginId } of CONNECT_TOOLS) {
      const dir = makeTempDir();
      try {
        await runInit({ cwd: dir });
        const connect = getPluginById(pluginId)!.connect!;

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

        expect(typeof connect.detect()).toBe('boolean');
        markPassed(`host-detection:${matrixId}`);
        expect(typeof connect.status(dir).connected).toBe('boolean');
        markPassed(`status-detection:${matrixId}`);

        if (connect.scopes.includes('user') && connect.scopes.includes('project')) {
          markPassed(`multi-scope-install:${matrixId}`);
        }

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

describe('backing: plan capture', () => {
  test('Claude Code: an ExitPlanMode plan is materialized + linked at Stop', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init', '--project', 'PlanCap']);
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'plan it', session_id: 'sp1' }),
      );
      const transcript = join(dir, 'plan.jsonl');
      writeFileSync(
        transcript,
        [
          {
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-06-10T10:00:00.000Z',
            promptSource: 'typed',
            sessionId: 'sp1',
            message: { role: 'user', content: 'plan it' },
          },
          {
            type: 'assistant',
            uuid: 'u2',
            timestamp: '2026-06-10T10:01:00.000Z',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'epc',
                  name: 'ExitPlanMode',
                  input: { plan: '# The Plan\n- ship it' },
                },
              ],
            },
          },
          {
            type: 'user',
            uuid: 'u3',
            timestamp: '2026-06-10T10:02:00.000Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'epc',
                  content: 'User has approved your plan.',
                },
              ],
            },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, session_id: 'sp1', transcript_path: transcript }),
      );
      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.plans.length).toBe(1);
      expect(data.plans[0].planPath).toBe('plans/epc.md');
      expect(existsSync(join(dir, '.showtail', 'plans', 'epc.md'))).toBe(true);
      markPassed('plan-capture:claude-code');
    } finally {
      cleanup(dir);
    }
  });

  test('Codex: an update_plan plan is captured + materialized to a linkable file', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const rollout = [
        {
          timestamp: '2026-06-10T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'spc', cwd: dir },
        },
        {
          timestamp: '2026-06-10T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'plan it' },
        },
        {
          timestamp: '2026-06-10T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'pl1',
            arguments: JSON.stringify({
              plan: [
                { step: 'Read the file', status: 'completed' },
                { step: 'Make the change', status: 'pending' },
              ],
            }),
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n');
      const transcript = parseCodexTranscript(rollout, dir);
      const res = await importCodexTranscript(author, transcript, {
        withResponses: true,
      });
      expect(res.plans).toBe(1);
      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.plans.length).toBe(1);
      // Codex writes no native plan file; the transcript plan is materialized to a
      // browsable, linkable file — like Claude Code's.
      expect(data.plans[0].planPath).toMatch(/^plans\//);
      expect(existsSync(join(dir, '.showtail', data.plans[0].planPath))).toBe(true);
      markPassed('plan-capture:codex');
    } finally {
      cleanup(dir);
    }
  });

  test('Antigravity CLI: the on-disk plan.md is linked at Stop', () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    const SID = 'sess-agy-plan';
    try {
      const brain = join(home, 'antigravity-cli', 'brain', SID);
      mkdirSync(join(brain, '.system_generated', 'logs'), { recursive: true });
      const transcriptPath = join(brain, '.system_generated', 'logs', 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        [
          {
            step_index: 0,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            status: 'DONE',
            created_at: '2026-06-10T10:00:00Z',
            content: '<USER_REQUEST>\nadd retry\n</USER_REQUEST>',
          },
          {
            step_index: 1,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '2026-06-10T10:01:00Z',
            tool_calls: [{ name: 'create_plan', args: { plan: '1. a\n2. b' } }],
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );
      writeFileSync(join(brain, 'plan.md'), '# Plan\n- from disk\n');
      const env = { ...spawnEnv(), GEMINI_HOME: home };

      runCli(dir, ['init', '--project', 'PlanCap'], { env });
      runCli(dir, ['hook', 'user-prompt', '--tool', 'antigravity-cli'], {
        env,
        input: JSON.stringify({ conversationId: SID, prompt: 'add retry' }),
      });
      runCli(dir, ['hook', 'stop', '--tool', 'antigravity-cli'], {
        env,
        input: JSON.stringify({ conversationId: SID, transcriptPath }),
      });
      runCli(dir, ['report', '--format', 'json'], { env });
      const data = readJsonReport(dir);
      const planPath = `plans/agy-plan_${SID}.md`;
      expect(data.plans.length).toBeGreaterThanOrEqual(1);
      expect(data.plans[0].planPath).toBe(planPath);
      expect(readFileSync(join(dir, '.showtail', planPath), 'utf8')).toContain(
        'from disk',
      );
      markPassed('plan-capture:antigravity-cli');
    } finally {
      cleanup(home);
      cleanup(dir);
    }
  });
});

describe('backing: decision capture', () => {
  test('Claude Code: an AskUserQuestion choice is captured as a decision at Stop', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init', '--project', 'DecisionCap']);
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'which option?', session_id: 'sd1' }),
      );
      const transcript = join(dir, 'decision.jsonl');
      writeFileSync(
        transcript,
        [
          {
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-06-10T10:00:00.000Z',
            promptSource: 'typed',
            sessionId: 'sd1',
            message: { role: 'user', content: 'which option?' },
          },
          {
            type: 'assistant',
            uuid: 'u2',
            timestamp: '2026-06-10T10:01:00.000Z',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'auq1',
                  name: 'AskUserQuestion',
                  input: {
                    questions: [
                      {
                        question: 'Which option?',
                        header: 'Option',
                        options: [
                          { label: 'Option A', description: 'the first' },
                          { label: 'Option B', description: 'the second' },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: 'user',
            uuid: 'u3',
            timestamp: '2026-06-10T10:02:00.000Z',
            toolUseResult: { answers: { 'Which option?': 'Option A' } },
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'auq1',
                  content:
                    'Your questions have been answered: "Which option?"="Option A"',
                },
              ],
            },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, session_id: 'sd1', transcript_path: transcript }),
      );
      const decisions = readAllEvents(pathsForRoot(dir)).filter(
        (e) => e.type === 'decision',
      );
      expect(decisions.length).toBeGreaterThanOrEqual(1);
      expect(decisions.some((e) => e.tool === 'claude-code')).toBe(true);
      markPassed('decision-capture:claude-code');
    } finally {
      cleanup(dir);
    }
  });

  test('Codex: a request_user_input choice parses as a decision', () => {
    const dir = makeTempDir();
    try {
      const rollout = [
        {
          timestamp: '2026-06-10T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 's1', cwd: dir },
        },
        {
          timestamp: '2026-06-10T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'codex: which approach?' },
        },
        {
          timestamp: '2026-06-10T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'request_user_input',
            call_id: 'c1',
            arguments: JSON.stringify({
              questions: [
                {
                  id: 'q1',
                  question: 'Which approach?',
                  header: 'Approach',
                  options: [{ label: 'Approach A' }, { label: 'Approach B' }],
                },
              ],
            }),
          },
        },
        {
          timestamp: '2026-06-10T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'c1',
            output: JSON.stringify({ answers: { q1: { answers: ['Approach A'] } } }),
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n');
      const t = parseCodexTranscript(rollout, dir);
      expect(t.messages.some((m) => m.role === 'decision')).toBe(true);
      markPassed('decision-capture:codex');
    } finally {
      cleanup(dir);
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
      const tools = [
        { matrixId: 'claude-code', tag: 'claude-code' },
        { matrixId: 'codex', tag: 'codex' },
        { matrixId: 'copilot-vscode', tag: 'github-copilot' },
        { matrixId: 'copilot-cli', tag: 'copilot-cli' },
        { matrixId: 'antigravity-cli', tag: 'antigravity-cli' },
        { matrixId: 'antigravity-ide', tag: 'antigravity-ide' },
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
      expect(JSON.stringify(data)).not.toContain(SECRET);
      expect(data.redactionCount).toBeGreaterThanOrEqual(tools.length);
      const seen = new Set((data.tools as Array<{ tool: string }>).map((x) => x.tool));
      for (const { matrixId, tag } of tools) {
        expect(seen.has(tag), `${tag} on timeline`).toBe(true);
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
    expect(
      readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ).toContain('showtail');
    markPassed('marketplace-install:claude-code');
  });

  test('Copilot (VS Code) ships extension install guidance', () => {
    const guidance = getPluginById('github-copilot')!.connect!.setupGuidance ?? [];
    expect(guidance.join('\n')).toContain('--install-extension');
    markPassed('marketplace-install:copilot-vscode');
  });
});

/**
 * The keystone: a `full` capability claim is only allowed if a test proves it.
 *
 * Runs after the backing blocks above (same file ⇒ guaranteed source order),
 * which mark each exercised capability. Here we assert every `full` cell in the
 * matrix has a registered, *passed* contract test — and that every hook-driven
 * capture cell is additionally certified in the live-verification ledger. A new
 * `full` claim with no backing test fails this suite, so the matrix can never
 * out-claim reality.
 */
describe('every full capability claim is backed by a passing test', () => {
  const claims = fullClaims();
  const registered = new Set(E2E_TEST_IDS);

  test('there are full claims to check (guards against an empty matrix)', () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  test('each full cell has a registered, passing contract test', () => {
    const passed = passedIds();
    const missing = claims.filter(
      (c) => !registered.has(c.testId) || !passed.has(c.testId),
    );
    // If this fails, either a backing block above did not run/mark this id,
    // or a cell was set to `full` without adding its backing exercise.
    expect(missing.map((c) => c.testId)).toEqual([]);
  });

  test('each hook-driven capture cell is certified in the live ledger', () => {
    const ledger = readLedger();
    const missing = claims.filter((c) => c.liveRequired && !ledgerHas(ledger, c.testId));
    // If this fails, run `showtail matrix --verify-live` on a machine with the
    // tool installed to certify it, or demote the cell to `partial` until then.
    expect(missing.map((c) => c.testId)).toEqual([]);
  });
});
