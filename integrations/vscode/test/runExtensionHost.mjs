// Runs the real extension and CLI against a disposable native chat journal.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionTestsPath = join(extensionRoot, 'test', 'extensionHost', 'index.js');
const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'showtail-vscode-host-')));
const workspace = join(testRoot, 'workspace');
const userData = join(testRoot, 'user-data');
const showtailHome = join(testRoot, 'showtail-home');
const artifacts = resolve(
  process.env.SHOWTAIL_TEST_ARTIFACT_DIR ??
    join(extensionRoot, '../../dist/acceptance', `editor-host-${Date.now()}`),
);
const bun = process.env.SHOWTAIL_BUN_BIN || 'bun';
let binary = process.env.SHOWTAIL_TEST_BINARY;
// Provider credentials have no purpose in a recorded editor-transport test.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && key !== 'ELECTRON_RUN_AS_NODE',
  ),
);
Object.assign(env, {
  SHOWTAIL_HOME: showtailHome,
  CODEX_HOME: join(testRoot, 'codex'),
  CLAUDE_CONFIG_DIR: join(testRoot, 'claude'),
  COPILOT_HOME: join(testRoot, 'copilot'),
  GEMINI_HOME: join(testRoot, 'gemini'),
  SHOWTAIL_VSCODE_STORAGE: join(userData, 'User', 'workspaceStorage'),
  SHOWTAIL_VSCODE_CLI: join(testRoot, 'missing-editor-cli'),
  SHOWTAIL_ANTIGRAVITY_CLI: join(testRoot, 'missing-antigravity-cli'),
  SHOWTAIL_COPILOT_CLI: join(testRoot, 'missing-copilot-cli'),
  SHOWTAIL_CODEX_BIN: join(testRoot, 'missing-codex'),
  SHOWTAIL_DISABLE_FIRST_RUN: '1',
  SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
  SHOWTAIL_TEST_USER_DATA: userData,
  SHOWTAIL_TEST_ROOT: testRoot,
  SHOWTAIL_TEST_BUN: bun,
  SHOWTAIL_TEST_READER: join(extensionRoot, 'test', 'extensionHost', 'readHistory.ts'),
});
function command(executable, args) {
  const result = spawnSync(executable, args, {
    env,
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}
let passed = false;
try {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(showtailHome, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(workspace, 'package.json'),
    '{"name":"editor-watcher-fixture","private":true}\n',
  );
  writeFileSync(
    join(workspace, 'AGENTS.md'),
    'User-owned instructions remain untouched.\n',
  );
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
  writeFileSync(
    join(workspace, '.git', 'hooks', 'pre-commit'),
    'User-owned hook remains untouched.\n',
  );
  if (binary) {
    if (!isAbsolute(binary) || !existsSync(binary))
      throw new Error('SHOWTAIL_TEST_BINARY must name an existing absolute executable.');
  } else {
    binary = join(testRoot, process.platform === 'win32' ? 'showtail.exe' : 'showtail');
    command(bun, [
      'build',
      '--compile',
      join(extensionRoot, '../../src/cli.ts'),
      '--outfile',
      binary,
    ]);
  }
  env.SHOWTAIL_TEST_BINARY = binary;
  // Machine-scoped binaryPath must be set in the throwaway USER profile.
  writeFileSync(
    join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'showtail.binaryPath': binary,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'workbench.startupEditor': 'none',
      },
      null,
      2,
    ),
  );
  command(binary, ['connect', 'copilot', '--yes', '--no-extension', '--no-assistant']);
  const editor =
    process.env.SHOWTAIL_VSCODE_EXE ||
    (await downloadAndUnzipVSCode(process.env.SHOWTAIL_VSCODE_VERSION || '1.95.3'));
  const launchArgs = [
    workspace,
    '--user-data-dir',
    userData,
    '--extensions-dir',
    join(testRoot, 'extensions'),
    '--disable-extensions',
    '--disable-telemetry',
    '--disable-updates',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    `--extensionDevelopmentPath=${extensionRoot}`,
    `--extensionTestsPath=${extensionTestsPath}`,
  ];
  // Spawn directly: runTests() merges process.env back into its supplied env,
  // which would reintroduce the provider credentials deliberately removed above.
  const child = spawn(editor, launchArgs, {
    env,
    cwd: workspace,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => {
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    chunks.push(chunk);
  });
  let timedOut = false;
  const stop = () => {
    if (child.exitCode !== null || !Number.isInteger(child.pid)) return;
    if (process.platform === 'win32')
      spawnSync(
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 10_000 },
      );
    else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
  };
  const watchdog = setTimeout(() => {
    timedOut = true;
    stop();
  }, 180_000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let exitCode;
  try {
    exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
  } finally {
    clearTimeout(watchdog);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    writeFileSync(join(artifacts, 'host.log'), Buffer.concat(chunks));
  }
  if (timedOut || exitCode !== 0)
    throw new Error(
      `Editor watcher test ${timedOut ? 'timed out' : `exited ${exitCode}`}. See ${artifacts}`,
    );
  const result = JSON.parse(readFileSync(join(testRoot, 'watcher-result.json'), 'utf8'));
  writeFileSync(
    join(artifacts, 'result.json'),
    JSON.stringify(
      {
        ...result,
        binaryVersion: command(binary, ['--version']).trim(),
        binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      },
      null,
      2,
    ),
  );
  passed = true;
  console.log(`Native editor watcher acceptance passed. Evidence: ${artifacts}`);
} finally {
  if (!passed)
    console.error(`Editor watcher fixture retained for diagnosis: ${testRoot}`);
  else {
    const owned = realpathSync(testRoot);
    const withinTemp = relative(realpathSync(tmpdir()), owned);
    if (
      isAbsolute(withinTemp) ||
      withinTemp === '..' ||
      withinTemp.startsWith('..' + sep) ||
      !withinTemp.startsWith('showtail-vscode-host-')
    )
      throw new Error('Refusing unsafe editor fixture cleanup.');
    rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
