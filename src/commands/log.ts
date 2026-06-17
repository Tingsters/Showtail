import type { Tool } from '../types.ts';
import { logEvent } from '../core/events.ts';
import { eventTypeList, isEventType } from '../core/schema.ts';
import { requirePaths, toRepoRelative } from '../core/storage.ts';

export interface LogOptions {
  type?: string;
  text?: string;
  files?: string;
  tags?: string;
  tool?: string;
  session?: string;
  /** Link this event to a prompt's turn (e.g. an `ai_output` for a prompt). */
  turn?: string;
  cwd?: string;
}

/** Split a comma-separated option value into a clean string array. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read all of stdin as text (used when --text is omitted and input is piped). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Record a single event in the current (or specified) session. */
export async function runLog(options: LogOptions): Promise<void> {
  const type = options.type;
  if (!type || !isEventType(type)) {
    throw new Error(
      `Please pass a valid --type. Supported types: ${eventTypeList()}.\n` +
        `Example: showtail log --type prompt --text "How do I structure this?"`,
    );
  }

  let text = options.text;
  if (text === undefined || text.length === 0) {
    text = await readStdin();
  }
  if (!text || text.length === 0) {
    throw new Error(
      'No text provided. Pass --text "..." or pipe text in via stdin.\n' +
        'Example: showtail log --type reflection --text "I understand the tokenizer now."',
    );
  }

  const paths = requirePaths(options.cwd);

  // Normalize any referenced files to clean repo-relative paths.
  const files = splitList(options.files).map((f) => toRepoRelative(paths.root, f));
  const tags = splitList(options.tags);

  const { event, session } = await logEvent(paths, {
    type,
    text,
    files,
    tags,
    tool: options.tool as Tool | undefined,
    sessionId: options.session,
    turnId: options.turn,
  });

  console.log(`Logged ${event.type} (${event.id}) to session ${session.id}.`);
  if (event.gitCommit) console.log(`  Git commit: ${event.gitCommit.slice(0, 10)}`);
}
