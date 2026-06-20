import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  codexHooksFeatureEnabled,
  enableCodexHooksFeature,
  installCodexHooks,
  removeCodexInstructions,
  resolveCodexTarget,
  uninstallCodexHooks,
  writeCodexInstructions,
  type InstallScope,
} from '../core/codex.ts';

function scopeOf(options: { user?: boolean }): InstallScope {
  return options.user ? 'user' : 'project';
}

export interface CodexInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  /** Skip the config.toml prompt and enable `features.hooks` non-interactively. */
  yes?: boolean;
  force?: boolean;
  cwd?: string;
}

/**
 * Ask a yes/no question (default Yes). Auto-yes when stdin isn't a TTY so the
 * command works in scripts/CI; the caller prints what was changed regardless.
 */
async function confirmDefaultYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Install (or refresh) the Codex AGENTS.md instructions and auto-capture hooks. */
export async function runCodexInstall(options: CodexInstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveCodexTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.agentsFile);
  writeCodexInstructions(target, { force: options.force });

  console.log(`${existed ? 'Updated' : 'Installed'} the Showtail Codex instructions:`);
  console.log(`  ${target.agentsFile}`);
  console.log(
    `  scope: ${scope === 'user' ? 'personal (all projects)' : 'this project'}`,
  );
  console.log('');

  if (withHooks) {
    installCodexHooks(target);
    console.log('Enabled auto-capture hooks (on by default):');
    console.log(`  ${target.hooksFile}`);
    console.log('');

    if (codexHooksFeatureEnabled(target.configToml)) {
      console.log(`  Codex hooks are already enabled in ${target.configToml}.`);
    } else {
      const proceed =
        options.yes ||
        (await confirmDefaultYes(
          `Enable Codex lifecycle hooks in ${target.configToml}?`,
        ));
      if (proceed) {
        const result = enableCodexHooksFeature(target.configToml);
        console.log(
          `  ${result === 'created' ? 'Created' : 'Updated'} ${target.configToml} ` +
            `(set features.hooks = true).`,
        );
      } else {
        console.log(
          '  Skipped. Codex hooks will NOT fire until you set, in config.toml:',
        );
        console.log('    [features]');
        console.log('    hooks = true');
      }
    }
    console.log('');
    console.log('  Privacy note: while these hooks are active, Showtail automatically');
    console.log(
      '  logs each prompt you submit and snapshots each file Codex edits, into',
    );
    console.log('  your local .showtail/ folder. Nothing leaves your machine. Review it');
    console.log(
      '  anytime with `showtail report`. To opt out, re-run with --no-hooks, or',
    );
    console.log(
      '  remove them with `showtail disconnect codex`' +
        (scope === 'user' ? ' --user' : '') +
        '.',
    );
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log(
      '  AGENTS.md still teaches Codex to log prompts and snapshot edits itself',
    );
    console.log(
      '  as you pair. That capture is model-driven, so it may be less complete',
    );
    console.log('  than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log(
    'Then just work with Codex in this project — it reads AGENTS.md automatically.',
  );
}

export interface CodexUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail Codex instructions and any hooks we installed. */
export async function runCodexUninstall(options: CodexUninstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveCodexTarget(scope, options.cwd);

  const removedInstructions = removeCodexInstructions(target);
  const removedHooks = uninstallCodexHooks(target);

  if (!removedInstructions && !removedHooks) {
    console.log(
      'Nothing to remove — no Showtail Codex integration found for this scope.',
    );
    return;
  }
  if (removedInstructions) console.log(`Removed instructions from: ${target.agentsFile}`);
  if (removedHooks) console.log(`Removed Showtail hooks from: ${target.hooksFile}`);
  console.log('Done. Auto-capture is off.');
  console.log(
    `(Left features.hooks in ${target.configToml} alone — it is harmless and may be used by other hooks.)`,
  );
}
