import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryStore, digest, type HistorySelection } from '../core/history.ts';
import { exportHistory } from '../core/historyReport.ts';
import { approvalCode, buildPrComment, scanComment } from '../core/prComment.ts';
import { verifySubmission } from '../core/submission.ts';

interface Preview {
  comment: string;
  code: string;
  targetUrl: string;
  visibility: string;
  exportDir: string;
  reportHash: string;
  historyHash: string;
  selection: HistorySelection;
  postedAt?: string;
}
export type GhRunner = (
  args: string[],
  cwd: string,
  input?: string,
) => { status: number | null; stdout: string; stderr: string };
const realGh: GhRunner = (args, cwd, input) => {
  const result = spawnSync('gh', args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};
function head(store: HistoryStore, selection: HistorySelection): string {
  return digest(JSON.stringify(store.records(selection).map((r) => r.hash)));
}

export function previewPr(
  store: HistoryStore,
  selection: HistorySelection,
  options: { pr?: string | boolean; repo?: string; title?: string; gh?: GhRunner },
): Record<string, unknown> {
  const gh = options.gh ?? realGh;
  const project =
    selection.kind === 'project' ? store.resolveProject(selection.projectId) : undefined;
  const cwd =
    project?.projectRoot && existsSync(project.projectRoot)
      ? project.projectRoot
      : store.home;
  const repoArgs = options.repo ? ['--repo', options.repo] : [];
  const ref = typeof options.pr === 'string' ? [options.pr] : [];
  const view = gh(['pr', 'view', ...ref, ...repoArgs, '--json', 'url'], cwd);
  if (view.status !== 0)
    throw new Error(
      'PR_NOT_FOUND: specify a PR URL, or --repo owner/repo and --pr number.',
    );
  const targetUrl = JSON.parse(view.stdout).url;
  if (
    typeof targetUrl !== 'string' ||
    !/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+$/.test(targetUrl)
  )
    throw new Error('PR_TARGET_INVALID');
  const ownerRepo = new URL(targetUrl).pathname.split('/').slice(1, 3).join('/');
  let visibility = 'UNKNOWN';
  const info = gh(['repo', 'view', ownerRepo, '--json', 'visibility'], cwd);
  if (info.status === 0) {
    try {
      visibility = JSON.parse(info.stdout).visibility;
    } catch {
      /* Warn as public if unknown. */
    }
  }
  const exported = exportHistory(store, selection, options);
  const comment = buildPrComment(exported.data, exported.manifest);
  if (scanComment(comment).length) throw new Error('COMMENT_SCAN_BLOCKED');
  const code = approvalCode(comment);
  const preview: Preview = {
    comment,
    code,
    targetUrl,
    visibility,
    exportDir: exported.dir,
    reportHash: exported.manifest.files['report.html']!,
    historyHash: head(store, selection),
    selection,
  };
  const path = join(exported.dir, 'pr-preview.json');
  writeFileSync(path, JSON.stringify(preview, null, 2) + '\n', { mode: 0o600 });
  store.setMeta('lastPrPreview', path);
  return {
    schemaVersion: 2,
    home: store.home,
    preview: true,
    posted: false,
    comment,
    code,
    targetUrl,
    visibility,
    publicAndPermanent: !['PRIVATE', 'INTERNAL'].includes(visibility),
    withheld: exported.manifest.withheld.total,
    exportPath: exported.dir,
  };
}

export function approvePr(
  store: HistoryStore,
  code: string,
  gh: GhRunner = realGh,
): Record<string, unknown> {
  const path = store.meta('lastPrPreview');
  if (!path) throw new Error('PR_PREVIEW_REQUIRED: nothing was posted.');
  const preview: Preview = JSON.parse(readFileSync(path, 'utf8'));
  if (preview.postedAt || preview.code !== code || approvalCode(preview.comment) !== code)
    throw new Error('PR_APPROVAL_INVALID: nothing was posted.');
  const verified = verifySubmission(preview.exportDir);
  if (
    !verified.ok ||
    verified.manifest?.files['report.html'] !== preview.reportHash ||
    head(store, preview.selection) !== preview.historyHash
  )
    throw new Error(
      'PR_REPORT_CHANGED: not submitting; generate and review a new preview.',
    );
  if (scanComment(preview.comment).length)
    throw new Error('COMMENT_SCAN_BLOCKED: not submitting.');
  const result = gh(
    ['pr', 'comment', preview.targetUrl, '--body-file', '-'],
    store.home,
    preview.comment,
  );
  if (result.status !== 0)
    throw new Error('PR_POST_FAILED: the GitHub CLI did not confirm posting.');
  preview.postedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(preview, null, 2) + '\n', { mode: 0o600 });
  return {
    schemaVersion: 2,
    home: store.home,
    posted: true,
    url: result.stdout.trim() || preview.targetUrl,
  };
}
