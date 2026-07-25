/**
 * `showtail redact` — the recovery path for a secret the write-time scrubber
 * missed.
 *
 * `src/core/redact.ts` runs before anything touches disk, and its own header
 * admits it is a safety net rather than a guarantee. When it misses, the value
 * is in the content-addressed object store for good, and without this command a
 * student's only remedy is deleting `.showtail/` and losing their whole trail.
 * That is far too steep a price for pasting an API key once.
 *
 * Two modes, both driven by the *same* rule engine as capture:
 *   - `--rescan` re-runs the current rule set (including any
 *     `settings.redact.custom` added since) over every stored object, every
 *     `textPreview`, and every materialized plan file;
 *   - `--pattern <regex>` scrubs one specific thing the student knows leaked.
 *
 * Because the store is content-addressed, scrubbing an object changes its
 * address: the cleaned text is written to a new address, the owning journal
 * entry is repointed at it, and the old object — the one holding the secret — is
 * deleted. Rewriting entries means re-chaining the shard, which `mapJournal`
 * does, so the pass leaves an intact chain instead of looking like tampering.
 *
 * That intact chain is exactly why the pass must also announce itself. A
 * re-chained journal is, by construction, indistinguishable from one that was
 * never touched, so the pass records a dated `redaction` marker entry — how many
 * entries it rewrote, how many values it removed, which rule labels fired, and
 * never a removed value or the `--pattern` source. `showtail verify` prints it
 * beside the chain result. The marker is an honest disclosure, not a proof: see
 * the note on {@link redactTrail} for what it does and does not guarantee.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeAuthorPaths, authorSlugs } from '../core/authors.ts';
import { preview } from '../core/events.ts';
import { ensureMachineId } from '../core/identity.ts';
import { makeId } from '../core/ids.ts';
import {
  JOURNAL_ENTRY_VERSION,
  appendJournal,
  mapJournal,
  readJournal,
} from '../core/journal.ts';
import { addressOf, readObject, removeObject, writeObject } from '../core/objects.ts';
import { redactDetailed } from '../core/redact.ts';
import {
  authorPaths,
  readConfig,
  requirePaths,
  type AuthorPaths,
  type ShowtailPaths,
} from '../core/storage.ts';
import type { JournalEntry, RedactConfig, RedactionRecord } from '../types.ts';

/** Which rules an after-the-fact pass runs. */
export type RedactMode = 'rescan' | 'pattern';

export interface RedactCommandOptions {
  cwd?: string;
  /** Re-run the project's current rule set over everything already stored. */
  rescan?: boolean;
  /** Scrub one specific regex the student knows leaked. */
  pattern?: string;
  /** Report what would change and write nothing. Always on unless `--yes`. */
  dryRun?: boolean;
  /** Actually apply a `--pattern` scrub (it is dry-run by default). */
  yes?: boolean;
  json?: boolean;
}

/** What one pass found (dry run) or did (applied). */
export interface RedactPass {
  mode: RedactMode;
  /** True when nothing was written — the report is a preview. */
  dryRun: boolean;
  /** Journal entries whose `refs`/`textPreview` changed. */
  entries: number;
  /** Stored objects rewritten to a new address. */
  objects: number;
  /** Objects nothing referenced that held a hit, and were simply deleted. */
  orphans: number;
  /** Materialized `plans/*.md` files rewritten in place. */
  plans: number;
  /** Total sensitive values removed. */
  values: number;
  /** Rule labels that fired, sorted. Never the values themselves. */
  labels: string[];
  /** Id of the `redaction` marker recorded, when the pass wrote anything. */
  markerId?: string;
}

/** A scrub of one string: the engine in `core/redact.ts`, bound to one mode. */
type Scrub = (text: string) => {
  text: string;
  hits: number;
  byLabel: Record<string, number>;
};

/**
 * Bind the shared rule engine to a mode. `--pattern` runs *only* the given
 * regex (labelled `pattern`), so a student removing one leaked value never
 * triggers an unrelated rule they hadn't asked about; `--rescan` runs whatever
 * `settings.redact` currently says, which is the point — a `custom` pattern
 * added after capture applies retroactively.
 */
