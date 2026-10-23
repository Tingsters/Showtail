/** Edits recovered from Antigravity IDE transcripts (`CODE_ACTION` lines). */

/** An edited file recovered from a transcript: the path + the IDE's edit note. */
export interface TranscriptEdit {
  /** Display path (repo-relative when under `root`, else absolute, posix slashes). */
  path: string;
  /** The CODE_ACTION description, recorded as the artifact's "diff" body. */
  diff: string;
  timestamp?: string;
  /** Stable id for idempotent re-import (see importedArtifactSourceIds). */
  sourceId: string;
}

/** Convert a `file:///C:/x/y.py` URI to a usable OS path (posix slashes). */
function fileUriToPath(uri: string): string | null {
  try {
    let p = decodeURIComponent(uri);
    // `file:///C:/…` → `C:/…`; a leading slash before a drive letter is spurious.
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    p = p.replace(/\\/g, '/');
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Tool/project bookkeeping paths are never student edit artifacts. */
function isInternalEditPath(path: string): boolean {
  return /(^|[\\/])\.(showtail|git|vscode|system_generated)([\\/]|$)/.test(path);
}

/**
 * Recover the files the IDE edited from a raw transcript. Each `CODE_ACTION` line
 * describes one file operation and embeds the target as a `file://` URI in its
 * `content` (e.g. "Created file file:///C:/…/x.py with requested content."). We
 * pull the path and keep the description as the artifact body. (The parsed
 * conversation drops edits, so this reads the raw JSONL directly.)
 */
export function extractTranscriptEdits(
  rawContent: string,
  sessionId: string,
): TranscriptEdit[] {
  const out: TranscriptEdit[] = [];
  let seq = 0;
  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: {
      type?: unknown;
      content?: unknown;
      created_at?: unknown;
      step_index?: unknown;
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'CODE_ACTION') continue;
    const content = typeof obj.content === 'string' ? obj.content : '';
    const idx = typeof obj.step_index === 'number' ? String(obj.step_index) : `n${seq++}`;
    const timestamp = typeof obj.created_at === 'string' ? obj.created_at : undefined;
    for (const m of content.matchAll(/file:\/\/([^\s)'"]+)/g)) {
      const p = fileUriToPath(m[1]!);
      if (!p) continue;
      if (isInternalEditPath(p)) continue;
      out.push({
        path: p,
        diff: content.trim() || `Antigravity edited ${p}`,
        timestamp,
        sourceId: `agy:edit:${sessionId}:${idx}:${p}`,
      });
    }
  }
  return out;
}
