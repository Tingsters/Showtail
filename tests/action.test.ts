import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fixture } from './centralHelpers.ts';

const action = readFileSync(join(import.meta.dir, '../action.yml'), 'utf8');
const script = action
  .split('      run: |')[2]!
  .split('\n')
  .slice(1)
  .map((line) => line.replace(/^        /, ''))
  .join('\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
for (const [valid, reportOnly] of [
  [true, false],
  [false, false],
  [false, true],
] as const) {
  test(`CI verifies signed exports: valid=${valid}, reportOnly=${reportOnly}`, () =>
    fixture(({ dir }) => {
      if (process.platform === 'win32' && !existsSync(bash)) return;
      const shim = join(dir, 'showtail');
      writeFileSync(
        shim,
        `#!/bin/sh\n[ "$1" = "verify-submission" ] || exit 9\nprintf '%s\\n' '{"ok":${valid},"problems":[]}'\nexit ${valid ? 0 : 1}\n`,
      );
      chmodSync(shim, 0o755);
      const workflow = join(dir, 'verify.sh');
      writeFileSync(workflow, script);
      const output = join(dir, 'output');
      const summary = join(dir, 'summary');
      const result = spawnSync(bash, [workflow], {
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH}`,
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INPUT_PATH: "student's export",
          INPUT_FAIL_ON_INVALID: String(!reportOnly),
        },
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status).toBe(valid || reportOnly ? 0 : 1);
      expect(readFileSync(output, 'utf8')).toContain(`ok=${valid}`);
      expect(readFileSync(summary, 'utf8')).toContain(valid ? '**PASS' : '**FAIL');
    }));
}
