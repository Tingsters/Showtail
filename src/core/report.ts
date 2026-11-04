/**
 * Report generation, split by concern into `./report/`:
 *  - `data.ts`     — read the trail off disk into structured `ReportData`.
 *  - `markdown.ts` — render `ReportData` as the canonical Markdown export.
 *  - `projection.ts` — coalesce equivalent native-event display projections.
 *  - `mdToHtml.ts` — convert the Markdown subset to HTML for public callers.
 *  - `html.ts`     — public entry point for the standalone offline viewer.
 *  - `viewer*.ts`  — assemble, encode and independently inspect the lazy viewer.
 *  - `time.ts`     — timestamp tokens and `<time>` tags.
 * This barrel re-exports the public surface so callers keep importing from
 * `core/report.ts`.
 */
export { buildToolBlocks, buildTurns } from './report/data.ts';
export {
  type AiMode,
  renderMarkdown,
  type ReportRenderOptions,
} from './report/markdown.ts';
export { renderHtml } from './report/html.ts';
export { markdownToHtml, renderRichText } from './report/mdToHtml.ts';
