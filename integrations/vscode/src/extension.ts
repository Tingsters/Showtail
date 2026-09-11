import * as vscode from 'vscode';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  ProjectControlController,
  registerProjectControlTool,
  type ProjectControlExecution,
} from './projectControl';
import {
  antigravitySaveReconcileInput,
  automaticCaptureSucceeded,
  captureConsentFromStatus,
  captureStatusArgs,
  chatCommandRequiresProject,
  chatSessionId,
  copilotImportArgs,
  copilotManagedRefreshArgs,
  extensionHookArgs,
  extensionHookPayload,
  latestProjectControlClaimId,
  latestReportProjectControlClaimId,
  managedRefreshSucceeded,
  type AssistantCapture,
  type CliResult,
  type CaptureConsent,
  type ExtensionHookContext,
  type ExtensionHookEvent,
  type ExtensionHookTool,
} from './showtailProtocol';

const execFileAsync = promisify(execFile);

let output: vscode.OutputChannel;
let extensionSessionId = `vscode-extension-${randomUUID()}`;
let antigravitySaveContext: ExtensionHookContext | undefined;

/** The configured `showtail` binary (on PATH by default). */
function showtailBin(): string {
  return (
    vscode.workspace.getConfiguration('showtail').get<string>('binaryPath') || 'showtail'
  );
}

function processOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

/** Run the showtail CLI; never throw — capture must never disrupt the editor. */
async function runShowtailResult(args: string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(showtailBin(), args, { cwd });
    return {
      stdout: processOutput(stdout),
      stderr: processOutput(stderr),
      exitCode: 0,
    };
  } catch (err) {
    const failure = err as Error & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = processOutput(failure.stdout);
    const stderr = processOutput(failure.stderr);
    const exitCode = typeof failure.code === 'number' ? failure.code : 1;
    output.appendLine(
      `showtail ${args.join(' ')} failed (${exitCode}): ${
        stderr.trim() || failure.message
      }`,
    );
    return { stdout, stderr, exitCode };
  }
}

async function runShowtail(args: string[], cwd: string): Promise<string | undefined> {
  const result = await runShowtailResult(args, cwd);
  return result.exitCode === 0 ? result.stdout : undefined;
}

/** Read tool-specific capture consent before any extension-driven work. */
async function captureConsent(
  tool: ExtensionHookTool,
  cwd: string,
): Promise<CaptureConsent> {
  return captureConsentFromStatus(await runShowtailResult(captureStatusArgs(tool), cwd));
}

/**
 * Run the showtail CLI, piping `input` to its stdin. Used for content (an AI
 * reply) that can be too long to pass safely as a command-line argument.
 */
function runShowtailStdin(
  args: string[],
  cwd: string,
  input: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const cp = spawn(showtailBin(), args, { cwd });
      let out = '';
      let errOut = '';
      let settled = false;
      cp.stdout.on('data', (d) => (out += d.toString()));
      cp.stderr.on('data', (d) => (errOut += d.toString()));
      cp.on('error', (err) => {
        if (settled) return;
        settled = true;
        output.appendLine(`showtail ${args.join(' ')} failed: ${err.message}`);
        resolve(undefined);
      });
      cp.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          output.appendLine(
            `showtail ${args.join(' ')} failed (${code ?? 1}): ${errOut.trim()}`,
          );
          resolve(undefined);
          return;
        }
        resolve(out);
      });
      cp.stdin.end(input);
    } catch (err) {
      output.appendLine(`showtail ${args.join(' ')} failed: ${(err as Error).message}`);
      resolve(undefined);
    }
  });
}

