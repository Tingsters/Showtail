/**
 * `showtail ignore` — mark a folder as scratch so its captured sessions never
 * surface in `showtail inbox` (they stay in the ledger, revealed by `--all`).
 *
 * This is the override for a folder that IS a real project (git/marker) but you
 * treat as a sandbox — the default surfacing rule already hides folderless / home /
 * temp / trivial work, so most scratch needs no entry here.
 */
import { resolve } from 'node:path';
import { emitJson } from '../core/output.ts';
import {
  addScratchPath,
  readScratchPaths,
  removeScratchPath,
} from '../core/globalConfig.ts';

/** CLI entry point for `showtail ignore`. */
export async function runIgnore(
  pathArg: string | undefined,
  opts: { remove?: boolean; list?: boolean; json?: boolean; cwd?: string } = {},
): Promise<void> {
  // List when asked, or when given nothing to act on.
  if (opts.list || (!pathArg && !opts.remove)) {
    const paths = readScratchPaths();
    if (opts.json) {
      emitJson({ scratchPaths: paths });
      return;
    }
    if (paths.length === 0) {
      console.log('No ignored folders. `showtail ignore <path>` marks one as scratch.');
      return;
    }
    console.log(
      'Ignored (scratch) folders — their sessions stay out of `showtail inbox`:',
    );
    for (const p of paths) console.log(`  ${p}`);
    return;
  }

  const target = resolve(pathArg ?? opts.cwd ?? process.cwd());

  if (opts.remove) {
    const next = removeScratchPath(target);
    if (opts.json) {
      emitJson({ removed: target, scratchPaths: next });
      return;
    }
    console.log(`No longer ignoring ${target}.`);
    return;
  }

  const next = addScratchPath(target);
  if (opts.json) {
    emitJson({ added: target, scratchPaths: next });
    return;
  }
  console.log(
    `Ignoring ${target} — its sessions won't show in \`showtail inbox\` (see \`--all\`).`,
  );
}
