import { join } from 'node:path';
import { buildReportData, renderHtml, renderMarkdown } from '../core/report.ts';
import { authorSlugs, upgradeIdentityIfProvisional } from '../core/authors.ts';
import { emitJson } from '../core/output.ts';
import { requirePaths, writeJson } from '../core/storage.ts';
import { fileLink, openInDefaultApp } from '../core/terminal.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { ReportData } from '../types.ts';

export interface ReportOptions {
  format?: string;
  cwd?: string;
  /** Open the generated report in the OS default app after writing it. */
  open?: boolean;
  /** Generate only this author's report (slugified email). */
  author?: string;
  /** Generate only the combined team report. */
  team?: boolean;
  /** Override the descriptive name shown in the title (beats the project name). */
  title?: string;
  /** Emit machine-readable JSON (the written paths + summary) instead of prose. */
  json?: boolean;
}

/** A filesystem-safe timestamp for report filenames, e.g. 2026-06-12T140300. */
function fileStamp(iso: string): string {
  return iso.replace(/:/g, '').replace(/\..+$/, '');
}

/** One report to generate: a filename key plus the scope passed to the builder. */
interface ReportTarget {
  key: string;
  scope: { authorSlug?: string };
}

/** A written report's primary file plus its Markdown source (if any). */
interface WrittenReport {
  key: string;
  format: string;
  reportPath: string;
  markdownPath: string | null;
}

/** Decide which reports to write: a single author, the team, or team + everyone. */
function reportTargets(options: ReportOptions, slugs: string[]): ReportTarget[] {
  if (options.author) {
    return [{ key: options.author, scope: { authorSlug: options.author } }];
  }
  if (options.team) {
    return [{ key: 'team', scope: {} }];
  }
  // Default: the combined team report first, then one per contributor.
  return [
    { key: 'team', scope: {} },
    ...slugs.map((s) => ({ key: s, scope: { authorSlug: s } })),
  ];
}

/**
 * Generate reports under `.showtail/reports/` and print where they were written.
 * In a multi-student project this writes a combined team report plus one report
 * per contributor by default; `--author <slug>` or `--team` narrows that. HTML
 * by default; the Markdown it renders from is written alongside as the source of
 * truth, and `--format md`/`--format json` switch the primary output. `--json`
 * emits the written paths + summary for an agent instead of prose.
 */
export async function runReport(options: ReportOptions): Promise<void> {
  const paths = requirePaths(options.cwd);
  // Turn-in checkpoint: if capture has been under a computer-derived placeholder, adopt
  // the student's real identity (gh/git/env) now and re-attribute the work, so the report
  // is under their real name even if they never made a git commit. Best-effort, silent.
  await upgradeIdentityIfProvisional(paths, { cwd: options.cwd ?? process.cwd() });
  const slugs = authorSlugs(paths);
  const stamp = fileStamp(new Date().toISOString());
  mkdirSync(paths.reportsDir, { recursive: true });

  const targets = reportTargets(options, slugs);
  const written: WrittenReport[] = [];
  let teamData: ReportData | undefined;

  for (const target of targets) {
    const data = buildReportData(paths, { ...target.scope, title: options.title });
    if (target.key === 'team') teamData = data;
    written.push(writeOneReport(paths.reportsDir, target.key, stamp, data, options));
  }

  const primary = written[0];
  const summarySource = teamData ?? (await firstData(paths, targets));

  if (options.json) {
    if (options.open && primary) openInDefaultApp(primary.reportPath);
    emitJson({
      format: options.format ?? 'html',
      reportPath: primary?.reportPath ?? null,
      markdownPath: primary?.markdownPath ?? null,
      summary: summarySource?.summary ?? null,
      reports: written,
    });
    return;
  }

  if (primary) maybeOpen(primary.reportPath, options);

  if (summarySource) {
    console.log('');
    console.log(
      `Summary: ${summarySource.summary.sessions} session(s), ` +
        `${summarySource.summary.events} event(s), ` +
        `${summarySource.summary.artifacts} artifact record(s)` +
        (summarySource.contributors.length > 1
          ? `, ${summarySource.contributors.length} contributor(s)`
          : '') +
        '.',
    );
  }
  console.log('Open a file above to review the full trail.');
}

/** Write one report in the requested format; return its written paths. */
function writeOneReport(
  reportsDir: string,
  key: string,
  stamp: string,
  data: ReportData,
  options: ReportOptions,
): WrittenReport {
  const base = `report-${key}-${stamp}`;
  const format = options.format ?? 'html';
  const quiet = options.json === true;

  if (format === 'json') {
    const out = join(reportsDir, `${base}.json`);
    writeJson(out, data);
    if (!quiet) console.log(`Wrote JSON report (${key}): ${fileLink(out)}`);
    return { key, format, reportPath: out, markdownPath: null };
  }

  // The Markdown is always written: on its own for `--format md`, and as the
  // source the HTML is rendered from otherwise.
  const mdOut = join(reportsDir, `${base}.md`);
  writeFileSync(mdOut, renderMarkdown(data) + '\n', 'utf8');

  if (format === 'md') {
    if (!quiet) console.log(`Wrote report (${key}): ${fileLink(mdOut)}`);
    return { key, format, reportPath: mdOut, markdownPath: null };
  }
  const htmlOut = join(reportsDir, `${base}.html`);
  writeFileSync(htmlOut, renderHtml(data), 'utf8');
  if (!quiet) console.log(`Wrote report (${key}): ${fileLink(htmlOut)}`);
  return { key, format, reportPath: htmlOut, markdownPath: mdOut };
}

/** Fallback summary source when no team report was generated (e.g. `--author`). */
async function firstData(
  paths: ReturnType<typeof requirePaths>,
  targets: ReportTarget[],
): Promise<ReportData | undefined> {
  const first = targets[0];
  if (!first) return undefined;
  return buildReportData(paths, first.scope);
}

/** With `--open`, launch the report in the OS default app (best-effort). */
function maybeOpen(path: string, options: ReportOptions): void {
  if (!options.open) return;
  console.log('Opening report…');
  openInDefaultApp(path);
}
