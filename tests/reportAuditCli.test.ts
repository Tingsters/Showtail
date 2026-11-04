import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, makeTempDir } from './helpers.ts';

test('audit iterations cannot overwrite an existing nonempty artifact directory', () => {
  const dir = makeTempDir();
  try {
    const previous = join(dir, 'previous-evidence.txt');
    writeFileSync(previous, 'Retain this evidence exactly.');
    const ran = spawnSync(
      process.execPath,
      ['run', 'scripts/acceptance/report-audit-run.ts', '--artifact-dir', dir],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      },
    );
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('previous audit evidence is retained');
    expect(readFileSync(previous, 'utf8')).toBe('Retain this evidence exactly.');
    expect(existsSync(join(dir, 'input'))).toBe(false);
  } finally {
    cleanup(dir);
  }
}, 20000);

test('private report audits are refused in CI before reading or writing report artifacts', () => {
  const dir = makeTempDir();
  try {
    const artifacts = join(dir, 'must-not-exist');
    const ran = spawnSync(
      process.execPath,
      [
        'run',
        'scripts/acceptance/report-audit-run.ts',
        '--report',
        join(dir, 'private.html'),
        '--artifact-dir',
        artifacts,
      ],
      {
        env: { ...process.env, CI: 'true' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      },
    );
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('Private --report inputs are local-only');
    expect(existsSync(artifacts)).toBe(false);
  } finally {
    cleanup(dir);
  }
}, 20000);

test('an unavailable browser produces an incomplete audit and a failing exit instead of a pass', () => {
  const dir = makeTempDir();
  try {
    const ran = spawnSync(
      process.execPath,
      [
        'run',
        'scripts/acceptance/report-audit-run.ts',
        '--fixture',
        'empty',
        '--artifact-dir',
        dir,
      ],
      {
        env: { ...process.env, SHOWTAIL_ACCEPTANCE_BROWSER: 'unavailable-engine' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      },
    );
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(1);
    const receipt = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    expect(receipt.status).toBe('incomplete');
    expect(receipt.visualReview).toBe('pending');
  } finally {
    cleanup(dir);
  }
}, 35000);
