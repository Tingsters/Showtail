import { resolve } from 'node:path';
import { resolveActiveAuthorForHook } from '../core/authors.ts';
import { resolveOrStartSession } from '../core/events.ts';
import { emitJson } from '../core/output.ts';
import { pathsForRoot, readConfig, resolveProjectContext } from '../core/storage.ts';
import { ShowtailError } from '../core/errors.ts';
import { ensureInitialized } from './init.ts';

export interface EnsureOptions {
  cwd?: string;
  json?: boolean;
}

/**
 * Make the current working folder ready to capture, idempotently: find (or
 * create) the trail at the right anchor and make sure a session is open. This is
 * the explicit repair/bootstrap command an integration or power user can call
 * when they intentionally want a trail now. Safe to run repeatedly.
 *
 * Anchoring matches automatic init: an existing trail or strong project boundary
 * is reused; otherwise `cwd` becomes the anchor. HOME and temp are valid when the
 * command is invoked there, and a HOME trail is never inherited by descendants.
 * Identity is resolved silently (cache / git-config, never prompting); if it can't
 * be settled, the trail is still created but no session is opened.
 */
export async function runEnsure(options: EnsureOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = resolveProjectContext({ cwd });
  if (context.state === 'none') {
    throw new ShowtailError(
      `Folder does not exist: ${cwd}`,
      2,
      {
        root: null,
        candidates: [],
      },
      'PATH_NOT_FOUND',
      'choose-existing-path',
    );
  }
  if (context.state === 'ambiguous') {
    throw new ShowtailError(
      'No single project could be selected.',
      2,
      {
        root: null,
        candidates: context.candidates,
      },
      'AMBIGUOUS_PROJECT',
      'review-inbox',
    );
  }
  const root = context.root;

  const { created } = await ensureInitialized(root, {
    ...(context.evidence === 'trail' ? {} : { anchorKind: context.evidence }),
    initialization: { mode: 'ensure', evidence: context.evidence },
  });
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
