/** Fast, fail-open intake. No plugin loading, transcript parsing, Git or SQLite. */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { dataPath } from './dataHome.ts';
import {
  readGlobalConfig,
  toolCaptureEnabledAt,
  toolCaptureGloballyDisabled,
} from './globalConfig.ts';
import { isSensitivePath } from './sensitivePaths.ts';

export interface Observation {
  version: 1;
  id: string;
  tool: string;
  cliName: string;
  event: string;
  nativeSessionId?: string;
  transcriptPath?: string;
  cwd?: string | null;
  workspacePaths: string[];
  files: string[];
  observedAt: string;
  enabledAt?: string;
  epoch?: string;
}
const aliases: Record<string, string> = {
  claude: 'claude-code',
  copilot: 'github-copilot',
};
const cliNames: Record<string, string> = {
  'claude-code': 'claude',
  'github-copilot': 'copilot',
  codex: 'codex',
  'copilot-cli': 'copilot-cli',
  'antigravity-cli': 'antigravity-cli',
  'antigravity-ide': 'antigravity-ide',
};
const string = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 32768 ? v : undefined;

export function makeObservation(
  event: string,
  raw: unknown,
  name: string,
): Observation | null {
  const tool = aliases[name] ?? name;
  const cliName = cliNames[tool];
  if (!cliName || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, any>;
  // Prompt capture is retired, including invocations from obsolete installations.
  if (!['session-start', 'post-edit', 'stop', 'session-end'].includes(event)) return null;
  if (
    tool === 'github-copilot' &&
    p.showtailExtension !== 'showtail-vscode-extension-hook/v1'
  )
    return null;
  if (
    tool === 'copilot-cli' &&
    ['session_id', 'hook_event_name', 'transcript_path'].some((k) => k in p)
  )
    return null;
  const cfg = readGlobalConfig();
  if (!cfg.captureEnabled || toolCaptureGloballyDisabled(cliName)) return null;
  const cwd = p.projectCwd === null ? null : string(p.projectCwd ?? p.cwd);
  const roots = (Array.isArray(p.workspacePaths) ? p.workspacePaths : [])
    .filter((v: unknown) => !!string(v) && isAbsolute(v as string))
    .slice(0, 128);
  const input = p.tool_input ?? p.toolInput ?? p.toolCall?.args ?? {};
  const paths: unknown[] = [
    ...(Array.isArray(p.editedFiles) ? p.editedFiles : []),
    input.file_path,
    input.path,
    input.TargetFile,
    p.tool_response?.filePath,
  ];
  // Only structured path hints; never interpret shell commands or queue content.
  const files =
    event === 'post-edit'
      ? [
          ...new Set(
            paths.flatMap((v) => {
              const path = string(v);
              if (!path) return [];
              const abs = isAbsolute(path) ? path : cwd ? resolve(cwd, path) : undefined;
              return abs && !isSensitivePath(abs) ? [abs] : [];
            }),
          ),
        ].slice(0, 128)
      : [];
  const transcript = string(p.transcript_path ?? p.transcriptPath);
  const id = string(p.session_id ?? p.sessionId ?? p.conversationId ?? p.thread_id);
  return {
    version: 1,
    id: randomUUID(),
    tool,
    cliName,
    event,
    nativeSessionId: id && id.length <= 512 ? id : undefined,
    transcriptPath: transcript && isAbsolute(transcript) ? transcript : undefined,
    cwd: cwd === null ? null : cwd && isAbsolute(cwd) ? cwd : (roots[0] ?? null),
    workspacePaths: roots,
    files,
    observedAt: new Date().toISOString(),
    enabledAt: toolCaptureEnabledAt(cliName),
    epoch: cfg.captureResumedAt ?? cfg.captureSince,
  };
}
export function observationConsent(o: Observation): boolean {
  const cfg = readGlobalConfig();
  return (
    cfg.captureEnabled === true &&
    !toolCaptureGloballyDisabled(o.cliName) &&
    toolCaptureEnabledAt(o.cliName) === o.enabledAt &&
    (cfg.captureResumedAt ?? cfg.captureSince) === o.epoch
  );
}
export function observerQueue(): string {
  return dataPath('observations');
}
export function observationCount(): number {
  const dir = observerQueue();
  return existsSync(dir)
    ? readdirSync(dir).filter((n) => /^[\w-]+\.json$/.test(n)).length
    : 0;
}
export function launchCollector(): void {
  try {
    const pid = Number(readFileSync(join(observerQueue(), 'worker.lock'), 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 0);
      return;
    }
  } catch {
    /* No live worker: start one. */
  }
  const runtime = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath);
  const args = runtime
    ? [resolve(import.meta.dir, '..', 'cli.ts'), '_collect']
    : ['_collect'];
  if (process.platform === 'win32') {
    // Windows hook hosts can tear down their process tree on return. The same
    // independent Start-Process launcher used by self-update survives that exit.
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const quoteArg = (value: string) =>
      `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal(args.map(quoteArg).join(' '))} -WindowStyle Hidden | Out-Null`;
    spawnSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 1500 },
    );
    return;
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}
export function observe(
  event: string,
  payload: unknown,
  tool: string,
  launch = true,
): void {
  const o = makeObservation(event, payload, tool);
  if (!o) return;
  const dir = observerQueue();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${o.id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
  renameSync(tmp, file);
  if (launch) launchCollector();
}

export async function observerMain(args: string[]): Promise<void> {
  const event = args[0] ?? '';
  const i = args.indexOf('--tool');
  const tool = i < 0 ? 'claude' : (args[i + 1] ?? '');
  try {
    observe(event, JSON.parse(await Bun.stdin.text()), tool);
  } catch {
    /* Never interrupt the host. */
  }
  // Antigravity's strict post-event parser requires a JSON object. This contains
  // no permission decision or additional context. Other hosts receive no bytes.
  if (tool.startsWith('antigravity')) process.stdout.write('{}\n');
}
