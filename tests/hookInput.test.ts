import { describe, expect, test } from 'bun:test';
import {
  extractApplyPatchFiles,
  extractEditedFiles,
  extractPrompt,
  extractSuggestedCode,
} from '../src/core/hookInput.ts';

describe('extractSuggestedCode', () => {
  test('Edit becomes a +/- diff', () => {
    const code = extractSuggestedCode({
      tool_input: {
        file_path: 'a.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      },
    });
    expect(code).toContain('- const a = 1;');
    expect(code).toContain('+ const a = 2;');
  });

  test('Write becomes added lines', () => {
    const code = extractSuggestedCode({
      tool_input: { file_path: 'a.ts', content: 'line one\nline two' },
    });
    expect(code).toBe('+ line one\n+ line two');
  });

  test('MultiEdit concatenates each edit', () => {
    const code = extractSuggestedCode({
      tool_input: {
        file_path: 'a.ts',
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: 'p', new_string: 'q' },
        ],
      },
    });
    expect(code).toContain('- x');
    expect(code).toContain('+ q');
  });

  test('Codex apply_patch envelope is passed through', () => {
    const patch = '*** Update File: a.ts\n@@\n-old\n+new\n';
    expect(extractSuggestedCode({ tool_input: { input: patch } })).toBe(patch);
  });

  test('returns undefined when there is nothing to capture', () => {
    expect(extractSuggestedCode({ tool_input: { file_path: 'a.ts' } })).toBeUndefined();
    expect(extractSuggestedCode({})).toBeUndefined();
  });
});

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

  describe('extractApplyPatchFiles (Codex)', () => {
    test('parses Add/Update/Move headers from the patch envelope', () => {
      const input =
        '*** Begin Patch\n' +
        '*** Add File: src/new.ts\n' +
        '+export const a = 1;\n' +
        '*** Update File: src/old.ts\n' +
        '@@\n-x\n+y\n' +
        '*** Move File: src/moved.ts\n' +
        '*** End Patch';
      expect(extractApplyPatchFiles({ tool_input: { input } })).toEqual([
        'src/new.ts',
        'src/old.ts',
        'src/moved.ts',
      ]);
    });

    test('skips Delete File headers', () => {
      const input =
        '*** Begin Patch\n*** Delete File: gone.ts\n*** Update File: kept.ts\n*** End Patch';
      expect(extractApplyPatchFiles({ tool_input: { input } })).toEqual(['kept.ts']);
    });

    test('also reads the patch field and a structured changes map, de-duping', () => {
      expect(
        extractApplyPatchFiles({ tool_input: { patch: '*** Update File: a.ts\n' } }),
      ).toEqual(['a.ts']);
      expect(
        extractApplyPatchFiles({ tool_input: { changes: { 'a.ts': {}, 'b.ts': {} } } }),
      ).toEqual(['a.ts', 'b.ts']);
      // input + changes referencing the same file collapses to one entry.
      expect(
        extractApplyPatchFiles({
          tool_input: { input: '*** Update File: a.ts\n', changes: { 'a.ts': {} } },
        }),
      ).toEqual(['a.ts']);
    });

    test('returns empty when nothing matches', () => {
      expect(extractApplyPatchFiles({})).toEqual([]);
      expect(extractApplyPatchFiles({ tool_input: {} })).toEqual([]);
      expect(
        extractApplyPatchFiles({ tool_input: { input: 'no headers here' } }),
      ).toEqual([]);
    });
  });
});
