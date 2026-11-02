import { readFileSync, writeFileSync } from 'node:fs';
import { renderMatrixMarkdown } from '../src/core/capabilityMatrix.ts';
import { blockFor, parseBlock } from '../src/core/managedBlock.ts';
const path = 'docs/integrations/index.md';
const content = readFileSync(path, 'utf8');
const block = parseBlock(content);
if (!block) throw new Error('Capability matrix block is missing.');
writeFileSync(
  path,
  content.slice(0, block.startIndex) +
    blockFor(renderMatrixMarkdown()) +
    content.slice(block.endIndex),
);
