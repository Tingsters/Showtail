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
    expect(AGY_IDE_BODY).toContain('showtail status --json --tool antigravity-ide');
    expect(AGY_IDE_BODY).toContain('"mode": "automatic"');
    expect(AGY_IDE_BODY).not.toContain('"hooksActive"');
    expect(AGY_IDE_BODY).not.toContain('showtail ensure');
    expect(AGY_IDE_BODY).not.toContain('showtail log --type');
    expect(AGY_IDE_BODY).not.toContain('showtail artifact');
    expect(AGY_IDE_BODY).toContain(
      'showtail projects "<student-project-wording>" --json',
    );
    expect(AGY_IDE_BODY).toContain('--project "<trail-id>"');
    expect(AGY_IDE_BODY).toContain("agent terminal's working directory");
    expect(AGY_IDE_BODY).toContain('returned `trailId` and `root`');
    expect(AGY_IDE_BODY).not.toMatch(
      /^\s*showtail (?:report|verify|status)(?:\s+#.*)?\s*$/m,
    );
    expect(AGY_IDE_BODY).not.toMatch(/`showtail (?:report|verify|status)`/);
  });

  test('hooks.json is a named bundle, enabled, using the IDE event names + glob matcher', () => {
    const json = antigravityIdeHooksJson();
    const parsed = JSON.parse(json);
    // Top-level *named* bundle (not the `{ hooks: {...} }` map the CLI uses).
    expect(parsed[ANTIGRAVITY_IDE_HOOK_NAMESPACE].enabled).toBe(true);
    // Only events the IDE's jsonhook.go recognizes (NOT SessionStart/UserPromptSubmit).
    expect(Object.keys(ANTIGRAVITY_IDE_HOOK_EVENTS)).toEqual([
      'PreInvocation',
      'PostToolUse',
      'Stop',
    ]);
    // `matcher` is a TOOL-NAME filter, so it belongs only on the tool event
    // (PostToolUse = '*' = all tools). PreInvocation/Stop are not tool events; a
    // matcher there made the IDE skip them, so they carry none.
    for (const g of ANTIGRAVITY_IDE_HOOK_EVENTS.PostToolUse!) expect(g.matcher).toBe('*');
    for (const event of ['PreInvocation', 'Stop'] as const) {
      for (const g of ANTIGRAVITY_IDE_HOOK_EVENTS[event]!) {
        expect(g.matcher).toBeUndefined();
      }
    }
  });

  test('every command carries the antigravity-ide tool tag (and a timeout)', () => {
    const commands = Object.values(ANTIGRAVITY_IDE_HOOK_EVENTS).flatMap((groups) =>
      groups.flatMap((g) => g.hooks),
    );
    expect(commands.length).toBe(3);
    for (const h of commands) {
      expect(h.command).toContain('showtail hook');
      expect(h.command).toContain('--tool antigravity-ide');
      expect(h.timeout).toBe(30);
    }
  });
});
