import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { runSubmit } from '../src/commands/submit.ts';
import { logEvent } from '../src/core/events.ts';
import { SUBMISSION_DIR } from '../src/core/submission.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, CLI, cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

/**
 * Runs the *real* "Verify trail" step script from action.yml under bash, the way the
 * runner would, so the `mode: submission` branch is exercised for what it does.
 */
const ROOT = join(import.meta.dir, '..');
/**
 * Git Bash on Windows. A bare `bash` there can resolve to WSL's System32\bash.exe, which
 * cannot run these scripts or see Windows paths, so name Git's explicitly.
 */
function findBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = join(root, 'Git', 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}
const BASH = findBash();
const hasBash = Bun.spawnSync([BASH, '-c', 'exit 0']).exitCode === 0;

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
  const proc = Bun.spawn([BASH, '--noprofile', '--norc', '-eo', 'pipefail', script], {
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
      expect(r.code, r.out).toBe(0);
      expect(r.output, r.out).toContain('ok=true');
      expect(r.summary, r.out).toContain('PASS');
      expect(r.summary, r.out).toContain('not show who made them');
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
      expect(r.code, r.out).toBe(1);
      expect(r.output, r.out).toContain('ok=false');
      expect(r.summary, r.out).toContain('FAIL');
      expect(r.summary, r.out).toContain('changed after signing');
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
      expect(r.code, r.out).toBe(0);
      expect(r.output, r.out).toContain('ok=false');
    } finally {
      cleanup(dir);
    }
  });

  test('a missing submission folder is a failure, not a pass', async () => {
    const dir = await makeSubmission();
    try {
      const r = await runStep(dir, { INPUT_SUBMISSION_DIR: 'nope' });
      expect(r.code, r.out).toBe(1);
      expect(r.output, r.out).not.toContain('ok=true');
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

describe('verify-submission --json emits exactly one document', () => {
  // The Action reads it with `jq`. A failing run used to print its result AND the CLI's error
  // envelope, two JSON documents, and jq exited 5 on the second. That only showed on runners
  // that have jq, so it is pinned here at the source.
  test('a failing verify prints one parseable JSON document and exits 3', async () => {
    const dir = await makeSubmission();
    try {
      const md = join(dir, SUBMISSION_DIR, 'report.md');
      writeFileSync(md, readFileSync(md, 'utf8') + '\nedited after signing\n');
      const r = runCli(dir, ['verify-submission', '--json'], { env: spawnEnv() });
      expect(r.code, r.stdout + r.stderr).toBe(3);
      const doc = JSON.parse(r.stdout); // throws if there is more than one document
      expect(doc.ok).toBe(false);
      expect(doc.problems.join(' ')).toContain('changed after signing');
    } finally {
      cleanup(dir);
    }
  });

  test('a passing verify prints one document and exits 0', async () => {
    const dir = await makeSubmission();
    try {
      const r = runCli(dir, ['verify-submission', '--json'], { env: spawnEnv() });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