/** The workspace folder a file belongs to. Never guess the first multi-root folder. */
function folderFor(uri: vscode.Uri | undefined): string | undefined {
  if (!uri) return undefined;
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

function workspaceRoots(): string[] {
  return [
    ...new Set(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ),
  ];
}

function activeFileFolder(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') return undefined;
  return folderFor(uri) ?? dirname(uri.fsPath);
}

function implicitProjectFolder(): string | undefined {
  const active = activeFileFolder();
  if (active) return active;
  const roots = workspaceRoots();
  return roots.length === 1 ? roots[0] : undefined;
}

async function pickProjectFolder(): Promise<string | undefined> {
  const implicit = implicitProjectFolder();
  if (implicit) return implicit;
  const roots = workspaceRoots();
  if (roots.length === 0) return undefined;
  const selected = await vscode.window.showQuickPick(
    roots.map((root) => ({ label: root, root })),
    { placeHolder: 'Choose the project for this Showtail command' },
  );
  return selected?.root;
}

function hookContext(preferredCwd?: string): ExtensionHookContext {
  const roots = workspaceRoots();
  const projectCwd = preferredCwd ?? (roots.length === 1 ? roots[0]! : null);
  return {
    // A child process still needs a real cwd. `projectCwd: null` tells the CLI
    // that this fallback is operational only and is not project evidence.
    cwd: projectCwd ?? homedir(),
    projectCwd,
    workspacePaths: roots,
  };
}

async function runExtensionHook(
  tool: ExtensionHookTool,
  event: ExtensionHookEvent,
  input: {
    sessionId: string;
    cwd: string;
    projectCwd: string | null;
    workspacePaths: string[];
    prompt?: string;
    editedFiles?: string[];
    assistant?: AssistantCapture;
  },
): Promise<string | undefined> {
  if ((await captureConsent(tool, input.cwd)) !== 'enabled') return undefined;
  return runShowtailStdin(
    extensionHookArgs(tool, event),
    input.cwd,
    JSON.stringify(extensionHookPayload(input)),
  );
}

/** Skip Showtail/Git/dependency bookkeeping files. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])(\.showtail|\.git|\.claude|node_modules)([\\/]|$)/.test(p);
}

/**
 * True when running inside Google's Antigravity IDE (a VS Code fork). Its
 * lifecycle hooks are unreliable, so there we capture via this extension (save
 * snapshots) plus the transcript import, and tag work `antigravity-ide`.
 */
function isAntigravityHost(): boolean {
  return /antigravity/i.test(vscode.env.appName ?? '');
}

/** The tool tag captures are recorded under, based on the host editor. */
function captureTool(): ExtensionHookTool {
  return isAntigravityHost() ? 'antigravity-ide' : 'github-copilot';
}

/**
 * Capture the Antigravity conversation by running `showtail import antigravity-ide
 * --auto`, debounced. `--auto` routes prompts/replies/edits by the transcript's
 * own file paths into one project, leaving unresolved or mixed-project work in
 * the local inbox. This needs no open folder, and repeated imports are idempotent.
 */
let importTimer: NodeJS.Timeout | undefined;
let importScheduleGeneration = 0;
async function scheduleAntigravityImport(): Promise<void> {
  const generation = ++importScheduleGeneration;
  if (importTimer) clearTimeout(importTimer);
  importTimer = undefined;
  const cwd = homedir();
  if ((await captureConsent('antigravity-ide', cwd)) !== 'enabled') return;
  if (generation !== importScheduleGeneration) return;

  importTimer = setTimeout(() => {
    importTimer = undefined;
    if (generation !== importScheduleGeneration) return;
    void (async () => {
      if ((await captureConsent('antigravity-ide', cwd)) !== 'enabled') return;
      const imported = await runShowtailResult(
        ['import', 'antigravity-ide', '--auto'],
        cwd,
      );
      const consentAfter =
        imported.exitCode === 0
          ? await captureConsent('antigravity-ide', cwd)
          : 'unknown';
      if (!automaticCaptureSucceeded(imported, consentAfter)) return;

      output.appendLine(
        'Captured the Antigravity conversation (auto-routed by edit paths).',
      );

      // The transcript and editor-save watchers use different native session IDs.
      // Re-opening the save ledger after import lets it discover the trail the
      // transcript prompt just created and project any earlier saved files there.
      const reconcile = antigravitySaveReconcileInput(
        extensionSessionId,
        antigravitySaveContext,
      );
      if (!reconcile) return;
      const captured = await runExtensionHook(
        'antigravity-ide',
        'session-start',
        reconcile,
      );
      if (captured !== undefined) {
        output.appendLine('Reconciled saved files with the Antigravity conversation.');
      }
    })();
  }, 3000);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionSessionId = `vscode-extension-${randomUUID()}`;
  antigravitySaveContext = undefined;
  importScheduleGeneration = 0;
  output = vscode.window.createOutputChannel('Showtail');
  context.subscriptions.push(output, {
    dispose: () => {
      if (importTimer) clearTimeout(importTimer);
      importTimer = undefined;
      importScheduleGeneration += 1;
      antigravitySaveContext = undefined;
    },
  });
  const host = isAntigravityHost() ? 'Antigravity IDE' : 'GitHub Copilot';
  output.appendLine(`Showtail extension is active for ${host}.`);

  const projectControl = new ProjectControlController(
    context,
    runShowtailResult,
    output,
    captureTool,
  );
  registerProjectControlTool(context, projectControl, output);
  registerChatParticipant(context, projectControl);
  registerSaveCapture(context, projectControl);
  registerCommands(context, projectControl);
  if (isAntigravityHost()) {
    registerAntigravity(context);
  } else {
    void maybeAutoInstallCopilot(context);
    registerCopilotChatCapture(context);
  }
}

/**
 * Capture **native** Copilot Chat by watching its on-disk session files. VS Code
 * persists every native turn (the normal chat box, not the `@showtail` participant)
 * as a `.jsonl` patch-journal (older builds: a single `.json`). We watch two places:
 *
 *  (a) **Workspace chats** — `…/workspaceStorage/<hash>/chatSessions/*.{json,jsonl}`.
 *      `context.storageUri` points at this extension's own folder inside that same
 *      `<hash>` dir, so `chatSessions` is its sibling — no hash→folder mapping.
 *  (b) **Empty-window chats** (no folder open) — `…/globalStorage/
 *      emptyWindowChatSessions/*.jsonl`.
 *
 * Every change seeds the session's complete workspace context through the hook
 * ledger, then runs `showtail import copilot --file <path> --auto --quiet`. The CLI
 * owns project resolution: one-root work lands there, mixed-root work stays in the
 * inbox, and re-firing only appends new transcript records through `sourceId` dedupe.
 */
function registerCopilotChatCapture(context: vscode.ExtensionContext): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const scheduleGenerations = new Map<string, number>();
  context.subscriptions.push({
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      scheduleGenerations.clear();
    },
  });

  // Debounced import of one changed chat-session file. The session-start hook is
  // ledger-only: it carries all workspace roots but cannot initialize a trail.
  const scheduleImport = (file: string): void => {
    const generation = (scheduleGenerations.get(file) ?? 0) + 1;
    scheduleGenerations.set(file, generation);
    const existing = timers.get(file);
    if (existing) clearTimeout(existing);
    timers.delete(file);
    const capture = hookContext();
    void (async () => {
      if ((await captureConsent('github-copilot', capture.cwd)) !== 'enabled') return;
      if (scheduleGenerations.get(file) !== generation) return;
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          if (scheduleGenerations.get(file) !== generation) return;
          const sessionId = chatSessionId(file);
          void (async () => {
            const seeded = await runExtensionHook('github-copilot', 'session-start', {
              sessionId,
              ...capture,
            });
            if (seeded === undefined) return;
            const imported = await runShowtailResult(
              copilotImportArgs(file),
              capture.cwd,
            );
            const consentAfter =
              imported.exitCode === 0
                ? await captureConsent('github-copilot', capture.cwd)
                : 'unknown';
            if (!automaticCaptureSucceeded(imported, consentAfter)) return;
            output.appendLine(`Captured native Copilot Chat from ${file}`);
            await maybeAutoInstallCopilot(context);
          })();
        }, 2000),
      );
    })();
  };

  const watch = (
    dir: string,
    onChange: (uri: vscode.Uri) => void,
    label: string,
  ): void => {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '*.{json,jsonl}'),
      );
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      context.subscriptions.push(watcher);
      output.appendLine(`Watching ${label} under ${dir}`);
    } catch (err) {
      output.appendLine(
        `Copilot Chat watch unavailable (${label}): ${(err as Error).message}`,
      );
    }
  };

  // (a) Workspace chat sessions, resolved from the complete session evidence.
  const storage = context.storageUri?.fsPath;
  if (storage) {
    const chatDir = join(dirname(storage), 'chatSessions');
    watch(chatDir, (uri) => scheduleImport(uri.fsPath), 'native Copilot Chat sessions');
  } else {
    output.appendLine(
      'No workspace storage yet — folder Copilot Chat capture starts once a folder is open.',
    );
  }

  // (b) Empty-window (no-folder) chats → routed by edited-file path via --auto.
  const global = context.globalStorageUri?.fsPath;
  if (global) {
    const emptyDir = join(dirname(global), 'emptyWindowChatSessions');
    watch(
      emptyDir,
      (uri) => scheduleImport(uri.fsPath),
      'empty-window Copilot Chat sessions',
    );
  }
}

