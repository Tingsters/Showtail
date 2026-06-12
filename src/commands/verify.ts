import { existsSync } from 'node:fs';
import { checkArtifactHashes } from '../core/artifacts.ts';
import { buildReportData, renderMarkdown } from '../core/report.ts';
import { validateEvent } from '../core/schema.ts';
import {
  readJsonl,
  readSessions,
  requirePaths,
  sessionFile,
  type ShowtailPaths,
} from '../core/storage.ts';
import { readConfig } from '../core/storage.ts';
import type { Session } from '../types.ts';

export interface VerifyOptions {
  cwd?: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
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

  // 2. Every session JSONL line parses and has the required fields.
  const eventsCheck: CheckResult = {
    name: 'session logs are valid JSONL',
    ok: true,
    details: [],
  };
  let sessions: Session[] = [];
  try {
    sessions = readSessions(paths);
  } catch (err) {
    eventsCheck.ok = false;
    eventsCheck.details.push(
      `sessions/index.json could not be read: ${(err as Error).message}`,
    );
  }
  for (const session of sessions) {
    const file = sessionFile(paths, session.id);
    if (!existsSync(file)) {
      // An empty session that never got a log is fine.
      continue;
    }
    let records: unknown[] = [];
    try {
      records = readJsonl<unknown>(file);
    } catch (err) {
      eventsCheck.ok = false;
      eventsCheck.details.push(
        `${session.id}: a line is not valid JSON (${(err as Error).message}).`,
      );
      continue;
    }
    records.forEach((rec, i) => {
      const issues = validateEvent(rec);
      if (issues.length > 0) {
        eventsCheck.ok = false;
        const summary = issues.map((x) => `${x.field}: ${x.message}`).join('; ');
        eventsCheck.details.push(`${session.id} line ${i + 1}: ${summary}`);
      }
    });
  }
  if (eventsCheck.ok && eventsCheck.details.length === 0) {
    eventsCheck.details.push(
      'All session logs parsed and contained the required fields.',
    );
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

  // 4. A report can be generated.
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
