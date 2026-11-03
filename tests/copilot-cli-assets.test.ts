import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COPILOT_BODY, copilotCliHooksJson } from '../src/core/copilotCli.ts';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
const asset = (file: string) =>
  readFileSync(join(import.meta.dir, '../assets', file), 'utf8').replace(/\r\n/g, '\n');
test('copilotCli: embedded skill and hook assets match the binary', () => {
  expect(COPILOT_BODY.replace(/\r\n/g, '\n')).toBe(asset('shared/report-skill.md'));
  expect(COPILOT_BODY.replace(/\r\n/g, '\n')).toBe(REPORT_SKILL);
  expect(asset('copilot-cli/hooks.json')).toBe(copilotCliHooksJson());
});
test('copilotCli: callbacks never capture prompts or run before invocation', () => {
  const hooks = copilotCliHooksJson();
  expect(hooks).not.toContain('user-prompt');
  expect(hooks).not.toContain('PreInvocation');
  expect(hooks).not.toContain('UserPromptSubmit');
});
