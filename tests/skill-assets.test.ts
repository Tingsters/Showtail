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
  });

  test('committed plugin hooks.json matches the generated hook config', () => {
    const committed = readAsset('assets', 'claude-code', 'plugin', 'hooks', 'hooks.json');
    expect(committed).toBe(pluginHooksJson());
  });
});
