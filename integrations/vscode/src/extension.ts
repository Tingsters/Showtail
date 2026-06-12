import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let output: vscode.OutputChannel;

/** The configured `showtail` binary (on PATH by default). */
function showtailBin(): string {
  return vscode.workspace.getConfiguration('showtail').get<string>('binaryPath') || 'showtail';
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
}

/** `@showtail <prompt>` — log the prompt, then answer via the Copilot model. */
function registerChatParticipant(context: vscode.ExtensionContext): void {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const cwd = folderFor(undefined);
    if (cwd && request.prompt.trim().length > 0) {
      await runShowtail(
        ['log', '--type', 'prompt', '--text', request.prompt, '--tool', 'github-copilot'],
        cwd,
      );
    }

    try {
      const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (!model) {
        stream.markdown(
          'No Copilot model is available, but your prompt was recorded in your Showtail trail.',
        );
        return;
      }
      const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];
      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        stream.markdown(chunk);
      }
    } catch (err) {
      output.appendLine(`model request failed: ${(err as Error).message}`);
      stream.markdown(
        'I could not reach the model just now, but your prompt was recorded in Showtail.',
      );
    }
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
        void runShowtail(['artifact', 'add', file, '--tool', 'github-copilot'], cwd).then(
          () => output.appendLine(`snapshotted ${file}`),
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
      const out = await runShowtail(['copilot', 'status'], cwd);
      output.show(true);
      output.appendLine(out ?? 'showtail not found on PATH.');
    }),
  );
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
