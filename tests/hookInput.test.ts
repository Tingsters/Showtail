import { describe, expect, test } from 'bun:test';
import {
  applyPatchEdits,
  extractAntigravityEditedFiles,
  extractApplyPatchFiles,
  extractEditedFiles,
  extractPrompt,
  extractShellCommandFiles,
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

    // Regression: the real Codex `custom_tool_call` shape delivers the envelope
    // flat (top-level `input` string + `name`), NOT nested under `tool_input`.
    // The old object-only parser returned [] here, so Codex edits weren't
    // captured. This is the exact payload that produced `hello_world.py`.
    test('parses the flat custom_tool_call shape (top-level input string)', () => {
      const payload = {
        cwd: '/proj',
        name: 'apply_patch',
        arguments: null,
        input:
          '*** Begin Patch\n*** Add File: hello_world.py\n' +
          '+def main() -> None:\n+    print("Hello, world!")\n*** End Patch\n',
      };
      expect(extractApplyPatchFiles(payload as any)).toEqual(['hello_world.py']);
      // The envelope also feeds the suggested-code diff.
      expect(extractSuggestedCode(payload as any)).toContain(
        '*** Add File: hello_world.py',
      );
    });

    test('tolerates tool_input handed over as a raw envelope string', () => {
      expect(
        extractApplyPatchFiles({
          tool_input: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' as any,
        }),
      ).toEqual(['a.ts']);
    });
  });

  describe('extractShellCommandFiles (Codex raw shell)', () => {
    const cmd = (command: string, cwd = '/proj') =>
      extractShellCommandFiles({
        tool_name: 'shell_command',
        cwd,
        tool_input: { command },
      });

    test('PowerShell Set-Content with a literal -LiteralPath/-Path', () => {
      expect(cmd("Set-Content -LiteralPath 'notes.txt' -Value 'hi'")).toEqual([
        'notes.txt',
      ]);
      expect(cmd('Out-File -FilePath out.log -Encoding ASCII')).toEqual(['out.log']);
      expect(cmd('Add-Content -Path "logs/app.txt" -Value x')).toEqual(['logs/app.txt']);
    });

    test('redirects and tee', () => {
      expect(cmd('echo hi > result.txt')).toEqual(['result.txt']);
      expect(cmd('cat a | tee -a combined.log')).toEqual(['combined.log']);
    });

    test('apply_patch run through the shell', () => {
      expect(
        cmd(
          'apply_patch <<EOF\n*** Begin Patch\n*** Add File: gen.ts\n*** End Patch\nEOF',
        ),
      ).toEqual(['gen.ts']);
    });

    test('reads command from a JSON-string arguments field', () => {
      expect(
        extractShellCommandFiles({
          name: 'shell_command',
          cwd: '/proj',
          arguments: JSON.stringify({
            command: "Set-Content -Path 'z.txt' -Value q",
            timeout_ms: 1000,
          }),
        } as any),
      ).toEqual(['z.txt']);
    });

    test('skips paths held in a shell variable (git fallback covers those)', () => {
      // The user's throwaway repro used `$scratch` — unresolvable from text alone.
      expect(cmd('Set-Content -LiteralPath $scratch -Encoding ASCII')).toEqual([]);
      expect(cmd('ls -la')).toEqual([]);
    });
  });
});

describe('applyPatchEdits (Codex envelope → clean per-file diffs)', () => {
  test('Add File → all "+ " lines, no envelope markers (matches Claude Write)', () => {
    const input =
      '*** Begin Patch\n*** Add File: hello_world.py\n' +
      '+def main() -> None:\n+    print("Hello, world!")\n*** End Patch\n';
    expect(applyPatchEdits({ cwd: '/p', name: 'apply_patch', input } as any)).toEqual([
      {
        file: 'hello_world.py',
        diff: '+ def main() -> None:\n+     print("Hello, world!")',
      },
    ]);
  });

  test('Update File → "+ "/"- " lines only, no @@/context', () => {
    const input =
      '*** Begin Patch\n*** Update File: a.ts\n@@\n const keep = 1;\n-const x = 1;\n+const x = 2;\n*** End Patch';
    expect(applyPatchEdits({ cwd: '/p', tool_input: { input } } as any)).toEqual([
      { file: 'a.ts', diff: '- const x = 1;\n+ const x = 2;' },
    ]);
  });

  test('Delete File → { deleted: true } with no diff', () => {
    const input = '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch';
    expect(applyPatchEdits({ cwd: '/p', input } as any)).toEqual([
      { file: 'gone.ts', deleted: true },
    ]);
  });

  test('multi-file envelope splits into one entry per file', () => {
    const input =
      '*** Begin Patch\n' +
      '*** Add File: new.ts\n+export const a = 1;\n' +
      '*** Update File: old.ts\n@@\n-let b = 1;\n+let b = 2;\n' +
      '*** Delete File: dead.ts\n' +
      '*** End Patch';
    expect(applyPatchEdits({ cwd: '/p', input } as any)).toEqual([
      { file: 'new.ts', diff: '+ export const a = 1;' },
      { file: 'old.ts', diff: '- let b = 1;\n+ let b = 2;' },
      { file: 'dead.ts', deleted: true },
    ]);
  });

  test('returns empty when there is no envelope', () => {
    expect(applyPatchEdits({ tool_input: { command: 'ls' } } as any)).toEqual([]);
  });
});

describe('extractAntigravityEditedFiles (IDE TargetFile shape)', () => {
  test('reads toolCall.args.TargetFile and unwraps the JSON-encoded value', () => {
    // Mirrors the IDE transcript: args values are JSON-string-encoded.
    const payload = {
      cwd: '/proj',
      toolCall: { name: 'write_to_file', args: { TargetFile: '"/proj/src/a.ts"' } },
    } as any;
    expect(extractAntigravityEditedFiles(payload)).toEqual(['src/a.ts']);
  });

  test('tolerates a plain (not JSON-encoded) path and tool_input/args wrappers', () => {
    expect(
      extractAntigravityEditedFiles({ tool_input: { TargetFile: 'src/b.ts' } } as any),
    ).toEqual(['src/b.ts']);
    expect(
      extractAntigravityEditedFiles({ args: { target_file: 'src/c.ts' } } as any),
    ).toEqual(['src/c.ts']);
  });

  test('returns empty when no recognizable target field is present', () => {
    expect(extractAntigravityEditedFiles({} as any)).toEqual([]);
    expect(
      extractAntigravityEditedFiles({
        toolCall: { args: { Description: '"x"' } },
      } as any),
    ).toEqual([]);
  });
});
