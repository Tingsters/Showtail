// Drives a REAL VS Code through the extension-host security checks in
// test/extensionHost/security.js, once with an untrusted workspace and once trusted.
//
//   bun run build && bun test/runSecurityHost.mjs
//
// It uses the VS Code you already have (SHOWTAIL_VSCODE_EXE overrides the location) and falls
// back to downloading one with @vscode/test-electron. Each run gets a throwaway profile and
// extensions directory, so your own VS Code settings and extensions are never touched. A
// window appears briefly while each mode runs.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const securityTests = join(extensionRoot, 'test', 'extensionHost', 'security.js');
const shimSource = join(extensionRoot, 'test', 'security', 'shim.ts');
const EXE = process.platform === 'win32' ? 'showtail.exe' : 'showtail';

async function findVSCode() {
  const fromEnv = process.env.SHOWTAIL_VSCODE_EXE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code',
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  return downloadAndUnzipVSCode('1.95.3');
}

const root = mkdtempSync(join(tmpdir(), 'showtail-security-host-'));
const legitDir = join(root, 'legit-bin');
const workspace = join(root, 'workspace');
mkdirSync(legitDir, { recursive: true });
mkdirSync(join(workspace, '.vscode'), { recursive: true });

try {
  // One compiled stand-in for the CLI, copied to two places: PATH (legitimate) and the workspace (planted).
  const built = Bun.spawnSync([process.execPath, 'build', '--compile', shimSource, '--outfile', join(legitDir, EXE)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (built.exitCode !== 0) throw new Error(`could not compile the test shim:\n${built.stderr}`);
  copyFileSync(join(legitDir, EXE), join(workspace, EXE));

  // The hostile part: the workspace tries to point showtail.binaryPath at the planted program.
  writeFileSync(
    join(workspace, '.vscode', 'settings.json'),
    `${JSON.stringify({ 'showtail.binaryPath': join(workspace, EXE), 'showtail.captureOnSave': true }, null, 2)}\n`,
  );

  const code = await findVSCode();
  console.log(`VS Code: ${code}`);
  let failed = false;

  for (const mode of ['untrusted', 'trusted']) {
    const args = [
      workspace,
      `--extensionDevelopmentPath=${extensionRoot}`,
      `--extensionTestsPath=${securityTests}`,
      `--user-data-dir=${join(root, `user-data-${mode}`)}`,
      `--extensions-dir=${join(root, `extensions-${mode}`)}`,
      '--disable-extensions',
      '--disable-telemetry',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      // Without this flag a fresh profile opens the folder untrusted, which is the point of the first run.
      ...(mode === 'trusted' ? ['--disable-workspace-trust'] : []),
    ];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      PATH: `${legitDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      Path: `${legitDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      SHOWTAIL_HOME: join(root, 'showtail-home'),
      SHOWTAIL_DISABLE_FIRST_RUN: '1',
      SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
      SHOWTAIL_HOST_EXPECT: mode,
      SHOWTAIL_TEST_LEGIT_DIR: legitDir,
    });
    const proc = Bun.spawn([code, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), 150_000);
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const ok = exitCode === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode} workspace (exit ${exitCode})`);
    const controlFile = join(legitDir, 'control.txt');
    if (existsSync(controlFile)) {
      const note = readFileSync(controlFile, 'utf8').trim().split(/\r?\n/).join(' | ');
      console.log(`      control: ${note}`);
    }
    if (!ok) {
      failed = true;
      console.log(`${out}\n${err}`.split('\n').filter((l) => /Error|assert|Expected|actual|expected|AssertionError|✗|failed/i.test(l)).slice(0, 25).join('\n'));
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
