/** One process per live scenario: native terminal handles never leak into the next. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCase, type LiveOptions } from './live.ts';
import { save, scrub, type Provider } from './common.ts';

const input = JSON.parse(process.argv[2] ?? '{}') as {
  options: LiveOptions;
  name: string;
  kind: string;
  provider?: Provider;
};
const dir = join(input.options.artifactDir, input.name);
mkdirSync(dir, { recursive: true });
const startedAt = new Date().toISOString();
try {
  const result = await runCase(input.options, input.name, input.kind, input.provider);
  save(join(dir, 'result.json'), {
    startedAt,
    completedAt: new Date().toISOString(),
    workerPid: process.pid,
    checks: result.checks,
    artifactDir: result.artifactDir,
  });
  process.exitCode = result.checks.some((c) => !c.ok) ? 1 : 0;
} catch (error) {
  save(join(dir, 'result.json'), {
    startedAt,
    completedAt: new Date().toISOString(),
    workerPid: process.pid,
    artifactDir: dir,
    checks: [
      {
        name: 'scenario worker completed',
        ok: false,
        detail: scrub(
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        ),
      },
    ],
  });
  process.exitCode = 1;
}
