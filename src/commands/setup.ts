import { detectTools } from '../core/detect.ts';
import {
  codexHooksFeatureEnabled,
  enableCodexHooksFeature,
  installCodexHooks,
  resolveCodexTarget,
  writeCodexInstructions,
} from '../core/codex.ts';
import { readGlobalConfig, writeGlobalConfig } from '../core/globalConfig.ts';
import { emitJson } from '../core/output.ts';
import { installHooks, resolveTarget, writeSkill } from '../core/skill.ts';
import { TOOL_LABELS } from '../types.ts';

export interface SetupOptions {
  /** Run without any prompts (setup is non-interactive regardless; kept for symmetry). */
  yes?: boolean;
  /** Turn automatic tracking back off (leaves connected tools in place). */
  off?: boolean;
  json?: boolean;
  cwd?: string;
}

interface ConnectedTool {
  tool: 'claude' | 'codex';
  scope: 'user';
  hooks: boolean;
}

/**
 * One-time guided setup: connect every installed AI tool at user scope (so it
 * works in all projects) and turn on automatic tracking. After this, a student
 * never has to run a Showtail command again — trails create themselves on first
 * AI use and sessions close themselves. Idempotent: safe to re-run.
 *
 * Connects via the core install helpers directly (not the chatty `connect`
 * wrappers) so output stays concise and `--json` emits a single clean object.
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  if (options.off) {
    writeGlobalConfig({ ...readGlobalConfig(), version: 1, autoInit: false });
    if (options.json) {
      emitJson({ autoInit: false });
      return;
    }
    console.log('Automatic tracking is now OFF.');
    console.log('Existing trails are untouched; connected tools stay connected.');
    console.log('Turn it back on anytime with `showtail setup`.');
    return;
  }

  const detected = detectTools();
  const connected: ConnectedTool[] = [];

  for (const d of detected) {
    if (!d.installed) continue;
    if (d.tool === 'claude') {
      const target = resolveTarget('user', options.cwd);
      writeSkill(target);
      installHooks(target);
      connected.push({ tool: 'claude', scope: 'user', hooks: true });
    } else if (d.tool === 'codex') {
      const target = resolveCodexTarget('user', options.cwd);
      writeCodexInstructions(target, {});
      installCodexHooks(target);
      if (!codexHooksFeatureEnabled(target.configToml)) {
        enableCodexHooksFeature(target.configToml);
      }
      connected.push({ tool: 'codex', scope: 'user', hooks: true });
    }
    // Copilot is project-scoped (.github/ lives in each repo) and the VS Code
    // extension auto-installs its instructions on first open, so there's nothing
    // to connect globally here — only guidance to install the extension.
  }

  // The single switch that turns automatic tracking on everywhere.
  const setupCompletedAt = new Date().toISOString();
  writeGlobalConfig({
    ...readGlobalConfig(),
    version: 1,
    autoInit: true,
    setupCompletedAt,
  });

  const copilotDetected = detected.find((d) => d.tool === 'copilot')?.installed ?? false;

  if (options.json) {
    emitJson({
      detected: detected.map((d) => ({ tool: d.tool, installed: d.installed })),
      connected,
      autoInit: true,
      setupCompletedAt,
    });
    return;
  }

  console.log('Showtail setup');
  console.log('');
  if (connected.length > 0) {
    console.log('Connected your AI tools (for all projects):');
    for (const c of connected) {
      console.log(`  ${TOOL_LABELS[`${c.tool}-code`] ?? c.tool} · hooks on`);
    }
  } else {
    console.log('No AI tools were detected to connect automatically.');
    console.log('  Connect one anytime with `showtail connect claude` (or codex).');
  }
  if (copilotDetected) {
    console.log('');
    console.log('VS Code detected. For GitHub Copilot capture, install the extension:');
    console.log('  code --install-extension Tingsters.showtail');
    console.log('  (It sets up each project automatically the first time you open it.)');
  }
  console.log('');
  console.log('Automatic tracking is ON. From now on, just work:');
  console.log(
    '  • The first time you use AI in a project, Showtail starts a trail for you.',
  );
  console.log('  • Sessions open and close around your tasks — no commands to run.');
  console.log('  • Ask your AI to "generate a Showtail report" whenever you want one.');
  console.log('');
  console.log('Privacy: everything stays local under .showtail/. Secrets and personal');
  console.log('data are scrubbed before storage, and nothing ever leaves your machine.');
  console.log(
    'Turn automatic tracking off anytime with `showtail setup --off`' +
      ' or `showtail disconnect <tool>`.',
  );
}
