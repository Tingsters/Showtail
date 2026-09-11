import { connectPlugins, getPlugin } from '../plugins/registry.ts';
import { toolCaptureGloballyDisabled } from './globalConfig.ts';

export type CaptureMode = 'automatic' | 'manual' | 'disconnected';

export interface ToolStatus {
  /** The tool's CLI name (e.g. 'claude', 'codex'). */
  tool: string;
  /** Human-friendly label (e.g. 'Claude Code'). */
  label: string;
  connected: boolean;
  /** Whether auto-capture hooks are active (tools that install hooks). */
  hooksActive?: boolean;
  /** Whether another native integration is actively capturing. */
  captureActive?: boolean;
  /** Whether the managed instructions are behind the latest. */
  updateAvailable?: boolean;
}

/** The capture guidance an agent needs for one requested tool. */
export interface ToolCaptureStatus {
  tool: string;
  mode: CaptureMode;
  connected: boolean;
  hooksActive: boolean;
}

/**
 * Connection state of every tool Showtail can integrate with, from the plugin
 * registry. Shared by `status` and `start`. No tool is named here — each
 * connect plugin reports its own state.
 */
export function toolStatuses(cwd?: string, tool?: string): ToolStatus[] {
  const selected = tool ? getPlugin(tool) : undefined;
  const plugins = connectPlugins().filter((plugin) =>
    tool ? selected?.id === plugin.id : true,
  );
  return plugins.map((plugin) => {
    // Runtime consent is authoritative over stale instructions/hooks that may
    // still exist in another project or an integration we could not uninstall.
    if (toolCaptureGloballyDisabled(plugin.cliName)) {
      return {
        tool: plugin.cliName,
        label: plugin.label,
        connected: false,
        hooksActive: false,
        captureActive: false,
      };
    }
    const state = plugin.connect.status(cwd);
    return {
      tool: plugin.cliName,
      label: plugin.label,
      ...state,
      // Active hooks are a live connection even if an older plugin status probe
      // only found project-scoped instructions and missed a user-scoped install.
      connected:
        state.connected || state.hooksActive === true || state.captureActive === true,
    };
  });
}

/** Resolve agent-facing capture guidance from the selected tool's status. */
export function toolCaptureStatus(
  requestedTool: string,
  tools: ToolStatus[],
): ToolCaptureStatus {
  const plugin = getPlugin(requestedTool);
  const canonical = plugin?.cliName ?? requestedTool;
  const status = tools.find((candidate) => candidate.tool === canonical);
  const automatic = status?.hooksActive === true || status?.captureActive === true;
  if (!status || (!status.connected && !automatic)) {
    return {
      tool: canonical,
      mode: 'disconnected',
      connected: false,
      hooksActive: false,
    };
  }
  const base = {
    tool: canonical,
    connected: true,
    hooksActive: status.hooksActive === true,
  };
  return { ...base, mode: automatic ? 'automatic' : 'manual' };
}

/** One-line state label for a tool, e.g. `connected · hooks active`. */
export function describeToolState(t: ToolStatus): string {
  if (!t.connected) return 'not connected';
  if (t.captureActive) return 'connected · capture active';
  if (t.hooksActive) return 'connected · hooks active';
  if (t.hooksActive === false) return 'connected · no hooks';
  return 'connected';
}

/** The indented `  claude   <state>` lines printed under a "Connected tools" heading. */
export function connectedToolsLines(tools: ToolStatus[]): string[] {
  return tools.map((t) => `  ${t.tool.padEnd(8)} ${describeToolState(t)}`);
}
