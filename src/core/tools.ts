import { existsSync } from 'node:fs';
import { autoCaptureActive, resolveTarget } from './skill.ts';
import { copilotState, resolveCopilotTarget } from './copilot.ts';
import {
  codexAutoCaptureActive,
  codexInstructionsState,
  resolveCodexTarget,
} from './codex.ts';

export interface ToolStatus {
  tool: 'claude' | 'copilot' | 'codex';
  connected: boolean;
  /** Whether auto-capture hooks are active (claude, codex). */
  hooksActive?: boolean;
  /** Whether the managed instructions are behind the latest (copilot, codex). */
  updateAvailable?: boolean;
}

/** Is the Showtail Claude Code skill installed at either scope? */
function skillInstalled(cwd?: string): boolean {
  return (
    existsSync(resolveTarget('project', cwd).skillFile) ||
    existsSync(resolveTarget('user', cwd).skillFile)
  );
}

/** Connection state of every tool Showtail can integrate with. Shared by `status` and `start`. */
export function toolStatuses(cwd?: string): ToolStatus[] {
  const claudeHooks = autoCaptureActive(cwd);
  const copilot = copilotState(resolveCopilotTarget(cwd));
  const codex = codexInstructionsState(resolveCodexTarget('project', cwd));
  return [
    {
      tool: 'claude',
      connected: skillInstalled(cwd) || claudeHooks,
      hooksActive: claudeHooks,
    },
    {
      tool: 'copilot',
      connected: copilot.installed,
      updateAvailable: copilot.installed ? copilot.updateAvailable : undefined,
    },
    {
      tool: 'codex',
      connected: codex.installed,
      hooksActive: codexAutoCaptureActive(cwd),
      updateAvailable: codex.installed ? codex.updateAvailable : undefined,
    },
  ];
}

/** One-line state label for a tool, e.g. `connected · hooks active`. */
export function describeToolState(t: ToolStatus): string {
  if (!t.connected) return 'not connected';
  if (t.hooksActive) return 'connected · hooks active';
  if (t.hooksActive === false) return 'connected · no hooks';
  return 'connected';
}

/** The indented `  claude   <state>` lines printed under a "Connected tools" heading. */
export function connectedToolsLines(tools: ToolStatus[]): string[] {
  return tools.map((t) => `  ${t.tool.padEnd(8)} ${describeToolState(t)}`);
}
