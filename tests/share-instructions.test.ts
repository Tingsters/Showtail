import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent-facing instructions are part of the security design: they are what
 * stops an AI assistant from posting a student's work somewhere without their say-so.
 * These tests pin the opt-in contract in every file so an edit cannot quietly weaken it.
 */
const ROOT = join(import.meta.dir, '..');
// Whitespace is collapsed so a phrase still matches when the prose wraps differently.
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

const FULL = [
  'assets/claude-code/plugin/skills/showtail/SKILL.md',
  'assets/codex/AGENTS.showtail.md',
  'assets/copilot/copilot-instructions.md',
  'assets/copilot-cli/showtail.showtail.md',
  'assets/antigravity-cli/AGY.showtail.md',
  'assets/antigravity-ide/AGY-IDE.showtail.md',
];
const SHORT = ['assets/copilot/showtail.instructions.md'];

describe('PR summary is opt-in, reviewed, and never automatic', () => {
  for (const file of FULL) {
    describe(file, () => {
      const text = read(file);

      test('asks the student first, with default no', () => {
        expect(text).toContain('Pull requests: ask first, and only the student decides');
        expect(text).toContain('The default is **no**');
        expect(text).toContain('nothing is posted unless you say yes');
      });

      test('shows the exact text via --preview before anything is posted', () => {
        expect(text).toContain('--pr --preview');
        expect(text).toContain('**entire comment text**');
        expect(text).toContain('confirm **that exact text**');
      });

      test('posts only with --approve and the preview code, never otherwise', () => {
        expect(text).toContain('--pr --approve <code>');
        expect(text).toContain(
          'Never run `--approve` unless the student approved the text',
        );
      });

      test('has no way around the review (no --yes, no auto-post)', () => {
        expect(text).not.toContain('--yes');
        expect(text).not.toMatch(/always (post|add) (a|the) (Showtail )?summary/i);
      });

      test('tells the student when the repository is public, and to rotate leaked keys', () => {
        expect(text).toContain('public and permanent');
        expect(text).toContain('rotate it now');
      });

      test('no longer claims the trail "may be committed" or is "never sent anywhere"', () => {
        expect(text).not.toContain('the trail may be committed');
        expect(text).not.toContain('Never send it anywhere');
        expect(text).toContain('Nothing leaves the machine except a sanitised summary');
      });

      test('separates the private report from the one to hand in', () => {
        expect(text).toContain('`showtail submit` makes the report to **hand in**');
        expect(text).toContain('never hand that one');
      });
    });
  }

  for (const file of SHORT) {
    test(`${file} requires the student's approval of the exact text`, () => {
      const text = read(file);
      expect(text).toContain('--pr --preview');
      expect(text).toContain('approved the exact text');
      expect(text).not.toContain('--yes');
    });
  }

  test('the Claude skill can only run showtail commands', () => {
    expect(read('assets/claude-code/plugin/skills/showtail/SKILL.md')).toContain(
      'allowed-tools: Bash(showtail *)',
    );
  });

  test('the command reference lists the submit commands', () => {
    const skill = read('assets/claude-code/plugin/skills/showtail/SKILL.md');
    expect(skill).toContain('--pr --preview');
    expect(skill).toContain('`showtail verify-submission [dir]`');
  });
});

describe('submit follows the same project-targeting discipline as report and verify', () => {
  for (const file of FULL) {
    test(`${file} resolves the project and passes --project, never a built path`, () => {
      const text = read(file);
      expect(text).toContain('showtail submit --project "<trail-id>" --pr --preview');
      expect(text).toContain(
        'showtail submit --project "<trail-id>" --pr --approve <code>',
      );
      expect(text).toContain('showtail projects "<student-project-wording>" --json');
      expect(text).toContain('never build a path');
    });
  }
});
