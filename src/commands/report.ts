import { join } from 'node:path';
import { buildReportData, renderHtml, renderMarkdown } from '../core/report.ts';
import { requirePaths, writeJson } from '../core/storage.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

export interface ReportOptions {
  format?: string;
  cwd?: string;
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
    console.log(`Wrote JSON report: ${out}`);
    return;
  }

  // The Markdown is always written: on its own for `--format md`, and as the
  // source the HTML is rendered from otherwise.
  const mdOut = join(paths.reportsDir, `report-${stamp}.md`);
  writeFileSync(mdOut, renderMarkdown(data) + '\n', 'utf8');

  if (options.format === 'md') {
    console.log(`Wrote report: ${mdOut}`);
  } else {
    const htmlOut = join(paths.reportsDir, `report-${stamp}.html`);
    writeFileSync(htmlOut, renderHtml(data), 'utf8');
    console.log(`Wrote report: ${htmlOut}`);
    console.log(`Markdown source: ${mdOut}`);
  }

  console.log('');
  console.log(
    `Summary: ${data.summary.sessions} session(s), ${data.summary.events} event(s), ` +
      `${data.summary.artifacts} artifact record(s).`,
  );
  console.log('Open the file above to review the full trail.');
}
