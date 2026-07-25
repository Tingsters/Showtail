import { existsSync } from 'node:fs';
import { checkArtifactHashes } from '../core/artifacts.ts';
import { authorSlugs } from '../core/authors.ts';
import { eventFromEntry } from '../core/events.ts';
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
import { checkChain, readJournalShards, type JournalShard } from '../core/journal.ts';
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
  const chainCheck: CheckResult = {
    name: 'journal chain is unbroken',
    ok: true,
    details: [],
  };
  let chained = 0;
  let unchained = 0;
  for (const journal of journals) {
    if (journal.error !== undefined) continue; // Already reported by check 2.
    for (const shard of journal.shards) {
      const { breaks, unchained: legacy } = checkChain(shard.entries);
      chained += shard.entries.length - legacy;
      unchained += legacy;
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
      `${chained} chained journal entr${chained === 1 ? 'y' : 'ies'} verified.`,
    );
  }
  if (chainCheck.ok && chained === 0 && unchained === 0) {
    chainCheck.details.push('No journal entries yet.');
  }
  checks.push(chainCheck);

  // 4. Stored content still hashes to the address it is filed under. The object
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

  // 5. File snapshots vs. the working tree. A file that differs from its last
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

  // 6. Portability: no journal entry carries an absolute path. Paths must be
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

  // 7. A report can be generated. This one deliberately re-reads the trail: it
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
