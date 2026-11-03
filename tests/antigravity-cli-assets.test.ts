import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGY_BODY, antigravityCliHooksJson } from '../src/core/antigravityCli.ts';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
const asset = (file: string) =>
  readFileSync(join(import.meta.dir, '../assets', file), 'utf8').replace(/\r\n/g, '\n');
test('antigravityCli: embedded skill and hook assets match the binary', () => {
  expect(AGY_BODY.replace(/\r\n/g, '\n')).toBe(asset('shared/report-skill.md'));
  expect(AGY_BODY.replace(/\r\n/g, '\n')).toBe(REPORT_SKILL);
  expect(asset('antigravity-cli/hooks.json')).toBe(antigravityCliHooksJson());
});
test('antigravityCli: callbacks never capture prompts or run before invocation', () => {
  const hooks = antigravityCliHooksJson();
  expect(hooks).not.toContain('user-prompt');
  expect(hooks).not.toContain('PreInvocation');
  expect(hooks).not.toContain('UserPromptSubmit');
});
