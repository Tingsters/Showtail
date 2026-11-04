#!/usr/bin/env bun
/** Developer-only visual audit. Private inputs are never accepted in CI. */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { renderHtml, renderMarkdown } from '../../src/core/report.ts';
import type { ReportData } from '../../src/types.ts';
import { parityReportFixture } from './report-fixture.ts';
import { largeReportFixture } from './report-large.ts';
import { inspectReport, runBrowserWorker } from './report.ts';
import type { AuditResult } from './report-audit-types.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    fixture: { type: 'string' },
    report: { type: 'string' },
    'artifact-dir': { type: 'string' },
  },
});
if (values.report && values.fixture)
  throw new Error('Use --report or --fixture, not both.');
if (values.report && process.env.CI)
  throw new Error(
    'Private --report inputs are local-only; CI must use synthetic fixtures.',
  );
const fixture = values.fixture ?? 'parity';
if (!['parity', 'large', 'empty'].includes(fixture))
  throw new Error('--fixture must be parity, large or empty.');
const artifactDir = resolve(
  values['artifact-dir'] ?? join('dist', 'acceptance', `report-audit-${Date.now()}`),
);
if (existsSync(artifactDir) && readdirSync(artifactDir).length > 0)
  throw new Error(
    'Choose a new artifact directory; previous audit evidence is retained.',
  );
mkdirSync(artifactDir, { recursive: true });
const synthetic = !values.report;
const reportPath = values.report
  ? resolve(values.report)
  : join(artifactDir, 'input', 'report.html');
let data: ReportData;
if (synthetic) {
  data = fixture === 'large' ? largeReportFixture() : parityReportFixture();
  if (fixture === 'empty') {
    data.turns = [];
    data.plans = [];
    data.fileObservations = [];
    data.contributors = [];
    data.tools = [];
    data.models = [];
    data.toolTimeline = [];
    data.coverage = undefined;
    data.summary = { sessions: 0, events: 0, artifacts: 0, plans: 0, decisions: 0 };
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderHtml(data));
  writeFileSync(join(dirname(reportPath), 'report.json'), JSON.stringify(data));
  writeFileSync(join(dirname(reportPath), 'report.md'), renderMarkdown(data));
} else
  data = JSON.parse(
    readFileSync(join(dirname(reportPath), 'report.json'), 'utf8'),
  ) as ReportData;
const hash = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt = {
  startedAt: new Date().toISOString(),
  synthetic,
  fixture: synthetic ? fixture : null,
  reportPath,
  htmlSha256: hash(reportPath),
  dataSha256: hash(join(dirname(reportPath), 'report.json')),
  revision: spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout?.trim(),
  workingTree: spawnSync('git', ['diff', 'HEAD'], { encoding: 'utf8', windowsHide: true })
    .stdout
    ? 'modified'
    : 'clean',
  bun: Bun.version,
  status: 'incomplete',
  visualReview: 'pending',
};
writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(receipt, null, 2));
writeFileSync(
  join(artifactDir, 'visual-review.json'),
  JSON.stringify(
    {
      status: 'pending',
      htmlSha256: receipt.htmlSha256,
      dataSha256: receipt.dataSha256,
      reviews: [],
      findings: [],
    },
    null,
    2,
  ) + '\n',
);
try {
  const functional = await inspectReport(
    reportPath,
    join(artifactDir, 'functional'),
    data.turns.map((turn) => turn.prompt.text),
  );
  if (synthetic && fixture === 'large') {
    functional.checks.push({
      name: 'large fixture single HTML remains below twelve MiB',
      ok: readFileSync(reportPath).length <= 12 * 1024 * 1024,
    });
    functional.checks.push({
      name: 'large fixture exercises full late-body search',
      ok: functional.checks.some(
        (check) =>
          check.name ===
            'full-history search finds text beyond visible prompt previews' && check.ok,
      ),
    });
  }
  const visual = await runBrowserWorker<AuditResult>(
    'report-audit-worker.ts',
    { reportPath, synthetic },
    join(artifactDir, 'visual'),
    300_000,
  );
  const checks = [...functional.checks, ...visual.checks];
  const failed = checks.filter((check) => !check.ok);
  const status = !visual.complete ? 'incomplete' : failed.length ? 'fail' : 'pass';
  const result = {
    ...receipt,
    completedAt: new Date().toISOString(),
    status,
    checks,
    visual,
  };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        artifactDir,
        status,
        passed: checks.length - failed.length,
        failed,
        screenshots: visual.states.length,
        visualReview: 'pending',
      },
      null,
      2,
    ),
  );
  process.exitCode = status === 'pass' ? 0 : 1;
} catch (error) {
  writeFileSync(
    join(artifactDir, 'result.json'),
    JSON.stringify({ ...receipt, error: String(error) }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
}
