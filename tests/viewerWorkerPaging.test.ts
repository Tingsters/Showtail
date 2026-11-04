import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ViewerTextStoreBuilder } from '../src/core/report/viewerCodec.ts';

function engine(turnItems: Record<string, any[]>, extra: Record<string, unknown> = {}) {
  const builder = new ViewerTextStoreBuilder();
  const turns = Object.entries(turnItems).map(([id, items]) => ({
    id,
    sessionId: id,
    preview: id,
    tool: 'Fixture',
    author: 'Fixture',
    models: [],
    itemsRef: builder.add(JSON.stringify(items)),
    itemIds: [],
  }));
  const additional = extra.makeRefs
    ? (extra.makeRefs as (b: ViewerTextStoreBuilder) => object)(builder)
    : {};
  const encoded = builder.finish();
  const blocks = new Map(encoded.blocks.map((b) => [b.id, b.data]));
  const sandbox: any = {
    TextEncoder,
    TextDecoder,
    DecompressionStream,
    ReadableStream,
    Uint8Array,
    atob,
    performance,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(readFileSync('assets/report/viewer-worker.js', 'utf8'), sandbox);
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (r: any) => void; reject: (e: Error) => void }
  >();
  const worker = sandbox.ShowtailReportWorker.create((message: any) => {
    if (message.type === 'needChunk') {
      void worker.handle({
        type: 'chunk',
        chunk: message.chunk,
        data: blocks.get(message.chunk),
      });
    } else if (!message.progress) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      if (message.ok) p.resolve(message.result);
      else p.reject(new Error(message.error));
    }
  });
  const call = (type: string, fields = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      void worker.handle({ id, type, ...fields });
    });
  const ready = call('init', {
    manifest: {
      viewerPayloadVersion: 1,
      turns,
      unlinked: [],
      items: {},
      aliases: {},
      observations: [],
      textStore: encoded.store,
      ...additional,
    },
  });
  return { call, ready, store: encoded.store, additional };
}

const tool = (n: number) => ({
  id: `tool-${n}`,
  sourceId: `native-${n}`,
  kind: 'tool',
  title: 'Bash',
  preview: `command ${n}`,
  timestamp: '2026-01-01T00:00:00.000Z',
});

test('twenty thousand tools stay in the worker and only twenty mounted rows cross the bridge', async () => {
  const { call, ready } = engine({
    dense: Array.from({ length: 20000 }, (_, n) => tool(n)),
  });
  await ready;
  const first = await call('getTurnPage', { turnId: 'dense', page: 0 });
  expect(first.items).toHaveLength(20);
  expect(first.total).toBe(20000);
  expect(JSON.stringify(first).length).toBeLessThan(10000);
  const last = await call('getTurnPage', { turnId: 'dense', itemId: 'tool-19999' });
  expect(last.page).toBe(999);
  expect(last.items.at(-1).id).toBe('tool-19999');
  expect(last.selected.id).toBe('tool-19999');
  const cache = await call('stats');
  expect(cache.cachedMetadata).toBe(1);
  expect(cache.peakCachedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test('concurrent exchange pages do not cancel one another or expose every exchange', async () => {
  const { call, ready } = engine(
    Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`turn-${n}`, [tool(n)]])),
  );
  await ready;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, n) => call('getTurnPage', { turnId: `turn-${n}` })),
  );
  expect(results.map((r) => r.items[0].id)).toEqual(
    Array.from({ length: 10 }, (_, n) => `tool-${n}`),
  );
});

