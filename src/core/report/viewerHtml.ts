import { createHash } from 'node:crypto';
import VIEWER_CSS from '../../../assets/report/viewer.css' with { type: 'text' };
import VIEWER_JS from '../../../assets/report/viewer.js' with { type: 'text' };
import WORKER_JS from '../../../assets/report/viewer-worker.js' with { type: 'text' };
import RICHTEXT_JS from '../../../assets/report/viewer-richtext.js' with { type: 'text' };
import type { ReportData } from '../../types.ts';
import { escapeHtml } from '../html.ts';
import { buildViewerPayload } from './viewerPayload.ts';
import { renderViewerPayload } from './viewerCodec.ts';
import type { ReportRenderOptions } from './markdown.ts';
import { modelLabel, toolLabel } from './data.ts';

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
const digest = (value: string) => createHash('sha256').update(value).digest('base64');
const scriptText = (source: string) => source.replace(/<\/script/gi, '<\\/script');

/** A single offline file; only its small overview is HTML before interaction. */
export function renderViewerHtml(
  data: ReportData,
  options?: ReportRenderOptions,
): string {
  const payload = buildViewerPayload(data, options);
  const index = payload.index;
  const title = `Showtail Report — ${data.displayName}${data.scope ? ' — ' + data.scope.name : ''}`;
  const worker = scriptText(WORKER_JS);
  const viewer = scriptText(VIEWER_JS);
  const richText = scriptText(RICHTEXT_JS);
  const bootstrap = `ShowtailViewer.start({root:document.getElementById('st-report-app'),manifest:JSON.parse(document.getElementById('st-report-manifest').textContent),workerSource:JSON.parse(document.getElementById('st-report-worker').textContent),getChunk:function(id){var node=document.querySelector('script[data-st-chunk="'+id+'"]');if(!node)throw new Error('Saved report content is missing');return node.textContent;}});`;
  const policy = `default-src 'none'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src blob:; script-src 'sha256-${digest(worker)}' 'sha256-${digest(richText)}' 'sha256-${digest(viewer)}' 'sha256-${digest(bootstrap)}'; style-src 'sha256-${digest(VIEWER_CSS)}'`;
  const staticPrompts = index.turns
    .slice(0, 25)
    .map(
      (turn) =>
        `<li><time datetime="${escapeHtml(turn.timestamp)}">${escapeHtml(turn.timestamp)}</time><p>${escapeHtml(turn.preview)}</p></li>`,
    )
    .join('');
  const coverage = data.coverage?.status ?? 'unchecked';
  const warnings = [
    ...new Set(data.coverage?.sources.flatMap((source) => source.warningCodes) ?? []),
  ];
  const duration = index.usage?.totalDurationMs;
  const durationText =
    duration === null || duration === undefined
      ? 'Not reported'
      : `${Math.floor(duration / 3_600_000)}h ${Math.floor(duration / 60_000) % 60}m ${Math.round(duration / 1000) % 60}s`;
  const number = (value: number | null | undefined) =>
    value === null || value === undefined
      ? 'Not reported'
      : value.toLocaleString('en-US');
  const staticStats = `<dl class="report-static-stats"><dt>Summed reported AI working time</dt><dd>${durationText}</dd><dt>Input tokens</dt><dd>${number(index.usage?.totalInputTokens)}</dd><dt>Output tokens</dt><dd>${number(index.usage?.totalOutputTokens)}</dd><dt>Cache-read tokens</dt><dd>${number(index.usage?.totalCacheReadTokens)}</dd><dt>Cache-creation tokens</dt><dd>${number(index.usage?.totalCacheCreationTokens)}</dd></dl>`;
  const planSummary = (index.plans ?? [])
    .slice(0, 25)
    .map(
      (plan) =>
        `<li>${escapeHtml(plan.title)} · ${escapeHtml(plan.status === 'none' ? 'approval not reported' : plan.status)}${plan.feedback ? ' · ' + escapeHtml(plan.feedback) : ''}</li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
<title>${escapeHtml(title)}</title><style>${VIEWER_CSS}</style></head>
<body><header class="report-header"><p class="eyebrow">Showtail Report</p><h1>${escapeHtml(index.title)}${data.scope ? ' — ' + escapeHtml(data.scope.name) : ''}</h1>
<p>${index.turns.length} prompts · ${data.summary.sessions} sessions <span class="report-secondary-counts">· ${index.uniqueFileCount ?? 0} files · ${data.summary.artifacts} captured revisions </span>· <span class="report-coverage">coverage: <strong>${escapeHtml(coverage)}</strong></span></p>
<details class="report-about"><summary>About this report</summary><p>Generated ${escapeHtml(index.generatedAt)}</p><p>${escapeHtml(index.authorship)}</p>
<p>${data.summary.decisions} decisions · ${data.summary.plans} captured plan records · ${data.summary.events} event records</p>
<p>Tools: ${escapeHtml(index.tools.map((tool) => toolLabel(tool.tool)).join(', '))}</p><p>Models: ${escapeHtml(index.models.map((model) => modelLabel(model.model)).join(', '))}</p>
<p>${escapeHtml(data.coverage?.meaning ?? 'Captured local history; completeness is not independently established.')}</p>${warnings.length ? '<p>Source notes: ' + escapeHtml(warnings.join(', ')) + '.</p>' : ''}
${data.redactionCount ? '<p>' + data.redactionCount + ' secrets or personal details were removed before saving.</p>' : ''}</details></header>
<main id="st-report-app"><h2>Overview</h2>${staticStats}${planSummary ? '<h2>Plans</h2><p>' + (index.plans?.length ?? 0) + ' distinct plans; showing the first 25.</p><ol>' + planSummary + '</ol>' : ''}<h2>Prompt timeline</h2><p>Showing the first ${Math.min(25, index.turns.length)} of ${index.turns.length} prompts. Detailed browsing requires JavaScript and a current browser.</p><ol>${staticPrompts}</ol></main>
<noscript><p>JavaScript is disabled. This overview remains readable; enable JavaScript to search and read the complete embedded history. Markdown and JSON copies are also generated by Showtail.</p></noscript>
${renderViewerPayload(index, payload.blocks)}
<script type="application/json" id="st-report-worker">${json(WORKER_JS)}</script>
<script>${worker}</script><script>${richText}</script><script>${viewer}</script><script>${bootstrap}</script>
</body></html>\n`;
}
