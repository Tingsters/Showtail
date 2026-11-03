/** Replay the open Claude turn on append; retain offsets, never transcript text. */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { sha256OfString } from './hash.ts';
import { isSyntheticPrompt } from './syntheticPrompt.ts';

interface Cursor {
  version: 2;
  size: number;
  ino: number;
  offset: number;
  prefixLength: number;
  prefixHash: string;
}
export function readClaudeSource(
  path: string,
  saved?: string,
): { content: string; checkpoint: string } {
  const fd = openSync(path, 'r');
  try {
    const st = statSync(path);
    const read = (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      let n = 0;
      while (n < length) {
        const count = readSync(fd, buffer, n, length - n, offset + n);
        if (!count) break;
        n += count;
      }
      return buffer.subarray(0, n);
    };
    let previous: Cursor | undefined;
    try {
      previous = saved ? JSON.parse(saved) : undefined;
    } catch {}
    if (
      previous &&
      (previous.version !== 2 ||
        !Number.isInteger(previous.offset) ||
        previous.offset < 0 ||
        previous.offset > previous.size ||
        !Number.isInteger(previous.prefixLength) ||
        previous.prefixLength < 0 ||
        previous.prefixLength > 4096)
    )
      previous = undefined;
    const prefixLength = previous?.prefixLength ?? Math.min(4096, st.size);
    const prefix = read(0, Math.min(prefixLength, st.size));
    const prefixHash = sha256OfString(prefix.toString('base64'));
    let offset =
      previous?.version === 2 &&
      previous.ino === st.ino &&
      st.size >= previous.size &&
      prefixHash === previous.prefixHash
        ? previous.offset
        : 0;
    let buffer = read(offset, st.size - offset);
    let content = buffer.toString('utf8');
    // A result from a prior turn (background work), or a queued submission whose
    // enqueue timestamp predates the turn, requires the complete source.
    if (offset) {
      const uses = new Set<string>();
      let needsPrefix = false;
      for (const line of content.split(/\r?\n/)) {
        try {
          const obj = JSON.parse(line);
          if (obj.promptSource === 'queued') needsPrefix = true;
          for (const part of Array.isArray(obj.message?.content)
            ? obj.message.content
            : []) {
            if (part.type === 'tool_use') uses.add(part.id);
            if (part.type === 'tool_result' && !uses.has(part.tool_use_id))
              needsPrefix = true;
          }
        } catch {}
      }
      if (needsPrefix) {
        offset = 0;
        buffer = read(0, st.size);
        content = buffer.toString('utf8');
      }
    }
    let resume = offset,
      start = 0;
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start);
      if (end < 0) break; // Do not checkpoint an incomplete trailing line.
      try {
        const obj = JSON.parse(buffer.subarray(start, end).toString('utf8'));
        const parts = obj.message?.content;
        const text =
          typeof parts === 'string'
            ? parts
            : Array.isArray(parts)
              ? parts
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? '')
                  .join('\n')
              : '';
        const human =
          obj.type === 'user' &&
          !obj.isMeta &&
          !obj.isSidechain &&
          !obj.isCompactSummary &&
          obj.promptSource !== 'system' &&
          (obj.origin?.kind === 'human' || !isSyntheticPrompt(text)) &&
          (typeof parts === 'string' ||
            (Array.isArray(parts) &&
              parts.some((p) => p.type === 'text') &&
              !parts.some((p) => p.type === 'tool_result')));
        if (human && obj.promptSource !== 'queued') resume = offset + start;
      } catch {}
      start = end + 1;
    }
    return {
      content,
      checkpoint: JSON.stringify({
        version: 2,
        size: st.size,
        ino: st.ino,
        offset: resume,
        prefixLength: prefix.length,
        prefixHash,
      } satisfies Cursor),
    };
  } finally {
    closeSync(fd);
  }
}
