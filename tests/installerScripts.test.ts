import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('standalone installers', () => {
  test('the POSIX installer verifies and stages the release before replacement', () => {
    const script = readFileSync(join(root, 'install.sh'), 'utf8');
    expect(script).toContain('SHA256SUMS');
    expect(script).toContain('mktemp');
    expect(script).toContain('file_sha256');
    expect(script).toContain('replacement_started=1');
    expect(script).toContain('mv "$backup" "$target"');
    expect(script).not.toContain('curl -fSL "$url" -o "$target"');
  });

  test('the Windows installer verifies and can restore the previous executable', () => {
    const script = readFileSync(join(root, 'install.ps1'), 'utf8');
    expect(script).toContain('SHA256SUMS');
    expect(script).toContain('Get-FileHash -Algorithm SHA256');
    expect(script).toContain('.previous');
    expect(script).toContain(
      'Move-Item -LiteralPath $backup -Destination $target -Force',
    );
    expect(script).not.toContain('Invoke-WebRequest -Uri $url -OutFile $target');
  });
});
