import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as chatgpt from '../core/chatgpt.ts';
import { readClipboard, readClipboardHtml } from '../core/clipboard.ts';
import * as gemini from '../core/gemini.ts';
import { readGlobalConfig, toolCaptureEnabledAt } from '../core/globalConfig.ts';
import { HistoryStore, digest } from '../core/history.ts';
import { automaticCaptureEnabled, captureTranscript } from '../core/historyCapture.ts';
import { CHATGPT_HTML, GEMINI_HTML, parseConversationHtml } from '../core/pasteHtml.ts';
import { redact } from '../core/redact.ts';
import { getPlugin } from '../plugins/registry.ts';
import type { HookTranscript } from '../plugins/types.ts';

export interface HistoryImportOptions {
  file?: string;
  list?: boolean;
  paste?: boolean;
  clipboard?: boolean;
  yes?: boolean;
  auto?: boolean;
  quiet?: boolean;
  json?: boolean;
  withResponses?: boolean;
  model?: string;
  date?: string;
  session?: string;
  cwd?: string;
}

export async function runHistoryImport(
  toolName: string,
  source: string | undefined,
  options: HistoryImportOptions = {},
): Promise<Record<string, unknown>> {
  const plugin = getPlugin(toolName);
  if (!plugin || (!plugin.import && !plugin.migration))
    throw new Error(`UNKNOWN_IMPORT_TOOL: ${toolName}`);
  if (options.auto && !automaticCaptureEnabled(plugin.id))
    return { skipped: 'capture-disabled' };
  let transcript: HookTranscript;
  let nativeId: string;
  let cwd: string | null = null;
  let transcriptPath: string | undefined;
  if (plugin.migration) {
    const candidates = plugin.migration.discover();
    if (options.list) return { transcripts: candidates };
    const file =
      options.file ??
      (source &&
      (source.includes('/') || source.includes('\\') || source.endsWith('.jsonl'))
        ? source
        : undefined);
    let candidate = file
      ? (candidates.find((c) => resolve(c.path) === resolve(file)) ?? {
          path: resolve(file),
          providerSessionId: `file:${digest(resolve(file))}`,
          mtimeMs: 0,
        })
      : candidates.find(
          (c) =>
            c.providerSessionId === source ||
            c.providerSessionId.startsWith(source ?? '\0'),
        );
    if (!candidate && !source && process.stdin.isTTY) {
      for (let i = 0; i < candidates.length; i++)
        console.error(
          `${i + 1}. ${candidates[i]!.providerSessionId} ${candidates[i]!.cwd ?? ''}`,
        );
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        candidate = candidates[Number(await rl.question('Conversation number: ')) - 1];
      } finally {
        rl.close();
      }
    }
    if (!candidate)
      throw new Error(
        'TRANSCRIPT_SELECTION_REQUIRED: use --list, a session ID, or --file.',
      );
    cwd = candidate.cwd ?? null;
    transcriptPath = candidate.path;
    transcript = await plugin.migration.read(
      candidate,
      cwd ?? options.cwd ?? process.cwd(),
    );
    nativeId = transcript.sessionId ?? candidate.providerSessionId;
    for (const plan of plugin.migration.planFiles?.(candidate) ?? [])
      transcript.messages.push({
        role: 'plan',
        text: plan.content,
        sourceId: plan.sourceId,
      });
  } else {
    const provider = plugin.id === 'google-gemini' ? gemini : chatgpt;
    let conversation: chatgpt.ParsedConversation;
    let fromClipboard = false;
    if (source && !options.file && /^https:\/\//.test(source)) {
      const valid =
        plugin.id === 'google-gemini'
          ? /^https:\/\/(?:gemini\.google\.com\/share|g\.co\/gemini\/share|share\.gemini\.google)\/[\w-]+/i
          : /^https:\/\/chatgpt\.com\/share\/[\w-]+/i;
      if (!valid.test(source))
        throw new Error('INVALID_SHARE_URL: supply a public provider share URL.');
      conversation = await provider.parseShareHtml(
        await provider.fetchSharedConversation(source),
      );
    } else {
      let raw: string;
      if (options.file) raw = readFileSync(options.file, 'utf8');
      else if (options.clipboard || (options.paste && process.stdin.isTTY)) {
        fromClipboard = true;
        let html: string | null = null;
        try {
          html = readClipboardHtml();
        } catch {
          /* Plain text is the fallback. */
        }
        const parsed = html
          ? parseConversationHtml(
              html,
              plugin.id === 'google-gemini' ? GEMINI_HTML : CHATGPT_HTML,
            )
          : null;
        raw = parsed ? '' : readClipboard();
        if (parsed) conversation = parsed;
      } else
        raw =
          source && !options.paste
            ? readFileSync(source, 'utf8')
            : await Bun.stdin.text();
      if (!conversation!) {
        try {
          conversation = await provider.parseShareHtml(raw!);
        } catch {
          conversation = provider.parseTranscript(raw!).conversation;
        }
      }
      if (fromClipboard && !options.yes) {
        console.error(
          `Import ${conversation!.messages.length} messages from the clipboard?`,
        );
        console.error(
          conversation!.messages
            .slice(0, 6)
            .map((m) => `${m.role}: ${redact(m.text).text.slice(0, 100)}`)
            .join('\n'),
        );
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          if (!/^y(es)?$/i.test(await rl.question('Import? [y/N] ')))
            return { skipped: 'declined' };
        } finally {
          rl.close();
        }
      }
    }
    nativeId =
      conversation!.id ?? `import:${digest(JSON.stringify(conversation!.messages))}`;
    const date = options.date
      ? new Date(options.date).toISOString()
      : new Date().toISOString();
    transcript = {
      sessionId: nativeId,
      messages: conversation!.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m, i) => ({
          role: m.role,
          text: m.text,
          sourceId: m.id || `${nativeId}:${i}`,
          timestamp: m.createTime ? new Date(m.createTime * 1000).toISOString() : date,
          model: m.model ?? options.model,
        })),
    };
  }
  if (options.withResponses === false) {
    transcript.messages = transcript.messages.filter((m) => m.role !== 'assistant');
    transcript.events = transcript.events?.filter((e) => e.type !== 'assistant_text');
  }
  if (!transcript.messages.length && !transcript.events?.length)
    throw new Error('EMPTY_CONVERSATION: no supported messages were found.');
  using store = new HistoryStore();
  const existing = options.session ? store.session(options.session) : undefined;
  if (options.session && !existing) throw new Error('SESSION_NOT_FOUND');
  const session =
    existing ??
    store.ensureSession({
      tool: plugin.id,
      nativeSessionId: nativeId,
      cwd,
      transcriptPath,
      startedAt: transcript.messages.find((m) => m.timestamp)?.timestamp,
    });
  const config = readGlobalConfig();
  const enabledAt = toolCaptureEnabledAt(plugin.cliName);
  const epoch = config.captureResumedAt ?? config.captureSince;
  const since = options.auto
    ? [enabledAt, config.captureSince, config.captureResumedAt]
        .filter((v): v is string => !!v)
        .sort()
        .at(-1)
    : undefined;
  const imported = captureTranscript(store, session, transcript, {
    since,
    continueCapture: options.auto
      ? () => {
          const latest = readGlobalConfig();
          return (
            automaticCaptureEnabled(plugin.id) &&
            enabledAt === toolCaptureEnabledAt(plugin.cliName) &&
            epoch === (latest.captureResumedAt ?? latest.captureSince)
          );
        }
      : undefined,
  });
  return {
    schemaVersion: 2,
    home: store.home,
    sessionId: session.id,
    imported,
    messages: transcript.messages.length,
    warnings: transcript.warnings ?? [],
  };
}

/** Catch up only known sessions; never scan project folders to find storage. */
export async function catchUpHistory(
  store: HistoryStore,
  _selection?: import('../core/history.ts').HistorySelection,
): Promise<number> {
  const { syncHistory } = await import('../core/historySync.ts');
  return (await syncHistory(store)).imported;
}
