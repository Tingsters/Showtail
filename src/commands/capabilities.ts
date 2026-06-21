import { activeAuthorPaths } from '../core/authors.ts';
import { readSessionEvents } from '../core/events.ts';
import { autoInitEnabled, readGlobalConfig } from '../core/globalConfig.ts';
import { emitJson } from '../core/output.ts';
import { currentSession } from '../core/sessions.ts';
import { findRoot, pathsForRoot, readConfig } from '../core/storage.ts';
import { toolStatuses } from '../core/tools.ts';

export interface CapabilitiesOptions {
  json?: boolean;
  cwd?: string;
}

/** What an agent should do next, given the current machine + project state. */
type NextAction = 'run-setup' | 'work' | 'report';

/**
 * A self-describing snapshot for an AI agent: is this folder tracked, is
 * automatic tracking on, what tools are connected, and what to do next. Unlike
 * `status`, this never throws in an untracked folder (it does not call
 * `requirePaths`), so an agent can safely call it anywhere to orient itself.
 */
export async function runCapabilities(options: CapabilitiesOptions = {}): Promise<void> {
  const cwd = options.cwd;
  const root = findRoot(cwd);
  const autoInit = autoInitEnabled();
  const setupCompleted = Boolean(readGlobalConfig().setupCompletedAt);

  let anchorKind: 'git' | 'cwd' | null = null;
  let session: { id: string; events: number } | null = null;
  if (root) {
    const paths = pathsForRoot(root);
    try {
      anchorKind = readConfig(paths).anchorKind ?? null;
    } catch {
      anchorKind = null;
    }
    const author = activeAuthorPaths(paths);
    const current = author ? currentSession(author) : null;
    if (author && current) {
      session = { id: current.id, events: readSessionEvents(author, current.id).length };
    }
  }

  const nextAction: NextAction = !autoInit
    ? 'run-setup'
    : session && session.events > 0
      ? 'report'
      : 'work';

  const payload = {
    initialized: Boolean(root),
    root: root ?? null,
    anchorKind,
    autoInit,
    setupCompleted,
    session,
    tools: toolStatuses(cwd),
    nextAction,
    commands: [
      {
        name: 'showtail ensure --json',
        does: 'initialize + open a session (idempotent)',
      },
      { name: 'showtail status --json', does: 'current session and connected tools' },
      { name: 'showtail report', does: 'generate the show-your-work report' },
      { name: 'showtail setup', does: 'one-time: connect tools + enable auto-tracking' },
    ],
  };

  if (options.json) {
    emitJson(payload);
    return;
  }

  console.log(`initialized: ${payload.initialized}`);
  console.log(`root: ${payload.root ?? '(none)'}`);
  console.log(`autoInit: ${autoInit}  setupCompleted: ${setupCompleted}`);
  console.log(`nextAction: ${nextAction}`);
  console.log('(use --json for the full machine-readable form)');
}
