import { existsSync } from 'node:fs';
import { checkArtifactHashes } from '../core/artifacts.ts';
import { authorSlugs } from '../core/authors.ts';
import { eventFromEntry } from '../core/events.ts';
import { buildReportData, renderMarkdown } from '../core/report.ts';
import { validateEvent } from '../core/schema.ts';
import {
  authorPaths,
  readConfig,
  requirePaths,
  trailIsNewerThanBinary,
  type ShowtailPaths,
} from '../core/storage.ts';
import { readJournal } from '../core/journal.ts';

export interface VerifyOptions {
  cwd?: string;
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

/**
 * Run all integrity checks against a project and return a structured result.
 * Pure-ish: it reads the project but prints nothing, so it is easy to test.
 */
export async function verifyProject(paths: ShowtailPaths): Promise<VerifyResult> {
  const checks: CheckResult[] = [];

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
  try {
    let i = 0;
    for (const slug of authorSlugs(paths)) {
      const author = authorPaths(paths, slug);
      for (const entry of readJournal(author)) {
        i += 1;
        if (entry.kind === 'artifact') {
          if (!entry.path || !entry.sha256) {
            eventsCheck.ok = false;
            eventsCheck.details.push(
              `${slug} entry ${i} (${entry.id}): artifact missing path/sha256.`,
            );
          }
          continue;
        }
        const issues = validateEvent(eventFromEntry(paths, entry, slug));
        if (issues.length > 0) {
          eventsCheck.ok = false;
          const summary = issues.map((x) => `${x.field}: ${x.message}`).join('; ');
          eventsCheck.details.push(`${slug} entry ${i} (${entry.id}): ${summary}`);
        }
      }
    }
  } catch (err) {
    eventsCheck.ok = false;
    eventsCheck.details.push(`journal could not be read: ${(err as Error).message}`);
  }
  if (eventsCheck.ok && eventsCheck.details.length === 0) {
    eventsCheck.details.push('All journal entries parsed and reconstructed correctly.');
  }
  checks.push(eventsCheck);

  // 3. Artifact hashes match the files currently on disk.
  const hashCheck: CheckResult = {
    name: 'artifact hashes match current files',
    ok: true,
    details: [],
  };
  try {
    const results = await checkArtifactHashes(paths);
    if (results.length === 0) {
      hashCheck.details.push('No artifacts recorded yet.');
    }
    for (const r of results) {
      if (r.status === 'match') {
        hashCheck.details.push(`ok      ${r.path}`);
      } else if (r.status === 'changed') {
        hashCheck.ok = false;
        hashCheck.details.push(
          `changed ${r.path} (file differs from the recorded snapshot)`,
        );
      } else {
        hashCheck.ok = false;
        hashCheck.details.push(`missing ${r.path} (recorded file is no longer on disk)`);
      }
    }
  } catch (err) {
    hashCheck.ok = false;
    hashCheck.details.push(`Could not check artifact hashes: ${(err as Error).message}`);
  }
  checks.push(hashCheck);

  // 4. Portability: no journal entry carries an absolute path. Paths must be
  //    repo-relative so a trail is portable across machines — and a projection
  //    from the ledger (whose records hold absolute paths) must re-relativize.
  const pathCheck: CheckResult = {
    name: 'recorded paths are repo-relative (portable)',
    ok: true,
    details: [],
  };
  try {
    let i = 0;
    for (const slug of authorSlugs(paths)) {
      const author = authorPaths(paths, slug);
      for (const entry of readJournal(author)) {
        i += 1;
        const bad: string[] = [];
        if (entry.path && isAbsoluteRecordedPath(entry.path)) bad.push(entry.path);
        for (const f of entry.files ?? []) {
          if (isAbsoluteRecordedPath(f)) bad.push(f);
        }
        if (bad.length > 0) {
          pathCheck.ok = false;
          pathCheck.details.push(
            `${slug} entry ${i} (${entry.id}): absolute path(s): ${bad.join(', ')}`,
          );
        }
      }
    }
  } catch (err) {
    pathCheck.ok = false;
    pathCheck.details.push(`paths could not be checked: ${(err as Error).message}`);
  }
  if (pathCheck.ok && pathCheck.details.length === 0) {
    pathCheck.details.push('All recorded paths are repo-relative.');
  }
  checks.push(pathCheck);

  // 5. A report can be generated.
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
