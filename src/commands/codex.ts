import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  codexAutoCaptureActive,
  codexHooksFeatureEnabled,
  enableCodexHooksFeature,
  installCodexHooks,
  removeCodexInstructions,
  resolveCodexTarget,
  uninstallCodexHooks,
  writeCodexInstructions,
} from '../core/codex.ts';
import { reportSkillFile } from '../core/reportDiscovery.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';
import {
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

/** Install (or refresh) the deferred reporting skill and native-history callbacks. */
export async function runCodexInstall(options: CodexInstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveCodexTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(reportSkillFile('codex'));
  writeCodexInstructions(target, { force: options.force });
  if (existsSync(reportSkillFile('codex')))
    printInstallHeader('Codex reporting skill', reportSkillFile('codex'), scope, existed);

  if (withHooks) {
    installCodexHooks(target);
    console.log(`Registered Codex observer callbacks: ${target.hooksFile}`);

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
    const removed = uninstallCodexHooks(target);
    console.log(
      `Auto-capture hooks are OFF at ${scope} scope${removed ? ' (existing Showtail hooks removed)' : ''}.`,
    );
    console.log(
      '  The reporting skill remains available; native history can be imported with sync.',
    );
    console.log(
      '  and edits will not be captured automatically. Re-run without --no-hooks',
    );
    console.log('  to restore hands-free capture.');
    if (codexAutoCaptureActive(options.cwd)) {
      console.log('  Automatic capture remains active through the other scope.');
    }
  }

  console.log('');
  console.log(
    'Capture reads Codex saved history; ordinary coding needs no Showtail instructions.',
  );
}

export interface CodexUninstallOptions {
  user?: boolean;
  all?: boolean;
  cwd?: string;
}

/** Remove the Showtail Codex instructions and any hooks we installed. */
export async function runCodexUninstall(
  options: CodexUninstallOptions,
): Promise<ConnectUninstallResult> {
  const scopes = options.all
    ? (['project', 'user'] as const)
    : ([scopeOf(options)] as const);
  const removedLines: Array<string | null> = [];

  for (const scope of scopes) {
    const target = resolveCodexTarget(scope, options.cwd);
    const removedInstructions = removeCodexInstructions(target);
    const removedHooks = uninstallCodexHooks(target);
    removedLines.push(
      removedInstructions ? `Removed instructions from: ${target.agentsFile}` : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    );
  }

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Codex integration found in the selected scope(s).',
    removedLines,
    trailer:
      '(Left features.hooks in config.toml alone — it is harmless and may be used by other hooks.)',
  });
  return { captureStopped: !codexAutoCaptureActive(options.cwd) };
}
