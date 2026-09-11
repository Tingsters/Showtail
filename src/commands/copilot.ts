import {
  copilotState,
  removeCopilotInstructions,
  resolveCopilotTarget,
  writeCopilotInstructions,
} from '../core/copilot.ts';
import { refreshExistingCopilotCliInstructions } from '../core/copilotCli.ts';
import {
  uninstallVsCodeExtension,
  VSCODE_EXTENSION_ID,
} from '../core/vscodeExtension.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';

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
  const cliRefresh = refreshExistingCopilotCliInstructions(target.root, {
    force: options.force,
  });
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
  if (cliRefresh.updateAvailable.length > 0 && !options.force) {
    console.log('');
    console.log(
      '  A customized Copilot CLI instruction block also has an update available.',
    );
    console.log(
      '  Your edits were kept; `--force` updates both Copilot instruction sets.',
    );
  }

  console.log('');
  console.log(
    'Native Copilot Chat prompts and replies are captured by the VS Code extension;',
  );
  console.log('saved files are snapshotted there too, without per-message commands.');

  if (options.extension !== false) {
    console.log('');
    console.log(
      'For automatic capture of prompts and edits, install the Showtail VS Code',
    );
    console.log(
      'extension (it captures native chat, snapshots saved files, and adds an `@showtail`',
    );
    console.log('control surface):');
    console.log(`  code --install-extension ${MARKETPLACE_ID}`);
    console.log('  (or install the .vsix from the GitHub Releases page)');
  }

  console.log('');
  console.log('Then just code with Copilot as usual — your saved edits are captured');
  console.log('automatically. Use `@showtail /report` or `/verify` in chat anytime.');
}

export interface CopilotUninstallOptions {
  /** Also remove the user-wide native extension that performs capture. */
  all?: boolean;
  cwd?: string;
}

/** Remove the Showtail Copilot instructions and, for a full disconnect, its extension. */
export async function runCopilotUninstall(
  options: CopilotUninstallOptions = {},
): Promise<ConnectUninstallResult> {
  const target = resolveCopilotTarget(options.cwd);
  const removed = removeCopilotInstructions(target);
  const extension = options.all ? uninstallVsCodeExtension() : undefined;

  if (removed) {
    console.log('Removed the Showtail Copilot instructions from .github/.');
  }
  if (extension?.wasInstalled) {
    console.log(`Removed the Showtail VS Code extension (${VSCODE_EXTENSION_ID}).`);
    console.log('Reload any open VS Code windows to unload the running extension.');
  }
  if (!removed && !extension?.wasInstalled) {
    console.log('Nothing to remove — no Showtail Copilot instructions found.');
  }

  const warnings: string[] = [];
  if (extension && !extension.uninstalled) {
    warnings.push(
      `Could not remove or verify the VS Code extension (${extension.reason ?? 'unknown error'}). ` +
        `Run \`code --uninstall-extension ${VSCODE_EXTENSION_ID}\` to remove the dormant component, then reload open VS Code windows.`,
    );
  } else if (!options.all) {
    warnings.push(
      `Only project instructions were removed; the user-wide VS Code extension was left in place. ` +
        `Run \`showtail disconnect copilot\` without a scope flag to stop it.`,
    );
  }

  return {
    captureStopped: options.all ? extension?.uninstalled === true : false,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
