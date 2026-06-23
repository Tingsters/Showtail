import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlock } from '../src/core/managedBlock.ts';
import { renderMatrixMarkdown } from '../src/core/capabilityMatrix.ts';

const README = join(import.meta.dir, '..', 'README.md');

describe('README capability matrix stays in sync with the data model', () => {
  test('the managed block equals the generated matrix', () => {
    const content = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
    const block = parseBlock(content);
    expect(block).not.toBeNull();
    // If this fails, regenerate with: bun run src/cli.ts matrix --write-readme
    expect(block!.inner).toBe(renderMatrixMarkdown().trim());
  });
});