/**
 * Antigravity capture — host-independent. The agent runs in an extension host that
 * frequently has no workspace folder and can edit an arbitrary project. We watch
 * the IDE's on-disk transcript and use the auto importer for the full conversation;
 * editor saves also go through the ledger-first hook path. Unresolved or mixed-root
 * work stays in the local inbox instead of being assigned by guesswork.
 */
function registerAntigravity(context: vscode.ExtensionContext): void {
  const brain = join(homedir(), '.gemini', 'antigravity-ide', 'brain');
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(brain), '**/transcript*.jsonl'),
    );
    watcher.onDidChange(() => void scheduleAntigravityImport());
    watcher.onDidCreate(() => void scheduleAntigravityImport());
    context.subscriptions.push(watcher);
    output.appendLine(`Watching Antigravity transcripts under ${brain}`);
  } catch (err) {
    output.appendLine(`transcript watch unavailable: ${(err as Error).message}`);
  }
  void scheduleAntigravityImport(); // capture anything already on disk at startup
}

/**
 * Keep the Copilot instructions (`.github/copilot-instructions.md`) set up and
 * current once capture has created the project-local trail:
 *   - if the instructions are already present, refresh them to the latest
 *     (a no-op when already current — `showtail connect copilot` only rewrites
 *     on change), so updates ship automatically on the next open;
 *   - if they're absent, install them the first time only (tracked in
 *     workspaceState) so we never fight a later manual `disconnect copilot`.
 * Activation itself is read-only for untracked folders. The first meaningful
 * prompt goes through the hook/import ledger and creates the trail; capture then
 * calls this again to install instructions without a separate setup command.
 */
