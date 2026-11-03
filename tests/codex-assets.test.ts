import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_BODY, codexHooksJson } from '../src/core/codex.ts';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
const asset = (file: string) =>
  readFileSync(join(import.meta.dir, '../assets', file), 'utf8').replace(/\r\n/g, '\n');
test('codex: embedded skill and hook assets match the binary', () => {
  expect(AGENTS_BODY.replace(/\r\n/g, '\n')).toBe(asset('shared/report-skill.md'));
  expect(AGENTS_BODY.replace(/\r\n/g, '\n')).toBe(REPORT_SKILL);
  expect(asset('codex/hooks.json')).toBe(codexHooksJson());
});
test('codex: callbacks never capture prompts or run before invocation', () => {
  const hooks = codexHooksJson();
  expect(hooks).not.toContain('user-prompt');
  expect(hooks).not.toContain('PreInvocation');
  expect(hooks).not.toContain('UserPromptSubmit');
});
