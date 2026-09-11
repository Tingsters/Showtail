import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runImportAntigravityIde } from '../src/commands/importAntigravityIde.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { writeGlobalConfig } from '../src/core/globalConfig.ts';
import { readLedgerRecords, unplacedSessions } from '../src/core/ledger.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { VSCODE_EXTENSION_HOOK_PROTOCOL } from '../src/core/vscodeExtensionHook.ts';
import { cleanup, envWithHome, makeTempDir, runCli } from './helpers.ts';

type ExtensionTool = 'github-copilot' | 'antigravity-ide';

describe('VS Code extension ledger flow', () => {
  let previousHome: string | undefined;
  let ledgerHome: string;
  let cleanupDirs: string[];

  beforeEach(() => {
    previousHome = process.env.SHOWTAIL_HOME;
    ledgerHome = makeTempDir();
    cleanupDirs = [ledgerHome];
    process.env.SHOWTAIL_HOME = ledgerHome;
    writeGlobalConfig({
      version: 1,
      autoInit: true,
      captureSince: '2026-09-09T00:00:00.000Z',
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = previousHome;
    for (const dir of cleanupDirs.reverse()) cleanup(dir);
  });

  function temp(): string {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    return dir;
  }

  function payload(
    sessionId: string,
    processCwd: string,
    projectCwd: string | null,
    workspacePaths: string[],
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      showtailExtension: VSCODE_EXTENSION_HOOK_PROTOCOL,
      session_id: sessionId,
      cwd: processCwd,
      projectCwd,
      workspacePaths,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  function hook(cwd: string, tool: ExtensionTool, event: string, input: string) {
    return runCli(cwd, ['hook', event, '--tool', tool], {
      input,
      env: envWithHome(ledgerHome),
    });
  }

  for (const tool of ['github-copilot', 'antigravity-ide'] as const) {
    test(`${tool} save waits for a prompt, then materializes with correct attribution`, () => {
      const project = temp();
      const file = join(project, 'src', 'app.ts');
      mkdirSync(join(project, 'src'), { recursive: true });
      writeFileSync(file, 'export const ready = true;\n', 'utf8');
      const sessionId = `${tool}-extension-session`;

      const saved = hook(
        project,
        tool,
        'post-edit',
        payload(sessionId, project, project, [project], { editedFiles: [file] }),
      );
      expect(saved.code).toBe(0);
      expect(existsSync(join(project, '.showtail'))).toBe(false);

      const prompted = hook(
        project,
        tool,
        'user-prompt',
        payload(sessionId, project, project, [project], {
          prompt: 'Build the project-local flow.',
        }),
      );
      expect(prompted.code).toBe(0);
      expect(existsSync(join(project, '.showtail', 'config.json'))).toBe(true);

      const paths = pathsForRoot(project);
      expect(
        readAllEvents(paths).some(
          (event) =>
            event.type === 'prompt' &&
            event.tool === tool &&
            event.text === 'Build the project-local flow.',
        ),
      ).toBe(true);
      expect(
        readAllArtifacts(paths).some(
          (artifact) => artifact.tool === tool && artifact.path === 'src/app.ts',
        ),
      ).toBe(true);
    });
  }

  test('Copilot rejects lookalike payloads without the extension sentinel', () => {
    const project = temp();
    const input = JSON.stringify({
      session_id: 'foreign-session',
      cwd: project,
      projectCwd: project,
      workspacePaths: [project],
      prompt: 'This must not be captured.',
    });

    expect(hook(project, 'github-copilot', 'user-prompt', input).code).toBe(0);
    expect(existsSync(join(project, '.showtail'))).toBe(false);
    expect(unplacedSessions({ includeHidden: true })).toHaveLength(0);
  });

  test('folderless @showtail prompt stays in the inbox without creating a HOME trail', () => {
    const processCwd = temp();
    const sessionId = 'folderless-showtail-participant';

    expect(
      hook(
        processCwd,
        'github-copilot',
        'user-prompt',
        payload(sessionId, processCwd, null, [], {
          prompt: 'Help me plan before I open the project.',
        }),
      ).code,
    ).toBe(0);

    expect(existsSync(join(processCwd, '.showtail'))).toBe(false);
    const inbox = unplacedSessions({ includeHidden: true }).filter(
      (session) => session.nativeSessionId === sessionId,
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.cwd).toBeNull();
    expect(inbox[0]!.workspacePaths ?? []).toEqual([]);
    expect(
      readLedgerRecords(inbox[0]!.id).some(
        (record) =>
          record.kind === 'prompt' &&
          record.text === 'Help me plan before I open the project.',
      ),
    ).toBe(true);
  });

  test('Antigravity transcript import reconciles saves from the extension session', async () => {
    const project = temp();
    const launcher = temp();
    const file = join(project, 'src', 'app.ts');
    const transcriptEdit = join(project, 'src', 'agent-edit.ts');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(file, 'export const captured = true;\n', 'utf8');
    const extensionSession = 'antigravity-extension-save-session';

    expect(
      hook(
        project,
        'antigravity-ide',
        'post-edit',
        payload(extensionSession, project, project, [project], {
          editedFiles: [file],
        }),
      ).code,
    ).toBe(0);
    expect(existsSync(join(project, '.showtail'))).toBe(false);

    const transcript = join(launcher, 'brain-session.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'USER_INPUT',
          step_index: 0,
          created_at: '2026-09-09T12:00:00.000Z',
          content: 'Implement the project change.',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          created_at: '2026-09-09T12:00:01.000Z',
          content: 'Implemented.',
        }),
        JSON.stringify({
          type: 'CODE_ACTION',
          step_index: 2,
          created_at: '2026-09-09T12:00:02.000Z',
          content: `Created file file:///${transcriptEdit.replace(/\\/g, '/')} with requested content.`,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    await runImportAntigravityIde(undefined, {
      auto: true,
      file: transcript,
      cwd: launcher,
      withResponses: true,
    });

    const paths = pathsForRoot(project);
    expect(existsSync(paths.config)).toBe(true);
    expect(
      readAllArtifacts(paths).some((artifact) => artifact.path === 'src/app.ts'),
    ).toBe(false);

    // This is the follow-up dispatched by the extension after a successful import.
    expect(
      hook(
        project,
        'antigravity-ide',
        'session-start',
        payload(extensionSession, project, project, [project]),
      ).code,
    ).toBe(0);
    expect(
      readAllArtifacts(paths).some(
        (artifact) =>
          artifact.tool === 'antigravity-ide' && artifact.path === 'src/app.ts',
      ),
    ).toBe(true);
  });

  test('empty-window chat with no edits stays inbox-only and does not create HOME fallback', () => {
    const processCwd = temp();
    const transcript = join(processCwd, 'empty-window.json');
    writeFileSync(
      transcript,
      JSON.stringify({
        version: 3,
        sessionId: 'empty-window',
        requests: [
          {
            requestId: 'request-1',
            timestamp: Date.now(),
            message: { text: 'Plan this before I open a project.' },
            agent: { extensionId: { value: 'GitHub.copilot-chat' } },
            response: [{ value: 'Here is a plan.' }],
          },
        ],
      }),
      'utf8',
    );

    expect(
      hook(
        processCwd,
        'github-copilot',
        'session-start',
        payload('empty-window', processCwd, null, []),
      ).code,
    ).toBe(0);
    const imported = runCli(
      processCwd,
      ['import', 'copilot', '--file', transcript, '--auto', '--quiet'],
      { env: envWithHome(ledgerHome) },
    );
    expect(imported.code).toBe(0);
    expect(existsSync(join(processCwd, '.showtail'))).toBe(false);

    const inbox = unplacedSessions({ includeHidden: true }).filter(
      (session) => session.tool === 'github-copilot',
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.cwd).toBeNull();
    expect(
      readLedgerRecords(inbox[0]!.id).some(
        (record) =>
          record.kind === 'prompt' &&
          record.text === 'Plan this before I open a project.',
      ),
    ).toBe(true);
  });

  test('zero-edit multi-root chat stays inbox-only instead of choosing the first root', () => {
    const first = temp();
    const second = temp();
    const processCwd = temp();
    mkdirSync(join(first, '.git'));
    mkdirSync(join(second, '.git'));
    const transcript = join(processCwd, 'multi-root.json');
    writeFileSync(
      transcript,
      JSON.stringify({
        version: 3,
        sessionId: 'multi-root',
        requests: [
          {
            requestId: 'request-1',
            timestamp: Date.now(),
            message: { text: 'Compare these projects before editing.' },
            agent: { extensionId: { value: 'GitHub.copilot-chat' } },
            response: [{ value: 'I will compare them.' }],
          },
        ],
      }),
      'utf8',
    );

    expect(
      hook(
        processCwd,
        'github-copilot',
        'session-start',
        payload('multi-root', processCwd, null, [first, second]),
      ).code,
    ).toBe(0);
    expect(
      runCli(
        processCwd,
        ['import', 'copilot', '--file', transcript, '--auto', '--quiet'],
        { env: envWithHome(ledgerHome) },
      ).code,
    ).toBe(0);

    expect(existsSync(join(first, '.showtail'))).toBe(false);
    expect(existsSync(join(second, '.showtail'))).toBe(false);
    expect(existsSync(join(processCwd, '.showtail'))).toBe(false);
    const inbox = unplacedSessions({ includeHidden: true }).filter(
      (session) => session.nativeSessionId === 'multi-root',
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.workspacePaths).toEqual(expect.arrayContaining([first, second]));
    expect(inbox[0]!.targets ?? []).toHaveLength(0);
  });
});
