import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { logConversationEvent } from '../src/core/conversationEvents.ts';
import {
  CREDENTIAL_WITHHELD,
  inputTargetsCredentialFile,
  OUTPUT_WITHHELD,
  withholdSensitiveParts,
} from '../src/core/conversationPrivacy.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData } from '../src/core/report.ts';
import { pathsForRoot, readConfig, writeConfig } from '../src/core/storage.ts';
import type { ConversationEvent } from '../src/types.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

// Not in any provider's format: only "never stored" can keep it out, not a rule.
const CANARY = 'canary-Zq8Xk2Lm9Pw4Rt7Vb3-c0ffee';

const result = (extra: Partial<ConversationEvent>): ConversationEvent => ({
  sequence: 1,
  type: 'tool_result',
  sourceId: 'r:result',
  toolUseId: 'r',
  ...extra,
});
const use = (
  input: ConversationEvent['input'],
  toolName = 'Write',
): ConversationEvent => ({
  sequence: 0,
  type: 'tool_use',
  sourceId: 'u:use',
  toolUseId: 'u',
  toolName,
  input,
});

describe('tool output is withheld by default', () => {
  test('stdout, stderr and content go; exit status and error flag stay', () => {
    const out = withholdSensitiveParts(
      result({
        stdout: CANARY,
        stderr: CANARY,
        content: CANARY,
        exitCode: 2,
        isError: true,
      }),
    );
    expect(out).not.toHaveProperty('stdout');
    expect(out).not.toHaveProperty('stderr');
    expect(out.content).toBe(OUTPUT_WITHHELD);
    expect(out.exitCode).toBe(2);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  test('a student answer to a question is kept: it is their decision, not output', () => {
    const answered = result({ content: { answers: { 'Which style?': 'Simple' } } });
    expect(withholdSensitiveParts(answered)).toEqual(answered);
    const named = result({ toolName: 'AskUserQuestion', content: 'Simple' });
    expect(withholdSensitiveParts(named).content).toBe('Simple');
    expect(
      withholdSensitiveParts(result({ toolName: 'request_user_input', content: 'x' }))
        .content,
    ).toBe('x');
  });

  test('settings.captureToolOutput opts back in', () => {
    const kept = withholdSensitiveParts(result({ stdout: 'ok\n' }), {
      captureToolOutput: true,
    });
    expect(kept.stdout).toBe('ok\n');
  });
});

describe('credential files are never stored through a tool input', () => {
  test('detects a credential path under any usual key, and in a patch header', () => {
    expect(inputTargetsCredentialFile({ file_path: '/p/.env', content: CANARY })).toBe(
      true,
    );
    expect(
      inputTargetsCredentialFile({ TargetFile: 'C:\\Users\\a\\.aws\\credentials' }),
    ).toBe(true);
    expect(inputTargetsCredentialFile({ path: 'keys/id_rsa' })).toBe(true);
    expect(
      inputTargetsCredentialFile({
        input: `*** Begin Patch\n*** Add File: config/.env.production\n+KEY=${CANARY}\n*** End Patch`,
      }),
    ).toBe(true);
    expect(
      inputTargetsCredentialFile({ file_path: '/p/src/main.py', content: 'x = 1' }),
    ).toBe(false);
    expect(inputTargetsCredentialFile({ command: 'ls' })).toBe(false);
    expect(inputTargetsCredentialFile(undefined)).toBe(false);
  });

  test('keeps the path, drops what was written', () => {
    const out = withholdSensitiveParts(
      use({ file_path: '/p/.env', content: `KEY=${CANARY}` }),
    );
    expect(out.input).toEqual({ file_path: '/p/.env', withheld: CREDENTIAL_WITHHELD });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  test('an ordinary file is untouched', () => {
    const e = use({ file_path: '/p/src/main.py', content: "print('ok')\n" });
    expect(withholdSensitiveParts(e)).toEqual(e);
  });
});

describe('end to end: nothing reaches the trail', () => {
  function allTrailText(root: string): string {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(readFileSync(p, 'utf8'));
      }
    };
    walk(join(root, '.showtail'));
    return out.join('\n');
  }

  test('output of a command and the content of a .env write are not stored or reported', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'set it up',
      });
      const base = { tool: 'claude-code' as const, turnId: prompt.id };
      logConversationEvent(author, {
        ...base,
        event: {
          ...use({ command: 'cat .env' }, 'Bash'),
          sourceId: 'b:use',
          toolUseId: 'b',
        } as never,
      });
      logConversationEvent(author, {
        ...base,
        event: result({
          sourceId: 'b:result',
          toolUseId: 'b',
          stdout: `KEY=${CANARY}`,
          exitCode: 0,
        }) as never,
      });
      logConversationEvent(author, {
        ...base,
        event: {
          ...use({ file_path: join(dir, '.env'), content: `KEY=${CANARY}` }),
          sourceId: 'w:use',
          toolUseId: 'w',
        } as never,
      });

      expect(allTrailText(dir)).not.toContain(CANARY);
      expect(JSON.stringify(buildReportData(paths))).not.toContain(CANARY);
      // The command itself is still recorded.
      expect(JSON.stringify(buildReportData(paths))).toContain('cat .env');
    } finally {
      cleanup(dir);
    }
  });

  test('captureToolOutput: true keeps the output (and pattern redaction still applies)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const config = readConfig(paths);
      config.settings.captureToolOutput = true;
      writeConfig(paths, config);
      const author = authorFor(paths);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'run it',
      });
      logConversationEvent(author, {
        tool: 'claude-code',
        turnId: prompt.id,
        event: result({
          sourceId: 'k:result',
          toolUseId: 'k',
          stdout: 'hello\nPASSWORD=hunter22xyz\n',
          exitCode: 0,
        }) as never,
      });
      const text = allTrailText(dir);
      expect(text).toContain('hello');
      expect(text).not.toContain('hunter22xyz');
    } finally {
      cleanup(dir);
    }
  });
});
