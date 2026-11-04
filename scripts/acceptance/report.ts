/** Browser assertions shared by recorded-fixture and real-session acceptance runs. */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export interface ReportCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

import { inspectViewerReport } from './report-browser.ts';

function browserEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(key),
    ),
  );
}

function nativeNode(): string {
  const candidates: string[] = [];
  if (process.env.SHOWTAIL_ACCEPTANCE_NODE_BIN)
    candidates.push(process.env.SHOWTAIL_ACCEPTANCE_NODE_BIN);
  const located = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    ['node'],
    { env: process.env, encoding: 'utf8', timeout: 5000 },
  );
  candidates.push(...(located.stdout ?? '').trim().split(/\r?\n/).filter(Boolean));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA)
    candidates.push(
      join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
    );
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const probe = spawnSync(
      bin,
      ['-p', 'process.versions.bun ? "bun" : process.versions.node'],
      {
        env: { ...browserEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      },
    );
    if (probe.status === 0 && Number(probe.stdout.trim().split('.')[0]) >= 20) return bin;
  }
  throw new Error(
    'UNAVAILABLE: browser acceptance requires real Node20+; set SHOWTAIL_ACCEPTANCE_NODE_BIN (VS Code Node mode is supported).',
  );
}

async function inspectInNode(
  reportPath: string,
  artifactDir: string,
  expectedPrompts: string[],
) {
  mkdirSync(artifactDir, { recursive: true });
  const resultPath = join(artifactDir, 'node-browser-result.json');
  if (existsSync(resultPath)) unlinkSync(resultPath);
  const inputPath = join(artifactDir, 'node-browser-input.json');
  writeFileSync(
    inputPath,
    JSON.stringify({ reportPath, artifactDir, expectedPrompts, resultPath }),
  );
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'browser-worker.ts')],
    outdir: artifactDir,
    naming: 'browser-worker.cjs',
    target: 'node',
    format: 'cjs',
    external: ['playwright'],
  });
  if (!built.success) throw new Error(built.logs.map((x) => x.message).join('\n'));
  const binary = nativeNode();
  const ran = spawnSync(binary, [join(artifactDir, 'browser-worker.cjs'), inputPath], {
    env: {
      ...browserEnvironment(),
      ELECTRON_RUN_AS_NODE: '1',
      // Artifacts may be outside the checkout; resolve the installed dependency
      // from this harness, rather than from the generated worker's ancestors.
      NODE_PATH: dirname(dirname(Bun.resolveSync('playwright', import.meta.dir))),
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (ran.error) throw ran.error;
  if (!existsSync(resultPath))
    throw new Error(`Browser worker exited ${ran.status}: ${ran.stderr}`);
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    checks: ReportCheck[];
  };
  if (!Array.isArray(result.checks) || !result.checks.length)
    throw new Error('Browser worker returned no checks');
  if (ran.status !== 0 && result.checks.every((c) => c.ok))
    result.checks.push({
      name: 'browser worker exited cleanly',
      ok: false,
      detail: `Exit ${ran.status}`,
    });
  writeFileSync(
    join(artifactDir, 'browser-runtime.json'),
    JSON.stringify({ binary, nodeMode: true, exitCode: ran.status }, null, 2) + '\n',
  );
  return result;
}

export async function inspectReport(
  reportPath: string,
  artifactDir: string,
  expectedPrompts: string[],
): Promise<{ checks: ReportCheck[] }> {
  if (process.versions.bun)
    return inspectInNode(reportPath, artifactDir, expectedPrompts);
  return inspectViewerReport(reportPath, artifactDir, expectedPrompts);
}
