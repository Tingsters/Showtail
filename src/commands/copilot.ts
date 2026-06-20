import {
  copilotState,
  removeCopilotInstructions,
  resolveCopilotTarget,
  writeCopilotInstructions,
} from '../core/copilot.ts';

export interface CopilotInstallOptions {
  /** Show the VS Code extension install guidance. Defaults to true. */
  extension?: boolean;
  /** Overwrite even instructions you've edited (take the latest). */
  force?: boolean;
  cwd?: string;
}

const MARKETPLACE_ID = 'Tingsters.showtail';

/**
 * Set up / refresh the GitHub Copilot integration. Only ever overwrites the
 * instructions Showtail itself wrote: untouched blocks update to the latest,
 * your own edits are kept (use --force to take the latest anyway).
 */
export async function runCopilotInstall(options: CopilotInstallOptions): Promise<void> {
  const target = resolveCopilotTarget(options.cwd);
  const before = copilotState(target);
  writeCopilotInstructions(target, { force: options.force });
  const after = copilotState(target);

  if (!before.installed) {
    console.log('Installed the Showtail Copilot instructions:');
  } else if (options.force) {
    console.log('Reset the Showtail Copilot instructions to the latest:');
  } else if (after.userEdited) {
    console.log(
      'Kept your customized Copilot instructions (Showtail only updates its own):',
    );
  } else {
    console.log('Showtail Copilot instructions are up to date:');
  }
  console.log(`  ${target.instructionsFile}`);
  console.log(`  ${target.pathInstructionsFile}`);

  if (after.userEdited && after.updateAvailable && !options.force) {
    console.log('');
    console.log('  A newer version is available. Your edits were kept — run');
    console.log('  `showtail connect copilot --force` to take the latest instead.');
  }

  console.log('');
  console.log(
    'These teach Copilot to record decisions, reflections, sources, and tests in',
  );
  console.log('the student’s voice (tagged github-copilot) as you pair.');

  if (options.extension !== false) {
    console.log('');
    console.log(
      'For automatic capture of prompts and edits, install the Showtail VS Code',
    );
    console.log(
      'extension (it snapshots saved files and adds an `@showtail` chat that logs',
    );
    console.log('your prompts):');
    console.log(`  code --install-extension ${MARKETPLACE_ID}`);
    console.log('  (or install the .vsix from the GitHub Releases page)');
  }

  console.log('');
  console.log('Then just code with Copilot as usual — your saved edits are captured');
  console.log('automatically. Use `@showtail /report` or `/verify` in chat anytime.');
}

export interface CopilotUninstallOptions {
  cwd?: string;
}

/** Remove the Showtail Copilot instructions (leaves the extension alone). */
export async function runCopilotUninstall(
  options: CopilotUninstallOptions = {},
): Promise<void> {
  const target = resolveCopilotTarget(options.cwd);
  const removed = removeCopilotInstructions(target);
  if (!removed) {
    console.log('Nothing to remove — no Showtail Copilot instructions found.');
    return;
  }
  console.log('Removed the Showtail Copilot instructions from .github/.');
  console.log(
    'To also remove the extension: code --uninstall-extension ' + MARKETPLACE_ID,
  );
}
