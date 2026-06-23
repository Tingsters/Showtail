import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_IDE_BODY,
  ANTIGRAVITY_IDE_HOOK_EVENTS,
  ANTIGRAVITY_IDE_HOOK_NAMESPACE,
  antigravityIdeHooksJson,
} from '../src/core/antigravityIde.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('antigravity-ide assets stay in sync with the single source of truth', () => {
  test('embedded AGY-IDE body matches the committed asset', () => {
    expect(AGY_IDE_BODY.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'antigravity-ide', 'AGY-IDE.showtail.md'),
    );
  });

  test('hooks.json is a named bundle, enabled, with the IDE edit-tool matcher', () => {
    const json = antigravityIdeHooksJson();
    const parsed = JSON.parse(json);
    // Top-level *named* bundle (not the `{ hooks: {...} }` map the CLI uses).
    expect(parsed[ANTIGRAVITY_IDE_HOOK_NAMESPACE].enabled).toBe(true);
    expect(json).toContain(
      '"matcher": "write_to_file|replace_file_content|multi_replace_file_content|edit|write|create_file|str_replace"',
    );
  });

  test('every command carries the antigravity-ide tool tag', () => {
    const commands = Object.values(ANTIGRAVITY_IDE_HOOK_EVENTS).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBe(4);
    for (const c of commands) {
      expect(c).toContain('showtail hook');
      expect(c).toContain('--tool antigravity-ide');
    }
  });
});
