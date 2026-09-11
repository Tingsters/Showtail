import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_MD, pluginHooksJson } from '../src/core/skill.ts';

const REPO = join(import.meta.dir, '..');

/** Read a committed asset file with normalized (LF) line endings. */
function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('claude-code assets stay in sync with the single source of truth', () => {
  test('embedded SKILL.md matches the committed plugin skill file', () => {
    const committed = readAsset(
      'assets',
      'claude-code',
      'plugin',
      'skills',
      'showtail',
      'SKILL.md',
    );
    expect(SKILL_MD.replace(/\r\n/g, '\n')).toBe(committed);
    expect(SKILL_MD).toContain('showtail status --json --tool claude');
    expect(SKILL_MD).toContain('"mode": "automatic"');
    expect(SKILL_MD).not.toContain('"hooksActive"');
    expect(SKILL_MD).not.toContain('showtail ensure');
    expect(SKILL_MD).not.toContain('showtail log --type prompt');
    expect(SKILL_MD).not.toContain('showtail artifact');
    expect(SKILL_MD).toContain('showtail log --type decision');
    expect(SKILL_MD).toContain('showtail projects "<student-project-wording>" --json');
    expect(SKILL_MD).toContain('showtail report --project "<trail-id>" --json --no-open');
    expect(SKILL_MD).toContain('showtail verify --project "<trail-id>" --json');
    expect(SKILL_MD).toContain(
      'showtail status --project "<trail-id>" --json --tool claude',
    );
    expect(SKILL_MD).toContain("Claude's terminal working directory");
    expect(SKILL_MD).toContain('returned `trailId` and `root`');
    expect(SKILL_MD).not.toMatch(/^\s*showtail (?:report|verify|status)(?:\s+#.*)?\s*$/m);
    expect(SKILL_MD).not.toMatch(/`showtail (?:report|verify|status)`/);
  });

  test('committed plugin hooks.json matches the generated hook config', () => {
    const committed = readAsset('assets', 'claude-code', 'plugin', 'hooks', 'hooks.json');
    expect(committed).toBe(pluginHooksJson());
  });
});
