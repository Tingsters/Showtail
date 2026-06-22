import { readGlobalConfig, writeGlobalConfig } from '../core/globalConfig.ts';
import { emitJson } from '../core/output.ts';
import { connectPlugins } from '../plugins/registry.ts';

export interface SetupOptions {
  /** Run without any prompts (setup is non-interactive regardless; kept for symmetry). */
  yes?: boolean;
  /** Turn automatic tracking back off (leaves connected tools in place). */
  off?: boolean;
  json?: boolean;
  cwd?: string;
}

interface ConnectedTool {
  tool: string;
  label: string;
  scope: 'user';
  hooks: boolean;
}

/**
 * One-time guided setup: connect every installed AI tool at user scope (so it
 * works in all projects) and turn on automatic tracking. After this, a student
 * never has to run a Showtail command again — trails create themselves on first
 * AI use and sessions close themselves. Idempotent: safe to re-run.
 *
 * Detection and connection are driven entirely by the plugin registry; this
 * command names no tool. Each connect plugin reports whether it's installed
 * (`detect`) and either auto-connects at user scope (`autoConnect`) or supplies
 * guidance to print (`setupGuidance`, e.g. Copilot's VS Code extension).
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

  const detected = connectPlugins().map((plugin) => ({
    plugin,
    installed: plugin.connect.detect(),
  }));

  const connected: ConnectedTool[] = [];
  const guidance: string[] = [];
  for (const { plugin, installed } of detected) {
    if (!installed) continue;
    const result = plugin.connect.autoConnect?.(options.cwd);
    if (result) {
      connected.push({
        tool: plugin.cliName,
        label: plugin.label,
        scope: 'user',
        hooks: result.hooks,
      });
    } else if (plugin.connect.setupGuidance) {
      guidance.push(...plugin.connect.setupGuidance);
    }
  }

  // The single switch that turns automatic tracking on everywhere.
  const setupCompletedAt = new Date().toISOString();
  writeGlobalConfig({
    ...readGlobalConfig(),
    version: 1,
    autoInit: true,
    setupCompletedAt,
  });

  if (options.json) {
    emitJson({
      detected: detected.map((d) => ({ tool: d.plugin.cliName, installed: d.installed })),
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
      console.log(`  ${c.label} · hooks ${c.hooks ? 'on' : 'off'}`);
    }
  } else {
    const names = connectPlugins()
      .filter((p) => p.connect.autoConnect)
      .map((p) => p.cliName);
    console.log('No AI tools were detected to connect automatically.');
    console.log(
      `  Connect one anytime with \`showtail connect ${names[0] ?? 'claude'}\`.`,
    );
  }
  if (guidance.length > 0) {
    console.log('');
    for (const line of guidance) console.log(line);
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
