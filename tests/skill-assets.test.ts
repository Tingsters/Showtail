import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
import { SKILL_MD, pluginHooksJson } from '../src/core/skill.ts';
const asset = (file: string) =>
  readFileSync(join(import.meta.dir, '../assets', file), 'utf8').replace(/\r\n/g, '\n');
test('skill: embedded skill and hook assets match the binary', () => {
  expect(SKILL_MD.replace(/\r\n/g, '\n')).toBe(
    asset('claude-code/plugin/skills/showtail/SKILL.md'),
  );
  expect(SKILL_MD.replace(/\r\n/g, '\n')).toBe(REPORT_SKILL);
  expect(asset('claude-code/plugin/hooks/hooks.json')).toBe(pluginHooksJson());
});
test('skill: callbacks never capture prompts or run before invocation', () => {
  const hooks = pluginHooksJson();
  expect(hooks).not.toContain('user-prompt');
  expect(hooks).not.toContain('PreInvocation');
  expect(hooks).not.toContain('UserPromptSubmit');
});
