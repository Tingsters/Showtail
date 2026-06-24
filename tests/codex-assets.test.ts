import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_BODY, CODEX_HOOK_EVENTS, codexHooksJson } from '../src/core/codex.ts';

const REPO = join(import.meta.dir, '..');

function readAsset(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('codex assets stay in sync with the single source of truth', () => {
  test('embedded AGENTS body matches the committed asset', () => {
    expect(AGENTS_BODY.replace(/\r\n/g, '\n')).toBe(
      readAsset('assets', 'codex', 'AGENTS.showtail.md'),
    );
  });

  test('hook config targets apply_patch + shell_command and tags every command --tool codex', () => {
    const json = codexHooksJson();
    // Catch both Codex edit paths: the structured `apply_patch` tool and raw
    // shell edits via `shell_command` (e.g. PowerShell Set-Content on Windows).
    expect(json).toContain('"matcher": "apply_patch|shell_command"');
    // Every Showtail command must carry the codex tool tag.
    const commands = Object.values(CODEX_HOOK_EVENTS).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBe(4);
    for (const c of commands) {
      expect(c).toContain('showtail hook');
      expect(c).toContain('--tool codex');
    }
  });
});
