import { expect, test } from 'bun:test';
import { COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS } from '../src/core/copilot.ts';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
test('Copilot exposes only the common on-request reporting skill', () => {
  expect(COPILOT_INSTRUCTIONS).toBe(REPORT_SKILL);
  expect(SHOWTAIL_PATH_INSTRUCTIONS).toBe(REPORT_SKILL);
  expect(REPORT_SKILL).not.toContain('applyTo:');
});
