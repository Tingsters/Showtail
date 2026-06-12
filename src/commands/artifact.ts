import { addArtifact } from '../core/artifacts.ts';
import { logEvent, resolveOrStartSession } from '../core/events.ts';
import { requirePaths } from '../core/storage.ts';

export interface ArtifactAddOptions {
  session?: string;
  /** Comma-separated related event ids. */
  events?: string;
  cwd?: string;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Record an artifact: hash the file, capture git/commit metadata, and also
 * drop an `artifact` event into the session so it shows up on the timeline.
 */
export async function runArtifactAdd(
  file: string,
  options: ArtifactAddOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);

  // Make sure there is a session to attach the timeline event to.
  const session = resolveOrStartSession(paths, options.session);
  const eventIds = splitList(options.events);

  const artifact = await addArtifact(paths, {
    filePath: file,
    sessionId: session.id,
    eventIds,
  });

  // Add a matching timeline event referencing the file.
  await logEvent(paths, {
    type: 'artifact',
    text: `Recorded artifact ${artifact.path} (sha256 ${artifact.sha256.slice(0, 10)})`,
    files: [artifact.path],
    sessionId: session.id,
  });

  console.log(`Recorded artifact: ${artifact.path}`);
  console.log(`  sha256: ${artifact.sha256}`);
  console.log(`  when:   ${artifact.timestamp}`);
  if (artifact.gitCommit) console.log(`  commit: ${artifact.gitCommit}`);
  console.log(`  session: ${session.id}`);
}