function makeScrub(
  mode: RedactMode,
  cfg: RedactConfig | undefined,
  pattern?: string,
): Scrub {
  if (mode === 'pattern') {
    const source = pattern!;
    // Rule categories off: the caller asked for this one thing. The project
    // `allow` list is skipped too — an explicit request outranks it.
    return (text) =>
      redactDetailed(text, { enabled: true, secrets: false, pii: false }, [
        { label: 'pattern', source },
      ]);
  }
  return (text) => redactDetailed(text, cfg);
}

/** Every object address the journals currently point at (`refs` + `diffHash`). */
function referencedObjects(authors: AuthorPaths[]): Set<string> {
  const refs = new Set<string>();
  for (const author of authors) {
    for (const entry of readJournal(author)) {
      for (const ref of [...(entry.refs ?? []), entry.diffHash]) {
        if (ref) refs.add(ref);
      }
    }
  }
  return refs;
}

/** Every address currently on disk in the object store. */
function storedObjects(paths: ShowtailPaths): string[] {
  const out: string[] = [];
  if (!existsSync(paths.objectsDir)) return out;
  for (const shard of readdirSync(paths.objectsDir).sort()) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let names: string[];
    try {
      names = readdirSync(join(paths.objectsDir, shard)).sort();
    } catch {
      continue;
    }
    for (const name of names) out.push(`sha256:${shard}${name}`);
  }
  return out;
}

/** A planned object rewrite: old address in, cleaned text and new address out. */
interface ObjectRewrite {
  newRef: string;
  text: string;
  hits: number;
}

/** Merge one scrub's per-label counts into a running tally. */
function tally(into: Record<string, number>, from: Record<string, number>): void {
  for (const [label, n] of Object.entries(from)) into[label] = (into[label] ?? 0) + n;
}

/**
 * Run one redaction pass over a whole trail.
 *
 * **What the audit marker is worth.** Re-chaining is what keeps a legitimate
 * scrub from reading as tampering — but it is also why the marker cannot be a
 * proof. `checkChain` only verifies that the journal is *internally* consistent,
 * and any local writer can produce a consistent journal: that was already true
 * before this command existed (`import undo` re-chains too). So the marker is a
 * voluntary disclosure that a pass happened, not evidence that every rewrite was
 * one. Crucially, it is never an *excuse*: a marker suppresses nothing, so an
 * edit made by hand — which leaves the following entry's `prev` stale — is still
 * reported as a break whether or not a marker sits next to it. Binding history
 * to a marker would need a signature (a key the student does not hold) or an
 * external witness; neither exists here, and this command does not pretend
 * otherwise.
 */
