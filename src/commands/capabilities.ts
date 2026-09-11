import { emitJson } from '../core/output.ts';
import { buildStatusSnapshot } from './status.ts';

export interface CapabilitiesOptions {
  json?: boolean;
  cwd?: string;
  tool?: string;
}

/**
 * A self-describing agent probe backed by the exact same read-only snapshot as
 * `status`, so the two commands cannot disagree about project or capture state.
 */
export async function runCapabilities(options: CapabilitiesOptions = {}): Promise<void> {
  const snapshot = buildStatusSnapshot(options);
  const payload = {
    ...snapshot,
    commands: [
      { name: 'showtail status --json', does: 'project, capture, and tool state' },
      {
        name: 'showtail report [path]',
        does: 'place captured work and generate a report',
      },
      { name: 'showtail setup', does: 'one-time: connect tools + enable auto-tracking' },
    ],
  };

  if (options.json) {
    emitJson(payload);
    return;
  }

  console.log(`initialized: ${payload.initialized}`);
  console.log(`root: ${payload.root ?? '(none)'}`);
  if (payload.candidateRoot) {
    console.log(`candidate: ${payload.candidateRoot} (${payload.evidence})`);
  }
  console.log(`autoInit: ${payload.autoInit}  setupCompleted: ${payload.setupCompleted}`);
  if (payload.capture) console.log(`capture: ${payload.capture.mode}`);
  console.log(`nextAction: ${payload.nextAction}`);
  console.log('(use --json for the full machine-readable form)');
}
