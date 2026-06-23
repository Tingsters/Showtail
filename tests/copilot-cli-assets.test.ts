import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COPILOT_BODY,
  COPILOT_CLI_HOOK_EVENTS,
  copilotCliHooksJson,
} from '../src/core/copilotCli.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('copilot-cli assets stay in sync with the single source of truth', () => {
  test('embedded instructions body matches the committed asset', () => {
    expect(COPILOT_BODY.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'copilot-cli', 'showtail.showtail.md'),
    );
  });

  test('hook config carries the version envelope and tags every command --tool copilot-cli', () => {
    const json = copilotCliHooksJson();
    // Copilot CLI expects a top-level version field on hook files.
    expect(json).toContain('"version": 1');
    // PostToolUse is matched to the edit tools.
    expect(json).toContain('"matcher"');

    const commands = Object.values(COPILOT_CLI_HOOK_EVENTS).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBe(4);
    for (const c of commands) {
      expect(c).toContain('showtail hook');
      expect(c).toContain('--tool copilot-cli');
    }
  });
});
