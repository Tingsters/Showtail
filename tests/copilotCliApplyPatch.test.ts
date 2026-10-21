import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copilotCliPlugin } from '../src/plugins/copilot-cli.ts';
import { COPILOT_CLI_HOOK_EVENTS } from '../src/core/copilotCli.ts';
import { cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';

/**
 * Copilot CLI writes files with `apply_patch` as well as `edit`: its postToolUse payload
 * carries the patch envelope as a raw string in `toolArgs`. 14 of 16 real local Copilot CLI
 * sessions used it, so a matcher or parser that only knew `edit` silently missed those edits.
 */
describe('copilot-cli apply_patch edits', () => {
  test('the postToolUse matcher covers apply_patch (and not a read like `view`)', () => {
    const matcher = COPILOT_CLI_HOOK_EVENTS.postToolUse![0]!.matcher!;
    const re = new RegExp(`^(?:${matcher})$`);
    for (const tool of ['edit', 'create', 'apply_patch', 'str_replace_editor']) {
      expect(re.test(tool), tool).toBe(true);
    }
    for (const tool of ['view', 'powershell', 'ask_user']) {
      expect(re.test(tool), tool).toBe(false);
    }
  });

  test('agentStop is wired to the same stop reconcile as sessionEnd', () => {
    const stop = (event: 'agentStop' | 'sessionEnd') =>
      COPILOT_CLI_HOOK_EVENTS[event]![0]!.hooks.map((h) => h.command);
    expect(stop('agentStop')).toEqual(['showtail hook stop --tool copilot-cli']);
    expect(stop('agentStop')).toEqual(stop('sessionEnd'));
  });

  test('the plugin parses an apply_patch payload into per-file edits with a diff', () => {
    const parse = copilotCliPlugin.connect!.hooks!.parse;
    const parsed = parse({
      cwd: '/repo',
      sessionId: 's1',
      toolName: 'apply_patch',
      toolArgs:
        '*** Begin Patch\n*** Update File: /repo/a.py\n@@\n-x = 1\n+x = 2\n*** End Patch\n',
    });
    expect(parsed.editedFiles).toEqual(['a.py']);
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.edits![0]!.diff).toContain('x = 2');
  });

  test('a real post-edit hook with an apply_patch payload records the file and its diff', () => {
    const dir = makeTempDir();
    try {
      const run = (args: string[], input?: string) => runCli(dir, args, { input });
      expect(run(['track', '--project', 'Patch']).code).toBe(0);
      run(
        ['hook', 'user-prompt', '--tool', 'copilot-cli'],
        JSON.stringify({ cwd: dir, sessionId: 'cc-patch-1', prompt: 'add a helper' }),
      );
      const file = join(dir, 'helper.py');
      writeFileSync(file, 'x = 2\n');
      const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-x = 1\n+x = 2\n*** End Patch\n`;
      const r = run(
        ['hook', 'post-edit', '--tool', 'copilot-cli'],
        JSON.stringify({
          cwd: dir,
          sessionId: 'cc-patch-1',
          toolName: 'apply_patch',
          toolArgs: patch,
        }),
      );
      expect(r.code).toBe(0);
      run(['report', '--format', 'json', '--no-sync', '--no-open']);
      const data = readJsonReport(dir);
      expect(data.summary.artifacts).toBeGreaterThanOrEqual(1);
      const text = JSON.stringify(data);
      expect(text).toContain('helper.py');
      expect(text).toContain('x = 2');
    } finally {
      cleanup(dir);
    }
  });
});
