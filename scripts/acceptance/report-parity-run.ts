#!/usr/bin/env bun
/// <reference path="../../src/types/assets.d.ts" />
/** Small visible-feature fixture, including all three report AI modes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderHtml, renderMarkdown } from '../../src/core/report.ts';
import { parityReportFixture } from './report-fixture.ts';
import { inspectReport } from './report.ts';
const dir = resolve(process.argv[2] ?? 'dist/acceptance/report-parity');
const modes = (
  process.argv[3] ? [process.argv[3]] : ['collapsed', 'full', 'off']
) as Array<'collapsed' | 'full' | 'off'>;
const results = [];
for (const ai of modes) {
  if (!['collapsed', 'full', 'off'].includes(ai))
    throw new Error('AI mode must be collapsed, full, or off');
  const output = join(dir, ai);
  mkdirSync(output, { recursive: true });
  const data = parityReportFixture();
  writeFileSync(join(output, 'report.html'), renderHtml(data, { ai }));
  writeFileSync(join(output, 'report.md'), renderMarkdown(data, { ai }));
  writeFileSync(join(output, 'report.json'), JSON.stringify(data));
  const result = await inspectReport(
    join(output, 'report.html'),
    join(output, 'browser'),
    data.turns.map((turn) => turn.prompt.text),
  );
  results.push({ mode: ai, checks: result.checks });
  console.log(
    JSON.stringify(
      {
        mode: ai,
        passed: result.checks.filter((check) => check.ok).length,
        failed: result.checks.filter((check) => !check.ok),
      },
      null,
      2,
    ),
  );
}
writeFileSync(join(dir, 'result.json'), JSON.stringify(results, null, 2) + '\n');
process.exitCode = results.some((result) => result.checks.some((check) => !check.ok))
  ? 1
  : 0;
