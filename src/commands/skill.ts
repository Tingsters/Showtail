import { existsSync } from 'node:fs';
import {
  autoCaptureActive,
  installHooks,
  removeSkill,
  resolveTarget,
  uninstallHooks,
  writeSkill,
  type InstallScope,
} from '../core/skill.ts';

export interface SkillInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

function scopeOf(options: { user?: boolean }): InstallScope {
  return options.user ? 'user' : 'project';
}

/** Install the Showtail skill and, by default, the auto-capture hooks. */
export async function runSkillInstall(options: SkillInstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.skillFile);
  writeSkill(target);

  console.log(`${existed ? 'Updated' : 'Installed'} the Showtail skill:`);
  console.log(`  ${target.skillFile}`);
  console.log(
    `  scope: ${scope === 'user' ? 'personal (all projects)' : 'this project'}`,
  );
  console.log('');

  if (withHooks) {
    installHooks(target);
    console.log('Enabled auto-capture hooks (on by default):');
    console.log(`  ${target.settingsFile}`);
    console.log('');
    console.log('  Privacy note: while these hooks are active, Showtail automatically');
    console.log(
      '  logs each prompt you submit and snapshots each file Claude edits, into',
    );
    console.log('  your local .showtail/ folder. Nothing leaves your machine. Review it');
    console.log(
      '  anytime with `showtail report`. To opt out, re-run with --no-hooks, or',
    );
    console.log(
      '  remove them with `showtail skill uninstall`' +
        (scope === 'user' ? ' --user' : '') +
        '.',
    );
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log('  The skill will instead log prompts and snapshot edits itself as you');
    console.log('  pair with Claude. That capture is model-driven, so it may be less');
    console.log('  complete than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log('Open Claude Code in this project and the skill will be available');
  console.log('automatically (or invoke it explicitly with `/showtail`).');
}

export interface SkillStatusOptions {
  cwd?: string;
}

/**
 * Report whether auto-capture hooks are active. The skill runs this to decide
 * whether to capture prompts/edits itself (avoiding duplication when hooks are
 * already doing it). The wording is intentionally instructional for the agent.
 */
export async function runSkillStatus(options: SkillStatusOptions = {}): Promise<void> {
  if (autoCaptureActive(options.cwd)) {
    console.log('auto-capture: ON');
    console.log(
      'Hooks are installed: every prompt and every file edit is recorded automatically.',
    );
    console.log(
      'Do NOT log prompts or file snapshots yourself — focus on the judgment events',
    );
    console.log('(decisions, reflections, sources, tests) in the student’s own voice.');
  } else {
    console.log('auto-capture: OFF');
    console.log('No capture hooks are installed; nothing is logging prompts or edits.');
    console.log('As you work, ALSO do what the hooks would have done:');
    console.log(
      '  - log the student’s request, in their words: showtail log --type prompt --text "..."',
    );
    console.log('  - snapshot files you change: showtail artifact add <file>');
    console.log('Plus the judgment events (decisions, reflections, sources, tests).');
  }
}

export interface SkillUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail skill and any hooks we installed. */
export async function runSkillUninstall(options: SkillUninstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveTarget(scope, options.cwd);

  const removedSkill = removeSkill(target);
  const touchedSettings = uninstallHooks(target);

  if (!removedSkill && !touchedSettings) {
    console.log('Nothing to remove — no Showtail skill or hooks found for this scope.');
    return;
  }
  if (removedSkill) console.log(`Removed skill: ${target.skillDir}`);
  if (touchedSettings) console.log(`Removed Showtail hooks from: ${target.settingsFile}`);
  console.log('Done. Auto-capture is off.');
}