async function maybeAutoInstallCopilot(context: vscode.ExtensionContext): Promise<void> {
  const roots = workspaceRoots();
  if ((await captureConsent('github-copilot', roots[0] ?? homedir())) !== 'enabled') {
    return;
  }
  for (const cwd of roots) {
    if (!existsSync(join(cwd, '.showtail', 'config.json'))) continue;

    const key = `showtail.autoInstalledCopilot:${cwd}`;
    const sentinel = join(cwd, '.github', 'instructions', 'showtail.instructions.md');

    if (existsSync(sentinel)) {
      const refreshed = await runShowtailResult(copilotManagedRefreshArgs(), cwd);
      const consentAfter =
        refreshed.exitCode === 0
          ? await captureConsent('github-copilot', cwd)
          : 'unknown';
      if (!managedRefreshSucceeded(refreshed, existsSync(sentinel), consentAfter)) {
        continue;
      }
      await context.workspaceState.update(key, true);
      output.appendLine(
        `Showtail Copilot instructions checked for ${cwd} (untouched blocks refreshed).`,
      );
      await maybeNotifyUpdate(context, cwd);
      continue;
    }

    // An absent sentinel after a successful install means the student explicitly
    // disconnected this project. Remember per root so a multi-root window never
    // lets one project's choice control another's.
    if (context.workspaceState.get<boolean>(key)) continue;

    const installed = await runShowtailResult(copilotManagedRefreshArgs(), cwd);
    const consentAfter =
      installed.exitCode === 0 ? await captureConsent('github-copilot', cwd) : 'unknown';
    if (!managedRefreshSucceeded(installed, existsSync(sentinel), consentAfter)) {
      continue;
    }
    await context.workspaceState.update(key, true);
    output.appendLine(`Auto-installed Showtail Copilot instructions in ${cwd}.`);
    void vscode.window.showInformationMessage(
      `Showtail set up Copilot instructions for ${cwd}.`,
    );
  }
}

