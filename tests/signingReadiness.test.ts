import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('SignPath Foundation readiness', () => {
  test('publishes the required policy, roles, privacy, and removal information', () => {
    const readme = read('README.md');
    const homepage = read('docs/index.md');
    const policy = read('docs/code-signing-policy.md');
    const releasePreamble = read('.github/release-preamble.md');
    const installation = read('docs/getting-started/installation.md');
    const uninstallation = read('docs/getting-started/uninstallation.md');
    const attribution =
      'Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by';

    expect(readme).toContain('## Code signing policy');
    expect(homepage).toContain('## Code signing policy');
    expect(policy).toContain(attribution);
    expect(releasePreamble).toContain(attribution);
    expect(policy).toContain('Tingsters');
    expect(policy).toContain('steveonjava');
    expect(policy).toContain('multi-factor authentication');
    expect(policy).toContain('no unsigned Windows fallback');
    expect(installation).toContain('user-level changes it makes');
    expect(installation).toContain('[Uninstallation](uninstallation.md)');
    expect(uninstallation).toContain('showtail setup --off');
    expect(uninstallation).toContain('Showtail\\bin');
  });

  test('pins Bun and enforces the Windows metadata required by SignPath', () => {
    const bunVersion = read('.bun-version').trim();
    const packageManifest = JSON.parse(read('package.json')) as { version: string };
    const windowsBuild = read('scripts/build-windows.ps1');
    const artifactConfiguration = read('.signpath/artifact-configuration.xml');
    const notices = read('THIRD_PARTY_NOTICES.md');

    expect(bunVersion).toBe('1.4.0');
    expect(windowsBuild).toContain('--windows-title=Showtail');
    expect(windowsBuild).toContain('--windows-publisher=Showtail contributors');
    expect(windowsBuild).toContain('$windowsVersion = "$Version.0"');
    expect(windowsBuild).toContain(`--windows-version=$windowsVersion`);
    expect(windowsBuild).toContain('ProductVersion = $windowsVersion');
    expect(artifactConfiguration).toContain('product-name="Showtail"');
    expect(artifactConfiguration).toContain('product-version="${version}"');
    expect(artifactConfiguration).toContain('file-version="${version}"');
    expect(notices).toContain(`Bun ${bunVersion}`);
    expect(packageManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('requires origin-verified signing before release publication', () => {
    const workflow = read('.github/workflows/release.yml');
    const signing = workflow.indexOf('Submit SignPath signing request');
    const verification = workflow.indexOf('Verify signed executable');
    const publication = workflow.indexOf('Publish signed release');

    expect(workflow).toContain('SIGNPATH_ENABLED');
    expect(workflow).toContain('archive: false');
    expect(workflow).toContain('skip-decompress: true');
    expect(workflow).toContain('SignPath Foundation');
    expect(workflow).toContain('git merge-base --is-ancestor');
    expect(signing).toBeGreaterThan(0);
    expect(verification).toBeGreaterThan(signing);
    expect(publication).toBeGreaterThan(verification);
  });

  test('pins every external GitHub Action to an immutable commit', () => {
    const workflowDir = join(root, '.github', 'workflows');
    const workflows = readdirSync(workflowDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => readFileSync(join(workflowDir, name), 'utf8'))
      .join('\n');

    for (const line of workflows.split('\n')) {
      const match = /^\s*uses:\s*([^\s#]+)/.exec(line);
      if (!match || match[1] === './') continue;
      expect(match[1]).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });
});
