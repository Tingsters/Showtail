import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { checkArtifactHashes } from '../core/artifacts.ts';
import { authorSlugs } from '../core/authors.ts';
import { eventFromEntry } from '../core/events.ts';
import {
  fileHistoryNumstat,
  gitToplevel,
  isShallowClone,
  uncommittedNumstat,
} from '../core/git.ts';
import { buildReportData, renderMarkdown } from '../core/report.ts';
import { validateEvent } from '../core/schema.ts';
import { checkObjects, objectExists } from '../core/objects.ts';
import {
  authorPaths,
  readConfig,
  requirePaths,
  trailIsNewerThanBinary,
  type ShowtailPaths,
} from '../core/storage.ts';
import {
  checkChain,
  journalSegmentPaths,
  readJournalShards,
  type JournalShard,
} from '../core/journal.ts';
import type { JournalEntry } from '../types.ts';

export interface VerifyOptions {
  cwd?: string;
  /** Print the structured result as JSON instead of the human summary. */
  json?: boolean;
}

interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
  /**
   * Set when the check could not actually examine anything, to a short stable
   * slug naming why (`no-git`, `shallow-clone`, `not-committed`, …).
   *
   * Such a check reports `ok: true` — it found nothing wrong, and a student
   * working without git must not be told their trail failed. But "nothing to
   * check" is not "checked and fine", and the human-facing `details` say so in
   * words that `--json` consumers are explicitly told not to parse. Without a
   * field like this, anyone building on `verify --json` sees a green check that
   * verified nothing and cannot tell the difference. Branch on this, not on text.
   */
  skipped?: string;
}

/**
 * Whether a recorded path is absolute (and therefore not portable). Checks both
 * POSIX (`/x`, `\\unc`) and Windows-drive (`C:\x`) forms regardless of the host
 * platform, since a trail may have been written on either and is checked on the
 * other. A repo-relative path — including a cross-root `../other/x` — is fine.
 */
function isAbsoluteRecordedPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p);
}

export interface VerifyResult {
  ok: boolean;
  checks: CheckResult[];
}

/** One author's journal, read once and shared by every check that needs it. */
interface AuthorJournal {
  slug: string;
  /** Per machine shard — the unit the hash chain covers. */
  shards: JournalShard[];
  /** Every entry, flattened, in the same order {@link readJournal} yields. */
  entries: JournalEntry[];
  /** Set when the journal couldn't be read at all (e.g. a torn JSON line). */
  error?: string;
}

/**
 * Read every author's journal exactly once. Segments can be 8 MB, so the checks
 * below share this instead of re-reading per check. A read failure is captured
 * per author rather than thrown, so one corrupt trail still gets a full report.
 */
function readJournals(paths: ShowtailPaths): AuthorJournal[] {
  const out: AuthorJournal[] = [];
  for (const slug of authorSlugs(paths)) {
    try {
      const shards = readJournalShards(authorPaths(paths, slug));
      out.push({ slug, shards, entries: shards.flatMap((s) => s.entries) });
    } catch (err) {
      out.push({ slug, shards: [], entries: [], error: (err as Error).message });
    }
  }
  return out;
}

// --- The git anchor -------------------------------------------------------

