/** Runs in the established real-Node browser transport. */
import { readFileSync, writeFileSync } from 'node:fs';
import { auditReport } from './report-audit-browser.ts';
import type { AuditInput } from './report-audit-types.ts';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as AuditInput;
auditReport(input)
  .then((result) => {
    writeFileSync(input.resultPath, JSON.stringify(result, null, 2) + '\n');
    process.exitCode =
      result.checks.some((check) => !check.ok) || !result.complete ? 1 : 0;
  })
  .catch((error) => {
    writeFileSync(
      input.resultPath,
      JSON.stringify({
        checks: [{ name: 'audit worker completed', ok: false, detail: String(error) }],
        states: [],
        errors: [String(error)],
        tasks: [],
        complete: false,
        engine: process.env.SHOWTAIL_ACCEPTANCE_BROWSER ?? 'chromium',
      }),
    );
    process.exitCode = 1;
  });
