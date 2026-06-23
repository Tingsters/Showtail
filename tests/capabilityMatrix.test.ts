import { describe, expect, test } from 'bun:test';
import {
  CAPABILITIES,
  INTEGRATION_IDS,
  fullClaimIsStructural,
  matrixJson,
  renderMatrixMarkdown,
} from '../src/core/capabilityMatrix.ts';
import { PLUGINS, labelForTool } from '../src/plugins/registry.ts';

describe('capability matrix invariants', () => {
  test('columns are every plugin in registry order, then cli', () => {
    expect(INTEGRATION_IDS).toEqual([...PLUGINS.map((p) => p.id), 'cli']);
  });

  test('every capability has a cell for every integration (no holes)', () => {
    for (const cap of CAPABILITIES) {
      for (const id of INTEGRATION_IDS) {
        expect(cap.cells[id], `${cap.id} missing cell for ${id}`).toBeDefined();
      }
    }
  });

  test('capability ids are unique', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every non-full cell carries an explanatory note', () => {
    for (const cap of CAPABILITIES) {
      for (const id of INTEGRATION_IDS) {
        const cell = cap.cells[id]!;
        if (cell.status !== 'full') {
          expect(
            cell.note?.trim(),
            `${cap.id}:${id} (${cell.status}) needs a note`,
          ).toBeTruthy();
        }
      }
    }
  });

  test('every full claim satisfies the capability’s structural requirement', () => {
    // A cell may only say "full" for a hook/import/scope capability if the
    // plugin actually declares the matching machinery. This ties the claim to
    // the real plugin contract so the matrix can't over-claim structurally.
    for (const cap of CAPABILITIES) {
      for (const id of INTEGRATION_IDS) {
        if (cap.cells[id]!.status !== 'full') continue;
        expect(
          fullClaimIsStructural(cap, id),
          `${cap.id}:${id} claims full but the plugin lacks the required capability`,
        ).toBe(true);
      }
    }
  });

  test('full claims line up with the plugin registry for capture and import', () => {
    const full = (capId: string, id: string) =>
      CAPABILITIES.find((c) => c.id === capId)!.cells[id]!.status === 'full';
    // Hook-based capture full ⇒ a hooks adapter exists.
    expect(full('live-capture-hooks', 'claude-code')).toBe(true);
    expect(full('live-capture-hooks', 'codex')).toBe(true);
    expect(full('live-capture-hooks', 'github-copilot')).toBe(false); // no hooks adapter
    // AI-reply reconcile full ⇒ a transcript reader exists (only Claude Code).
    expect(full('auto-ai-output-capture', 'claude-code')).toBe(true);
    expect(full('auto-ai-output-capture', 'codex')).toBe(false);
    // Import full ⇒ an import capability exists.
    expect(full('session-import', 'chatgpt')).toBe(true);
    expect(full('session-import', 'codex')).toBe(false);
  });
});

describe('capability matrix rendering', () => {
  test('renders one header column per integration and never emits undefined', () => {
    const md = renderMatrixMarkdown();
    for (const id of INTEGRATION_IDS) expect(md).toContain(labelForTool(id));
    expect(md).not.toContain('undefined');
    // Header + divider + one row per capability.
    const tableRows = md.split('\n').filter((l) => l.startsWith('|'));
    expect(tableRows.length).toBe(CAPABILITIES.length + 2);
  });

  test('json view is serializable and covers every cell', () => {
    const json = matrixJson();
    expect(json.integrations.map((i) => i.id)).toEqual(INTEGRATION_IDS);
    expect(json.capabilities.length).toBe(CAPABILITIES.length);
    // Round-trips through JSON (no functions leaked in).
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