/** `realpathSync`, falling back to the input when it cannot be resolved. */
function realPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Absolute path → repo-root-relative with posix separators (git's spelling).
 * Both sides are resolved through symlinks first: `git rev-parse --show-toplevel`
 * always reports the physical path, and on macOS the trail's own path routinely
 * is not one (`/var/folders/…` → `/private/var/folders/…`). Comparing the two
 * spellings unresolved would make every such trail look like it sits outside its
 * own repository.
 */
function repoRelative(repoRoot: string, target: string): string {
  return relative(realPath(repoRoot), realPath(target)).split(sep).join('/');
}

/**
 * Whether a repo-relative path is a journal file. Used to narrow a diff taken
 * over the whole `.showtail/` tree down to the journal: only the journal is
 * append-only. `sessions/`, `state.json` and the rest are rewritten in normal
 * use, and counting their line removals would fail every honest trail.
 */
function isJournalPath(path: string): boolean {
  return /(^|\/)authors\/[^/]+\/journal\//.test(path);
}

/** One rewrite of already-recorded journal lines, as git saw it. */
interface JournalRewrite {
  /** Short commit SHA, or a phrase for a rewrite that isn't committed yet. */
  where: string;
  /** When it was committed (git's committer date), or "uncommitted". */
  when: string;
  removed: number;
  added: number;
  /** Repo-relative journal paths the rewrite touched. */
  paths: string[];
}

/** One-line description of a marker the trail uses to declare a rewrite. */
function describeMarker(entry: JournalEntry): string {
  const r = entry.redaction;
  if (r?.reason === 'import-undo') {
    return `import undo at ${entry.ts} (${r.entries} entr${r.entries === 1 ? 'y' : 'ies'} removed)`;
  }
  return (
    `redaction pass at ${entry.ts} (${r?.mode ?? 'unknown'}: ` +
    `${r?.entries ?? 0} entr${r?.entries === 1 ? 'y' : 'ies'} rewritten)`
  );
}

/**
 * Check the journal against git — the only anchor Showtail has *outside* the
 * folder it is trying to vouch for.
 *
 * The chain check above can only prove the journal is internally consistent,
 * and anything that can write the folder can produce a consistent journal: edit
 * a line, re-chain everything after it, and the chain is intact again. What that
 * rewrite cannot do is escape git. A journal segment is append-only by
 * construction, so across its whole history every commit that touches it should
 * add lines and remove none. A re-chain rewrites every line after the edit —
 * git counts those as removals, and the rewrite is loud.
 *
 * Everything here degrades to information, never a failure, when there is no
 * anchor to read: no git, not a repo, trail not committed. Showtail is designed
 * to work without git and must keep doing so. The one thing it must not do is
 * report "verified" when it checked nothing — a shallow clone has no history to
 * read, and says exactly that instead of passing quietly.
 */
async function checkJournalHistory(
  paths: ShowtailPaths,
  journals: AuthorJournal[],
): Promise<CheckResult> {
  const check: CheckResult = {
    name: 'journal history is append-only (git)',
    ok: true,
    details: [],
  };

  const toplevel = await gitToplevel(paths.root);
  if (toplevel === undefined) {
    check.details.push(
      'Not a git repository (or git is not installed), so there is no record outside ' +
        '`.showtail/` to hold the journal against — nothing to check here, and not a ' +
        'problem. Note what that costs: the checks above prove the trail is internally ' +
        'consistent, not that it was never rewritten. Committing `.showtail/` as you ' +
        'work, and pushing it, is what gives it an anchor.',
    );
    check.skipped = 'no-git';
    return check;
  }
  const repoRoot = resolve(toplevel);

  const segments = journals.flatMap((journal) =>
    journalSegmentPaths(authorPaths(paths, journal.slug)),
  );
  if (segments.length === 0) {
    check.details.push('No journal segments yet — nothing to check.');
    check.skipped = 'no-journal';
    return check;
  }

  const base = repoRelative(repoRoot, paths.base);
  if (base.startsWith('..')) {
    check.details.push(
      `The trail lives outside the git repository at ${repoRoot}, so its history is ` +
        'not recorded there — nothing to check.',
    );
    check.skipped = 'trail-outside-repo';
    return check;
  }

  if (await isShallowClone(repoRoot)) {
    check.details.push(
      'NOT VERIFIED: this is a shallow clone, so almost none of the repository’s ' +
        'history is present and a rewritten journal would leave no trace in what is. ' +
        'This check was skipped rather than passed. Check out the full history — in ' +
        'GitHub Actions, `fetch-depth: 0` on actions/checkout — and verify again.',
    );
    check.skipped = 'shallow-clone';
    return check;
  }

  // One query over the whole `.showtail/` tree, filtered to journal paths: a
  // segment file that was *deleted* is then still seen, which asking about the
  // files that exist today never would.
  const revisions = await fileHistoryNumstat(repoRoot, base, isJournalPath);
  if (revisions.length === 0) {
    check.details.push(
      `The journal is not committed to git yet (${segments.length} segment file(s) on ` +
        'disk), so there is no history to check it against. Commit `.showtail/` — a ' +
        'file that only ever grows, whose every revision is in git, is what makes a ' +
        'later rewrite visible from outside the folder.',
    );
    check.skipped = 'not-committed';
    return check;
  }
  const pending = await uncommittedNumstat(repoRoot, base, isJournalPath);

  if (revisions.some((rev) => rev.binary) || pending.binary) {
    check.details.push(
      'NOT VERIFIED: git treats the journal as a binary file (a `.gitattributes` rule, ' +
        'most likely), so it reports no line counts and an added line cannot be told ' +
        'from a removed one. This check was skipped rather than passed. Let the journal ' +
        'be diffed as text and verify again.',
    );
    check.skipped = 'journal-not-text';
    return check;
  }

  const rewrites: JournalRewrite[] = revisions
    .filter((rev) => rev.deleted > 0)
    .map((rev) => ({
      where: rev.commit.slice(0, 10),
      when: rev.date,
      removed: rev.deleted,
      added: rev.added,
      paths: rev.paths,
    }));
  if (pending.deleted > 0) {
    // Caught before it is ever committed — the same rewrite, one step earlier.
    rewrites.push({
      where: 'uncommitted',
      when: 'in the working tree right now',
      removed: pending.deleted,
      added: pending.added,
      paths: pending.paths,
    });
  }

  const addedLines = revisions.reduce((n, rev) => n + rev.added, 0);
  if (rewrites.length === 0) {
    check.details.push(
      `Append-only across ${revisions.length} commit(s): ${addedLines} journal line(s) ` +
        'added, none removed or changed.',
    );
    return check;
  }

  // Reconcile against what the trail says it did to itself. `showtail redact`
  // and `showtail import undo` legitimately rewrite lines, and each records a
  // dated marker; one marker accounts for one rewrite, oldest first, so the
  // rewrites left over are the ones nothing declares.
  const declared = journals
    .flatMap((journal) => journal.entries.filter((e) => e.kind === 'redaction'))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  check.details.push(
    `git history shows ${rewrites.length} rewrite(s) of already-recorded journal ` +
      'lines (the journal only ever grows, so a revision that removes or changes ' +
      'lines rewrote history):',
  );
  const unexplained: JournalRewrite[] = [];
  let next = 0;
  for (const rewrite of rewrites) {
    const marker = declared[next];
    if (marker) next += 1;
    else unexplained.push(rewrite);
    check.details.push(
      `  ${rewrite.where}  ${rewrite.when} — ${rewrite.removed} line(s) removed, ` +
        `${rewrite.added} added (${rewrite.paths.join(', ')})` +
        (marker ? ` — declared: ${describeMarker(marker)}` : ' — UNEXPLAINED'),
    );
  }

  if (unexplained.length === 0) {
    check.details.push(
      `Each is accounted for by a rewrite the trail declares (${declared.length} ` +
        'marker(s)) — history was rewritten on purpose, and said so.',
    );
    return check;
  }

  check.ok = false;
  check.details.push(
    `${unexplained.length} of ${rewrites.length} rewrite(s) unexplained: the trail ` +
      `declares ${declared.length} deliberate rewrite(s) (\`showtail redact\`, ` +
      '`showtail import undo`), which does not account for them.',
  );
  check.details.push(
    'This says the recorded history was rewritten, not that anyone cheated. A ' +
      'hand-edit, a merge resolved by editing the journal, or a tool that reformatted ' +
      'the file all look like this. The commits above are where to ask.',
  );
  return check;
}

/**
 * Run all integrity checks against a project and return a structured result.
 * Pure-ish: it reads the project but prints nothing, so it is easy to test.
 *
 * What "integrity" means here is worth stating, because it is easy to get
 * backwards: the trail must be provably *unmodified*, while the student's own
 * code is expected to keep changing. So editing a recorded journal line, or the
 * stored text of a prompt, is a failure — but editing a source file after its
 * last snapshot is normal work and only ever reported as information.
 */
export async function verifyProject(paths: ShowtailPaths): Promise<VerifyResult> {
  const checks: CheckResult[] = [];
  const journals = readJournals(paths);

  // 1. config.json exists and parses.
  const configCheck: CheckResult = {
    name: 'config.json is present and valid',
    ok: false,
    details: [],
  };
  if (!existsSync(paths.config)) {
    configCheck.details.push('config.json is missing — run `showtail init`.');
  } else {
    try {
      readConfig(paths);
      configCheck.ok = true;
    } catch (err) {
      configCheck.details.push(
        `config.json could not be parsed: ${(err as Error).message}`,
      );
    }
  }
  checks.push(configCheck);

  // 2. Every journal entry parses and reconstructs into a valid event.
  const eventsCheck: CheckResult = {
    name: 'journal entries are valid',
    ok: true,
    details: [],
  };
  for (const journal of journals) {
    if (journal.error !== undefined) {
      eventsCheck.ok = false;
      eventsCheck.details.push(`journal could not be read: ${journal.error}`);
      continue;
    }
    let i = 0;
    for (const entry of journal.entries) {
      i += 1;
      if (entry.kind === 'redaction') {
        // An audit marker left by `showtail redact`, not an event: it has no
        // text to reconstruct, only the counts check 3 reports.
        const record = entry.redaction;
        if (
          !record ||
          typeof record.entries !== 'number' ||
          !Array.isArray(record.labels)
        ) {
          eventsCheck.ok = false;
          eventsCheck.details.push(
            `${journal.slug} entry ${i} (${entry.id}): redaction marker is malformed.`,
          );
        }
        continue;
      }
      if (entry.kind === 'artifact') {
        if (!entry.path || !entry.sha256) {
          eventsCheck.ok = false;
          eventsCheck.details.push(
            `${journal.slug} entry ${i} (${entry.id}): artifact missing path/sha256.`,
          );
        }
        continue;
      }
      const issues = validateEvent(eventFromEntry(paths, entry, journal.slug));
      if (issues.length > 0) {
        eventsCheck.ok = false;
        const summary = issues.map((x) => `${x.field}: ${x.message}`).join('; ');
        eventsCheck.details.push(`${journal.slug} entry ${i} (${entry.id}): ${summary}`);
      }
    }
  }
  if (eventsCheck.ok && eventsCheck.details.length === 0) {
    eventsCheck.details.push('All journal entries parsed and reconstructed correctly.');
  }
  checks.push(eventsCheck);

  // 3. The journal's hash chain is unbroken: every entry still commits to the one
  //    before it, so a line that was edited, deleted, or spliced in shows up here.
  //
  //    A recorded `showtail redact` pass is reported *alongside* this result, not
  //    instead of it. Such a pass re-chains what it rewrites, so it never produces
  //    a break in the first place — which is exactly why it has to announce
  //    itself, and equally why a marker must never excuse one. A break sitting
  //    next to a marker is still a break: the marker is a disclosure that history
  //    was rewritten on purpose, not a licence for any particular rewrite.
  const chainCheck: CheckResult = {
    name: 'journal chain is unbroken',
    ok: true,
    details: [],
  };
  let chained = 0;
  let unchained = 0;
  const passes: JournalEntry[] = [];
  const undos: JournalEntry[] = [];
  for (const journal of journals) {
    if (journal.error !== undefined) continue; // Already reported by check 2.
    for (const shard of journal.shards) {
      const { breaks, unchained: legacy } = checkChain(shard.entries);
      chained += shard.entries.length - legacy;
      unchained += legacy;
      for (const entry of shard.entries) {
        if (entry.kind !== 'redaction') continue;
        if (entry.redaction?.reason === 'import-undo') undos.push(entry);
        else passes.push(entry);
      }
      for (const b of breaks) {
        chainCheck.ok = false;
        chainCheck.details.push(
          `${journal.slug}/${shard.machineId} entry ${b.index} (${b.id}): ` +
            'the entry before it does not match this entry’s recorded link ' +
            '— the journal was edited after it was written.',
        );
      }
    }
  }
  if (unchained > 0) {
    // Informational, never a failure: a trail written before chaining existed is
    // simply not chained, and there is nothing the student could have done.
    chainCheck.details.push(
      `${unchained} entr${unchained === 1 ? 'y is' : 'ies are'} unchained ` +
        '(written by an older Showtail) — nothing to check, not a problem.',
    );
  }
  if (chainCheck.ok && chained > 0) {
    chainCheck.details.push(
      `chain intact; ${chained} chained journal entr${chained === 1 ? 'y' : 'ies'} verified.`,
    );
  }
  if (chainCheck.ok && chained === 0 && unchained === 0) {
    chainCheck.details.push('No journal entries yet.');
  }
  if (passes.length > 0) {
    chainCheck.details.push(
      `${passes.length} recorded redaction pass${passes.length === 1 ? '' : 'es'} ` +
        '(`showtail redact` removed stored content on purpose and re-linked the chain):',
    );
    for (const entry of passes) {
      const r = entry.redaction;
      chainCheck.details.push(
        `  ${entry.ts} — ${r?.mode ?? 'unknown'}: ${r?.entries ?? 0} entr` +
          `${r?.entries === 1 ? 'y' : 'ies'} rewritten, ${r?.values ?? 0} value(s) removed` +
          `${r?.labels?.length ? ` (${r.labels.join(', ')})` : ''}.`,
      );
    }
    if (!chainCheck.ok) {
      // Said plainly, because the marker is the one thing that could be mistaken
      // for a licence to rewrite: a pass re-chains, so it cannot cause a break.
      chainCheck.details.push(
        '  A recorded pass re-links the chain, so it never causes a break — ' +
          'the break(s) above are unexplained.',
      );
    }
  }
  if (undos.length > 0) {
    // The other declared rewrite: `showtail import undo` drops a batch and
    // re-chains, so like a redaction pass it leaves no break and has to say so.
    chainCheck.details.push(
      `${undos.length} recorded import undo${undos.length === 1 ? '' : 's'} ` +
        '(`showtail import undo` removed an imported batch and re-linked the chain):',
    );
    for (const entry of undos) {
      const r = entry.redaction;
      chainCheck.details.push(
        `  ${entry.ts} — ${r?.entries ?? 0} entr${r?.entries === 1 ? 'y' : 'ies'} removed` +
          `${r?.batch ? ` (batch ${r.batch})` : ''}.`,
      );
    }
  }
  checks.push(chainCheck);

  // 4. The journal's history in git is append-only. Placed right after the chain
  //    so the two read together: the chain proves the journal is *internally*
  //    consistent, and this proves nobody quietly made it so. Informational
  //    whenever there is no git history to read (see checkJournalHistory).
  checks.push(await checkJournalHistory(paths, journals));

  // 5. Stored content still hashes to the address it is filed under. The object
  //    store holds the prompt and AI-response *text*, so this is what catches an
  //    invented prompt — something the artifact check structurally cannot see.
  const objectCheck: CheckResult = {
    name: 'stored content matches its address',
    ok: true,
    details: [],
  };
  try {
    const results = checkObjects(paths);
    for (const r of results) {
      if (r.status === 'mismatch') {
        objectCheck.ok = false;
        objectCheck.details.push(
          `tampered ${r.ref} (stored content no longer hashes to its address).`,
        );
      } else if (r.status === 'missing') {
        objectCheck.ok = false;
        objectCheck.details.push(
          `unreadable ${r.ref} (stored object could not be read).`,
        );
      }
    }
    // An object the journal points at but that is no longer in the store: the
    // other half of the same tamper (delete the text instead of editing it).
    const seen = new Set<string>();
    for (const journal of journals) {
      for (const entry of journal.entries) {
        for (const ref of [...(entry.refs ?? []), entry.diffHash]) {
          if (!ref || seen.has(ref)) continue;
          seen.add(ref);
          if (!objectExists(paths, ref)) {
            objectCheck.ok = false;
            objectCheck.details.push(
              `missing ${ref} (referenced by ${journal.slug} entry ${entry.id} ` +
                'but not in the object store).',
            );
          }
        }
      }
    }
    if (objectCheck.ok) {
      objectCheck.details.push(
        results.length === 0
          ? 'No stored content yet.'
          : `All ${results.length} stored object(s) match their address.`,
      );
    }
  } catch (err) {
    objectCheck.ok = false;
    objectCheck.details.push(
      `Stored content could not be checked: ${(err as Error).message}`,
    );
  }
  checks.push(objectCheck);

  // 6. File snapshots vs. the working tree. A file that differs from its last
  //    snapshot is NOT a failure — it is what "kept working on it" looks like,
  //    and failing there would punish exactly the behavior the tool encourages.
  //    Only an unreadable trail fails here; a vanished file is a warning.
  const snapshotCheck: CheckResult = {
    name: 'file snapshots are accounted for',
    ok: true,
    details: [],
  };
  try {
    const results = await checkArtifactHashes(paths);
    if (results.length === 0) {
      snapshotCheck.details.push('No artifacts recorded yet.');
    }
    let edited = 0;
    let missing = 0;
    for (const r of results) {
      if (r.status === 'match') {
        snapshotCheck.details.push(`ok      ${r.path}`);
      } else if (r.status === 'changed') {
        edited += 1;
        snapshotCheck.details.push(`edited  ${r.path}`);
      } else {
        missing += 1;
        snapshotCheck.details.push(
          `missing ${r.path} (recorded file is no longer on disk)`,
        );
      }
    }
    if (edited > 0) {
      snapshotCheck.details.push(
        `${edited} file(s) edited since their last snapshot — expected if you kept working.`,
      );
    }
    if (missing > 0) {
      snapshotCheck.details.push(
        `warning: ${missing} recorded file(s) are no longer on disk (moved or deleted?).`,
      );
    }
  } catch (err) {
    snapshotCheck.ok = false;
    snapshotCheck.details.push(
      `Could not check file snapshots: ${(err as Error).message}`,
    );
  }
  checks.push(snapshotCheck);

  // 7. Portability: no journal entry carries an absolute path. Paths must be
  //    repo-relative so a trail is portable across machines — and a projection
  //    from the ledger (whose records hold absolute paths) must re-relativize.
  const pathCheck: CheckResult = {
    name: 'recorded paths are repo-relative (portable)',
    ok: true,
    details: [],
  };
  for (const journal of journals) {
    if (journal.error !== undefined) {
      pathCheck.ok = false;
      pathCheck.details.push(`paths could not be checked: ${journal.error}`);
      continue;
    }
    let i = 0;
    for (const entry of journal.entries) {
      i += 1;
      const bad: string[] = [];
      if (entry.path && isAbsoluteRecordedPath(entry.path)) bad.push(entry.path);
      for (const f of entry.files ?? []) {
        if (isAbsoluteRecordedPath(f)) bad.push(f);
      }
      if (bad.length > 0) {
        pathCheck.ok = false;
        pathCheck.details.push(
          `${journal.slug} entry ${i} (${entry.id}): absolute path(s): ${bad.join(', ')}`,
        );
      }
    }
  }
  if (pathCheck.ok && pathCheck.details.length === 0) {
    pathCheck.details.push('All recorded paths are repo-relative.');
  }
  checks.push(pathCheck);

  // 8. A report can be generated. This one deliberately re-reads the trail: it
  //    exercises the real report path end to end, which is the whole point.
  const reportCheck: CheckResult = {
    name: 'a report can be generated',
    ok: false,
    details: [],
  };
  try {
    const data = buildReportData(paths);
    renderMarkdown(data);
    reportCheck.ok = true;
    reportCheck.details.push('Report generated successfully (not written to disk).');
  } catch (err) {
    reportCheck.details.push(`Report generation failed: ${(err as Error).message}`);
  }
  checks.push(reportCheck);

  return { ok: checks.every((c) => c.ok), checks };
}

/** CLI entry: verify the project and print a clear pass/fail summary. */
export async function runVerify(options: VerifyOptions = {}): Promise<boolean> {
  const paths = requirePaths(options.cwd);
  const result = await verifyProject(paths);

  if (options.json) {
    // Stable machine-readable shape: { ok, checks: [{ name, ok, details }] }.
    console.log(JSON.stringify(result));
    return result.ok;
  }

  console.log('Showtail verification');
  console.log('');
  if (trailIsNewerThanBinary(paths)) {
    console.log(
      'Note: this trail was written by a newer Showtail — some sessions may not be ' +
        'visible to this version. Upgrade Showtail to read everything.',
    );
    console.log('');
  }
  for (const check of result.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`);
    for (const detail of check.details) {
      console.log(`        ${detail}`);
    }
  }
  console.log('');
  console.log(result.ok ? 'All checks passed.' : 'Some checks failed (see above).');
  return result.ok;
}
