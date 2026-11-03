import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, type Provider, type Scenario } from './common.ts';

export interface NativeRevision {
  evidence: 'native-file-change' | 'structured-write' | 'bash-snapshot';
  provider: Provider;
  nativeSessionId: string;
  nativeId: string;
  file: string;
  kind: 'add' | 'update' | 'delete';
  added: string[];
  removed: string[];
  deltaKnown: boolean;
  timestamp?: string;
}

interface CapturedRevision {
  kind: string;
  native_id?: string;
  nativeSessionId?: string;
  source_id?: string;
  sourceId?: string;
  file?: string;
  diff?: string;
  deleted?: boolean;
  duplicateOf?: string;
  tags?: string[];
}

const pathKey = (file: string) => {
  const key = file.replace(/\\/g, '/');
  return process.platform === 'win32' || /^[A-Za-z]:\//.test(key)
    ? key.toLowerCase()
    : key;
};
const contentLines = (text: string) =>
  text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
function deltaLines(lines: string[]) {
  return {
    added: lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
    removed: lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)),
  };
}

/** Compare identity AND delta: a later revision of one file cannot stand in for an earlier one. */
export function compareNativeRevisions(
  expected: NativeRevision[],
  records: CapturedRevision[],
) {
  return compareRevisions(expected, records, false);
}

/** Preserve each persisted workspace delta without claiming which actor caused it. */
export function compareNativeSnapshots(
  expected: NativeRevision[],
  records: CapturedRevision[],
) {
  return compareRevisions(expected, records, true);
}

function compareRevisions(
  expected: NativeRevision[],
  records: CapturedRevision[],
  snapshots: boolean,
) {
  const missing = expected.filter(
    (revision) =>
      (revision.evidence === 'bash-snapshot') !== snapshots ||
      !records.some((record) => {
        if (
          !(
            record.kind === 'edit' ||
            (snapshots &&
              record.kind === 'audit' &&
              record.tags?.includes('observed-workspace-delta'))
          ) ||
          !record.file ||
          record.duplicateOf ||
          record.tags?.includes('observed-file-state')
        )
          return false;
        if (
          pathKey(record.file) !== pathKey(revision.file) ||
          (record.native_id ?? record.nativeSessionId) !== revision.nativeSessionId
        )
          return false;
        const sourceId = record.source_id ?? record.sourceId ?? '';
        const prefixes =
          revision.provider === 'codex'
            ? [`codex:edit:${revision.nativeId}#`]
            : snapshots
              ? [`${revision.nativeId}:edits#`]
              : [`${revision.nativeId}#`, `${revision.nativeId}:edits#`];
        if (
          !prefixes.some((prefix) => sourceId.startsWith(prefix)) ||
          (revision.kind === 'delete') !== (record.deleted === true)
        )
          return false;
        if (!revision.deltaKnown) return true;
        const lines = (record.diff ?? '').replace(/\r\n/g, '\n').split('\n');
        const hasFileHeaders =
          lines[0]?.startsWith('--- ') && lines[1]?.startsWith('+++ ');
        // Codex stores display-ready + / - lines; Claude retains unified hunks.
        const actual =
          revision.provider === 'codex'
            ? {
                added: lines
                  .filter((line) => line.startsWith('+'))
                  .map((line) => (line.startsWith('+ ') ? line.slice(2) : line.slice(1))),
                removed: lines
                  .filter((line) => line.startsWith('-'))
                  .map((line) => (line.startsWith('- ') ? line.slice(2) : line.slice(1))),
              }
            : deltaLines(hasFileHeaders ? lines.slice(2) : lines);
        if (
          revision.evidence === 'structured-write' &&
          hasFileHeaders &&
          !lines.some((line) => line.startsWith('@@'))
        ) {
          // A full-content Write is rendered as old/new string splits. The empty
          // original and final newline are presentation sentinels, not revisions.
          if (
            revision.kind === 'add' &&
            actual.removed.length === 1 &&
            actual.removed[0] === ''
          )
            actual.removed = [];
          if (actual.added.at(-1) === '') actual.added.pop();
          if (revision.kind !== 'add' && actual.removed.at(-1) === '')
            actual.removed.pop();
        }
        return (
          JSON.stringify(actual.added) === JSON.stringify(revision.added) &&
          JSON.stringify(actual.removed) === JSON.stringify(revision.removed)
        );
      }),
  );
  return {
    expected: expected.length,
    matched: expected.length - missing.length,
    missing,
  };
}

