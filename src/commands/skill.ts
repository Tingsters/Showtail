import { existsSync } from 'node:fs';
import {
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
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

function scopeOf(options: { user?: boolean }): InstallScope {
  return options.user ? 'user' : 'project';
}

/** Install the Showtail skill (and optionally the auto-capture hooks). */
export async function runSkillInstall(options: SkillInstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveTarget(scope, options.cwd);

  const existed = existsSync(target.skillFile);
  writeSkill(target);

  console.log(`${existed ? 'Updated' : 'Installed'} the Showtail skill:`);
  console.log(`  ${target.skillFile}`);
  console.log(
    `  scope: ${scope === 'user' ? 'personal (all projects)' : 'this project'}`,
  );
  console.log('');

  if (options.hooks) {
    installHooks(target);
    console.log('Enabled auto-capture hooks:');
    console.log(`  ${target.settingsFile}`);
    console.log('');
    console.log('  Privacy note: while these hooks are active, Showtail will');
    console.log('  automatically log each prompt you submit and snapshot each file');
    console.log('  Claude edits, into your local .showtail/ folder. Nothing leaves');
    console.log('  your machine. Review it anytime with `showtail report`, and turn it');
    console.log(
      '  off with `showtail skill uninstall`' + (scope === 'user' ? ' --user' : '') + '.',
    );
  } else {
    console.log('Auto-capture hooks were NOT enabled (skill only).');
    console.log('  To also auto-log prompts and edits, re-run with --with-hooks:');
    console.log(
      `    showtail skill install${scope === 'user' ? ' --user' : ''} --with-hooks`,
    );
  }

  console.log('');
  console.log('Open Claude Code in this project and the skill will be available');
  console.log('automatically (or invoke it explicitly with `/showtail`).');
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
