import {
  copilotInstalled,
  removeCopilotInstructions,
  resolveCopilotTarget,
  writeCopilotInstructions,
} from '../core/copilot.ts';

export interface CopilotInstallOptions {
  /** Show the VS Code extension install guidance. Defaults to true. */
  extension?: boolean;
  cwd?: string;
}

const MARKETPLACE_ID = 'Tingsters.showtail';

/**
 * Set up the GitHub Copilot integration: write the repo's Copilot custom
 * instructions (the analog of the Claude Code skill) and point the student at
 * the VS Code extension that does the automatic capture.
 */
export async function runCopilotInstall(options: CopilotInstallOptions): Promise<void> {
  const target = resolveCopilotTarget(options.cwd);
  const existed = copilotInstalled(target);
  writeCopilotInstructions(target);

  console.log(`${existed ? 'Updated' : 'Installed'} the Showtail Copilot instructions:`);
  console.log(`  ${target.instructionsFile}`);
  console.log(`  ${target.pathInstructionsFile}`);
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

export interface CopilotStatusOptions {
  cwd?: string;
}

/** Report whether the Copilot instructions are installed for this project. */
export async function runCopilotStatus(
  options: CopilotStatusOptions = {},
): Promise<void> {
  const target = resolveCopilotTarget(options.cwd);
  if (copilotInstalled(target)) {
    console.log('copilot integration: ON');
    console.log(`  instructions: ${target.instructionsFile}`);
  } else {
    console.log('copilot integration: OFF');
    console.log('  Run `showtail copilot install` to set it up.');
  }
}
