import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitFrontmatter } from '../src/core/managedBlock.ts';
import { REPORT_SKILL } from '../src/core/reportDiscovery.ts';
test('discovery is small and limited to explicit Showtail requests', () => {
  const { preamble, body } = splitFrontmatter(REPORT_SKILL);
  const description = preamble.split('description: ')[1]!.split('\n')[0]!;
  expect(description.split(/\s+/).length).toBeLessThanOrEqual(40);
  expect(body.split(/\s+/).length).toBeLessThanOrEqual(150);
  expect(description).toContain('explicitly requests Showtail');
  expect(body).not.toContain('Check capture');
  expect(body).not.toContain('showtail connect');
  expect(body).not.toContain('showtail log');
  expect(preamble).not.toContain('allowed-tools:');
});
test('submission instructions load separately and require approval of exact PR text', () => {
  expect(REPORT_SKILL).toContain('[submission.md]');
  const reference = readFileSync(
    join(import.meta.dir, '../assets/shared/submission.md'),
    'utf8',
  );
  expect(reference).toContain('explicitly requests');
  expect(reference).toContain('--pr --preview');
  expect(reference).toContain('entire returned comment');
  expect(reference).toContain('public and permanent');
  expect(reference).toContain('approval of that exact text');
  expect(reference).toContain('--pr --approve');
  expect(reference).toContain('Handing it in is manual');
  expect(reference).toContain('Never approve changed or refused previews');
});