/**
 * When the instructions were customized AND a newer Showtail version exists,
 * nudge once (per update episode) — never overwriting the user's edits.
 */
async function maybeNotifyUpdate(
  context: vscode.ExtensionContext,
  cwd: string,
): Promise<void> {
  const NOTIFY_KEY = `showtail.copilotUpdateNotified:${cwd}`;
  const status = await runShowtail(captureStatusArgs('github-copilot'), cwd);
  let updateAvailable = false;
  try {
    const parsed = status ? JSON.parse(status) : null;
    const copilot = parsed?.tools?.find((t: { tool: string }) => t.tool === 'copilot');
    updateAvailable = copilot?.updateAvailable === true;
  } catch {
    updateAvailable = false;
  }

  if (!updateAvailable) {
    if (context.workspaceState.get<boolean>(NOTIFY_KEY)) {
      await context.workspaceState.update(NOTIFY_KEY, false); // reset for next time
    }
    return;
  }
  if (context.workspaceState.get<boolean>(NOTIFY_KEY)) return; // already nudged this episode
  await context.workspaceState.update(NOTIFY_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    'Showtail: a newer version of the Copilot instructions is available. Your edits were kept.',
    'Apply update',
    'Keep mine',
  );
  if (choice === 'Apply update') {
    const sentinel = join(cwd, '.github', 'instructions', 'showtail.instructions.md');
    const refreshed = await runShowtailResult(copilotManagedRefreshArgs(true), cwd);
    const consentAfter =
      refreshed.exitCode === 0 ? await captureConsent('github-copilot', cwd) : 'unknown';
    if (!managedRefreshSucceeded(refreshed, existsSync(sentinel), consentAfter)) {
      return;
    }
    await context.workspaceState.update(NOTIFY_KEY, false);
    output.appendLine('Applied the latest Showtail Copilot instructions.');
  }
}

/**
 * `@showtail` — the Showtail control surface in chat. It is NOT a coding agent
 * (use native Copilot for that — Showtail can capture edits on save when connected). It:
 *   - `/report` `/open_report` `/verify` `/status` `/trace <file>` — run Showtail
 *   - plain text — records your prompt verbatim and gives a quick answer
 */
function previousProjectControlClaim(
  context: vscode.ChatContext,
  action: 'report' | 'open_report' | 'status' | 'verify',
): string | undefined {
  const markers = context.history.map((turn) => {
    const result = (turn as { result?: vscode.ChatResult }).result;
    return result?.metadata?.showtailProjectControl;
  });
  return action === 'open_report'
    ? (latestReportProjectControlClaimId(markers) ?? latestProjectControlClaimId(markers))
    : latestProjectControlClaimId(markers);
}