/** Independent, deliberately small oracle for the actual provider's persisted events. */
export function nativeState(s: Scenario, provider: Provider) {
  const dir =
    provider === 'codex'
      ? join(s.env.CODEX_HOME!, 'sessions')
      : join(s.env.CLAUDE_CONFIG_DIR!, 'projects');
  const parseErrors: string[] = [];
  const rows = files(dir)
    .filter((p) => p.endsWith('.jsonl'))
    .flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) => {
          if (!line.trim()) return [];
          try {
            return [{ path, row: JSON.parse(line) }];
          } catch {
            parseErrors.push(`${path}:${index + 1}`);
            return [];
          }
        }),
    );
  const childFiles = new Set(
    rows
      .filter(
        (r) =>
          r.row.type === 'session_meta' &&
          typeof r.row.payload?.source === 'object' &&
          r.row.payload.source?.subagent,
      )
      .map((r) => r.path),
  );
  const primary = rows.filter(
    (r) => !/[\\/]subagents[\\/]/.test(r.path) && !childFiles.has(r.path),
  );
  const messages =
    provider === 'codex'
      ? primary
          .filter(
            (r) =>
              r.row.type === 'event_msg' &&
              r.row.payload?.type === 'item_completed' &&
              r.row.payload.item?.type === 'UserMessage',
          )
          .map((r) => ({
            text:
              r.row.payload.item.content?.map((x: any) => x.text ?? '').join('') ?? '',
            id: r.row.payload.item.id,
            path: r.path,
            timestamp: r.row.timestamp ?? '',
          }))
      : primary
          .filter(
            (r) =>
              r.row.type === 'user' &&
              typeof r.row.message?.content === 'string' &&
              !r.row.isMeta,
          )
          .map((r) => ({
            text: r.row.message.content,
            id: r.row.uuid,
            path: r.path,
            timestamp: r.row.timestamp ?? '',
          }));
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const completedPrompts = new Set<string>();
  const currentPrompt = new Map<string, string>();
  const errors: Array<{ promptId: string; code: string; message: string }> = [];
  for (const { path, row } of primary) {
    if (
      provider === 'codex' &&
      row.type === 'event_msg' &&
      row.payload?.type === 'item_completed' &&
      row.payload.item?.type === 'UserMessage'
    )
      currentPrompt.set(path, row.payload.item.id);
    if (
      provider === 'claude' &&
      row.type === 'user' &&
      typeof row.message?.content === 'string' &&
      !row.isMeta
    )
      currentPrompt.set(path, row.uuid);
    if (
      (provider === 'codex' &&
        row.type === 'event_msg' &&
        ['task_complete', 'task_completed'].includes(row.payload?.type)) ||
      (provider === 'claude' &&
        row.type === 'assistant' &&
        row.message?.stop_reason === 'end_turn')
    ) {
      const id = currentPrompt.get(path);
      if (id) completedPrompts.add(id);
      if (id && provider === 'codex' && row.payload?.error)
        errors.push({
          promptId: id,
          code: String(row.payload.error.codex_error_info ?? 'provider_error'),
          message: String(row.payload.error.message ?? row.payload.error),
        });
    }
  }
  const completed = completedPrompts.size;
  const revisionMap = new Map<string, NativeRevision>();
  const snapshotMap = new Map<string, NativeRevision>();
  const sessions = new Map<string, string>();
  const tools = new Map<
    string,
    { name: string; input: any; session: string; cwd: string }
  >();
  const nativeFile = (file: string, cwd: string) => {
    if (file.startsWith('file:')) return fileURLToPath(file);
    if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return file;
    return resolve(cwd.startsWith('file:') ? fileURLToPath(cwd) : cwd, file);
  };
  const remember = (revision: NativeRevision) =>
    revisionMap.set(
      `${revision.nativeSessionId}\0${revision.nativeId}\0${pathKey(revision.file)}`,
      revision,
    );
  for (const { path, row } of rows) {
    const session =
      provider === 'codex'
        ? row.type === 'session_meta'
          ? row.payload?.id
          : sessions.get(path)
        : (row.sessionId ?? sessions.get(path));
    if (session && (provider !== 'codex' || !sessions.has(path)))
      sessions.set(path, session);
    if (provider === 'claude')
      for (const part of row.message?.content?.filter?.(
        (part: any) => part.type === 'tool_use',
      ) ?? []) {
        tools.set(`${path}\0${part.id}`, {
          name: part.name,
          input: part.input,
          session,
          cwd: row.cwd ?? s.workspace,
        });
      }
  }
  for (const { path, row } of rows) {
    let session = sessions.get(path);
    if (!session) continue;
    const child = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/.exec(path);
    if (provider === 'claude' && child) session += `:agent:${child[1]}`;
    if (provider === 'codex') {
      const item = row.payload?.item;
      if (
        item?.type !== 'FileChange' ||
        item.status !== 'completed' ||
        typeof item.id !== 'string'
      )
        continue;
      for (const [file, change] of Object.entries(item.changes ?? {}) as Array<
        [string, any]
      >) {
        const kind = change.type;
        if (!['add', 'update', 'delete'].includes(kind)) continue;
        const delta =
          typeof change.unified_diff === 'string'
            ? deltaLines(change.unified_diff.split(/\r?\n/))
            : typeof change.content === 'string'
              ? {
                  added: kind === 'add' ? contentLines(change.content) : [],
                  removed: kind === 'delete' ? contentLines(change.content) : [],
                }
              : { added: [], removed: [] };
        remember({
          evidence: 'native-file-change',
          provider,
          nativeSessionId: row.payload.thread_id ?? session,
          nativeId: item.id,
          file: nativeFile(file, s.workspace),
          kind,
          ...delta,
          deltaKnown:
            typeof change.unified_diff === 'string' || typeof change.content === 'string',
          timestamp: row.timestamp,
        });
      }
    } else
      for (const result of row.message?.content?.filter?.(
        (part: any) => part.type === 'tool_result',
      ) ?? []) {
        if (result.is_error || typeof result.tool_use_id !== 'string') continue;
        const structured = row.toolUseResult;
        if (!structured || typeof structured !== 'object') continue;
        const call = tools.get(`${path}\0${result.tool_use_id}`);
        const emit = (
          file: string,
          kind: NativeRevision['kind'],
          delta: { added: string[]; removed: string[] },
          known: boolean,
          evidence: NativeRevision['evidence'] = 'structured-write',
        ) => {
          const revision: NativeRevision = {
            evidence,
            provider,
            nativeSessionId: session!,
            nativeId: result.tool_use_id,
            file: nativeFile(file, call?.cwd ?? row.cwd ?? s.workspace),
            kind,
            ...delta,
            deltaKnown: known,
            timestamp: row.timestamp,
          };
          if (evidence === 'bash-snapshot')
            snapshotMap.set(
              `${revision.nativeSessionId}\0${revision.nativeId}\0${pathKey(revision.file)}`,
              revision,
            );
          else remember(revision);
        };
        if (Array.isArray(structured.bashEditDiff?.files))
          for (const file of structured.bashEditDiff.files) {
            if (typeof file.filePath !== 'string') continue;
            const hunks = Array.isArray(file.hunks) ? file.hunks : [];
            emit(
              file.filePath,
              file.deleted ? 'delete' : file.created ? 'add' : 'update',
              deltaLines(hunks.flatMap((hunk: any) => hunk.lines ?? [])),
              hunks.length > 0,
              'bash-snapshot',
            );
          }
        if (call && ['Write', 'Edit', 'MultiEdit'].includes(call.name)) {
          const file = structured.filePath ?? call.input?.file_path;
          if (typeof file !== 'string') continue;
          const hunks = Array.isArray(structured.structuredPatch)
            ? structured.structuredPatch
            : [];
          if (hunks.length)
            emit(
              file,
              structured.type === 'create' ? 'add' : 'update',
              deltaLines(hunks.flatMap((hunk: any) => hunk.lines ?? [])),
              true,
            );
          else if (structured.type === 'create' && typeof structured.content === 'string')
            emit(
              file,
              'add',
              { added: contentLines(structured.content), removed: [] },
              true,
            );
          else emit(file, 'update', { added: [], removed: [] }, false);
        }
      }
  }
  const appliedRevisions = [...revisionMap.values()];
  const bashSnapshots = [...snapshotMap.values()];
  const calls = rows.flatMap((r) =>
    provider === 'codex'
      ? r.row.type === 'response_item' &&
        ['function_call', 'custom_tool_call'].includes(r.row.payload?.type)
        ? [
            {
              name: r.row.payload.name,
              input: r.row.payload.arguments ?? r.row.payload.input,
            },
          ]
        : []
      : (r.row.message?.content
          ?.filter?.((x: any) => x.type === 'tool_use')
          .map((x: any) => ({ name: x.name, input: JSON.stringify(x.input) })) ?? []),
  );
  const applied = rows.flatMap((r) =>
    provider === 'codex' &&
    r.row.payload?.item?.type === 'FileChange' &&
    r.row.payload.item.status === 'completed'
      ? Object.keys(r.row.payload.item.changes ?? {})
      : [],
  );
  if (provider === 'claude') {
    const edits = new Map<string, string>();
    for (const { row } of rows)
      for (const part of row.message?.content?.filter?.(
        (x: any) => x.type === 'tool_use',
      ) ?? []) {
        if (
          ['Write', 'Edit', 'MultiEdit'].includes(part.name) &&
          typeof part.input?.file_path === 'string'
        )
          edits.set(part.id, part.input.file_path);
      }
    for (const { row } of rows)
      for (const result of row.message?.content?.filter?.(
        (x: any) => x.type === 'tool_result',
      ) ?? []) {
        const path = edits.get(result.tool_use_id);
        if (
          path &&
          !result.is_error &&
          row.toolUseResult &&
          typeof row.toolUseResult === 'object'
        )
          applied.push(path);
      }
  }
  const answers = primary.flatMap((r) =>
    provider === 'codex'
      ? r.row.payload?.item?.type === 'AgentMessage'
        ? [r.row.payload.item.content?.map((x: any) => x.text ?? '').join('') ?? '']
        : []
      : r.row.type === 'assistant'
        ? (r.row.message?.content
            ?.filter?.((x: any) => x.type === 'text')
            .map((x: any) => x.text) ?? [])
        : [],
  );
  const models = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.row.message?.model,
          r.row.type === 'turn_context' ? r.row.payload?.model : undefined,
        ])
        .filter(Boolean),
    ),
  ];
  const childSources = [
    ...new Set(
      rows
        .filter((r) => /[\\/]subagents[\\/]/.test(r.path) || childFiles.has(r.path))
        .map((r) => r.path),
    ),
  ];
  const primarySources = [...new Set(primary.map((r) => r.path))];
  const outcomes = rows.flatMap((r) =>
    provider === 'codex'
      ? r.row.payload?.item?.type === 'CommandExecution'
        ? [
            {
              command: r.row.payload.item.command ?? '',
              exitCode: r.row.payload.item.exit_code ?? r.row.payload.item.exitCode,
              status: r.row.payload.item.status,
            },
          ]
        : []
      : (r.row.message?.content
          ?.filter?.((x: any) => x.type === 'tool_result')
          .map((x: any) => ({
            command: undefined,
            exitCode: undefined,
            status: x.is_error ? 'failed' : 'completed',
          })) ?? []),
  );
  const contexts = primary
    .filter((r) =>
      provider === 'codex'
        ? r.row.type === 'response_item' && r.row.payload?.role === 'developer'
        : r.row.type === 'api-request-blob' &&
          ['system', 'user'].includes(r.row.message?.role),
    )
    .map((r) =>
      JSON.stringify(
        provider === 'codex'
          ? (r.row.payload.content ?? '')
          : (r.row.message.content ?? ''),
      ),
    );
  const toolInputs = new Map<string, string>();
  for (const { row } of rows) {
    if (
      provider === 'codex' &&
      row.type === 'response_item' &&
      ['function_call', 'custom_tool_call'].includes(row.payload?.type)
    )
      toolInputs.set(
        row.payload.call_id,
        String(row.payload.arguments ?? row.payload.input ?? ''),
      );
    if (provider === 'claude')
      for (const part of row.message?.content?.filter?.(
        (x: any) => x.type === 'tool_use',
      ) ?? [])
        toolInputs.set(part.id, part.input?.command ?? JSON.stringify(part.input));
  }
  for (const { row } of rows) {
    if (
      provider === 'codex' &&
      row.type === 'response_item' &&
      ['function_call_output', 'custom_tool_call_output'].includes(row.payload?.type)
    ) {
      const output =
        typeof row.payload.output === 'string'
          ? row.payload.output
          : JSON.stringify(row.payload.output);
      outcomes.push({
        command: toolInputs.get(row.payload.call_id) ?? '',
        exitCode: undefined,
        status: /Script failed|exit code:\s*[1-9]|Process exited with code [1-9]/i.test(
          output,
        )
          ? 'failed'
          : 'completed',
      });
    }
    if (provider === 'claude')
      for (const result of row.message?.content?.filter?.(
        (x: any) => x.type === 'tool_result',
      ) ?? []) {
        const command = toolInputs.get(result.tool_use_id) ?? '';
        const output = JSON.stringify(row.toolUseResult ?? result.content);
        outcomes.push({
          command,
          exitCode: undefined,
          status:
            result.is_error ||
            /error:\s*(?:No test files|Cannot find|Module not found)|exit code[: ]+[1-9]/i.test(
              output,
            )
              ? 'failed'
              : 'completed',
        });
      }
  }
  return {
    errors,
    messages,
    completed,
    completedIds: [...completedPrompts],
    calls,
    answers,
    applied,
    appliedRevisions,
    bashSnapshots,
    models,
    childSources,
    primarySources,
    outcomes,
    parseErrors,
    contexts,
    sourceFiles: [...new Set(rows.map((r) => r.path))],
    children: rows.filter(
      (r) => /[\\/]subagents[\\/]/.test(r.path) || childFiles.has(r.path),
    ).length,
  };
}
