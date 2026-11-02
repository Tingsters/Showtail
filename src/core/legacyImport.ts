/** Read-only adapters for pre-central-store data. No legacy writer is used here. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  HistoryStore,
  containsPath,
  digest,
  type RecordInput,
  type SessionInput,
} from './history.ts';
import { dataHome } from './dataHome.ts';
import { checkChain } from './journal.ts';
import type { JournalEntry } from '../types.ts';

interface LegacyItem {
  session: SessionInput;
  input: RecordInput;
  source: string;
  originalId: string;
  turn?: string;
  aliases: string[];
  canonicalRecord?: boolean;
  project?: { root: string; name?: string; trailId?: string };
}
export interface LegacyPreview {
  sources: string[];
  records: number;
  sessions: number;
  warnings: string[];
  imported?: number;
  duplicates?: number;
}
function json<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function lines(path: string, recoveryWarnings?: string[]): any[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        if (recoveryWarnings) {
          recoveryWarnings.push(
            `LEGACY_INVALID_JSON: ${path}, line ${index + 1}; unreadable row preserved in the original source.`,
          );
          return undefined;
        }
        throw new Error(
          `LEGACY_INVALID_JSON: ${path}, line ${index + 1}. Source unchanged.`,
        );
      }
    })
    .filter((value) => value !== undefined);
}
function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(path, entry.name))
    .sort();
}
function object(base: string, ref: string): string {
  const hash = ref.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('LEGACY_INVALID_OBJECT_REF');
  const path = join(base, 'objects', hash.slice(0, 2), hash.slice(2));
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`LEGACY_OBJECT_MISSING: ${hash}`);
  const content = readFileSync(path, 'utf8');
  if (digest(content) !== hash) throw new Error(`LEGACY_OBJECT_CHANGED: ${hash}`);
  return content;
}

function loadLedger(base: string, items: LegacyItem[], warnings: string[]): void {
  const source = `legacy-ledger:${resolve(base)}`;
  for (const dir of directories(join(base, 'sessions'))) {
    if (!existsSync(join(dir, 'session.json')) || !existsSync(join(dir, 'records.jsonl')))
      continue;
    const session = json(join(dir, 'session.json'));
    if (!session.id || !session.tool || !session.nativeSessionId)
      throw new Error('LEGACY_SESSION_INVALID');
    const records = lines(join(dir, 'records.jsonl'));
    const known = new Set<string>();
    for (const r of records) {
      if (!r.id || !r.kind || !Number.isFinite(Date.parse(r.ts)))
        throw new Error('LEGACY_RECORD_INVALID');
      if (r.supersedesRecordId && !known.has(r.supersedesRecordId))
        throw new Error('LEGACY_CORRECTION_PREDECESSOR_MISSING');
      known.add(r.id);
      const {
        tool: _tool,
        turnKey: _turn,
        supersedesRecordId: _supersedes,
        context,
        planFileContent,
        planFileSourceId,
        transcriptFinal: _final,
        ...fields
      } = r;
      const sourceId = r.sourceId ?? `ledger:${session.id}:${r.id}`;
      items.push({
        source,
        originalId: r.id,
        canonicalRecord: true,
        aliases: [
          sourceId,
          ...(r.supersedesRecordId ? [`${sourceId}:revision:${r.id}`] : []),
        ],
        turn: r.turnKey,
        session: {
          tool: session.tool,
          nativeSessionId: session.nativeSessionId,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          cwd: session.cwd,
          workspacePaths: session.workspacePaths,
          authorId: session.slug ? `legacy:${session.slug}` : undefined,
          authorName: session.slug,
          transcriptPath: session.transcriptPath,
        },
        input: {
          ...fields,
          text: planFileContent ?? fields.text,
          sourceId,
          context,
          transcriptFinal: r.transcriptFinal,
          provenance: { source, id: r.id },
        },
      });
      if (planFileSourceId) items[items.length - 1]!.aliases.push(planFileSourceId);
    }
  }
  warnings.push(
    'Legacy ledger records have no journal hash chain; their original syntax and correction references were checked.',
  );
}

function loadProject(
  base: string,
  items: LegacyItem[],
  warnings: string[],
  recoverDamaged = false,
): void {
  const config = json(join(base, 'config.json'));
  const root = dirname(base);
  const source = `legacy-project:${resolve(base)}`;
  const project = { root, name: config.project, trailId: config.trailId };
  for (const authorDir of directories(join(base, 'authors'))) {
    const slug = basename(authorDir);
    const author = existsSync(join(authorDir, 'author.json'))
      ? json(join(authorDir, 'author.json'))
      : { name: slug };
    const sessions = new Map<string, any>();
    for (const index of [
      join(authorDir, 'sessions.json'),
      ...(() => {
        const dir = join(authorDir, 'sessions');
        return existsSync(dir)
          ? readdirSync(dir)
              .filter((f) => f.endsWith('.json'))
              .map((f) => join(dir, f))
          : [];
      })(),
    ]) {
      if (!existsSync(index)) continue;
      const contents = json(index);
      for (const session of Array.isArray(contents)
        ? contents
        : (contents.sessions ?? []))
        sessions.set(session.id, session);
    }
    const journal = join(authorDir, 'journal');
    // Very early trails had unsharded segments directly under journal/.
    const shards = [...directories(journal), journal];
    for (const shard of shards) {
      if (!existsSync(shard)) continue;
      const warningCount = warnings.length;
      const entries: JournalEntry[] = readdirSync(shard)
        .filter((name) => /^\d+\.log$/.test(name))
        .sort()
        .flatMap((name) =>
          lines(join(shard, name), recoverDamaged ? warnings : undefined),
        );
      const chain = checkChain(entries);
      if (chain.breaks.length && !recoverDamaged)
        throw new Error(
          `LEGACY_CHAIN_BROKEN: ${base} (${chain.breaks.length} breaks). Source unchanged.`,
        );
      if (chain.breaks.length)
        warnings.push(
          `LEGACY_CHAIN_BROKEN: ${base} (${chain.breaks.length} breaks); recovered records retain unverified legacy provenance.`,
        );
      const unverified = warningCount !== warnings.length;
      if (chain.unchained)
        warnings.push(`${chain.unchained} legacy journal entries predate hash chaining.`);
      for (const entry of entries) {
        if (!entry.id || !Number.isFinite(Date.parse(entry.ts)))
          throw new Error('LEGACY_RECORD_INVALID');
        const session = sessions.get(entry.conv ?? '');
        const content = (entry.refs ?? []).map((ref) => object(base, ref)).join('\n');
        const kind =
          entry.kind === 'artifact'
            ? 'edit'
            : entry.kind === 'conversation'
              ? 'conversation_event'
              : entry.kind === 'redaction' || entry.kind === 'enrichment'
                ? 'audit'
                : entry.type === 'artifact'
                  ? 'audit'
                  : (entry.type as RecordInput['kind']);
        const tool = entry.tool ?? session?.tool ?? 'cli';
        const {
          id,
          ts,
          sourceId,
          turn,
          model,
          tags,
          toolName,
          isError,
          gitCommit,
          gitBranch,
          durationMs,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        } = entry;
        const input: RecordInput = {
          id,
          kind,
          ts,
          sourceId: sourceId ?? `legacy:${config.trailId ?? source}:${slug}:${id}`,
          model,
          tags,
          toolName,
          isError,
          gitCommit,
          gitBranch,
          durationMs,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          provenance: {
            source,
            id,
            ...(unverified ? { legacyIntegrity: 'unverified' as const } : {}),
          },
        };
        if (kind === 'edit') {
          input.file = resolve(root, entry.linkPath ?? entry.path ?? 'unknown-file');
          input.sha256 = entry.sha256;
          input.diff = entry.diffHash ? object(base, entry.diffHash) : undefined;
        } else if (kind === 'conversation_event')
          input.conversationEvent = JSON.parse(content);
        else
          input.text =
            content ||
            entry.textPreview ||
            (kind === 'audit'
              ? 'Legacy history transformation (original audit preserved by import provenance).'
              : '');
        items.push({
          input,
          source,
          originalId: id,
          aliases: sourceId ? [sourceId] : [],
          turn,
          project,
          session: {
            tool,
            nativeSessionId:
              session?.nativeSessionId ??
              session?.claudeSessionId ??
              `legacy:${config.trailId ?? source}:${slug}:${entry.conv ?? id}`,
            startedAt: session?.startedAt ?? entry.ts,
            endedAt: session?.endedAt,
            cwd: root,
            authorId: `legacy:${slug}`,
            authorName: author.name ?? slug,
          },
        });
      }
    }
  }
}

export function importLegacy(
  sources: string[],
  options: { dryRun?: boolean; recoverDamaged?: boolean } = {},
): LegacyPreview {
  if (!sources.length) throw new Error('Provide at least one --from path.');
  const items: LegacyItem[] = [];
  const warnings: string[] = [];
  const paths = [...new Set(sources.map((p) => resolve(p)))];
  const ledgers: string[] = [];
  const projects: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`LEGACY_SOURCE_MISSING: ${path}`);
    if (containsPath(path, dataHome()) || containsPath(dataHome(), path))
      throw new Error(
        'LEGACY_SOURCE_OVERLAPS_STORE: use a separate SHOWTAIL_HOME; the original must remain untouched.',
      );
    const project = existsSync(join(path, '.showtail', 'config.json'))
      ? join(path, '.showtail')
      : path;
    if (existsSync(join(project, 'config.json')) && existsSync(join(project, 'authors')))
      projects.push(project);
    else if (existsSync(join(path, 'ledger', 'sessions')))
      ledgers.push(join(path, 'ledger'));
    else if (existsSync(join(path, 'sessions'))) ledgers.push(path);
    else throw new Error(`LEGACY_SOURCE_UNRECOGNIZED: ${path}`);
  }
  // Source order must not decide whether a journal projection is duplicated.
  for (const path of new Set(ledgers)) loadLedger(path, items, warnings);
  for (const path of new Set(projects))
    loadProject(path, items, warnings, options.recoverDamaged);
  const result: LegacyPreview = {
    sources: paths,
    records: items.length,
    sessions: new Set(items.map((i) => `${i.session.tool}:${i.session.nativeSessionId}`))
      .size,
    warnings: [...new Set(warnings)],
  };
  if (options.dryRun) return result;
  using store = new HistoryStore();
  let imported = 0;
  let duplicates = 0;
  const turnMap = new Map<string, string>();
  for (const item of items) {
    store
      .transaction(() => {
        const session = store.ensureSession(item.session);
        const old = store.importRecord(item.source, item.originalId);
        // Ledger revisions share source IDs. Only projected journal copies may
        // deduplicate against aliases; every original ledger record must be replayed.
        let record =
          old ??
          (item.canonicalRecord
            ? undefined
            : item.aliases
                .map((alias) => store.bySource(session.id, alias))
                .find(Boolean));
        if (record) duplicates++;
        else {
          const turnId = item.turn
            ? (turnMap.get(`${item.source}:${item.turn}`) ??
              store.importRecord(item.source, item.turn)?.turnId)
            : undefined;
          const appended = store.append(session.id, { ...item.input, turnId });
          record = appended.record;
          if (appended.inserted) imported++;
          else duplicates++;
        }
        if (!record) return;
        if (
          item.session.endedAt &&
          item.session.endedAt >= store.session(session.id)!.lastSeenAt
        )
          store.endSession(session.id, item.session.endedAt);
        store.noteImport(item.source, item.originalId, record.id);
        turnMap.set(`${item.source}:${item.originalId}`, record.turnId ?? record.id);
        for (const alias of item.aliases)
          if (!store.bySource(session.id, alias))
            store.alias(session.id, alias, record.id);
        // A legacy accidental HOME trail must not become a catch-all project view.
        if (
          item.project &&
          !(
            containsPath(homedir(), item.project.root) &&
            containsPath(item.project.root, homedir())
          )
        ) {
          const project = store.registerProject(
            item.project.root,
            item.project.name,
            item.project.trailId,
          );
          if (item.project.trailId)
            store.setMeta(`projectAlias:${item.project.trailId}`, project.projectId);
          store
            .query("INSERT OR IGNORE INTO turn_projects VALUES (?,?,'context')")
            .run(record.turnId ?? record.id, project.projectId);
        }
      })
      .immediate();
  }
  if (items.some((item) => item.input.provenance?.legacyIntegrity === 'unverified')) {
    const key = digest(JSON.stringify({ sources: paths, warnings: result.warnings }));
    const session = store.ensureSession({
      tool: 'cli',
      nativeSessionId: `legacy-recovery:${key}`,
    });
    store.append(session.id, {
      kind: 'audit',
      sourceId: `legacy-recovery:${key}`,
      text: `Declared legacy recovery. Readable records were imported from a damaged journal; their legacy integrity is unverified. Original source bytes must be retained.\n${result.warnings.join('\n')}`,
    });
  }
  store.setMeta(
    `legacyImport:${randomImportId()}`,
    JSON.stringify({
      sources: paths,
      imported,
      duplicates,
      at: new Date().toISOString(),
      warnings: result.warnings,
    }),
  );
  return { ...result, imported, duplicates };
}
function randomImportId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
