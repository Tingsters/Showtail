/**
 * `showtail inbox` — the unplaced-session tray. Lists the sessions the ledger
 * captured but couldn't route to a project (a scratch IDE workspace, a global
 * tool running in HOME, a zero-edit planning session), plus any whose target
 * trail has since gone missing. On a terminal it doubles as a picker: choose
 * sessions and the repo to place them in, and it reattaches them. Without a TTY
 * (or with `--json`) it just reports, so scripts/agents can drive `reattach`.
 */
import { createInterface } from 'node:readline';
import { emitJson } from '../core/output.ts';
import { oneLine } from '../core/text.ts';
import {
  readLedgerRecords,
  unplacedSessions,
  type LedgerSession,
} from '../core/ledger.ts';
import { parseSelection } from './importClaude.ts';
import { reattachLedgerSession } from './reattach.ts';

type Unplaced = LedgerSession & { targetMissing?: boolean };

/** A friendly "how long ago" label for an ISO timestamp. */
function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/** Prompt/edit counts and the first prompt text for a session's records. */
function summarize(session: Unplaced): {
  prompts: number;
  edits: number;
  firstPrompt?: string;
} {
  let prompts = 0;
  let edits = 0;
  let firstPrompt: string | undefined;
  for (const rec of readLedgerRecords(session.id)) {
    if (rec.kind === 'edit') edits += 1;
    else if (rec.kind === 'prompt') {
      prompts += 1;
      if (!firstPrompt && rec.text) firstPrompt = rec.text;
    }
  }
  return { prompts, edits, firstPrompt };
}

/** Print one session as the numbered block shown in the listing / picker. */
function printSession(session: Unplaced, ordinal: number): void {
  const { prompts, edits, firstPrompt } = summarize(session);
  const meta = [`${prompts} prompt(s)`, `${edits} edit(s)`];
  const flag = session.targetMissing ? '  [target missing]' : '';
  console.log(
    `  ${ordinal}. ${relativeTime(session.lastSeenAt)}    ${meta.join(', ')} · ${session.tool}${flag}`,
  );
  if (firstPrompt) console.log(`     first: ${oneLine(firstPrompt, 100)}`);
  if (session.cwd) console.log(`     cwd:   ${session.cwd}`);
  console.log(`     id: ${session.id}`);
  console.log('');
}

/** Machine-readable shape for `--json`. */
function toJson(session: Unplaced): Record<string, unknown> {
  const { prompts, edits, firstPrompt } = summarize(session);
  return {
    id: session.id,
    tool: session.tool,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd ?? null,
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    status: session.targetMissing ? 'target-missing' : 'inbox',
    prompts,
    edits,
    firstPrompt: firstPrompt ?? null,
  };
}

/** Ask one line on the terminal, returning the trimmed answer or a default. */
function ask(question: string, def: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [${def}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}

/** Interactively pick sessions to place (numbers/ranges, `all`, or q to cancel). */
async function pickSessions(sessions: Unplaced[]): Promise<Unplaced[] | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (
        await new Promise<string>((resolve) => {
          rl.question(`Pick sessions to place [e.g. 1,3 or 'all', q to quit]: `, resolve);
        })
      )
        .trim()
        .toLowerCase();
      if (answer === '' || answer === 'q' || answer === 'quit') return null;
      if (answer === 'all' || answer === '*') return sessions;
      const chosen = parseSelection(answer, sessions.length);
      if (chosen) return chosen.map((i) => sessions[i]!);
      process.stderr.write(
        `  Didn't understand that. Enter numbers between 1 and ${sessions.length} (e.g. 1,3), 'all', or q.\n`,
      );
    }
    return null;
  } finally {
    rl.close();
  }
}

/** CLI entry point for `showtail inbox`. */
export async function runInbox(
  opts: { json?: boolean; cwd?: string } = {},
): Promise<void> {
  const sessions = unplacedSessions();

  if (opts.json) {
    emitJson({ sessions: sessions.map(toJson) });
    return;
  }

  if (sessions.length === 0) {
    console.log('Inbox empty — every captured session is placed in a project.');
    return;
  }

  console.log(`Unplaced sessions (${sessions.length}):`);
  console.log('');
  sessions.forEach((s, i) => printSession(s, i + 1));

  // Non-interactive: just report and show how to place one by id.
  if (!process.stdin.isTTY) {
    console.log('Place one with:  showtail reattach <session-id> --to <path>');
    return;
  }

  const chosen = await pickSessions(sessions);
  if (!chosen || chosen.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }

  const toPath = await ask('Place into which project path?', opts.cwd ?? process.cwd());
  for (const session of chosen) {
    const { root, projected } = await reattachLedgerSession(session, toPath);
    console.log(`  ${session.id} → ${root} — ${projected} record(s) projected.`);
  }
  console.log('');
  console.log('Run `showtail report` there to see them alongside your other work.');
}