test('tool runs retain chronology and page their members with accurate failure totals', async () => {
  const items = [
    { id: 'ai', kind: 'ai' },
    ...Array.from({ length: 42 }, (_, n) => ({ ...tool(n), isError: n === 7 })),
    { id: 'plan', kind: 'plan' },
    tool(42),
    tool(43),
  ];
  const { call, ready } = engine({ turn: items });
  await ready;
  const groups = await call('getTurnPage', { turnId: 'turn', groupTools: true });
  expect(groups.items.map((i: any) => i.kind)).toEqual([
    'ai',
    'tool_group',
    'plan',
    'tool_group',
  ]);
  expect(groups.items[1].count).toBe(42);
  expect(groups.items[1].failed).toBe(1);
  const members = await call('getTurnPage', {
    turnId: 'turn',
    groupId: groups.items[1].id,
    page: 1,
  });
  expect(members.items).toHaveLength(20);
  expect(members.items[0].id).toBe('tool-20');
  expect(members.total).toBe(42);
  expect(members.pages).toBe(3);
  const linked = await call('getTurnPage', {
    turnId: 'turn',
    groupTools: true,
    itemId: 'tool-41',
  });
  expect(linked.items[1]).toMatchObject({
    selected: true,
    selectedItemId: 'tool-41',
    selectedPage: 2,
  });
});

test('decoded metadata competes with raw chunks in the same sixteen MiB LRU', async () => {
  const { call, ready } = engine(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => [
        `turn-${n}`,
        Array.from({ length: 1000 }, (_, i) => ({
          ...tool(n * 1000 + i),
          preview: 'x'.repeat(800),
        })),
      ]),
    ),
  );
  await ready;
  for (let n = 0; n < 12; n++) await call('getTurnPage', { turnId: `turn-${n}` });
  const stats = await call('stats');
  expect(stats.peakCachedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(stats.cachedMetadata).toBeLessThan(12);
  expect((await call('getTurnPage', { turnId: 'turn-0' })).items[0].id).toBe('tool-0');
});

test('file groups and revisions are paged separately and native wrappers stay outside display counts', async () => {
  const items = Array.from({ length: 50 }, (_, n) => [
    { id: `revision-${n}-a`, kind: 'revision', path: `file-${n}.ts` },
    { id: `revision-${n}-b`, kind: 'revision', path: `file-${n}.ts` },
  ]).flat();
  items.push({ id: 'wrapper', kind: 'plan', nativeOnly: true } as any);
  const { call, ready } = engine({ turn: items });
  await ready;
  const files = await call('getTurnPage', { turnId: 'turn', kind: 'files', page: 2 });
  expect(files.fileGroups).toHaveLength(10);
  expect(files.total).toBe(50);
  expect(files.counts.total).toBe(100);
  const revisions = await call('getTurnPage', { turnId: 'turn', filePath: 'file-49.ts' });
  expect(revisions.items.map((i: any) => i.id)).toEqual([
    'revision-49-a',
    'revision-49-b',
  ]);
});

test('search includes orphan plan feedback, readable tool results, raw evidence and recap text', async () => {
  const { call, ready } = engine(
    { turn: [] },
    {
      makeRefs(builder: ViewerTextStoreBuilder) {
        const resultRef = builder.add('result-channel-canary'),
          rawRef = builder.add('raw-provider-canary');
        const itemsRef = builder.add(
          JSON.stringify([{ ...tool(1), resultRef, rawRefs: [rawRef] }]),
        );
        return {
          plans: [
            {
              id: 'orphan-plan',
              title: 'Plan',
              feedback: 'feedback-canary',
              textRef: builder.add('orphan-plan-body'),
            },
          ],
          turns: [
            {
              id: 'turn',
              itemsRef,
              itemIds: [],
              recapRef: builder.add('recap-channel-canary'),
            },
          ],
        };
      },
    },
  );
  await ready;
  for (const query of [
    'result-channel-canary',
    'raw-provider-canary',
    'recap-channel-canary',
  ]) {
    const result = await call('search', { query });
    expect(result.matches.prompts).toEqual(['turn']);
  }
  const plans = await call('search', { query: 'feedback-canary' });
  expect(plans.matches.plans).toEqual(['orphan-plan']);
});

