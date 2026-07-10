import type { Artifact, EntityDelta, Event } from '../types.ts';
import { readAllArtifacts } from '../core/artifacts.ts';
import { diffEntities, hasEntityChanges } from '../core/entities.ts';
import { readAllEvents } from '../core/events.ts';
import { requirePaths, toRepoRelative } from '../core/storage.ts';
import { emitJson } from '../core/output.ts';

export interface TraceOptions {
  format?: string;
  cwd?: string;
}

interface TraceResult {
  path: string;
  artifacts: Artifact[];
  events: Event[];
}

/** Friendly labels for the trace output. */
const TYPE_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  ai_output: 'AI output',
  artifact: 'Artifact',
};

/** One-line "changed X · added Y · removed Z" for the text trace. */
function formatDelta(delta: EntityDelta): string {
  const seg = (label: string, items: string[]): string =>
    items.length === 0 ? '' : `${label} ${items.join(', ')}`;
  return [
    seg('changed', delta.changed),
    seg('added', delta.added),
    seg('removed', delta.removed),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Collect everything Showtail knows about one file. */
function collectTrace(cwd: string | undefined, file: string): TraceResult {
  const paths = requirePaths(cwd);
  const repoPath = toRepoRelative(paths.root, file);

  // A file may have been touched by several teammates, so trace across all authors.
  const artifacts = readAllArtifacts(paths)
    .filter((a) => a.path === repoPath)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const events = readAllEvents(paths)
    .filter((e) => e.files?.includes(repoPath))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { path: repoPath, artifacts, events };
}

/** Show the known provenance trail for a single file. */
export async function runTrace(file: string, options: TraceOptions): Promise<void> {
  const result = collectTrace(options.cwd, file);

  if (options.format === 'json') {
    emitJson(result);
    return;
  }

  console.log(`Provenance trail for: ${result.path}`);
  console.log('');

  console.log('Artifact history (hashes over time):');
  if (result.artifacts.length === 0) {
    console.log('  (none recorded — try `showtail artifact ' + result.path + '`)');
  } else {
    let prevEntities: Artifact['entities'];
    for (const a of result.artifacts) {
      const commit = a.gitCommit ? `  commit ${a.gitCommit.slice(0, 10)}` : '';
      console.log(`  ${a.timestamp}  ${a.sha256.slice(0, 16)}…${commit}`);
      const delta = diffEntities(prevEntities, a.entities);
      if (hasEntityChanges(delta)) console.log(`      ↳ ${formatDelta(delta)}`);
      prevEntities = a.entities;
    }
  }
  console.log('');

  console.log('Related events:');
  if (result.events.length === 0) {
    console.log('  (none — link a file when you log, e.g. --files ' + result.path + ')');
  } else {
    for (const e of result.events) {
      const label = TYPE_LABELS[e.type] ?? e.type;
      console.log(`  ${e.timestamp}  [${label}] ${e.text}`);
    }
  }
}
