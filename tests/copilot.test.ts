import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  COPILOT_INSTRUCTIONS,
  SHOWTAIL_PATH_INSTRUCTIONS,
  copilotInstalled,
  copilotState,
  copilotUpToDate,
  removeCopilotInstructions,
  resolveCopilotTarget,
  writeCopilotInstructions,
} from '../src/core/copilot.ts';
import { sha256OfString } from '../src/core/hash.ts';
import { runCopilotInstall, runCopilotUninstall } from '../src/commands/copilot.ts';
import { cleanup, makeTempDir } from './helpers.ts';

/** Mirror the core's fingerprint so tests can craft blocks with a chosen stamp. */
const shortHash = (t: string): string => sha256OfString(t.trim()).slice(0, 12);
const blockOf = (sha: string, inner: string): string =>
  `<!-- showtail:start sha=${sha} -->\n${inner}\n<!-- showtail:end -->\n`;

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

describe('copilot instructions respect user edits (fingerprint)', () => {
  test('an in-block user edit is detected and NOT overwritten on refresh', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      writeCopilotInstructions(target);
      expect(copilotState(target).userEdited).toBe(false);

      // Edit a line inside the managed block of the path-specific file.
      const file = target.pathInstructionsFile;
      const edited = readFileSync(file, 'utf8').replace(
        'Showtail provenance',
        'MY OWN provenance',
      );
      writeFileSync(file, edited, 'utf8');

      // A normal refresh (no --force) must keep the edit.
      writeCopilotInstructions(target);
      expect(readFileSync(file, 'utf8')).toContain('MY OWN provenance');

      const state = copilotState(target);
      expect(state.userEdited).toBe(true);
      // Forked from the current version, so no nag.
      expect(state.updateAvailable).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('--force overwrites a user-edited block back to the latest', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      writeCopilotInstructions(target);
      const file = target.pathInstructionsFile;
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace('Showtail provenance', 'MY OWN provenance'),
        'utf8',
      );

      writeCopilotInstructions(target, { force: true });
      const after = readFileSync(file, 'utf8');
      expect(after).not.toContain('MY OWN provenance');
      expect(after).toContain('Showtail provenance');
      expect(copilotState(target).userEdited).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('content outside the block survives even when the block is edited', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      writeCopilotInstructions(target);
      const file = target.pathInstructionsFile;
      // Add user content after the end marker, and edit inside the block.
      let content = readFileSync(file, 'utf8');
      content = content.replace('Showtail provenance', 'MY OWN provenance');
      content = content.trimEnd() + '\n\n## My extra rules\nAlways add a test.\n';
      writeFileSync(file, content, 'utf8');

      writeCopilotInstructions(target);
      const after = readFileSync(file, 'utf8');
      expect(after).toContain('## My extra rules');
      expect(after).toContain('MY OWN provenance'); // edit kept too
    } finally {
      cleanup(dir);
    }
  });

  test('updateAvailable is true only when forked from an OLDER version', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(target.githubDir, { recursive: true });

      // Forked from an older version, then edited -> update available.
      const oldBody = COPILOT_INSTRUCTIONS.trim() + '\n\n(older version)';
      writeFileSync(
        target.instructionsFile,
        blockOf(shortHash(oldBody), oldBody + '\nEDITED BY USER'),
        'utf8',
      );
      // Path file: forked from the CURRENT version, then edited -> no nag.
      mkdirSync(dirname(target.pathInstructionsFile), { recursive: true });
      const curBody = SHOWTAIL_PATH_INSTRUCTIONS.replace(
        /^---\n[\s\S]*?\n---\n/,
        '',
      ).trim();
      writeFileSync(
        target.pathInstructionsFile,
        blockOf(shortHash(curBody), curBody + '\nEDITED'),
        'utf8',
      );

      const state = copilotState(target);
      expect(state.userEdited).toBe(true);
      expect(state.updateAvailable).toBe(true); // because of the older-forked one
    } finally {
      cleanup(dir);
    }
  });

  test('legacy markerless showtail.instructions.md migrates to block form', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(dirname(target.pathInstructionsFile), { recursive: true });
      writeFileSync(target.pathInstructionsFile, SHOWTAIL_PATH_INSTRUCTIONS, 'utf8');

      writeCopilotInstructions(target);
      const after = readFileSync(target.pathInstructionsFile, 'utf8');
      expect(after).toContain('<!-- showtail:start sha=');
      expect(after).toContain('applyTo:'); // frontmatter preserved
      expect(copilotState(target).userEdited).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a fully custom markerless showtail.instructions.md is respected', () => {
    const dir = makeTempDir();
    try {
      const target = resolveCopilotTarget(dir);
      mkdirSync(dirname(target.pathInstructionsFile), { recursive: true });
      const custom = '---\napplyTo: "**"\n---\n\n# Totally my own instructions\n';
      writeFileSync(target.pathInstructionsFile, custom, 'utf8');

      writeCopilotInstructions(target);
      const after = readFileSync(target.pathInstructionsFile, 'utf8');
      expect(after).toContain('# Totally my own instructions');
      expect(after).not.toContain('<!-- showtail:start'); // not force-injected
    } finally {
      cleanup(dir);
    }
  });
});
