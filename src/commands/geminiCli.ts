import { existsSync } from 'node:fs';
import {
  installGeminiCliHooks,
  removeGeminiCliInstructions,
  resolveGeminiCliTarget,
  uninstallGeminiCliHooks,
  writeGeminiCliInstructions,
} from '../core/geminiCli.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

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
  printInstallHeader('Gemini CLI instructions', target.contextFile, scope, existed);

  if (withHooks) {
    installGeminiCliHooks(target);
    printHooksEnabled(target.settingsFile);
    printPrivacyNote({ editSubject: 'Gemini CLI', disconnectName: 'gemini-cli', scope });
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

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Gemini CLI integration found for this scope.',
    removedLines: [
      removedInstructions ? `Removed instructions from: ${target.contextFile}` : null,
      removedHooks ? `Removed Showtail hooks from: ${target.settingsFile}` : null,
    ],
  });
}
