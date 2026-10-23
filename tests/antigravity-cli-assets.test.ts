import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_BODY,
  ANTIGRAVITY_BLOCK_NAME,
  ANTIGRAVITY_CLI_HOOK_EVENTS,
  antigravityCliHooksJson,
} from '../src/core/antigravityCli.ts';
import { entryCommands } from '../src/core/hookMerge.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('antigravity-cli assets stay in sync with the single source of truth', () => {
  test('embedded AGY body matches the committed asset', () => {
    expect(AGY_BODY.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'antigravity-cli', 'AGY.showtail.md'),
    );
    expect(AGY_BODY).toContain('showtail status --json --tool antigravity-cli');
    expect(AGY_BODY).toContain('"mode": "automatic"');
    expect(AGY_BODY).not.toContain('"hooksActive"');
    expect(AGY_BODY).not.toContain('showtail ensure');
    expect(AGY_BODY).not.toContain('showtail log --type');
    expect(AGY_BODY).not.toContain('showtail artifact');
    expect(AGY_BODY).toContain('showtail projects "<student-project-wording>" --json');
    expect(AGY_BODY).toContain('--project "<trail-id>"');
    expect(AGY_BODY).toContain("agent terminal's working directory");
    expect(AGY_BODY).toContain('returned `trailId` and `root`');
    expect(AGY_BODY).not.toMatch(/^\s*showtail (?:report|verify|status)(?:\s+#.*)?\s*$/m);
    expect(AGY_BODY).not.toMatch(/`showtail (?:report|verify|status)`/);
  });

  test('hook config uses agy’s real schema, events, and edit-tool matcher', () => {
    const parsed = JSON.parse(antigravityCliHooksJson());
    // agy reads a NAMED block with an `enabled` flag, not a `{ hooks: {...} }` wrapper.
    expect(Object.keys(parsed)).toEqual([ANTIGRAVITY_BLOCK_NAME]);
    expect(parsed[ANTIGRAVITY_BLOCK_NAME].enabled).toBe(true);
    // agy's real lifecycle events (NO UserPromptSubmit).
    expect(Object.keys(ANTIGRAVITY_CLI_HOOK_EVENTS).sort()).toEqual(
      ['PostToolUse', 'PreInvocation', 'SessionStart', 'Stop'].sort(),
    );
    expect(parsed[ANTIGRAVITY_BLOCK_NAME].PostToolUse[0].matcher).toContain(
      'write_to_file',
    );

    // Tool events take matcher groups; every other event takes handlers DIRECTLY.
    // Nesting a non-tool event's handlers under `hooks` makes agy reject the whole
    // hooks.json ("command hook must specify 'command'"), disabling every bundle.
    for (const [event, entries] of Object.entries(ANTIGRAVITY_CLI_HOOK_EVENTS)) {
      for (const entry of entries) {
        if (event === 'PostToolUse' || event === 'PreToolUse') {
          expect('hooks' in entry).toBe(true);
        } else {
          expect(entry).toMatchObject({ type: 'command' });
          expect('hooks' in entry).toBe(false);
        }
      }
    }

    // Every Showtail command must be a BARE `showtail …` (no quotes/paths, since
    // agy execs the first token via cmd.exe) and carry the tool tag.
    const commands = Object.values(ANTIGRAVITY_CLI_HOOK_EVENTS).flatMap((entries) =>
      entries.flatMap(entryCommands),
    );
    expect(commands.length).toBe(4);
    for (const c of commands) {
      expect(c).toMatch(/^showtail hook /);
      expect(c).toContain('--tool antigravity-cli');
    }
  });
});
