import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, tree } from './centralHelpers.ts';
import { importLegacy } from '../src/core/legacyImport.ts';
import { HistoryStore } from '../src/core/history.ts';

test('legacy journal recovery is explicit, audited, repeatable, and preserves originals', () =>
  fixture(({ dir }) => {
    const base = join(dir, 'older-project', '.showtail');
    const journal = join(base, 'authors', 'student', 'journal', 'machine');
    mkdirSync(journal, { recursive: true });
    writeFileSync(
      join(base, 'config.json'),
      JSON.stringify({ version: 5, trailId: 'trl_damaged', project: 'Older project' }),
    );
    const first = {
      v: 1,
      id: 'first',
      kind: 'event',
      type: 'prompt',
      ts: '2026-01-01T00:00:00.000Z',
      textPreview: 'Readable work',
    };
    const last = {
      ...first,
      id: 'last',
      ts: '2026-01-01T00:01:00.000Z',
      prev: 'broken-legacy-hash',
      textPreview: 'Later readable work',
    };
    writeFileSync(
      join(journal, '0001.log'),
      [
        JSON.stringify(first),
        '{unreadable row password=DoNotPrintThis123',
        JSON.stringify(last),
      ].join('\n'),
    );
    const original = tree(base);
    expect(() => importLegacy([base])).toThrow('LEGACY_INVALID_JSON');
    const preview = importLegacy([base], { dryRun: true, recoverDamaged: true });
    expect(preview.records).toBe(2);
    expect(preview.warnings.join(' ')).not.toContain('DoNotPrintThis123');
    expect(importLegacy([base], { recoverDamaged: true }).imported).toBe(2);
    expect(importLegacy([base], { recoverDamaged: true }).imported).toBe(0);
    using store = new HistoryStore();
    expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(2);
    expect(store.records().filter((r) => r.kind === 'audit')).toHaveLength(1);
    expect(
      store
        .records()
        .filter((r) => r.kind === 'prompt')
        .every((r) => r.provenance?.legacyIntegrity === 'unverified'),
    ).toBe(true);
    expect(store.verify().ok).toBe(true);
    expect(tree(base)).toEqual(original);
  }));