test('native-only supporting plan records remain searchable, paged and directly inspectable', async () => {
  let finalRef = '';
  const { call, ready } = engine(
    {},
    {
      makeRefs(builder: ViewerTextStoreBuilder) {
        finalRef = builder.add('Exact supporting native plan source canary');
        const native = Array.from({ length: 25 }, (_, n) => ({
          id: `native-source-${n}`,
          kind: 'plan',
          nativeOnly: true,
          textRef: finalRef,
          sourceId: `native-plan-source-${n}`,
        }));
        return {
          turns: [
            {
              id: 'turn',
              itemIds: [],
              itemsRef: builder.add(
                JSON.stringify([{ id: 'canonical-plan', kind: 'plan' }, ...native]),
              ),
            },
          ],
        };
      },
    },
  );
  await ready;
  const canonical = await call('getTurnPage', { turnId: 'turn' });
  expect(canonical.items.map((item: any) => item.id)).toEqual(['canonical-plan']);
  expect(canonical.counts).toMatchObject({ total: 1, native: 25, byKind: { plan: 1 } });
  const native = await call('getTurnPage', { turnId: 'turn', kind: 'native', page: 1 });
  expect(native.items).toHaveLength(5);
  const linked = await call('getTurnPage', {
    turnId: 'turn',
    itemId: 'native-source-24',
  });
  expect(linked.kind).toBe('native');
  expect(linked.page).toBe(1);
  expect(linked.selected.id).toBe('native-source-24');
  expect((await call('getPage', { ref: linked.selected.textRef, page: 0 })).text).toBe(
    'Exact supporting native plan source canary',
  );
  expect(
    (await call('search', { query: 'supporting native plan source' })).matches.prompts,
  ).toEqual(['turn']);
});

test('rich pages carry fence and table state while raw download remains byte-for-byte complete', async () => {
  const source =
    '```js\n' +
    Array.from({ length: 220 }, (_, n) => `const value_${n} = ${n};`).join('\n') +
    '\n```\nAfter the fence.';
  const table =
    '| A | B |\n|---|---|\n' +
    Array.from({ length: 220 }, (_, n) => `| ${n} | value |`).join('\n');
  let wideTableRef = '',
    fencedRef = '',
    tableRef = '',
    giantRef = '';
  const { call, ready } = engine(
    {},
    {
      makeRefs(builder: ViewerTextStoreBuilder) {
        fencedRef = builder.add(source);
        tableRef = builder.add(table);
        wideTableRef = builder.add(
          '| ' +
            'header'.repeat(500) +
            ' | B |\n|---|---|\n' +
            Array.from({ length: 220 }, (_, n) => `| ${n} | value |`).join('\n'),
        );
        giantRef = builder.add('x'.repeat(70000));
        return {};
      },
    },
  );
  await ready;
  const second = await call('getRichPage', { ref: fencedRef, page: 1 });
  expect(second.context.fence).toMatchObject({ marker: '```', language: 'js' });
  expect(second.context.partialLine).toBe(false);
  const continuation = await call('getRichPage', { ref: tableRef, page: 1 });
  expect(continuation.context.table.header).toBe('| A | B |');
  expect(
    (await call('getRichPage', { ref: wideTableRef, page: 1 })).context.table,
  ).toEqual({ oversized: true });
  const giant = await call('getRichPage', { ref: giantRef, page: 1 });
  expect(giant.context.partialLine).toBe(true);
  expect((await call('download', { ref: fencedRef })).parts.join('')).toBe(source);
  expect((await call('download', { ref: tableRef })).parts.join('')).toBe(table);
});

test('a quoted-looking closing fence inside ordinary code does not terminate continuation state', async () => {
  let ref = '';
  const source =
    '```text\n> ```\n' +
    Array.from({ length: 220 }, (_, n) => `> kept operator ${n}`).join('\n') +
    '\n```';
  const { call, ready } = engine(
    {},
    {
      makeRefs(builder: ViewerTextStoreBuilder) {
        ref = builder.add(source);
        return {};
      },
    },
  );
  await ready;
  const page = await call('getRichPage', { ref, page: 1 });
  expect(page.context.fence).toMatchObject({ marker: '```', quoteDepth: 0 });
});