export function redactTrail(
  paths: ShowtailPaths,
  options: { mode: RedactMode; pattern?: string; dryRun: boolean },
): RedactPass {
  const { mode, dryRun } = options;
  const config = readConfig(paths);
  const scrub = makeScrub(mode, config.settings.redact, options.pattern);
  const authors = authorSlugs(paths).map((slug) => authorPaths(paths, slug));

  // --- Plan every object rewrite before touching anything ------------------
  const referenced = referencedObjects(authors);
  const rewrites = new Map<string, ObjectRewrite>();
  const labels: Record<string, number> = {};
  let values = 0;
  let objects = 0;
  let orphans = 0;
  const orphanRefs: string[] = [];

  for (const ref of storedObjects(paths)) {
    const content = readObject(paths, ref);
    if (content === null) continue;
    const result = scrub(content);
    if (result.hits === 0 || result.text === content) continue;
    tally(labels, result.byLabel);
    values += result.hits;
    if (referenced.has(ref)) {
      rewrites.set(ref, {
        newRef: addressOf(result.text),
        text: result.text,
        hits: result.hits,
      });
      objects += 1;
    } else {
      // Nothing points at it (a past `import undo` leaves objects behind), so
      // there is no entry to repoint — the content just goes.
      orphanRefs.push(ref);
      orphans += 1;
    }
  }

  // --- Plan every journal-entry rewrite ------------------------------------
  // `edit` returns the *same object* when an entry needs nothing, which is how
  // `mapJournal` decides a shard was untouched (and so keeps its chain as-is).
  const previewHits: Record<string, number> = {};
  let previewValues = 0;
  const edit = (entry: JournalEntry): JournalEntry => {
    const next: JournalEntry = { ...entry };
    let touched = false;
    let hits = 0;

    if (entry.refs && entry.refs.length > 0) {
      const refs = entry.refs.map((ref) => rewrites.get(ref)?.newRef ?? ref);
      if (refs.some((ref, i) => ref !== entry.refs![i])) {
        next.refs = refs;
        touched = true;
        for (const ref of entry.refs) hits += rewrites.get(ref)?.hits ?? 0;
      }
      // The preview is derived from the first ref's text, so regenerate it from
      // the cleaned content rather than scrubbing the (truncated) preview.
      const head = rewrites.get(entry.refs[0]!);
      if (head) {
        next.textPreview = preview(head.text);
        next.bytes = Buffer.byteLength(head.text);
      }
    }
    if (entry.diffHash) {
      const rewritten = rewrites.get(entry.diffHash);
      if (rewritten) {
        next.diffHash = rewritten.newRef;
        touched = true;
        hits += rewritten.hits;
      }
    }
    // A preview whose backing object was not rewritten (no refs at all, or the
    // object is gone) is still scrubbed on its own — it is stored text too.
    if (!touched && next.textPreview) {
      const result = scrub(next.textPreview);
      if (result.hits > 0 && result.text !== next.textPreview) {
        next.textPreview = result.text;
        touched = true;
        hits += result.hits;
        tally(previewHits, result.byLabel);
        previewValues += result.hits;
      }
    }
    if (!touched) return entry;
    if (hits > 0) next.redacted = (entry.redacted ?? 0) + hits;
    return next;
  };

  let entries = 0;
  for (const author of authors) {
    if (dryRun) {
      entries += readJournal(author).filter((e) => edit(e) !== e).length;
    } else {
      entries += mapJournal(author, edit);
    }
  }
  tally(labels, previewHits);
  values += previewValues;

  // --- Materialized plan files ---------------------------------------------
  // Plans are saved as plain `plans/<id>.md` for the report to link, redacted at
  // write time like everything else — so a missed secret sits there too.
  let plans = 0;
  const planEdits: { file: string; text: string }[] = [];
  if (existsSync(paths.plansDir)) {
    for (const name of readdirSync(paths.plansDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const file = join(paths.plansDir, name);
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const result = scrub(content);
      if (result.hits === 0 || result.text === content) continue;
      planEdits.push({ file, text: result.text });
      tally(labels, result.byLabel);
      values += result.hits;
      plans += 1;
    }
  }

  const pass: RedactPass = {
    mode,
    dryRun,
    entries,
    objects,
    orphans,
    plans,
    values,
    labels: Object.keys(labels).sort(),
  };
  if (dryRun || values === 0) return pass;

  // --- Apply ----------------------------------------------------------------
  for (const { newRef, text } of rewrites.values()) {
    const written = writeObject(paths, text);
    /* c8 ignore next */
    if (written !== newRef) throw new Error('Object address changed while rewriting.');
  }
  for (const { file, text } of planEdits) writeFileSync(file, text, 'utf8');

  // Drop the objects holding the removed text, but only once nothing points at
  // them any more: the store dedups, so two entries can share one address and
  // the rewrite must land for both before the old one can go.
  const stillReferenced = referencedObjects(authors);
  for (const ref of [...rewrites.keys(), ...orphanRefs]) {
    if (!stillReferenced.has(ref)) removeObject(paths, ref);
  }

  pass.markerId = recordMarker(paths, pass);
  return pass;
}

/**
 * Append the `redaction` audit marker. It goes to the acting author's shard
 * *after* the rewrite, so its `prev` links to the re-chained tail. Returns the
 * marker's id, or undefined when the trail has no author to attribute it to
 * (only reachable on an empty trail, where nothing was scrubbed anyway).
 */
function recordMarker(paths: ShowtailPaths, pass: RedactPass): string | undefined {
  const slug = authorSlugs(paths)[0];
  const author =
    activeAuthorPaths(paths) ??
    (slug ? authorPaths(paths, slug, ensureMachineId()) : null);
  if (!author) return undefined;
  const redaction: RedactionRecord = {
    reason: 'redact',
    mode: pass.mode,
    entries: pass.entries,
    values: pass.values,
    labels: pass.labels,
    objects: pass.objects,
  };
  const marker: JournalEntry = {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'redaction',
    id: makeId('red'),
    ts: new Date().toISOString(),
    type: 'redaction',
    actorSlug: author.slug,
    redaction,
  };
  appendJournal(author, marker);
  return marker.id;
}

/** Human summary lines for one pass (shared by the dry run and the real thing). */
function summaryLines(pass: RedactPass): string[] {
  const out: string[] = [];
  if (pass.values === 0) {
    out.push('Nothing to redact — the current rules find no matches in this trail.');
    return out;
  }
  const verb = pass.dryRun ? 'Would remove' : 'Removed';
  out.push(`${verb} ${pass.values} value(s) matching: ${pass.labels.join(', ')}.`);
  out.push(`  journal entries: ${pass.entries}`);
  out.push(`  stored objects rewritten: ${pass.objects}`);
  if (pass.orphans > 0) out.push(`  unreferenced objects deleted: ${pass.orphans}`);
  if (pass.plans > 0) out.push(`  plan files rewritten: ${pass.plans}`);
  if (pass.dryRun) {
    out.push('');
    out.push('Nothing was written. Re-run with --yes to apply.');
  } else {
    out.push('');
    out.push(
      pass.markerId
        ? `Recorded redaction marker ${pass.markerId} — \`showtail verify\` will report ` +
            'this pass beside the chain result.'
        : 'No author to attribute the pass to, so no marker was recorded.',
    );
  }
  return out;
}

/**
 * CLI entry. Returns true when the pass completed (including a dry run that
 * found nothing); throws with a clear message on bad usage.
 */
export async function runRedact(options: RedactCommandOptions = {}): Promise<boolean> {
  const paths = requirePaths(options.cwd);

  if (options.rescan && options.pattern !== undefined) {
    throw new Error(
      'Choose one: --rescan (re-run the current rules) or --pattern <regex>.',
    );
  }
  if (!options.rescan && options.pattern === undefined) {
    throw new Error(
      'Nothing to do. Use --rescan to re-run the current rules over everything already\n' +
        'stored, or --pattern <regex> to scrub one specific value you know leaked.',
    );
  }

  const mode: RedactMode = options.pattern === undefined ? 'rescan' : 'pattern';
  if (mode === 'pattern') {
    try {
      new RegExp(options.pattern!);
    } catch (err) {
      throw new Error(
        `--pattern is not a valid regular expression: ${(err as Error).message}`,
      );
    }
  }

  // Removing content from a provenance trail must never be a single keystroke:
  // `--pattern` is a preview until `--yes`. `--rescan` only applies rules the
  // project already configured, so it runs unless `--dry-run` is asked for.
  const dryRun = options.dryRun === true || (mode === 'pattern' && options.yes !== true);

  const config = readConfig(paths);
  if (mode === 'rescan' && config.settings.redact?.enabled === false) {
    const message =
      'Redaction is turned off for this project (settings.redact.enabled is false), so ' +
      '--rescan has no rules to run. Turn it on, or use --pattern <regex>.';
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.log(message);
    return false;
  }

  const pass = redactTrail(paths, { mode, pattern: options.pattern, dryRun });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, ...pass }));
    return true;
  }
  console.log(
    pass.dryRun
      ? `Redaction preview (${mode}) — nothing will be written.`
      : `Redaction pass (${mode}).`,
  );
  console.log('');
  for (const line of summaryLines(pass)) console.log(line);
  return true;
}
