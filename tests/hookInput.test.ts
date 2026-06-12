import { describe, expect, test } from 'bun:test';
import { extractEditedFiles, extractPrompt } from '../src/core/hookInput.ts';

describe('hookInput', () => {
  test('extractPrompt returns trimmed prompt text', () => {
    expect(extractPrompt({ prompt: '  How do I parse this?  ' })).toBe(
      'How do I parse this?',
    );
  });

  test('extractPrompt returns null when missing or empty', () => {
    expect(extractPrompt({})).toBeNull();
    expect(extractPrompt({ prompt: '   ' })).toBeNull();
    expect(extractPrompt({ prompt: 123 as unknown as string })).toBeNull();
  });

  test('extractEditedFiles reads file_path from tool_input', () => {
    expect(extractEditedFiles({ tool_input: { file_path: 'src/a.ts' } })).toEqual([
      'src/a.ts',
    ]);
  });

  test('extractEditedFiles handles a file_paths array and de-dupes', () => {
    expect(
      extractEditedFiles({
        tool_input: { file_path: 'a.ts', file_paths: ['a.ts', 'b.ts'] },
      }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  test('extractEditedFiles returns empty when nothing matches', () => {
    expect(extractEditedFiles({})).toEqual([]);
    expect(extractEditedFiles({ tool_input: {} })).toEqual([]);
  });
});
