import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionTestsPath = join(extensionRoot, 'test', 'extensionHost', 'index.js');
const testRoot = mkdtempSync(join(tmpdir(), 'showtail-vscode-host-'));
const workspace = join(testRoot, 'workspace');
const showtailHome = join(testRoot, 'showtail-home');

mkdirSync(join(workspace, '.vscode'), { recursive: true });
writeFileSync(
  join(workspace, '.vscode', 'settings.json'),
  `${JSON.stringify(
    {
      'showtail.binaryPath': join(testRoot, 'missing-showtail'),
      'showtail.captureOnSave': false,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

try {
  await runTests({
    version: '1.95.3',
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-telemetry'],
    extensionTestsEnv: {
      SHOWTAIL_HOME: showtailHome,
      SHOWTAIL_DISABLE_FIRST_RUN: '1',
      SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
    },
  });
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
