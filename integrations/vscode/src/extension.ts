import * as vscode from 'vscode';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let output: vscode.OutputChannel;

/** The configured `showtail` binary (on PATH by default). */
function showtailBin(): string {
  return (
    vscode.workspace.getConfiguration('showtail').get<string>('binaryPath') || 'showtail'
  );
}

/** Run the showtail CLI; never throw — capture must never disrupt the editor. */
async function runShowtail(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(showtailBin(), args, { cwd });
    return stdout;
  } catch (err) {
    output.appendLine(`showtail ${args.join(' ')} failed: ${(err as Error).message}`);
    return undefined;
  }
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
      cp.stdout.on('data', (d) => (out += d.toString()));
      cp.on('error', (err) => {
        output.appendLine(`showtail ${args.join(' ')} failed: ${err.message}`);
        resolve(undefined);
      });
      cp.on('close', () => resolve(out));
      cp.stdin.end(input);
    } catch (err) {
      output.appendLine(`showtail ${args.join(' ')} failed: ${(err as Error).message}`);
      resolve(undefined);
    }
  });
}

/** Pull the logged event id out of `runLog`'s output ("Logged prompt (evt_…)"). */
function loggedEventId(out: string | undefined): string | undefined {
  return out?.match(/\((evt_[A-Za-z0-9_]+)\)/)?.[1];
}

/** The workspace folder a file belongs to (or the first folder as a fallback). */
function folderFor(uri: vscode.Uri | undefined): string | undefined {
  if (uri) {
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    if (wf) return wf.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Skip Showtail/Git/dependency bookkeeping files. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])(\.showtail|\.git|\.claude|node_modules)([\\/]|$)/.test(p);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Showtail');
  context.subscriptions.push(output);
  output.appendLine('Showtail is capturing your GitHub Copilot work trail.');

  registerChatParticipant(context);
  registerSaveCapture(context);
  registerCommands(context);
  void maybeAutoInstallCopilot(context);
}

/**
 * Make sure this workspace is a tracked Showtail project, honoring the global
 * opt-in. Returns true if a `.showtail/` exists (already, or after a silent
 * auto-init). When the folder is untracked, asks the CLI what to do via
 * `capabilities --json`: if automatic tracking is on, run `showtail ensure` to
 * start a trail at the right anchor; if it's off, do nothing (return false) so
 * we never create folders for a student who hasn't run `showtail setup`.
 */
async function ensureTracked(cwd: string): Promise<boolean> {
  if (existsSync(join(cwd, '.showtail'))) return true;
  const capsRaw = await runShowtail(['capabilities', '--json'], cwd);
  if (!capsRaw) return false;
  let caps: { initialized?: boolean; autoInit?: boolean };
  try {
    caps = JSON.parse(capsRaw);
  } catch {
    return false;
  }
  if (caps.initialized) return true;
  if (!caps.autoInit) return false; // opt-in off — respect it
  await runShowtail(['ensure'], cwd);
  if (!existsSync(join(cwd, '.showtail'))) return false;
  output.appendLine(
    'Showtail started a trail for this project (automatic tracking is on).',
  );
  return true;
}

/**
 * Keep the Copilot instructions (`.github/copilot-instructions.md`) set up and
 * current, so opening the project in VS Code is all the student needs to do:
 *   - if the instructions are already present, refresh them to the latest
 *     (a no-op when already current — `showtail connect copilot` only rewrites
 *     on change), so updates ship automatically on the next open;
 *   - if they're absent, install them the first time only (tracked in
 *     workspaceState) so we never fight a later manual `disconnect copilot`.
 * Only acts inside a `.showtail/` project.
 */
