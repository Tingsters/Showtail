import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGY_IDE_BODY, antigravityIdeHooksJson } from '../src/core/antigravityIde.ts';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
const asset = (file: string) =>
  readFileSync(join(import.meta.dir, '../assets', file), 'utf8').replace(/\r\n/g, '\n');
test('antigravityIde: embedded skill and hook assets match the binary', () => {
  expect(AGY_IDE_BODY.replace(/\r\n/g, '\n')).toBe(asset('shared/report-skill.md'));
  expect(AGY_IDE_BODY.replace(/\r\n/g, '\n')).toBe(REPORT_SKILL);
  expect(asset('antigravity-ide/hooks.json')).toBe(antigravityIdeHooksJson());
});
test('antigravityIde: callbacks never capture prompts or run before invocation', () => {
  const hooks = antigravityIdeHooksJson();
  expect(hooks).not.toContain('user-prompt');
  expect(hooks).not.toContain('PreInvocation');
  expect(hooks).not.toContain('UserPromptSubmit');
});
