import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardrail: the core capture/status dispatch must stay free of per-tool
 * knowledge. All individual coding-system specifics live in src/plugins/. These
 * tests fail if a `tool === 'x'` branch or a tool-specific extractor selection
 * creeps back into the central dispatchers.
 */
const SRC = join(import.meta.dir, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Drop line comments + block comments so we only inspect actual code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('core stays tool-agnostic', () => {
  test('the hook dispatcher has no per-tool branching', () => {
    const code = stripComments(read('commands/hook.ts'));
    // No `tool === 'claude'` / `=== 'codex'` style branches.
    expect(code).not.toMatch(/===\s*['"](claude|codex|copilot|gemini|chatgpt)/i);
    // The dispatcher never selects a tool-specific payload extractor itself —
    // each plugin's adapter.parse owns that.
    for (const fn of [
      'extractApplyPatchFiles',
      'extractEditedFiles',
      'extractSuggestedCode',
    ]) {
      expect(code).not.toContain(fn);
    }
  });

  test('tool status is registry-driven and names no tool', () => {
    const code = stripComments(read('core/tools.ts'));
    for (const name of ['claude', 'codex', 'copilot', 'gemini', 'chatgpt']) {
      expect(code).not.toContain(`'${name}`);
    }
  });

  test('setup detection is registry-driven and names no tool', () => {
    const code = stripComments(read('commands/setup.ts'));
    for (const name of ['claude', 'codex', 'copilot', 'gemini', 'chatgpt']) {
      expect(code).not.toContain(`'${name}`);
    }
  });
});
