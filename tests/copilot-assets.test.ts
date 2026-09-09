import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS } from '../src/core/copilot.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('copilot assets stay in sync with the single source of truth', () => {
  test('embedded copilot-instructions.md matches the committed asset', () => {
    expect(COPILOT_INSTRUCTIONS.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'copilot', 'copilot-instructions.md'),
    );
  });

  test('embedded showtail.instructions.md matches the committed asset', () => {
    expect(SHOWTAIL_PATH_INSTRUCTIONS.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'copilot', 'showtail.instructions.md'),
    );
  });

  test('VS Code instructions never ask the model to perform routine capture', () => {
    for (const body of [COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS]) {
      expect(body).not.toContain('showtail log');
      expect(body).not.toContain('showtail artifact');
      expect(body.toLowerCase()).toMatch(/(?:do not|never) run/);
    }
  });
});
