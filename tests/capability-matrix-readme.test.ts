import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlock } from '../src/core/managedBlock.ts';
import { renderMatrixMarkdown } from '../src/core/capabilityMatrix.ts';

// The capability matrix lives on the docs site's integrations page, kept in sync
// with the data model and regenerated via `bun run src/cli.ts matrix --write-readme`.
const MATRIX_DOC = join(import.meta.dir, '..', 'docs', 'integrations', 'index.md');

describe('docs capability matrix stays in sync with the data model', () => {
  test('the managed block equals the generated matrix', () => {
    const content = readFileSync(MATRIX_DOC, 'utf8').replace(/\r\n/g, '\n');
    const block = parseBlock(content);
    expect(block).not.toBeNull();
    // If this fails, regenerate with: bun run src/cli.ts matrix --write-readme
    expect(block!.inner).toBe(renderMatrixMarkdown().trim());
  });
});
