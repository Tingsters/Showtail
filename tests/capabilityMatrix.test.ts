import { describe, expect, test } from 'bun:test';
import {
  CAPABILITIES,
  INTEGRATIONS,
  INTEGRATION_IDS,
  STATUS_EMOJI,
  cellFor,
  fullClaimIsStructural,
  fullClaims,
  matrixJson,
  renderMatrixMarkdown,
} from '../src/core/capabilityMatrix.ts';

const EMOJIS = new Set(Object.values(STATUS_EMOJI));

describe('capability matrix invariants', () => {
  test('integration ids and capability ids are unique', () => {
    expect(new Set(INTEGRATION_IDS).size).toBe(INTEGRATIONS.length);
    const capIds = CAPABILITIES.map((c) => c.id);
    expect(new Set(capIds).size).toBe(capIds.length);
  });

  test('every cell resolves to a valid status', () => {
    for (const cap of CAPABILITIES) {
      for (const integ of INTEGRATIONS) {
        expect(['full', 'partial', 'planned', 'unsupported']).toContain(
          cellFor(cap, integ).status,
        );
      }
    }
  });

  test('overrides are full/partial only, and only on tools Showtail has a plugin for', () => {
    const withPlugin = new Set(INTEGRATIONS.filter((i) => i.pluginId).map((i) => i.id));
    for (const cap of CAPABILITIES) {
      for (const [id, cell] of Object.entries(cap.overrides)) {
        expect(INTEGRATION_IDS, `${cap.id}: unknown override ${id}`).toContain(id);
        expect(['full', 'partial'], `${cap.id}:${id} override`).toContain(cell.status);
        expect(withPlugin.has(id), `${cap.id}:${id} override needs a plugin`).toBe(true);
      }
    }
  });

  test('planned vs unsupported is deterministic — derived cells are never full/partial', () => {
    // Determinism (point 5): any cell NOT hand-authored as an override comes from
    // the surface rule, which may only yield planned or unsupported.
    for (const cap of CAPABILITIES) {
      for (const integ of INTEGRATIONS) {
        if (integ.id in cap.overrides) continue;
        expect(['planned', 'unsupported'], `${cap.id}:${integ.id} derived`).toContain(
          cellFor(cap, integ).status,
        );
      }
    }
  });

  test('a full claim requires a plugin and satisfies the structural requirement', () => {
    for (const cap of CAPABILITIES) {
      for (const integ of INTEGRATIONS) {
        if (cellFor(cap, integ).status !== 'full') continue;
        expect(integ.pluginId, `${cap.id}:${integ.id} full needs a plugin`).toBeTruthy();
        expect(
          fullClaimIsStructural(cap, integ),
          `${cap.id}:${integ.id} full but plugin lacks the capability`,
        ).toBe(true);
      }
    }
  });

  test('every row with a partial/planned cell carries a Notes callout', () => {
    for (const cap of CAPABILITIES) {
      const needsNote = INTEGRATIONS.some((i) =>
        ['partial', 'planned'].includes(cellFor(cap, i).status),
      );
      if (needsNote) {
        expect(cap.note?.trim(), `${cap.id} needs a row note`).toBeTruthy();
      }
    }
  });

  test('full claims line up with the plugin contract and the surface model', () => {
    const status = (capId: string, intId: string) =>
      cellFor(
        CAPABILITIES.find((c) => c.id === capId)!,
        INTEGRATIONS.find((i) => i.id === intId)!,
      ).status;
    // Hook capture is full only for the hook-plugin tools.
    expect(status('live-capture-hooks', 'claude-code')).toBe('full');
    expect(status('live-capture-hooks', 'zed')).toBe('unsupported'); // Zed has no hooks
    // A tool with all surfaces but no plugin yet reads as planned, never unsupported.
    expect(status('live-capture-hooks', 'copilot-desktop')).toBe('planned');
    // Codex capture is live-certified (full); the CLI plugins are built but their
    // live capture isn't certified on this machine, so they read partial.
    expect(status('live-capture-hooks', 'codex')).toBe('full');
    expect(status('live-capture-hooks', 'copilot-cli')).toBe('partial');
    expect(status('session-import', 'antigravity-cli')).toBe('planned');
    // Codex marketplace exists now → planned, not unsupported (R1 correction).
    expect(status('marketplace-install', 'codex')).toBe('planned');
    // Hosted web apps: connect-family unsupported, import full.
    expect(status('host-detection', 'chatgpt')).toBe('unsupported');
    expect(status('session-import', 'chatgpt')).toBe('full');
  });

  test('plan capture: full for the file-backed tools, partial/planned/unsupported otherwise', () => {
    const cap = CAPABILITIES.find((c) => c.id === 'plan-capture')!;
    const status = (intId: string) =>
      cellFor(cap, INTEGRATIONS.find((i) => i.id === intId)!).status;
    // The capability row exists and every integration carries the planFiles flag.
    expect(cap).toBeDefined();
    expect(INTEGRATIONS.every((i) => typeof i.surface.planFiles === 'boolean')).toBe(
      true,
    );
    // Tools whose plan is captured + materialized to a linkable file: full.
    // Claude Code and Codex materialize the transcript plan; Antigravity links a
    // real plan.md. All three are full.
    expect(status('claude-code')).toBe('full');
    expect(status('antigravity-cli')).toBe('full');
    expect(status('codex')).toBe('full');
    // Antigravity IDE writes a plan file but has no plugin yet → planned.
    expect(status('antigravity-ide')).toBe('planned');
    // Tools with no plan surface → unsupported.
    expect(status('chatgpt')).toBe('unsupported');
    expect(status('copilot-cli')).toBe('unsupported');
  });

  test('plan-capture full claims are structural and certified by contract test (not the headless live run)', () => {
    const claims = fullClaims().filter((c) => c.capabilityId === 'plan-capture');
    expect(claims.map((c) => c.integration).sort()).toEqual([
      'antigravity-cli',
      'claude-code',
      'codex',
    ]);
    // Reconciled on the Stop hook (not raised by headless print mode), so — like
    // auto-ai-output-capture — it is not in the live-certified set.
    expect(claims.every((c) => !c.liveRequired)).toBe(true);
  });
});

describe('capability matrix rendering', () => {
  test('cells are emoji-only, one column per integration plus a Notes column', () => {
    const md = renderMatrixMarkdown();
    const lines = md.split('\n');
    const headerCols = lines[0]!
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    // Capability + every integration + Notes.
    expect(headerCols.length).toBe(INTEGRATIONS.length + 2);
    for (const integ of INTEGRATIONS) expect(headerCols).toContain(integ.label);
    expect(headerCols[headerCols.length - 1]).toBe('Notes');

    // Status cells contain only an emoji glyph (no words, no footnote numbers).
    const firstRow = lines.find((l) => l.startsWith('| **'))!;
    const statusCells = firstRow
      .split('|')
      .slice(2, 2 + INTEGRATIONS.length)
      .map((s) => s.trim());
    for (const c of statusCells)
      expect(EMOJIS.has(c), `cell "${c}" should be a status emoji`).toBe(true);

    expect(md).not.toContain('undefined');
    expect(md).not.toContain('**Notes:**'); // no footnote list
    expect(md).not.toMatch(/\[\d+\]/); // no footnote markers
  });

  test('json view is serializable and covers every cell', () => {
    const json = matrixJson();
    expect(json.integrations.map((i) => i.id)).toEqual(INTEGRATION_IDS);
    expect(json.capabilities.length).toBe(CAPABILITIES.length);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
