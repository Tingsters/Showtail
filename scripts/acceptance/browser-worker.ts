/** Runs in real Node (including VS Code's Node mode), never in a model process. */
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectReport } from './report.ts';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  reportPath: string;
  artifactDir: string;
  expectedPrompts: string[];
  resultPath: string;
};
inspectReport(input.reportPath, input.artifactDir, input.expectedPrompts)
  .then((result) => {
    writeFileSync(input.resultPath, JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.checks.some((c) => !c.ok) ? 1 : 0;
  })
  .catch((error) => {
    writeFileSync(
      input.resultPath,
      JSON.stringify({
        checks: [{ name: 'browser worker completed', ok: false, detail: String(error) }],
      }) + '\n',
    );
    process.exitCode = 1;
  });