function renderProjectControlExecution(execution: ProjectControlExecution): string {
  if (!execution.ok) return execution.message;
  const sections: string[] = [];
  if (execution.selection.crossWorkspace) {
    sections.push(
      `Showtail selected **${execution.selection.displayName}** at ` +
        `\`${execution.selection.root}\`, outside the open workspace.`,
    );
  }
  if (execution.action === 'status' || execution.action === 'verify') {
    sections.push(`\`\`\`json\n${execution.text}\n\`\`\``);
  } else {
    sections.push(execution.text);
  }
  return sections.join('\n\n');
}

function controlChatResult(execution: ProjectControlExecution): vscode.ChatResult {
  return execution.ok
    ? { metadata: { showtailProjectControl: execution.marker } }
    : { errorDetails: { message: execution.message } };
}

function registerChatParticipant(
  context: vscode.ExtensionContext,
  projectControl: ProjectControlController,
): void {
  // VS Code forks (e.g. Antigravity) may not expose the chat API. Feature-detect
  // so activation still succeeds there and the save-capture path keeps working.
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    output.appendLine('Chat API unavailable here — skipping the @showtail participant.');
    return;
  }
  const tool = captureTool();
  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token,
  ) => {
    const implicit = implicitProjectFolder();
    let promptCaptured = false;

    if (
      request.command === 'report' ||
      request.command === 'open_report' ||
      request.command === 'verify' ||
      request.command === 'status'
    ) {
      const action = request.command;
      stream.progress(
        action === 'report' || action === 'open_report'
          ? 'Resolving the project and preparing its Showtail report...'
          : `Resolving the project and running Showtail ${action}...`,
      );
      const execution = await projectControl.execute(
        {
          action,
          ...(request.prompt.trim() ? { selector: request.prompt } : {}),
          ...(!request.prompt.trim()
            ? { priorClaimId: previousProjectControlClaim(chatContext, action) }
            : {}),
        },
        token,
        { requestIdentity: request.toolInvocationToken },
      );
      stream.markdown(renderProjectControlExecution(execution));
      return controlChatResult(execution);
    }

    if (request.command === 'trace' && chatCommandRequiresProject(request.command)) {
      const project = await pickProjectFolder();
      if (!project) {
        stream.markdown('Focus a project file or choose one project folder first.');
        return;
      }
      const file = request.prompt.trim();
      if (!file) {
        stream.markdown('Pass a file path, e.g. `@showtail /trace src/app.ts`.');
        return;
      }
      const out = await runShowtail(['trace', file], project);
      stream.markdown('```\n' + (out ?? 'No trail found.').trim() + '\n```');
      return;
    }

    // Plain text: capture the prompt through the same durable hook ledger, then
    // give a quick answer. This also works before a project trail exists.
    if (request.prompt.trim().length > 0) {
      const capture = hookContext(implicit);
      const captured = await runExtensionHook(tool, 'user-prompt', {
        sessionId: extensionSessionId,
        ...capture,
        prompt: request.prompt,
      });
      if (captured !== undefined) {
        promptCaptured = true;
        if (tool === 'github-copilot') {
          await maybeAutoInstallCopilot(context);
        }
        stream.markdown('_Captured your prompt with Showtail._\n\n');
      }
    }

    try {
      const model =
        request.model ?? (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0];
      if (model) {
        const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];
        const response = await model.sendRequest(messages, {}, token);
        let full = '';
        for await (const chunk of response.text) {
          stream.markdown(chunk);
          full += chunk;
        }
        // Capture the model's reply as ai_output, linked to the prompt's turn.
        if (promptCaptured && full.trim().length > 0) {
          const modelId = model.family ?? model.id;
          const capture = hookContext(implicit);
          await runExtensionHook(tool, 'stop', {
            sessionId: extensionSessionId,
            ...capture,
            assistant: {
              text: full,
              sourceId: `vscode-participant:${extensionSessionId}:${randomUUID()}`,
              ...(modelId ? { model: modelId } : {}),
            },
          });
        }
      }
    } catch (err) {
      output.appendLine(`model request failed: ${(err as Error).message}`);
    }

    stream.markdown(
      '\n\n_For hands-on file edits, use Copilot agent mode — Showtail can capture saved ' +
        'edits when connected. Try `@showtail /report` or `/verify` anytime._',
    );
  };

  const participant = vscode.chat.createChatParticipant('showtail.chat', handler);
  context.subscriptions.push(participant);
}

