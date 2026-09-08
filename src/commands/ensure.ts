import { resolve } from 'node:path';
import { resolveActiveAuthorForHook } from '../core/authors.ts';
import { resolveOrStartSession } from '../core/events.ts';
import { emitJson } from '../core/output.ts';
import {
  findRoot,
  isHomedirCatchAll,
  pathsForRoot,
  readConfig,
  resolveAnchor,
} from '../core/storage.ts';
import { ensureInitialized } from './init.ts';

export interface EnsureOptions {
  cwd?: string;
  json?: boolean;
}

/**
 * Make the current working folder ready to capture, idempotently: find (or
 * create) the trail at the right anchor and make sure a session is open. This is
 * the single command an agent — or the VS Code extension on first open — can
 * call blindly at the start of a task. Safe to run repeatedly.
 *
 * Anchoring matches automatic init: an existing trail above `cwd` is reused;
 * otherwise the git repo root (or `cwd`) becomes the anchor. Refuses to create a
 * trail directly in HOME, which would turn every subfolder into one shared trail.
 * Identity is resolved silently (cache / git-config, never prompting); if it
 * can't be settled, the trail is still created but no session is opened.
 */
export async function runEnsure(options: EnsureOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());

  if (isHomedirCatchAll(cwd)) {
    if (options.json) {
      emitJson({
        created: false,
        initialized: false,
        reason: 'home-directory',
        nextAction: 'open-project',
      });
    } else {
      console.log('Showtail is ready — open a project folder and start working.');
    }
    return;
  }

  const existing = findRoot(cwd);
  const root = existing ?? (await resolveAnchor(cwd));

  const { created } = await ensureInitialized(root);
  const paths = pathsForRoot(root);
  const author = await resolveActiveAuthorForHook(paths, { cwd });
  const session = author ? resolveOrStartSession(author) : null;
  const config = readConfig(paths);

  if (options.json) {
    emitJson({
      root,
      created,
      initialized: true,
      anchorKind: config.anchorKind ?? null,
      sessionId: session?.id ?? null,
    });
    return;
  }

  console.log(
    created ? `Started a Showtail trail at ${root}.` : `Showtail is ready at ${root}.`,
  );
  if (session) {
    console.log(`Active session: ${session.id}`);
  } else {
    console.log(
      'Set your identity (git config user.email) to open a session, then run again.',
    );
  }
}
