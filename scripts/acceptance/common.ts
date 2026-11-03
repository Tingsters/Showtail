/** Acceptance-only helpers. Never loaded by the normal test preload or coding host. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export type Check = { name: string; ok: boolean; detail?: string };
export type Provider = 'codex' | 'claude';
export const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export const save = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
export const canonicalText = (s: string) => s.replace(/\r\n/g, '\n').trim();
export function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isSymbolicLink()
      ? []
      : e.isDirectory()
        ? files(join(root, e.name))
        : [join(root, e.name)],
  );
}
export function snapshot(root: string) {
  return Object.fromEntries(
    files(root)
      .filter((p) => !p.startsWith(join(root, '.git') + sep))
      .map((p) => [p.slice(root.length + 1), hash(readFileSync(p))]),
  );
}
export function findCommand(name: string): string {
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
    encoding: 'utf8',
    env: process.env,
  });
  const found = r.stdout?.trim().split(/\r?\n/)[0];
  if (!found || !existsSync(found))
    throw new Error(`UNAVAILABLE: ${name} is not installed`);
  return resolve(found);
}
const authSecrets = new Set<string>();
export function scrub(s: string): string {
  let out = s;
  for (const value of authSecrets) out = out.split(value).join('[REDACTED]');
  for (const [key, value] of Object.entries(process.env))
    if (value && value.length > 8 && /KEY|TOKEN|SECRET|PASSWORD/.test(key))
      out = out.split(value).join('[REDACTED]');
  return out
    .replace(/sk-[\w.-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[\w.+\/-]+/gi, 'Bearer [REDACTED]');
}
export async function command(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeout = 90_000,
) {
  // The sync transport is also used by the compiled-CLI regression fixtures.
  // It avoids Bun/ConPTY socket handle reuse during repeated Windows profiles.
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: scrub(result.stdout ?? ''),
    stderr: scrub(result.stderr ?? ''),
  };
}
export interface Scenario {
  root: string;
  workspace: string;
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  artifactDir: string;
  checks: Check[];
  credentials: string[];
  protectedFiles?: Record<string, string>;
}
export function createScenario(binary: string, artifactDir: string): Scenario {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'showtail-acceptance-')));
  const workspace = join(root, 'project');
  const home = join(root, 'history');
  for (const name of [
    'project',
    'history',
    'bin',
    'codex',
    'claude',
    'copilot',
    'gemini',
  ])
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const bin = join(
    root,
    'bin',
    process.platform === 'win32' ? 'showtail.exe' : 'showtail',
  );
  copyFileSync(binary, bin);
  // Preserve platform/runtime essentials but exclude unrelated inherited credentials.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/KEY|TOKEN|SECRET|PASSWORD|^CODEX_|^CLAUDE_|^SHOWTAIL_|^ANTHROPIC_/i.test(key),
    ),
  ) as NodeJS.ProcessEnv;
  Object.assign(env, {
    SHOWTAIL_HOME: home,
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    COPILOT_HOME: join(root, 'copilot'),
    GEMINI_HOME: join(root, 'gemini'),
    SHOWTAIL_DISABLE_FIRST_RUN: '1',
    SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
    // Test profiles must not update the installed provider executable.
    DISABLE_AUTOUPDATER: '1',
    SHOWTAIL_IDENTITY_EMAIL: 'acceptance@example.test',
    SHOWTAIL_IDENTITY_NAME: 'Acceptance',
    SHOWTAIL_ROOT_CEILING: root,
    SHOWTAIL_VSCODE_CLI: join(root, 'no-editor'),
    SHOWTAIL_ANTIGRAVITY_CLI: join(root, 'no-antigravity'),
    PATH:
      join(root, 'bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
  });
  // Environment keys are case insensitive on Windows; avoid a duplicate inherited Path.
  for (const key of Object.keys(env))
    if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
  writeFileSync(
    join(workspace, 'package.json'),
    '{"name":"acceptance-sample","private":true,"type":"module"}\n',
  );
  spawnSync('git', ['init', '--quiet'], { cwd: workspace, env });
  mkdirSync(join(workspace, '.github'), { recursive: true });
  writeFileSync(
    join(workspace, '.github', 'copilot-instructions.md'),
    'Keep unrelated project notes intact.\n',
  );
  writeFileSync(
    join(workspace, 'AGENTS.md'),
    'Use local dependencies for this project.\n',
  );
  const protectedFiles = Object.fromEntries(
    [
      ...files(join(workspace, '.git', 'hooks')),
      join(workspace, '.git', 'config'),
      join(workspace, 'AGENTS.md'),
      join(workspace, '.github', 'copilot-instructions.md'),
    ]
      .filter(existsSync)
      .map((p) => [p, hash(readFileSync(p))]),
  );
  mkdirSync(artifactDir, { recursive: true });
  save(join(artifactDir, 'scenario.json'), {
    root,
    workspace,
    home,
    binary,
    sha256: hash(readFileSync(binary)),
  });
  return {
    root,
    workspace,
    home,
    bin,
    env,
    artifactDir,
    checks: [],
    credentials: [],
    protectedFiles,
  };
}
export function provisionAuth(s: Scenario, provider: Provider) {
  if (provider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error(
        'UNAVAILABLE: ANTHROPIC_API_KEY is required for the isolated Claude profile',
      );
    s.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else {
    s.env.SHOWTAIL_CODEX_BIN = findCommand('codex');
    const source = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    if (!existsSync(source))
      throw new Error(
        'UNAVAILABLE: Codex auth.json is required for the isolated profile',
      );
    // OAuth login cannot be represented by CODEX_ACCESS_TOKEN on every host version.
    // Copy only credentials into the disposable private profile; never settings/history.
    const target = join(s.env.CODEX_HOME!, 'auth.json');
    const bytes = readFileSync(source);
    const auth = JSON.parse(bytes.toString('utf8'));
    for (const value of Object.values(auth.tokens ?? {}))
      if (typeof value === 'string' && value.length > 8) authSecrets.add(value);
    if (typeof auth.OPENAI_API_KEY === 'string') authSecrets.add(auth.OPENAI_API_KEY);
    writeFileSync(target, bytes, { mode: 0o600 });
    bytes.fill(0);
    s.credentials.push(target);
  }
}
export function clearAuth(s: Scenario) {
  for (const p of s.credentials) if (existsSync(p)) unlinkSync(p);
  delete s.env.ANTHROPIC_API_KEY;
}
export async function cli(s: Scenario, args: string[]) {
  const r = await command(s.bin, args, s.env, s.workspace);
  if (r.code !== 0)
    throw new Error(`${args.join(' ')} exited ${r.code}: ${r.stderr || r.stdout}`);
  return r;
}
export function ledger(s: Scenario) {
  const path = join(s.home, 'history.sqlite');
  if (!existsSync(path)) return [];
  using db = new Database(path, { readonly: true });
  const rows = db
    .query(
      'SELECT r.*,s.tool,s.native_id FROM records r JOIN sessions s ON r.session_id=s.id WHERE NOT EXISTS (SELECT 1 FROM records newer WHERE newer.supersedes_id=r.id) ORDER BY r.rowid',
    )
    .all() as any[];
  return rows.map((row) => {
    const p = JSON.parse(row.payload);
    return {
      ...row,
      ...p,
      text: p.textRef
        ? (db.query('SELECT content FROM objects WHERE hash=?').get(p.textRef) as any)
            ?.content
        : p.text,
      diff: p.diffRef
        ? (db.query('SELECT content FROM objects WHERE hash=?').get(p.diffRef) as any)
            ?.content
        : p.diff,
    };
  });
}
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
  message: string,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`TIMEOUT: ${message}`);
}
export function check(s: Scenario, name: string, ok: boolean, detail?: string) {
  s.checks.push({ name, ok, ...(detail ? { detail } : {}) });
  save(join(s.artifactDir, 'checks.json'), s.checks);
  return ok;
}
export function queueEmpty(s: Scenario) {
  const dir = join(s.home, 'observations');
  return (
    !existsSync(dir) ||
    readdirSync(dir).every((n) => !n.endsWith('.json') && n !== 'worker.lock')
  );
}
export async function connect(s: Scenario, provider: Provider, assistant = true) {
  await cli(s, ['connect', provider, '--yes', ...(assistant ? [] : ['--no-assistant'])]);
}
export function uniqueRun() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
}
