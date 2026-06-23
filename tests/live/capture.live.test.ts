/**
 * Tier B — LLM-driven live capture tests.
 *
 * These drive the REAL tools (Claude Code, Codex, …) headlessly and assert the
 * `.showtail` trail captured their work. They need the tool binaries and a live
 * model, so they are gated behind SHOWTAIL_LIVE=1 and skipped in normal
 * `bun test` / CI. Run them with:
 *
 *   SHOWTAIL_LIVE=1 bun test tests/live
 *
 * The maintainer certification path is `showtail matrix --verify-live`, which
 * runs the same driver and records results in matrix-verification.json. This
 * file lets a developer run and watch the live checks directly. A tool that is
 * not installed is skipped (not failed).
 */
import { describe, expect, test } from 'bun:test';
import { LIVE_INTEGRATIONS, verifyToolLive } from '../../src/core/liveVerify.ts';
import { getPluginById } from '../../src/plugins/registry.ts';

const LIVE = Boolean(process.env.SHOWTAIL_LIVE);

describe('live capture (SHOWTAIL_LIVE=1)', () => {
  for (const integration of LIVE_INTEGRATIONS) {
    const detected = getPluginById(integration)?.connect?.detect() ?? false;
    test.skipIf(!LIVE || !detected)(
      `${integration}: driving the real tool captures prompts/edits`,
      () => {
        const result = verifyToolLive(integration);
        // The tool ran and at least one capture capability was certified live.
        expect(result.available).toBe(true);
        expect(
          result.certified.length,
          result.error ?? 'no capabilities certified',
        ).toBeGreaterThan(0);
      },
      360_000,
    );
  }
});
