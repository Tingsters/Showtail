import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  COPILOT_INSTRUCTIONS,
  SHOWTAIL_PATH_INSTRUCTIONS,
  copilotInstalled,
  copilotUpToDate,
  removeCopilotInstructions,
  resolveCopilotTarget,
  writeCopilotInstructions,
} from '../src/core/copilot.ts';
import { runCopilotInstall, runCopilotUninstall } from '../src/commands/copilot.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('copilot integration', () => {
  test('install writes both instruction files', async () => {
    const dir = makeTempDir();
    try {
      await runCopilotInstall({ cwd: dir, extension: false });
      const target = resolveCopilotTarget(dir);
      expect(existsSync(target.instructionsFile)).toBe(true);
      expect(existsSync(target.pathInstructionsFile)).toBe(true);
      expect(readFileSync(target.pathInstructionsFile, 'utf8')).toContain('applyTo:');
      expect(copilotInstalled(target)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('install preserves a pre-existing copilot-instructions.md', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(target.githubDir, { recursive: true });
      writeFileSync(target.instructionsFile, '# My own rules\nUse tabs.\n', 'utf8');

      writeCopilotInstructions(target);
      const content = readFileSync(target.instructionsFile, 'utf8');
      expect(content).toContain('# My own rules');
      expect(content).toContain('Use tabs.');
      expect(content).toContain('showtail:start');
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate Showtail blocks)', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      writeCopilotInstructions(target);
      writeCopilotInstructions(target);
      const content = readFileSync(target.instructionsFile, 'utf8');
      const starts = content.split('showtail:start').length - 1;
      expect(starts).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('uninstall removes our block but keeps the user content', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(target.githubDir, { recursive: true });
      writeFileSync(target.instructionsFile, '# My own rules\nUse tabs.\n', 'utf8');
      writeCopilotInstructions(target);

      removeCopilotInstructions(target);
      const content = readFileSync(target.instructionsFile, 'utf8');
      expect(content).toContain('# My own rules');
      expect(content).not.toContain('showtail:start');
      expect(existsSync(target.pathInstructionsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('uninstall deletes copilot-instructions.md when only our block was there', async () => {
    const dir = makeTempDir();
    try {
      await runCopilotInstall({ cwd: dir, extension: false });
      const target = resolveCopilotTarget(dir);
      await runCopilotUninstall({ cwd: dir });
      expect(existsSync(target.instructionsFile)).toBe(false);
      expect(copilotInstalled(target)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('refresh replaces a stale Showtail block with the current instructions', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(target.githubDir, { recursive: true });
      // Simulate an outdated installed block.
      writeFileSync(
        target.instructionsFile,
        '<!-- showtail:start -->\nOLD CONTENT\n<!-- showtail:end -->\n',
        'utf8',
      );
      writeCopilotInstructions(target);
      const content = readFileSync(target.instructionsFile, 'utf8');
      expect(content).not.toContain('OLD CONTENT');
      expect(content).toContain('EVERY prompt');
      expect(copilotUpToDate(target)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('copilotUpToDate is false before install, true after, and a no-op write keeps mtime', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      expect(copilotUpToDate(target)).toBe(false);
      writeCopilotInstructions(target);
      expect(copilotUpToDate(target)).toBe(true);

      // A refresh when already current must not rewrite the file.
      const before = statSync(target.instructionsFile).mtimeMs;
      writeCopilotInstructions(target);
      const after = statSync(target.instructionsFile).mtimeMs;
      expect(after).toBe(before);
    } finally {
      cleanup(dir);
    }
  });

  test('embedded instruction assets are non-empty', () => {
    expect(COPILOT_INSTRUCTIONS).toContain('Showtail');
    expect(SHOWTAIL_PATH_INSTRUCTIONS).toContain('applyTo:');
  });

  test('instructions tell Copilot to log every prompt (incl. brainstorming)', () => {
    expect(COPILOT_INSTRUCTIONS).toContain('EVERY prompt');
    expect(COPILOT_INSTRUCTIONS).toContain('Brainstorming');
    expect(SHOWTAIL_PATH_INSTRUCTIONS.toLowerCase()).toContain('every');
    expect(SHOWTAIL_PATH_INSTRUCTIONS.toLowerCase()).toContain('brainstorm');
  });
});