async function maybeAutoInstallCopilot(context: vscode.ExtensionContext): Promise<void> {
  const cwd = folderFor(undefined);
  if (!cwd) return;
  // Automatic tracking: if the student has opted in (via `showtail setup`),
  // silently start a trail on first open of an untracked project, mirroring the
  // hook auto-init in editor tools. Gated on the opt-in so we never create
  // folders for someone who hasn't run setup.
  if (!(await ensureTracked(cwd))) return; // not tracked and not opted in

  const KEY = 'showtail.autoInstalledCopilot';
  // Sentinel: our path-specific instructions file. If present, it's installed.
  const sentinel = join(cwd, '.github', 'instructions', 'showtail.instructions.md');

  if (existsSync(sentinel)) {
    // Installed already — refresh untouched blocks to the latest (edit-aware:
    // a block you've customized is kept, not overwritten).
    await runShowtail(['connect', 'copilot', '--no-extension'], cwd);
    await context.workspaceState.update(KEY, true);
    output.appendLine(
      'Showtail Copilot instructions checked (untouched blocks refreshed).',
    );
    await maybeNotifyUpdate(context, cwd);
    return;
  }

  // Absent: only auto-install the first time, to respect a manual uninstall.
  if (context.workspaceState.get<boolean>(KEY)) return;

  const out = await runShowtail(['connect', 'copilot', '--no-extension'], cwd);
  await context.workspaceState.update(KEY, true);
  if (out !== undefined) {
    output.appendLine('Auto-installed Showtail Copilot instructions in .github/.');
    vscode.window.showInformationMessage(
      'Showtail set up Copilot instructions for this project (.github/copilot-instructions.md).',
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
  const NOTIFY_KEY = 'showtail.copilotUpdateNotified';
  const status = await runShowtail(['status', '--json'], cwd);
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
    await runShowtail(['connect', 'copilot', '--no-extension', '--force'], cwd);
    await context.workspaceState.update(NOTIFY_KEY, false);
    output.appendLine('Applied the latest Showtail Copilot instructions.');
  }
}

/**
 * `@showtail` — the Showtail control surface in chat. It is NOT a coding agent
 * (use native Copilot for that — your edits are captured on save). It:
 *   - `/report` `/verify` `/status` `/trace <file>` — run those Showtail commands
 *   - plain text — records your prompt verbatim and gives a quick answer
 */
function registerChatParticipant(context: vscode.ExtensionContext): void {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const cwd = folderFor(undefined);
    if (!cwd) {
      stream.markdown('Open a folder to use Showtail.');
      return;
    }

    // Slash commands map straight to the CLI and show the output in chat.
    if (request.command === 'report') {
      stream.progress('Generating your Showtail report…');
      const out = await runShowtail(['report'], cwd);
      const m = out?.match(/Wrote report:\s*(.+)/);
      stream.markdown(
        m
          ? `Report written to \`${m[1].trim()}\`.`
          : 'Could not generate a report. Run `showtail init` in this project first.',
      );
      return;
    }
    if (request.command === 'verify' || request.command === 'status') {
      const args = request.command === 'verify' ? ['verify'] : ['status'];
      const out = await runShowtail(args, cwd);
      stream.markdown(
        '```\n' + (out ?? 'showtail was not found on your PATH.').trim() + '\n```',
      );
      return;
    }
    if (request.command === 'trace') {
      const file = request.prompt.trim();
      if (!file) {
        stream.markdown('Pass a file path, e.g. `@showtail /trace src/app.ts`.');
        return;
      }
      const out = await runShowtail(['trace', file], cwd);
      stream.markdown('```\n' + (out ?? 'No trail found.').trim() + '\n```');
      return;
    }

    // Plain text: record the prompt verbatim, then give a quick answer.
    let turnId: string | undefined;
    if (request.prompt.trim().length > 0) {
      const logged = await runShowtail(
        ['log', '--type', 'prompt', '--text', request.prompt, '--tool', 'github-copilot'],
        cwd,
      );
      turnId = loggedEventId(logged);
      stream.markdown('_Recorded your prompt in your Showtail trail._\n\n');
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
        if (full.trim().length > 0) {
          const args = ['log', '--type', 'ai_output', '--tool', 'github-copilot'];
          if (turnId) args.push('--turn', turnId);
          // Record which model produced the reply (e.g. "gpt-4o"); `family` is the
          // stable coarse id, falling back to the exact deployed `id`.
          const modelId = model.family ?? model.id;
          if (modelId) args.push('--model', modelId);
          await runShowtailStdin(args, cwd, full);
        }
      }
    } catch (err) {
      output.appendLine(`model request failed: ${(err as Error).message}`);
    }

    stream.markdown(
      '\n\n_For hands-on file edits, use Copilot agent mode — your saved edits are captured ' +
        'automatically. Try `@showtail /report` or `/verify` anytime._',
    );
  };

  const participant = vscode.chat.createChatParticipant('showtail.chat', handler);
  context.subscriptions.push(participant);
}

/** Snapshot files as artifacts when saved (debounced per file). */
function registerSaveCapture(context: vscode.ExtensionContext): void {
  const timers = new Map<string, NodeJS.Timeout>();

  const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
    const captureOnSave = vscode.workspace
      .getConfiguration('showtail')
      .get<boolean>('captureOnSave', true);
    if (!captureOnSave) return;

    const file = doc.uri.fsPath;
    if (isInternalPath(file)) return;
    const cwd = folderFor(doc.uri);
    if (!cwd) return;

    // Collapse rapid saves of the same file into one snapshot.
    const existing = timers.get(file);
    if (existing) clearTimeout(existing);
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        void runShowtail(['artifact', file, '--tool', 'github-copilot'], cwd).then(() =>
          output.appendLine(`snapshotted ${file}`),
        );
      }, 1500),
    );
  });

  context.subscriptions.push(sub, {
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  });
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('showtail.report', async () => {
      const cwd = folderFor(undefined);
      if (!cwd) {
        vscode.window.showWarningMessage('Showtail: open a folder first.');
        return;
      }
      const out = await runShowtail(['report'], cwd);
      const match = out?.match(/Wrote report:\s*(.+)/);
      if (match) {
        const doc = await vscode.workspace.openTextDocument(match[1].trim());
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showWarningMessage(
          'Showtail: could not generate a report. Run `showtail init` in this project first.',
        );
      }
    }),
    vscode.commands.registerCommand('showtail.status', async () => {
      const cwd = folderFor(undefined);
      if (!cwd) return;
      const out = await runShowtail(['status'], cwd);
      output.show(true);
      output.appendLine(out ?? 'showtail not found on PATH.');
    }),
  );
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
