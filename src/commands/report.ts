import { join } from 'node:path';
import { buildReportData, renderHtml, renderMarkdown } from '../core/report.ts';
import { requirePaths, writeJson } from '../core/storage.ts';
import { fileLink, openInDefaultApp } from '../core/terminal.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

export interface ReportOptions {
  format?: string;
  cwd?: string;
  /** Open the generated report in the OS default app after writing it. */
  open?: boolean;
}

/** A filesystem-safe timestamp for report filenames, e.g. 2026-06-12T140300. */
function fileStamp(iso: string): string {
  return iso.replace(/:/g, '').replace(/\..+$/, '').replace('T', 'T');
}

/**
 * Generate a report under `.showtail/reports/` and print where it was written.
 * HTML by default (easy for an educator to open in a browser); the Markdown it
 * is rendered from is written alongside it as the source of truth. `--format md`
 * writes Markdown only, and `--format json` writes the structured data instead.
 */
export async function runReport(options: ReportOptions): Promise<void> {
  const paths = requirePaths(options.cwd);
  const data = buildReportData(paths);
  const stamp = fileStamp(data.generatedAt);

  mkdirSync(paths.reportsDir, { recursive: true });

  if (options.format === 'json') {
    const out = join(paths.reportsDir, `report-${stamp}.json`);
    writeJson(out, data);
    console.log(`Wrote JSON report: ${fileLink(out)}`);
    maybeOpen(out, options);
    return;
  }

  // The Markdown is always written: on its own for `--format md`, and as the
  // source the HTML is rendered from otherwise.
  const mdOut = join(paths.reportsDir, `report-${stamp}.md`);
  writeFileSync(mdOut, renderMarkdown(data) + '\n', 'utf8');

  // The main artifact for `--open` is the format's primary file.
  let primary = mdOut;
  if (options.format === 'md') {
    console.log(`Wrote report: ${fileLink(mdOut)}`);
  } else {
    const htmlOut = join(paths.reportsDir, `report-${stamp}.html`);
    writeFileSync(htmlOut, renderHtml(data), 'utf8');
    console.log(`Wrote report: ${fileLink(htmlOut)}`);
    console.log(`Markdown source: ${fileLink(mdOut)}`);
    primary = htmlOut;
  }
  maybeOpen(primary, options);

  console.log('');
  console.log(
    `Summary: ${data.summary.sessions} session(s), ${data.summary.events} event(s), ` +
      `${data.summary.artifacts} artifact record(s).`,
  );
  console.log('Open the file above to review the full trail.');
}

/** With `--open`, launch the report in the OS default app (best-effort). */
function maybeOpen(path: string, options: ReportOptions): void {
  if (!options.open) return;
  console.log('Opening report…');
  openInDefaultApp(path);
}
