/** Actual viewport captures and visible user tasks; no model calls or app-state mutation. */
import { chromium, firefox, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReportData } from '../../src/types.ts';
import type { AuditInput, AuditResult, AuditState } from './report-audit-types.ts';

export async function auditReport(input: AuditInput): Promise<AuditResult> {
  mkdirSync(input.artifactDir, { recursive: true });
  const engine = process.env.SHOWTAIL_ACCEPTANCE_BROWSER ?? 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(engine))
    throw new Error('Unknown audit browser');
  const data = JSON.parse(
    readFileSync(join(dirname(input.reportPath), 'report.json'), 'utf8'),
  ) as ReportData;
  const result: AuditResult = {
    checks: [],
    states: [],
    errors: [],
    tasks: [],
    engine,
    complete: false,
  };
  const check = (name: string, ok: boolean, detail?: string) =>
    result.checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const browser = await { chromium, firefox, webkit }[engine as 'chromium'].launch({
    headless: true,
  });
  const context = await browser.newContext({
    offline: true,
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.errors.push(error.message));
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(new URL(request.url()).origin);
  });
  let theme = 'light';
  const nav = async (scope: string) => {
    const target = page.locator(`.st-v-nav-link[data-scope="${scope}"]:visible`).first();
    let actions = 1;
    if (!(await target.count())) {
      await page.locator('#st-viewer-menu > summary').click();
      actions++;
    }
    await target.click();
    await page.waitForFunction(
      (scope) => (window as any).ShowtailViewer.active.state.scope === scope,
      scope,
    );
    result.tasks.push({ task: `Navigate to ${scope}`, actions });
  };
  const load = async (
    width: number,
    height: number,
    appearance: 'light' | 'dark' = 'light',
  ) => {
    theme = appearance;
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: appearance });
    await page.goto(pathToFileURL(input.reportPath).href);
    await page.locator('.st-v-app[data-ready="true"]').waitFor();
    await nav('overview');
  };
  const capture = async (name: string, readingTarget?: string) => {
    if (readingTarget) await page.locator(readingTarget).first().scrollIntoViewIfNeeded();
    else await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    const screenshot = `${name}.png`;
    await page.screenshot({ path: join(input.artifactDir, screenshot) });
    const geometry = await page.evaluate(() => {
      const nested = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(
        (element) => {
          const style = getComputedStyle(element);
          return (
            element !== document.scrollingElement &&
            element !== document.body &&
            element.getClientRects().length > 0 &&
            ['auto', 'scroll'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 2
          );
        },
      );
      return {
        width: document.documentElement.scrollWidth,
        viewport: { width: innerWidth, height: innerHeight },
        nested: nested.map((element) => element.className),
        first:
          document
            .querySelector('#st-viewer-list > li:not(.st-v-session-group)')
            ?.getBoundingClientRect().top ?? null,
      };
    });
    check(
      `${name}: no horizontal page overflow`,
      geometry.width <= geometry.viewport.width + 1,
    );
    check(
      `${name}: document owns vertical scrolling`,
      geometry.nested.length === 0,
      JSON.stringify(geometry.nested),
    );
    check(
      `${name}: no visible rendering error`,
      (await page
        .locator('.st-v-error:visible,#st-viewer-status.is-error:visible')
        .count()) === 0,
    );
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const state: AuditState = {
      name,
      screenshot,
      viewport: geometry.viewport,
      theme,
      firstEntryTop: geometry.first,
      violations: scan.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        targets: violation.nodes.map((node) => JSON.stringify(node.target)),
      })),
      incomplete: scan.incomplete.map((violation) => violation.id),
    };
    result.states.push(state);
    check(
      `${name}: automated accessibility scan`,
      state.violations.length === 0,
      state.violations
        .map((violation) => `${violation.id}: ${violation.targets.join(', ')}`)
        .join('; '),
    );
    writeFileSync(
      join(input.artifactDir, 'progress.json'),
      JSON.stringify(result, null, 2),
    );
  };
  const openPlan = async () => {
    await page.locator('#st-viewer-list > li details > summary').first().click();
    await page.locator('#st-viewer-list [data-loaded="true"]').first().waitFor();
  };
  const openExchange = async () => {
    await page.locator('.st-v-open-turn').first().click();
    await page.locator('.st-v-exchange [data-loaded="true"]').first().waitFor();
    const exchange = page.locator('.st-v-exchange').first();
    const signals = await exchange
      .locator('.st-v-badge.is-signal,.st-v-badge.is-error')
      .allTextContents();
    check(
      'exchange status badges are not repeated',
      new Set(signals).size === signals.length,
      signals.join('; '),
    );
  };
  const keyboardScroll = async () => {
    const region = page.locator('.st-v-text pre[data-scroll-region="true"]').first();
    if (!(await region.count())) {
      if (input.synthetic) check('fixture exercises a wide code block', false);
      return;
    }
    const scrollingElement = (await region.elementHandle())!;
    await page.locator('#st-viewer-search').focus();
    let reached = false;
    for (let n = 0; n < 160; n++) {
      await page.keyboard.press('Tab');
      reached = await region.evaluate((element) => element === document.activeElement);
      if (reached) break;
    }
    check('Tab reaches the overflowing code block', reached);
    if (reached) {
      const before = await region.evaluate((element) => element.scrollLeft);
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(
        () =>
          document.activeElement instanceof HTMLElement &&
          document.activeElement.scrollLeft > 0,
      );
      check(
        'arrow keys scroll the focused code block',
        (await region.evaluate((element) => element.scrollLeft)) > before,
      );
      check(
        'keyboard scrolling has a visible focus indicator',
        await scrollingElement.evaluate(
          (element) => parseFloat(getComputedStyle(element).outlineWidth) > 0,
        ),
      );
      await capture('phone-code-keyboard', '.st-v-text pre[data-scroll-region="true"]');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.st-v-text pre')).every(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          !element.hasAttribute('tabindex'),
      ),
    );
    check('fitting code blocks leave the tab order after resize', true);
    if (input.synthetic)
      check(
        'reference code fits on desktop and no longer adds a tab stop',
        await scrollingElement.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth + 1 &&
            !element.hasAttribute('tabindex'),
        ),
      );
  };
  const hasPlans =
    data.plans.length > 0 || data.turns.some((turn) => turn.plans.length > 0);
  try {
    await load(1440, 1000);
    await capture('desktop-overview');
    await nav('plans');
    await capture('desktop-plans');
    if (hasPlans) {
      await openPlan();
      await capture('desktop-plan-open');
    }
    await nav('sessions');
    if (data.turns.length)
      await page.locator('#st-viewer-list > li details > summary').first().click();
    await capture('desktop-session-open');
    await nav('prompts');
    await capture('desktop-exchanges');
    if (data.turns.length) {
      await openExchange();
      await capture('desktop-exchange-open');
      await capture('desktop-exchange-reading', '.st-v-exchange');
      await page.locator('#st-viewer-filters > summary').click();
      await capture('desktop-filters');
      await page.locator('#st-viewer-ai').uncheck();
      await capture('desktop-ai-hidden');
      await page.locator('#st-viewer-ai').check();
      await page.locator('#st-viewer-filters > summary').click();
      await page.locator('#st-viewer-page-actions > summary').click();
      await capture('desktop-page-actions');
      await page.locator('#st-viewer-expand-page').click();
      check(
        'page expansion retains keyboard focus',
        await page
          .locator('#st-viewer-expand-page')
          .evaluate((element) => element === document.activeElement),
      );
      await page.locator('#st-viewer-collapse-page').click();
      check(
        'page collapse retains keyboard focus',
        await page
          .locator('#st-viewer-collapse-page')
          .evaluate((element) => element === document.activeElement),
      );
    }
    await load(390, 844);
    await capture('phone-overview');
    await page.locator('#st-viewer-menu > summary').click();
    await capture('phone-navigation');
    await nav('plans');
    await capture('phone-plans');
    if (hasPlans) {
      await openPlan();
      await capture('phone-plan-reading', '#st-viewer-list .st-v-text-panel');
      await keyboardScroll();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await nav('sessions');
    if (data.turns.length)
      await page.locator('#st-viewer-list > li details > summary').first().click();
    await capture('phone-session-open');
    if (data.turns.length) await capture('phone-session-reading', '.st-v-session');
    await nav('prompts');
    await capture('phone-exchanges');
    const density = result.states.at(-1)!;
    if (data.turns.length) {
      const phoneToolbar = await page
        .locator('.st-v-page-toolbar')
        .evaluate((toolbar) => {
          const pager = toolbar.querySelector('.st-v-pager')!;
          const actions = toolbar.querySelector('.st-v-page-actions')!;
          const fullCount = pager.querySelector('.st-v-page-count')!;
          const compactCount = pager.querySelector('.st-v-page-count-compact')!;
          return {
            oneRow:
              actions.getBoundingClientRect().top < pager.getBoundingClientRect().bottom,
            fullCount: fullCount.textContent,
            compactVisible: compactCount.getBoundingClientRect().width > 1,
            compactHiddenFromAssistiveTech:
              compactCount.getAttribute('aria-hidden') === 'true',
          };
        });
      check('phone page actions share a row with pagination', phoneToolbar.oneRow);
      check(
        'phone pagination keeps the full accessible count and a compact visible count',
        phoneToolbar.compactVisible &&
          phoneToolbar.compactHiddenFromAssistiveTech &&
          /Page \d+ of \d+ · \d+ entries/.test(phoneToolbar.fullCount ?? ''),
      );
      check(
        'first phone exchange starts within sixty percent of the viewport',
        density.firstEntryTop !== null && density.firstEntryTop <= 844 * 0.6,
        `${density.firstEntryTop}px of 844px`,
      );
      await openExchange();
      await capture('phone-exchange-open');
      await capture('phone-exchange-reading', '.st-v-exchange');
      const withRevision = data.turns.find((turn) =>
        turn.codeChanges.some(
          (change) =>
            change.revisions?.some((revision) => !!revision.diff) || !!change.diff,
        ),
      );
      if (withRevision) {
        await nav('prompts');
        const exchangeButton = page.locator(
          `.st-v-open-turn[data-turn-id=${JSON.stringify(withRevision.prompt.id)}]`,
        );
        for (
          let n = 0;
          !(await exchangeButton.count()) && n <= Math.ceil(data.turns.length / 10);
          n++
        ) {
          await page.locator('#st-viewer-list-next').click();
        }
        await exchangeButton.click();
        await page.locator('.st-v-exchange [data-loaded="true"]').first().waitFor();
        const files = page
          .locator(
            `.st-v-exchange[data-turn-id=${JSON.stringify(withRevision.prompt.id)}]`,
          )
          .getByRole('button', { name: /^Files \(/ });
        await files.click();
        await page.locator('[data-file-path]').first().waitFor();
        await capture('phone-files', '.st-v-file-choices');
        const file = withRevision.codeChanges.find(
          (change) =>
            change.revisions?.some((revision) => !!revision.diff) || !!change.diff,
        )!;
        const choice = page.locator(`[data-file-path=${JSON.stringify(file.path)}]`);
        for (
          let n = 0;
          !(await choice.count()) && n <= Math.ceil(withRevision.codeChanges.length / 20);
          n++
        ) {
          await page
            .locator(
              `[id=${JSON.stringify('st-viewer-files-' + withRevision.prompt.id + '-next')}]`,
            )
            .click();
        }
        await choice.click();
        let foundDiff = false;
        for (
          let n = 0;
          !foundDiff && n <= Math.ceil((file.revisions?.length ?? 0) / 20);
          n++
        ) {
          const rows = page.locator('.st-v-kind-revision');
          await rows.first().waitFor();
          for (let i = 0; i < (await rows.count()); i++) {
            const row = rows.nth(i);
            await row.locator('.st-v-item-disclosure > summary').click();
            const body = row.locator('.st-v-text').first();
            await body.waitFor({ state: 'attached' });
            await page.waitForFunction(
              (element) => element && element.textContent !== 'Loading recorded content…',
              await body.elementHandle(),
            );
            if (await row.locator('.st-v-diff').count()) {
              foundDiff = true;
              break;
            }
          }
          if (!foundDiff) {
            const next = page.locator('#st-viewer-activity-next');
            if (await next.isDisabled()) break;
            await next.click();
          }
        }
        check(
          'file journey finds persisted text among metadata-only revisions',
          foundDiff,
        );
        await page.locator('.st-v-diff').first().waitFor();
        await capture('phone-file-reading', '.st-v-diff');
        check(
          'file journey loads an actual captured diff',
          (await page.locator('.st-v-diff').first().innerText()).length > 0,
        );
      }
      const query = data.turns.at(-1)!.prompt.text.split(/\r?\n/)[0]!.trim().slice(0, 40);
      await page.locator('#st-viewer-search').fill(query);
      await page.waitForFunction(
        () => !(window as any).ShowtailViewer.active.state.searching,
      );
      check(
        'visible search can find a captured prompt',
        (await page.locator('.st-v-open-turn').count()) > 0,
      );
      await capture('phone-search-results');
      await page
        .locator('#st-viewer-search')
        .fill('SHOWTAIL_NO_RESULTS_a2be0d7fb3c64d96');
      await page.waitForFunction(
        () => !(window as any).ShowtailViewer.active.state.searching,
      );
      check(
        'no-result search has an explicit empty state',
        await page.locator('.st-v-empty').isVisible(),
      );
      await capture('phone-search-empty');
      await page.locator('#st-viewer-search').fill('');
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await capture('narrow-reflow');
    await load(820, 1180);
    await nav('plans');
    await capture('tablet-plans');
    await load(1280, 640);
    await capture('short-window-overview');
    await load(1440, 1000, 'dark');
    await capture('dark-overview');
    if (hasPlans) {
      await nav('plans');
      await openPlan();
      await capture('dark-plan-reading', '#st-viewer-list .st-v-text-panel');
    }
    await nav('prompts');
    if (data.turns.length) {
      await openExchange();
      await capture('dark-exchange-open');
      await capture('dark-exchange-reading', '.st-v-exchange');
    }
    check(
      'audit has no runtime errors',
      result.errors.length === 0,
      result.errors.join('; '),
    );
    check('audit stays offline', requests.length === 0, requests.join('; '));
    const required = [
      'desktop-overview',
      'desktop-plans',
      'desktop-session-open',
      'desktop-exchanges',
      'phone-overview',
      'phone-navigation',
      'phone-plans',
      'phone-session-open',
      'phone-exchanges',
      'narrow-reflow',
      'tablet-plans',
      'short-window-overview',
      'dark-overview',
    ];
    if (data.turns.length)
      required.push(
        'desktop-exchange-open',
        'desktop-exchange-reading',
        'desktop-filters',
        'desktop-ai-hidden',
        'desktop-page-actions',
        'phone-session-reading',
        'phone-exchange-open',
        'phone-exchange-reading',
        'phone-search-results',
        'phone-search-empty',
        'dark-exchange-open',
        'dark-exchange-reading',
      );
    if (hasPlans)
      required.push('desktop-plan-open', 'phone-plan-reading', 'dark-plan-reading');
    if (input.synthetic && hasPlans) required.push('phone-code-keyboard');
    if (
      data.turns.some((turn) =>
        turn.codeChanges.some(
          (change) =>
            change.revisions?.some((revision) => !!revision.diff) || !!change.diff,
        ),
      )
    )
      required.push('phone-files', 'phone-file-reading');
    const names = result.states.map((state) => state.name);
    const missing = required.filter((name) => !names.includes(name));
    check(
      'required screenshot manifest is complete',
      missing.length === 0 && new Set(names).size === names.length,
      missing.join(', '),
    );
    result.complete = missing.length === 0;
  } catch (error) {
    check('all required visual scenarios completed', false, String(error));
    await page
      .screenshot({ path: join(input.artifactDir, 'failure.png') })
      .catch(() => {});
  } finally {
    const failed = result.checks.some((check) => !check.ok) || !result.complete;
    await context.tracing.stop(
      failed ? { path: join(input.artifactDir, 'failure-trace.zip') } : {},
    );
    await browser.close();
  }
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const cards = result.states
    .map(
      (state) =>
        `<article><h2>${escape(state.name)}</h2><p>${state.viewport.width} × ${state.viewport.height} · ${state.theme} · ${state.violations.length} accessibility findings</p><a href="${state.screenshot}"><img src="${state.screenshot}" alt="${escape(state.name)}"></a></article>`,
    )
    .join('');
  writeFileSync(
    join(input.artifactDir, 'review.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Showtail visual audit</title><style>body{font:16px system-ui;margin:2rem;color:#222;background:#f3f5f8}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:1.5rem}article{background:white;padding:1rem}img{max-width:100%;height:auto}h2{font-size:1rem}</style><h1>Showtail visual audit</h1><p>${escape(engine)} · ${input.synthetic ? 'Synthetic fixture' : 'Private local report'} · <a href="../visual-review.json">AI visual review record</a></p><p>Review the actual images and reading tasks. Passing automated checks does not establish visual quality.</p><main>${cards}</main></html>`,
  );
  return result;
}
