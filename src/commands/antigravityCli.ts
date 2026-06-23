import { existsSync } from 'node:fs';
import {
  installAntigravityCliHooks,
  removeAntigravityCliInstructions,
  resolveAntigravityCliTarget,
  uninstallAntigravityCliHooks,
  writeAntigravityCliInstructions,
} from '../core/antigravityCli.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

export interface AntigravityCliInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Install (or refresh) the Antigravity CLI instructions and auto-capture hooks. */
export async function runAntigravityCliInstall(
  options: AntigravityCliInstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveAntigravityCliTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.contextFile);
  writeAntigravityCliInstructions(target, { force: options.force });
  printInstallHeader('Antigravity CLI instructions', target.contextFile, scope, existed);

  if (withHooks) {
    installAntigravityCliHooks(target);
    printHooksEnabled(target.hooksFile);
    printPrivacyNote({
      editSubject: 'Antigravity CLI',
      disconnectName: 'antigravity-cli',
      scope,
    });
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log(
      '  The instructions still teach Antigravity CLI to log prompts and snapshot',
    );
    console.log(
      '  edits itself as you pair. That capture is model-driven, so it may be less',
    );
    console.log('  complete than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log(
    'Then just work with Antigravity CLI in this project — it reads the .agents rules automatically.',
  );
}

export interface AntigravityCliUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail Antigravity CLI instructions and any hooks we installed. */
export async function runAntigravityCliUninstall(
  options: AntigravityCliUninstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveAntigravityCliTarget(scope, options.cwd);

  const removedInstructions = removeAntigravityCliInstructions(target);
  const removedHooks = uninstallAntigravityCliHooks(target);

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Antigravity CLI integration found for this scope.',
    removedLines: [
      removedInstructions ? `Removed instructions from: ${target.contextFile}` : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    ],
  });
}
