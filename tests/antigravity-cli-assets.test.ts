import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_BODY,
  ANTIGRAVITY_CLI_HOOK_EVENTS,
  antigravityCliHooksJson,
} from '../src/core/antigravityCli.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('antigravity-cli assets stay in sync with the single source of truth', () => {
  test('embedded AGY body matches the committed asset', () => {
    expect(AGY_BODY.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'antigravity-cli', 'AGY.showtail.md'),
    );
  });

  test('hook config matches edit tools and tags every command --tool antigravity-cli', () => {
    const json = antigravityCliHooksJson();
    expect(json).toContain('"matcher": "write_file|replace|edit"');
    // Every Showtail command must carry the antigravity-cli tool tag.
    const commands = Object.values(ANTIGRAVITY_CLI_HOOK_EVENTS).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBe(4);
    for (const c of commands) {
      expect(c).toContain('showtail hook');
      expect(c).toContain('--tool antigravity-cli');
    }
  });
});
