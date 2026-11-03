import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCopilotUninstall } from '../src/commands/copilot.ts';
import {
  copilotInstalled,
  removeCopilotInstructions,
  resolveCopilotTarget,
  writeCopilotInstructions,
} from '../src/core/copilot.ts';
import { blockFor } from '../src/core/managedBlock.ts';
import { reportSkillFile } from '../src/core/reportDiscovery.ts';
import { VSCODE_EXTENSION_ID } from '../src/core/vscodeExtension.ts';
import { cleanup, makeTempDir, stubInstalledExtensionCli } from './helpers.ts';

describe('Copilot passive reporting integration', () => {
  test('installs a deferred user skill without creating project instructions', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      writeCopilotInstructions(target);
      expect(existsSync(reportSkillFile('copilot'))).toBe(true);
      expect(existsSync(target.instructionsFile)).toBe(false);
      expect(existsSync(target.pathInstructionsFile)).toBe(false);
      expect(copilotInstalled(target)).toBe(true);
      const first = readFileSync(reportSkillFile('copilot'), 'utf8');
      const mtime = statSync(reportSkillFile('copilot')).mtimeMs;
      writeCopilotInstructions(target);
      expect(readFileSync(reportSkillFile('copilot'), 'utf8')).toBe(first);
      expect(statSync(reportSkillFile('copilot')).mtimeMs).toBe(mtime);
    } finally {
      cleanup(dir);
    }
  });
  test('retires old managed project instructions while preserving user content', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(target.githubDir, { recursive: true });
      writeFileSync(
        target.instructionsFile,
        'User rules\n' + blockFor('old instructions') + '\n',
      );
      writeCopilotInstructions(target);
      expect(readFileSync(target.instructionsFile, 'utf8')).toBe('User rules\n\n');
      removeCopilotInstructions(target);
      expect(readFileSync(target.instructionsFile, 'utf8')).toBe('User rules\n\n');
    } finally {
      cleanup(dir);
    }
  });
  test('preserves unmarked user instructions byte for byte', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(dirname(target.pathInstructionsFile), { recursive: true });
      const text = '---\napplyTo: "**"\n---\nCustom rules.\n';
      writeFileSync(target.pathInstructionsFile, text);
      writeCopilotInstructions(target);
      removeCopilotInstructions(target);
      expect(readFileSync(target.pathInstructionsFile, 'utf8')).toBe(text);
    } finally {
      cleanup(dir);
    }
  });
  test('a full uninstall removes the native capture extension too', async () => {
    const dir = makeTempDir();
    const previousCli = process.env.SHOWTAIL_VSCODE_CLI;
    try {
      const record = join(dir, 'extension-args.txt');
      process.env.SHOWTAIL_VSCODE_CLI = stubInstalledExtensionCli(
        dir,
        record,
        VSCODE_EXTENSION_ID,
        'code',
      );
      writeCopilotInstructions(resolveCopilotTarget(dir));

      const result = await runCopilotUninstall({ cwd: dir, all: true });

      expect(result.captureStopped).toBe(true);
      expect(readFileSync(record, 'utf8')).toContain('--uninstall-extension');
    } finally {
      if (previousCli === undefined) delete process.env.SHOWTAIL_VSCODE_CLI;
      else process.env.SHOWTAIL_VSCODE_CLI = previousCli;
      cleanup(dir);
    }
  });
});
