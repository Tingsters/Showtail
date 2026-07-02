/**
 * Report generation, split by concern into `./report/`:
 *  - `data.ts`     — read the trail off disk into structured `ReportData`.
 *  - `markdown.ts` — render `ReportData` as the canonical Markdown export.
 *  - `mdToHtml.ts` — convert the Markdown subset (and free-form card text) to HTML.
 *  - `html.ts`     — assemble the standalone interactive HTML document.
 *  - `time.ts`     — timestamp tokens and `<time>` tags.
 * This barrel re-exports the public surface so callers keep importing from
 * `core/report.ts`.
 */
export { buildReportData, buildToolBlocks, buildTurns } from './report/data.ts';
export { renderMarkdown } from './report/markdown.ts';
export { renderHtml } from './report/html.ts';
export { markdownToHtml } from './report/mdToHtml.ts';
