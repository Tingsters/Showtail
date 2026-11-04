import type { ReportData } from '../../types.ts';
import type { ViewerTextStore } from './viewerCodec.ts';

/** Internal portable viewer contract; independent of the public report schema. */
export interface ViewerItem {
  id: string;
  kind: 'ai' | 'tool' | 'decision' | 'plan' | 'revision' | 'observation' | 'note';
  title: string;
  preview: string;
  timestamp: string;
  textRef?: string;
  /** Complete provider records are inspectable without repeating them in the prose. */
  rawRefs?: string[];
  resultRef?: string;
  nativeOnly?: boolean;
  planStatus?: 'approved' | 'revised' | 'none';
  feedback?: string;
  nonBlocking?: boolean;
  path?: string;
  linkPath?: string;
  capturedOnly?: boolean;
  recordId?: string;
  sourceId?: string;
  isError?: boolean;
  sha256?: string;
  basis?: string;
  toolOutcome?: 'failed' | 'succeeded';
  toolCallId?: string;
  turnId?: string;
  tags?: string[];
  nativeEvents?: {
    sourceId?: string;
    type: string;
    sequence: number;
    timestamp?: string;
  }[];
  evidence?: NonNullable<ReportData['fileObservations']>;
}

export interface ViewerUsageStats {
  totalDurationMs: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheReadTokens: number | null;
  totalCacheCreationTokens: number | null;
  turnCount: number;
  recapCount: number;
  durationCount: number;
  tokenCount: number;
  metricCounts: Record<
    | 'durationMs'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheCreationTokens',
    number
  >;
}

export interface ViewerPlan extends ViewerItem {
  kind: 'plan';
  status: 'approved' | 'revised' | 'none';
  tool: string;
  author: string;
  actorSlug?: string;
  planPath?: string;
  sessionId?: string;
  itemId?: string;
  capturedRecords: number;
  aliases: string[];
}

export interface ViewerSession {
  id: string;
  label: string;
  from: string;
  to: string;
  tool: string;
  authors: string[];
  models: string[];
  turnIds: string[];
  unlinkedIds: string[];
  promptCount: number;
  revisionCount: number;
  fileCount: number;
  planCount: number;
  decisionCount: number;
  failedTools: number;
  stats: ViewerUsageStats;
}

export interface ViewerTurn {
  id: string;
  sessionId: string;
  sourceId?: string;
  actorSlug?: string;
  recap?: Omit<import('../../types.ts').Event, 'text'>;
  recapRef?: string;
  signals?: import('./data.ts').TurnSignals;
  toolSummary?: import('./data.ts').ToolRunSummary;
  longTurn?: boolean;
  timestamp: string;
  preview: string;
  promptRef?: string;
  tool: string;
  models: string[];
  author: string;
  itemIds: string[];
  itemsRef?: string;
  itemCount?: number;
  revisionCount?: number;
  files: string[];
  unlinked?: boolean;
}

export interface ViewerIndex {
  viewerPayloadVersion: 1;
  title: string;
  generatedAt: string;
  aiMode: 'full' | 'collapsed' | 'off';
  summary: ReportData['summary'];
  coverage?: ReportData['coverage'];
  contributors: ReportData['contributors'];
  tools: ReportData['tools'];
  models: ReportData['models'];
  authorship: string;
  plans?: ViewerPlan[];
  sessions?: ViewerSession[];
  usage?: ViewerUsageStats;
  toolTimeline?: ReportData['toolTimeline'];
  redactionCount?: number;
  scope?: ReportData['scope'];
  uniqueFileCount?: number;
  turns: ViewerTurn[];
  unlinked: ViewerTurn[];
  observations: ViewerItem[];
  items: Record<string, ViewerItem>;
  aliases: Record<string, string>;
  textStore: ViewerTextStore;
}

/** Hydrate the schema independently for validation; bootstrap never expands the full index. */
export function expandViewerIndex(
  index: ViewerIndex,
  texts: Map<string, string>,
): ViewerIndex {
  const items: Record<string, ViewerItem> = Object.assign(
    Object.create(null),
    index.items,
  );
  const expand = (turn: ViewerTurn): ViewerTurn => {
    if (!turn.itemsRef) return { ...turn, itemIds: [...turn.itemIds] };
    const value = texts.get(turn.itemsRef);
    if (value === undefined) throw new Error('Missing exchange metadata');
    const rows = JSON.parse(value) as ViewerItem[];
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) => !row || typeof row.id !== 'string' || typeof row.kind !== 'string',
      )
    )
      throw new Error('Invalid exchange metadata');
    for (const row of rows) {
      if (items[row.id]) throw new Error('Duplicate viewer item identity');
      if (row.textRef && !texts.has(row.textRef)) throw new Error('Missing item content');
      items[row.id] = row;
    }
    return { ...turn, itemIds: rows.map((row) => row.id) };
  };
  return {
    ...index,
    turns: index.turns.map(expand),
    unlinked: index.unlinked.map(expand),
    items,
  };
}
