import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS } from '../src/core/copilot.ts';
import { PROJECT_TARGETING_INSTRUCTIONS } from '../src/core/projectTargetingInstructions.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('copilot assets stay in sync with the single source of truth', () => {
  const composed = (...parts: string[]): string =>
    `${readAsset(...parts).trimEnd()}\n\n${PROJECT_TARGETING_INSTRUCTIONS.trim()}\n`;

  test('embedded copilot-instructions.md includes the shared targeting policy', () => {
    expect(COPILOT_INSTRUCTIONS.replace(/\r\n/g, '\n')).toBe(
      composed('assets', 'copilot', 'copilot-instructions.md'),
    );
  });

  test('embedded showtail.instructions.md includes the shared targeting policy', () => {
    expect(SHOWTAIL_PATH_INSTRUCTIONS.replace(/\r\n/g, '\n')).toBe(
      composed('assets', 'copilot', 'showtail.instructions.md'),
    );
  });

  test('VS Code instructions never ask the model to perform routine capture', () => {
    for (const body of [COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS]) {
      expect(body).not.toContain('showtail log');
      expect(body).not.toContain('showtail artifact');
      expect(body.toLowerCase()).toMatch(/(?:do not|never) run/);
      expect(body).toContain('stable trail ID');
      expect(body).toContain('Never choose from the terminal working directory');
    }
  });
});