/** Send saved files through the ledger-first hook path (debounced per file). */
function registerSaveCapture(
  context: vscode.ExtensionContext,
  projectControl: ProjectControlController,
): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const scheduleGenerations = new Map<string, number>();

  const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
    const captureOnSave = vscode.workspace
      .getConfiguration('showtail')
      .get<boolean>('captureOnSave', true);
    if (!captureOnSave) return;

    const file = doc.uri.fsPath;
    if (isInternalPath(file)) return;
    const preferredCwd = folderFor(doc.uri) ?? dirname(file);
    const tool = captureTool();
    const capture = hookContext(preferredCwd);
    const generation = (scheduleGenerations.get(file) ?? 0) + 1;
    scheduleGenerations.set(file, generation);

    // Collapse rapid saves of the same file into one hook event.
    const existing = timers.get(file);
    if (existing) clearTimeout(existing);
    timers.delete(file);
    void (async () => {
      // Snapshot consent when the save occurs. A file saved while capture is
      // stopped must not be queued and then picked up by a quick reconnect.
      if ((await captureConsent(tool, capture.cwd)) !== 'enabled') return;
      if (scheduleGenerations.get(file) !== generation) return;
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          if (scheduleGenerations.get(file) !== generation) return;
          void runExtensionHook(tool, 'post-edit', {
            sessionId: extensionSessionId,
            ...capture,
            editedFiles: [file],
          }).then(async (captured) => {
            if (captured === undefined) return;
            output.appendLine(`Captured saved file ${file}`);
            await projectControl.noteEditProject(file);
            if (tool === 'antigravity-ide') {
              antigravitySaveContext = capture;
              void scheduleAntigravityImport();
            } else {
              await maybeAutoInstallCopilot(context);
            }
          });
        }, 1500),
      );
    })();
  });

  context.subscriptions.push(sub, {
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      scheduleGenerations.clear();
    },
  });
}

async function runProjectControlCommand(
  projectControl: ProjectControlController,
  action: 'open_report' | 'status' | 'verify',
  selector?: string,
): Promise<void> {
  const execution = await projectControl.execute({
    action,
    ...(typeof selector === 'string' && selector.trim() ? { selector } : {}),
  });
  if (!execution.ok) {
    output.appendLine(`Showtail ${action}: ${execution.message}`);
    void vscode.window.showWarningMessage(`Showtail: ${execution.message}`);
    return;
  }

  output.appendLine(`Showtail ${action}: ${execution.text}`);
  if (execution.selection.crossWorkspace) {
    void vscode.window.showInformationMessage(
      `Showtail selected ${execution.selection.displayName} outside the open workspace: ${execution.selection.root}`,
    );
  }
  if (action === 'status' || action === 'verify') {
    output.show(true);
    return;
  }
  if (execution.opened === false) {
    void vscode.window.showWarningMessage(
      `Showtail generated the report at ${execution.reportPath}, but VS Code could not open it.`,
    );
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  projectControl: ProjectControlController,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('showtail.report', (selector?: string) =>
      runProjectControlCommand(projectControl, 'open_report', selector),
    ),
    vscode.commands.registerCommand('showtail.openReport', (selector?: string) =>
      runProjectControlCommand(projectControl, 'open_report', selector),
    ),
    vscode.commands.registerCommand('showtail.status', (selector?: string) =>
      runProjectControlCommand(projectControl, 'status', selector),
    ),
    vscode.commands.registerCommand('showtail.verify', (selector?: string) =>
      runProjectControlCommand(projectControl, 'verify', selector),
    ),
  );
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
