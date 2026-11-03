#!/usr/bin/env bun
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { command, findCommand, hash, save, uniqueRun } from './common.ts';
import { runLive } from './live.ts';
import { runOffline } from './offline.ts';
import { inspectReport } from './report.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    live: { type: 'boolean' },
    binary: { type: 'string' },
    'artifact-dir': { type: 'string' },
    repetitions: { type: 'string' },
    provider: { type: 'string' },
    scenario: { type: 'string' },
    'turn-timeout': { type: 'string' },
    sandbox: { type: 'string' },
  },
});
if (process.platform === 'win32' && Bun.semver.satisfies(Bun.version, '<1.4.0'))
  throw new Error(
    'Windows acceptance/browser tests require Bun1.4.0 or newer; the application runtime requirement is unchanged.',
  );
const repetitions = Number(values.repetitions ?? 3),
  turnTimeout = Number(values['turn-timeout'] ?? 600_000);
if (!Number.isSafeInteger(repetitions) || repetitions < 1)
  throw new Error('repetitions must be a positive integer');
if (!Number.isSafeInteger(turnTimeout) || turnTimeout < 1000)
  throw new Error('turn-timeout must be an integer of at least1000 milliseconds');
const sandbox = values.sandbox ?? 'workspace-write';
if (!['workspace-write', 'danger-full-access'].includes(sandbox))
  throw new Error('sandbox must be workspace-write or danger-full-access');
const artifactDir = resolve(
  values['artifact-dir'] ?? join('dist', 'acceptance', uniqueRun()),
);
mkdirSync(artifactDir, { recursive: true });
let binary: string;
if (values.binary) binary = resolve(values.binary);
else if (values.live) binary = findCommand('showtail');
else {
  binary = join(artifactDir, process.platform === 'win32' ? 'showtail.exe' : 'showtail');
  const built = await command(
    process.execPath,
    ['build', '--compile', 'src/cli.ts', '--outfile', binary],
    process.env,
    process.cwd(),
  );
  if (built.code !== 0) throw new Error(built.stderr);
}
const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const retries: Array<Record<string, unknown>> = [];
const receipt = {
  startedAt: new Date().toISOString(),
  binary,
  sha256: hash(readFileSync(binary)),
  bun: Bun.version,
  live: !!values.live,
  status: 'running',
  coverage: values.live
    ? values.provider || values.scenario || repetitions < 3
      ? 'partial-live'
      : 'full-live'
    : 'offline',
  selection: {
    providers: values.live
      ? values.provider
        ? [values.provider]
        : ['codex', 'claude']
      : [],
    scenario: values.scenario ?? null,
    repetitions,
    turnTimeout,
    providerSandbox: values.live ? sandbox : null,
  },
  checks,
  retries,
};
save(join(artifactDir, 'result.json'), receipt);
try {
  if (values.live) {
    if (values.provider && !['codex', 'claude'].includes(values.provider))
      throw new Error('provider must be codex or claude');
    const result = await runLive({
      binary,
      artifactDir,
      repetitions,
      turnTimeout,
      providers: values.provider ? [values.provider as 'codex' | 'claude'] : undefined,
      scenario: values.scenario,
      sandbox: sandbox as 'workspace-write' | 'danger-full-access',
    });
    checks.push(...result.checks);
    retries.push(...result.retries);
    if (!result.scenarios.length) throw new Error('No scenarios selected');
  } else {
    const result = await runOffline({ binary, artifactDir });
    checks.push(...result.checks);
    checks.push(
      ...(
        await inspectReport(
          result.reportPath,
          join(artifactDir, 'browser'),
          result.expectedPrompts,
        )
      ).checks,
    );
  }
} catch (error) {
  checks.push({ name: 'acceptance completed', ok: false, detail: String(error) });
}
const passed = checks.filter((c) => c.ok).length,
  failed = checks.length - passed;
save(join(artifactDir, 'result.json'), {
  ...receipt,
  completedAt: new Date().toISOString(),
  status: failed ? 'fail' : 'pass',
  passed,
  failed,
  checks: checks.map((c) => ({
    ...c,
    status: c.ok ? 'pass' : c.detail?.includes('UNAVAILABLE:') ? 'unavailable' : 'fail',
  })),
});
console.log(
  JSON.stringify(
    {
      artifactDir,
      binary,
      coverage: receipt.coverage,
      passed,
      failed,
      failures: checks.filter((c) => !c.ok),
    },
    null,
    2,
  ),
);
process.exitCode = failed ? 1 : 0;
