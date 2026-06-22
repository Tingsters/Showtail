import { existsSync } from 'node:fs';
import {
  installGeminiCliHooks,
  removeGeminiCliInstructions,
  resolveGeminiCliTarget,
  uninstallGeminiCliHooks,
  writeGeminiCliInstructions,
  type InstallScope,
} from '../core/geminiCli.ts';

function scopeOf(options: { user?: boolean }): InstallScope {
  return options.user ? 'user' : 'project';
}

export interface GeminiCliInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Install (or refresh) the Gemini CLI GEMINI.md instructions and auto-capture hooks. */
export async function runGeminiCliInstall(
  options: GeminiCliInstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveGeminiCliTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.contextFile);
  writeGeminiCliInstructions(target, { force: options.force });

  console.log(
    `${existed ? 'Updated' : 'Installed'} the Showtail Gemini CLI instructions:`,
  );
  console.log(`  ${target.contextFile}`);
  console.log(
    `  scope: ${scope === 'user' ? 'personal (all projects)' : 'this project'}`,
  );
  console.log('');

  if (withHooks) {
    installGeminiCliHooks(target);
    console.log('Enabled auto-capture hooks (on by default):');
    console.log(`  ${target.settingsFile}`);
    console.log('');
    console.log('  Privacy note: while these hooks are active, Showtail automatically');
    console.log(
      '  logs each prompt you submit and snapshots each file Gemini CLI edits, into',
    );
    console.log('  your local .showtail/ folder. Nothing leaves your machine. Review it');
    console.log(
      '  anytime with `showtail report`. To opt out, re-run with --no-hooks, or',
    );
    console.log(
      '  remove them with `showtail disconnect gemini-cli`' +
        (scope === 'user' ? ' --user' : '') +
        '.',
    );
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log(
      '  GEMINI.md still teaches Gemini CLI to log prompts and snapshot edits itself',
    );
    console.log(
      '  as you pair. That capture is model-driven, so it may be less complete',
    );
    console.log('  than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log(
    'Then just work with Gemini CLI in this project — it reads GEMINI.md automatically.',
  );
}

export interface GeminiCliUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail Gemini CLI instructions and any hooks we installed. */
export async function runGeminiCliUninstall(
  options: GeminiCliUninstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveGeminiCliTarget(scope, options.cwd);

  const removedInstructions = removeGeminiCliInstructions(target);
  const removedHooks = uninstallGeminiCliHooks(target);

  if (!removedInstructions && !removedHooks) {
    console.log(
      'Nothing to remove — no Showtail Gemini CLI integration found for this scope.',
    );
    return;
  }
  if (removedInstructions) {
    console.log(`Removed instructions from: ${target.contextFile}`);
  }
  if (removedHooks) console.log(`Removed Showtail hooks from: ${target.settingsFile}`);
  console.log('Done. Auto-capture is off.');
}
