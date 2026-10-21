import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { runSubmit } from '../src/commands/submit.ts';
import { logEvent } from '../src/core/events.ts';
import { SUBMISSION_DIR } from '../src/core/submission.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, CLI, cleanup, makeTempDir, spawnEnv } from './helpers.ts';

/**
 * Runs the *real* "Verify trail" step script from action.yml under bash, the way the
 * runner would, so the `mode: submission` branch is exercised for what it does.
 */
const ROOT = join(import.meta.dir, '..');
const hasBash = Bun.spawnSync(['bash', '-c', 'exit 0']).exitCode === 0;

function stepScript(): string {
  const action = Bun.YAML.parse(readFileSync(join(ROOT, 'action.yml'), 'utf8')) as {
    runs: { steps: Array<{ id?: string; run: string }> };
  };
  return action.runs.steps.find((s) => s.id === 'verify')!.run;
}

async function makeSubmission(): Promise<string> {
  const dir = makeTempDir();
  await runInit({ cwd: dir });
  await logEvent(authorFor(pathsForRoot(dir)), {
    type: 'prompt',
    text: 'build a parser',
  });
  const orig = console.log;
  console.log = () => {};
  try {
    await runSubmit({ cwd: dir, sync: false });
  } finally {
    console.log = orig;
  }
  return dir;
}

async function runStep(
  project: string,
  input: Record<string, string>,
): Promise<{ code: number; summary: string; output: string; out: string }> {
  const work = makeTempDir();
  const shims = makeTempDir();
  const bun = process.execPath.split(String.fromCharCode(92)).join('/');
  const cli = CLI.split(String.fromCharCode(92)).join('/');
  writeFileSync(join(shims, 'showtail'), `#!/bin/sh\nexec "${bun}" run "${cli}" "$@"\n`);
  chmodSync(join(shims, 'showtail'), 0o755);
  const script = join(work, 'step.sh');
  writeFileSync(script, stepScript());
  const summary = join(work, 'summary.md');
  const output = join(work, 'output.txt');
  writeFileSync(summary, '');
  writeFileSync(output, '');
  const proc = Bun.spawn(['bash', '--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: project,
    env: {
      ...spawnEnv(),
      RUNNER_TEMP: work,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
      INPUT_PATH: project,
      INPUT_FAIL_ON_INVALID: 'true',
      INPUT_MODE: 'submission',
      INPUT_SUBMISSION_DIR: SUBMISSION_DIR,
      PATH: `${shims}${delimiter}${process.env.PATH ?? ''}`,
      ...input,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [so, se, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = {
    code,
    summary: readFileSync(summary, 'utf8'),
    output: readFileSync(output, 'utf8'),
    out: so + se,
  };
  cleanup(work);
  cleanup(shims);
  return result;
}

describe.skipIf(!hasBash)('the Action in submission mode', () => {
  test('a valid submission passes, and says what that does and does not show', async () => {
    const dir = await makeSubmission();
    try {
      const r = await runStep(dir, {});
      expect(r.code).toBe(0);
      expect(r.output).toContain('ok=true');
      expect(r.summary).toContain('PASS');
      expect(r.summary).toContain('not show who made them');
    } finally {
      cleanup(dir);
    }
  });

  test('a report edited after signing fails the check', async () => {
    const dir = await makeSubmission();
    try {
      const md = join(dir, SUBMISSION_DIR, 'report.md');
      writeFileSync(md, readFileSync(md, 'utf8') + '\nedited after signing\n');
      const r = await runStep(dir, {});
      expect(r.code).toBe(1);
      expect(r.output).toContain('ok=false');
      expect(r.summary).toContain('FAIL');
      expect(r.summary).toContain('changed after signing');
    } finally {
      cleanup(dir);
    }
  });

  test('fail-on-invalid: false reports without failing the workflow', async () => {
    const dir = await makeSubmission();
    try {
      const md = join(dir, SUBMISSION_DIR, 'report.md');
      writeFileSync(md, readFileSync(md, 'utf8') + '\nedited\n');
      const r = await runStep(dir, { INPUT_FAIL_ON_INVALID: 'false' });
      expect(r.code).toBe(0);
      expect(r.output).toContain('ok=false');
    } finally {
      cleanup(dir);
    }
  });

  test('a missing submission folder is a failure, not a pass', async () => {
    const dir = await makeSubmission();
    try {
      const r = await runStep(dir, { INPUT_SUBMISSION_DIR: 'nope' });
      expect(r.code).toBe(1);
      expect(r.output).not.toContain('ok=true');
    } finally {
      cleanup(dir);
    }
  });
});

describe('action.yml', () => {
  test('declares the mode inputs and keeps trail verification the default', () => {
    const action = Bun.YAML.parse(readFileSync(join(ROOT, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
    };
    expect(action.inputs.mode!.default).toBe('trail');
    expect(action.inputs['submission-dir']!.default).toBe('showtail-submission');
  });

  test('its install step stays contained and pinned to verified downloads', () => {
    const text = readFileSync(join(ROOT, 'action.yml'), 'utf8');
    expect(text).toContain('SHOWTAIL_DISABLE_FIRST_RUN=1');
    expect(existsSync(join(ROOT, 'install.sh'))).toBe(true);
  });
});
