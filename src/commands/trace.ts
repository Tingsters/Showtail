import type { Artifact, EntityChanges, Event } from '../types.ts';
import { readAllArtifacts, recoverEntities } from '../core/artifacts.ts';
import { diffEntitiesDetailed, hasEntityChanges } from '../core/entities.ts';
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

/** Indented, glyph-prefixed `<glyph> <kind> <name> <verb>` lines for the text trace. */
function formatDeltaLines(changes: EntityChanges): string[] {
  const row = (glyph: string, kind: string, name: string, verb: string): string =>
    `      ${glyph} ${kind} ${name} ${verb}`;
  return [
    ...changes.added.map((e) => row('+', e.kind, e.name, 'added')),
    ...changes.changed.map((e) => row('~', e.kind, e.name, 'changed')),
    ...changes.renamed.map((r) => row('~', r.kind, `${r.from} → ${r.to}`, 'renamed')),
    ...changes.removed.map((e) => row('-', e.kind, e.name, 'removed')),
  ];
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
  // Recover entity data (which functions/classes changed) for snapshots whose file is
  // still on disk unchanged, so the delta shows even when live capture missed it.
  await recoverEntities(requirePaths(options.cwd), result.artifacts);

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
      const changes = diffEntitiesDetailed(prevEntities, a.entities);
      if (hasEntityChanges(changes)) {
        for (const line of formatDeltaLines(changes)) console.log(line);
      }
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
