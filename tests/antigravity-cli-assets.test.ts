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

  test('hook config uses agy’s real schema, events, and edit-tool matcher', () => {
    const parsed = JSON.parse(antigravityCliHooksJson());
    // agy reads a NAMED block with an `enabled` flag, not a `{ hooks: {...} }` wrapper.
    expect(Object.keys(parsed)).toEqual(['showtail']);
    expect(parsed.showtail.enabled).toBe(true);
    // agy's real lifecycle events (NO UserPromptSubmit).
    expect(Object.keys(ANTIGRAVITY_CLI_HOOK_EVENTS).sort()).toEqual(
      ['PostToolUse', 'PreInvocation', 'SessionStart', 'Stop'].sort(),
    );
    expect(parsed.showtail.PostToolUse[0].matcher).toContain('write_to_file');

    // Every Showtail command must be a BARE `showtail …` (no quotes/paths, since
    // agy execs the first token via cmd.exe) and carry the tool tag.
    const commands = Object.values(ANTIGRAVITY_CLI_HOOK_EVENTS).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBe(4);
    for (const c of commands) {
      expect(c).toMatch(/^showtail hook /);
      expect(c).toContain('--tool antigravity-cli');
    }
  });
});
