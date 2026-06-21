import { join } from 'node:path';
import { buildReportData, renderHtml, renderMarkdown } from '../core/report.ts';
import { authorSlugs } from '../core/authors.ts';
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
 * truth, and `--format md`/`--format json` switch the primary output.
 */
export async function runReport(options: ReportOptions): Promise<void> {
  const paths = requirePaths(options.cwd);
  const slugs = authorSlugs(paths);
  const stamp = fileStamp(new Date().toISOString());
  mkdirSync(paths.reportsDir, { recursive: true });

  const targets = reportTargets(options, slugs);
  let firstPrimary: string | undefined;
  let teamData: ReportData | undefined;

  for (const target of targets) {
    const data = buildReportData(paths, target.scope);
    if (target.key === 'team') teamData = data;
    const primary = writeOneReport(paths.reportsDir, target.key, stamp, data, options);
    firstPrimary ??= primary;
  }

  if (firstPrimary) maybeOpen(firstPrimary, options);

  const summarySource = teamData ?? (await firstData(paths, targets));
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

/** Write one report in the requested format; return its primary file path. */
function writeOneReport(
  reportsDir: string,
  key: string,
  stamp: string,
  data: ReportData,
  options: ReportOptions,
): string {
  const base = `report-${key}-${stamp}`;

  if (options.format === 'json') {
    const out = join(reportsDir, `${base}.json`);
    writeJson(out, data);
    console.log(`Wrote JSON report (${key}): ${fileLink(out)}`);
    return out;
  }

  // The Markdown is always written: on its own for `--format md`, and as the
  // source the HTML is rendered from otherwise.
  const mdOut = join(reportsDir, `${base}.md`);
  writeFileSync(mdOut, renderMarkdown(data) + '\n', 'utf8');

  if (options.format === 'md') {
    console.log(`Wrote report (${key}): ${fileLink(mdOut)}`);
    return mdOut;
  }
  const htmlOut = join(reportsDir, `${base}.html`);
  writeFileSync(htmlOut, renderHtml(data), 'utf8');
  console.log(`Wrote report (${key}): ${fileLink(htmlOut)}`);
  return htmlOut;
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
