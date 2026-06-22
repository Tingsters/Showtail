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
} from '../core/codex.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

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
  printInstallHeader('Codex instructions', target.agentsFile, scope, existed);

  if (withHooks) {
    installCodexHooks(target);
    printHooksEnabled(target.hooksFile);

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
    printPrivacyNote({ editSubject: 'Codex', disconnectName: 'codex', scope });
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

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Codex integration found for this scope.',
    removedLines: [
      removedInstructions ? `Removed instructions from: ${target.agentsFile}` : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    ],
    trailer: `(Left features.hooks in ${target.configToml} alone — it is harmless and may be used by other hooks.)`,
  });
}
