import { join } from 'node:path';
import { buildReportData, renderMarkdown } from '../core/report.ts';
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
 * Markdown by default; `--format json` writes the structured data instead.
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

  const out = join(paths.reportsDir, `report-${stamp}.md`);
  writeFileSync(out, renderMarkdown(data) + '\n', 'utf8');
  console.log(`Wrote report: ${out}`);
  console.log('');
  console.log(
    `Summary: ${data.summary.sessions} session(s), ${data.summary.events} event(s), ` +
      `${data.summary.artifacts} artifact record(s).`,
  );
  console.log('Open the file above to review the full trail.');
}
