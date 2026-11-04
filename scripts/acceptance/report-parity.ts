/** Visible behavior checks: embedded data alone cannot satisfy these assertions. */
import type { Page, Locator } from 'playwright';
import type { ReportData } from '../../src/types.ts';
import type { ViewerIndex } from '../../src/core/report/viewerTypes.ts';
import type { DecodedViewerHtml } from '../../src/core/report/viewerCodec.ts';
import { labelForModel, labelForTool } from '../../src/plugins/registry.ts';
import { expectedUsage, type ReportCheck } from './report-content.ts';

const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const turnSelector = (id: string) => `.st-v-exchange[data-turn-id=${JSON.stringify(id)}]`;

async function reveal(section: Locator) {
  await section.evaluate((element) => {
    if (element instanceof HTMLDetailsElement) element.open = true;
    for (const detail of element.querySelectorAll('details')) detail.open = true;
  });
}

export async function inspectVisibleParity(
  page: Page,
  data: ReportData,
  index: ViewerIndex,
  decoded: DecodedViewerHtml,
): Promise<ReportCheck[]> {
  const checks: ReportCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      check(name, false, error instanceof Error ? error.message : String(error));
    }
  };
  const navigate = async (scope: string) => {
    const target = `.st-v-nav-link[data-scope=${JSON.stringify(scope)}]:visible`;
    if (!(await page.locator(target).count()))
      await page.locator('#st-viewer-menu > summary').click();
    await page.locator(target).first().click();
    await page.waitForFunction(
      (scope) => (window as any).ShowtailViewer.active.state.scope === scope,
      scope,
    );
  };
  const overview = page.locator('#st-viewer-overview');
  await step('report overview exposes capture context and statistics', async () => {
    await navigate('overview');
    check('report overview is visible', (await overview.count()) === 1);
    if (!(await overview.count())) return;
    await reveal(overview);
    const text = await overview.innerText();
    check(
      'report overview visibly names contributors, tools and models',
      data.contributors.every((c) => text.includes(c.name)) &&
        data.tools.every((tool) =>
          normalized(text).includes(normalized(labelForTool(tool.tool))),
        ) &&
        data.models.every((model) =>
          normalized(text).includes(normalized(labelForModel(model.model))),
        ),
    );
    if (data.coverage)
      check(
        'coverage meaning and source warnings remain readable',
        text.includes(data.coverage.meaning) &&
          (data.coverage.sources.length === 0 || /source|conversation/i.test(text)) &&
          data.coverage.sources
            .flatMap((source) => source.warningCodes)
            .every((warning) => normalized(text).includes(normalized(warning))),
      );
    if (data.redactionCount)
      check(
        'redaction count is visible in the report',
        new RegExp(
          `(?:${data.redactionCount}[^.\\n]*(?:redact|remov|secret)|(?:redact|remov|secret)[^.\\n]*${data.redactionCount})`,
          'i',
        ).test(text.replace(/\s+/g, ' ').replace(/,/g, '')),
      );
    const stats = overview.locator('[data-stats="report"]');
    check('report statistics have a readable overview', (await stats.count()) > 0);
    if (await stats.count()) {
      const expected = expectedUsage(data.turns);
      for (const [field, total] of [
        ['inputTokens', expected.totalInputTokens],
        ['outputTokens', expected.totalOutputTokens],
      ] as const) {
        const cell = stats.locator(`[data-stat="${field}"]`);
        check(
          `report ${field} is visibly correct`,
          (await cell.count()) > 0 &&
            (total === null
              ? /not captured|unavailable|unknown|not recorded|—/i.test(
                  await cell.innerText(),
                )
              : (await cell.innerText()).replace(/,/g, '').includes(String(total))),
        );
      }
    }
  });
  if (data.plans.length)
    await step('captured plans are available as a readable index', async () => {
      await navigate('plans');
      const section = page.locator('#st-viewer-plans');
      check('Plans index is visible when plans exist', (await section.count()) === 1);
      if (!(await section.count())) return;
      for (const plan of [...(index.plans ?? [])]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(0, 10)) {
        const row = section.locator(`[data-plan-id=${JSON.stringify(plan.id)}]`);
        const badge = row.locator('summary [data-plan-status]').first();
        check(
          'closed plan summaries visibly expose their title and approval status',
          (await row.count()) === 1 &&
            (await row.innerText()).includes(plan.title) &&
            (await badge.count()) === 1 &&
            (await badge.isVisible()) &&
            (await badge.getAttribute('data-plan-status')) === plan.status,
        );
        if (!(await row.count())) continue;
        await reveal(row);
        const body = row
          .locator(`[data-text-ref=${JSON.stringify(plan.textRef)}][data-loaded="true"]`)
          .first();
        await body.waitFor();
        check(
          'opened plan shows its captured source context',
          (await row.innerText()).includes(plan.author),
        );
        check(
          'plan body opens as readable captured content without a renderer error',
          (await body.innerText()).trim().length > 0 &&
            (await row.locator('.st-v-error:visible').count()) === 0,
        );
        if (decoded.texts.get(plan.textRef!)?.includes('capture21()')) {
          const semantic = {
            fallback: await body.locator('.st-v-rich-fallback').count(),
            headings: await body.locator('h2,h3,h4,h5,h6').count(),
            strong: await body.locator('strong').count(),
            lists: await body.locator('ul').count(),
            links: await body.locator('a').count(),
            code: await body.locator('code').count(),
          };
          check(
            'ordinary 115-line plan preserves headings, lists, emphasis, links and code without formatting fallback',
            (await body.locator('.st-v-rich-fallback').count()) === 0 &&
              (await body.locator('h2,h3,h4,h5,h6').count()) >= 20 &&
              (await body.locator('strong').count()) >= 40 &&
              (await body.locator('ul').count()) >= 20 &&
              (await body.locator('a').count()) >= 20 &&
              (await body.locator('code').count()) >= 20,
            JSON.stringify(semantic),
          );
        }
        if (plan.feedback) {
          const feedback = row.locator('.st-v-plan-feedback');
          check(
            'plan revision feedback is visibly separate from its body',
            (await feedback.count()) === 1 &&
              normalized(await feedback.innerText()).includes(
                normalized(plan.feedback.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')),
              ) &&
              (await row.innerText()).includes(plan.title),
          );
        }
        if (!plan.turnId)
          check(
            'orphan plan is readable with honest source context',
            (await row.innerText()).includes(plan.title) &&
              /unlinked|without|no linked|orphan|not linked/i.test(await row.innerText()),
          );
      }
    });
  await step('session grouping and sorting preserve every conversation', async () => {
    await navigate('prompts');
    const grouping = page.locator('#st-viewer-group');
    check('session grouping control is available', (await grouping.count()) === 1);
    if (!(await grouping.count())) return;
    await grouping.selectOption('session');
    const ids: string[] = [];
    for (let n = 0; n <= Math.ceil(index.turns.length / 10); n++) {
      ids.push(
        ...(await page
          .locator('#st-viewer-list .st-v-open-turn[data-turn-id]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-turn-id')!))),
      );
      if (await page.locator('#st-viewer-list-next').isDisabled()) break;
      await page.locator('#st-viewer-list-next').click();
    }
    const sessionByTurn = new Map(index.turns.map((turn) => [turn.id, turn.sessionId]));
    const sessions = ids.map((id) => sessionByTurn.get(id));
    const runs = sessions.filter((id, n) => n === 0 || id !== sessions[n - 1]);
    check(
      'session grouping spans the complete report without interleaving conversations',
      ids.length === index.turns.length &&
        new Set(ids).size === ids.length &&
        new Set(runs).size === runs.length,
    );
    check(
      'session groups show readable conversation headings',
      (await page.locator('.st-v-session-heading[data-session-id]').count()) > 0,
    );
    await navigate('sessions');
    await reveal(page.locator('#st-viewer-reader'));
    check(
      'session usage remains readable in the conversation index',
      (await page.locator('[data-stats="session"]').count()) > 0,
    );
    await navigate('prompts');
    await grouping.selectOption('time');
    await page.locator('#st-viewer-sort').selectOption('oldest');
  });
  await step('ordinary exchanges can remain open together', async () => {
    await navigate('prompts');
    await page.locator('#st-viewer-group').selectOption('time');
    await page.locator('#st-viewer-sort').selectOption('oldest');
    const first = [...index.turns]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(0, 3);
    for (const turn of first) {
      const toggle = page.locator(
        `${turnSelector(turn.id)} .st-v-open-turn[data-turn-id]`,
      );
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await page.locator(`${turnSelector(turn.id)} [data-turn-detail]`).waitFor();
    }
    check(
      'multiple exchanges remain readable without replacing one another',
      (await page.locator('.st-v-exchange [data-turn-detail]').count()) >=
        Math.min(3, index.turns.length),
    );
    for (const turn of first) {
      const source = data.turns.find((entry) => entry.prompt.id === turn.id)!;
      const exchange = page.locator(turnSelector(turn.id));
      const text = await exchange.innerText();
      if (source.recap?.gitBranch)
        check(
          'captured branch is visible with its exchange',
          text.includes(source.recap.gitBranch),
        );
      check(
        'models and author remain visible with exchanges',
        turn.models.every((model) => normalized(text).includes(normalized(model))) &&
          text.includes(turn.author),
      );
      const stats = exchange.locator('[data-stats="turn"]');
      check(
        'turn statistics expose captured or unavailable values',
        (await stats.count()) > 0,
      );
      if (await stats.count())
        for (const field of ['inputTokens', 'outputTokens'] as const) {
          const cell = stats.locator(`[data-stat="${field}"]`);
          const value = source.recap?.[field];
          check(
            `turn ${field} distinguishes zero from missing evidence`,
            (await cell.count()) > 0 &&
              (value === undefined
                ? /not captured|unavailable|unknown|not recorded|—/i.test(
                    await cell.innerText(),
                  )
                : (await cell.innerText()).replace(/,/g, '').includes(String(value))),
          );
        }
      if (source.decisions.length)
        check('decision signals remain visible', /decision/i.test(text));
      if (source.plans.some((plan) => plan.tags?.includes('plan-revised')))
        check('revised plan signal remains visible', /revis/i.test(text));
      if (source.toolCalls.some((tool) => tool.isError))
        check('failed tool signal remains visible', /fail/i.test(text));
    }
  });
  const richTurn = data.turns.find((turn) =>
    turn.aiOutputs.some((event) => event.text.includes('# Captured Markdown')),
  );
  if (richTurn && index.aiMode !== 'off')
    await step('Markdown and captured tool details remain readable', async () => {
      const exchange = page.locator(turnSelector(richTurn.prompt.id));
      const ai = index.turns
        .find((turn) => turn.id === richTurn.prompt.id)!
        .itemIds.map((id) => index.items[id]!)
        .find(
          (item) =>
            item.kind === 'ai' &&
            decoded.texts.get(item.textRef!)?.includes('# Captured Markdown'),
        )!;
      await reveal(exchange);
      const prose = exchange
        .locator(`[data-text-ref=${JSON.stringify(ai.textRef)}][data-loaded="true"]`)
        .first();
      await prose.waitFor();
      check(
        'Markdown prose renders semantic headings, emphasis, lists, quotations, tables and code',
        (await prose.locator('h1,h2,h3,h4,h5,h6').count()) > 0 &&
          (await prose.locator('strong').count()) > 0 &&
          (await prose.locator('em').count()) > 0 &&
          (await prose.locator('ul ul').count()) > 0 &&
          (await prose.locator('blockquote').count()) > 0 &&
          (await prose.locator('table th').count()) === 2 &&
          (await prose.locator('pre code').count()) > 0,
      );
      check(
        'fenced TypeScript code keeps selective syntax highlighting',
        (await prose.locator('pre code .tok-kw').count()) > 0,
      );
      check(
        'captured links stay safe and captured HTML stays inert',
        (await prose.locator('a[href="https://example.com/docs"]').count()) === 1 &&
          (await prose.locator('a[href^="javascript:"]').count()) === 0 &&
          !(await page.evaluate(() => Boolean((window as any).__capturedExecuted))),
      );
      const groups = exchange.locator('.st-v-tool-group');
      check(
        'tool calls have a concise grouped presentation',
        (await groups.count()) > 0 && (await groups.count()) < richTurn.toolCalls.length,
      );
      await reveal(exchange);
      const raw = exchange.locator('details[data-raw-records]');
      if (await groups.count()) await raw.first().waitFor({ state: 'attached' });
      check(
        'complete tool records have explicit raw disclosures',
        (await raw.count()) > 0,
      );
      if (await raw.count()) {
        await reveal(raw.last());
        check(
          'raw tool outcome and channels are retained',
          /Complete stdout|Deliberate tool failure|exitCode/.test(
            await exchange.innerText(),
          ),
        );
      }
    });
  const lateTurn = data.turns.find((turn) =>
    turn.aiOutputs.some((event) => event.text.includes('FENCE_CONTINUITY_CANARY')),
  );
  if (lateTurn && index.aiMode !== 'off')
    await step('late Markdown pages retain their formatting context', async () => {
      const turn = index.turns.find((turn) => turn.id === lateTurn.prompt.id)!;
      const item = turn.itemIds
        .map((id) => index.items[id]!)
        .find(
          (item) =>
            item.kind === 'ai' &&
            decoded.texts.get(item.textRef!)?.includes('FENCE_CONTINUITY_CANARY'),
        )!;
      const lastPage = decoded.index.textStore.refs[item.textRef!]!.pages.length - 1;
      await page.evaluate(
        ({ turn, item, ref, pageNumber }) => {
          location.hash = new URLSearchParams({
            section: 'prompts',
            turn,
            item,
            textRef: ref,
            textPage: String(pageNumber),
            group: 'time',
            sort: 'oldest',
          }).toString();
        },
        { turn: turn.id, item: item.id, ref: item.textRef!, pageNumber: lastPage },
      );
      const content = page
        .locator(
          `${turnSelector(turn.id)} [data-text-ref=${JSON.stringify(item.textRef)}][data-text-page="${lastPage}"][data-loaded="true"]`,
        )
        .first();
      await content.waitFor();
      check(
        'a code fence crossing text pages remains code and closes before the next paragraph',
        (await content.locator('pre code').allTextContents()).some((text) =>
          text.includes('FENCE_CONTINUITY_CANARY'),
        ) &&
          (await content.locator('p').allTextContents()).some((text) =>
            text.includes('Final paragraph.'),
          ),
      );
      await navigate('prompts');
      await page.locator('#st-viewer-group').selectOption('time');
      await page.locator('#st-viewer-sort').selectOption('oldest');
    });
  await step('AI controls retain mode and visibility preferences', async () => {
    const toggle = page.locator('#st-viewer-ai'),
      mode = page.locator('#st-viewer-ai-mode');
    if (index.aiMode === 'off') {
      check(
        'AI-off report contains no narration controls or visible AI narration',
        (await page.locator('.st-v-kind-ai').count()) === 0 &&
          ((await toggle.count()) === 0 || (await toggle.isDisabled())),
      );
      return;
    }
    check(
      'AI visibility and full/collapsed controls are available',
      (await toggle.count()) === 1 && (await mode.count()) === 1,
    );
    if (!(await toggle.count()) || !(await mode.count())) return;
    await toggle.uncheck();
    check(
      'AI visibility control hides narration',
      (await page.locator('.st-v-kind-ai:visible').count()) === 0,
    );
    await toggle.check();
    await mode.selectOption('full');
    check(
      'full narration mode is selected visibly',
      (await mode.inputValue()) === 'full',
    );
    await mode.selectOption('collapsed');
  });
  await step(
    'display preferences persist and browser history restores reading position',
    async () => {
      await page.locator('#st-viewer-group').selectOption('session');
      await page.locator('#st-viewer-sort').selectOption('newest');
      await page.locator('#st-viewer-zone').selectOption('UTC');
      if (index.aiMode !== 'off') {
        await page.locator('#st-viewer-ai').uncheck();
        await page.locator('#st-viewer-ai-mode').selectOption('full');
      }
      await page.reload();
      await page.locator('.st-v-app[data-ready="true"]').waitFor();
      await page.locator('#st-viewer-filters').evaluate((element) => {
        (element as HTMLDetailsElement).open = true;
      });
      check(
        'timezone, ordering, grouping and narration preferences survive reload',
        (await page.locator('#st-viewer-zone').inputValue()) === 'UTC' &&
          (await page.locator('#st-viewer-sort').inputValue()) === 'newest' &&
          (await page.locator('#st-viewer-group').inputValue()) === 'session' &&
          (index.aiMode === 'off' ||
            (!(await page.locator('#st-viewer-ai').isChecked()) &&
              (await page.locator('#st-viewer-ai-mode').inputValue()) === 'full')),
      );
      await page.locator('#st-viewer-group').selectOption('time');
      await page.locator('#st-viewer-sort').selectOption('oldest');
      if (index.aiMode !== 'off') {
        await page.locator('#st-viewer-ai').check();
        await page
          .locator('#st-viewer-ai-mode')
          .selectOption(index.aiMode === 'full' ? 'full' : 'collapsed');
      }
      const ids = index.turns.slice(0, 2).map((turn) => turn.id);
      if (ids.length === 2) {
        for (const id of ids) {
          await page.evaluate((id) => {
            location.hash = new URLSearchParams({
              section: 'prompts',
              turn: id,
              group: 'time',
              sort: 'oldest',
            }).toString();
          }, id);
          await page.locator(`${turnSelector(id)} [data-turn-detail]`).waitFor();
        }
        await page.goBack();
        await page.waitForFunction(
          (id) => (window as any).ShowtailViewer.active.state.selected === id,
          ids[0],
        );
        const back = await page
          .locator(`${turnSelector(ids[0]!)} [data-turn-detail]`)
          .isVisible();
        await page.goForward();
        await page.waitForFunction(
          (id) => (window as any).ShowtailViewer.active.state.selected === id,
          ids[1],
        );
        check(
          'Back and Forward restore the selected exchange',
          back &&
            (await page
              .locator(`${turnSelector(ids[1]!)} [data-turn-detail]`)
              .isVisible()),
        );
      }
    },
  );
  await step('only the current page expands and prints', async () => {
    const actions = page.locator('#st-viewer-page-actions');
    if (!(await actions.evaluate((element) => (element as HTMLDetailsElement).open)))
      await actions.locator('summary').click();
    const expand = page.locator('#st-viewer-expand-page'),
      print = page.locator('#st-viewer-print-page');
    check(
      'page-only expand and print controls are clearly named',
      (await expand.count()) === 1 &&
        /page/i.test(await expand.innerText()) &&
        (await print.count()) === 1 &&
        /page/i.test(await print.innerText()),
    );
    if (!(await expand.count()) || !(await print.count())) return;
    await expand.click();
    await page.waitForFunction(
      () =>
        !Array.from(
          document.querySelectorAll('#st-viewer-list [data-turn-activity] > p.st-v-note'),
        ).some((node) => node.textContent === 'Loading recorded activity…') &&
        !Array.from(document.querySelectorAll('#st-viewer-list .st-v-text')).some(
          (node) => node.textContent === 'Loading recorded content…',
        ),
    );
    const expandedNodes = await page.locator('*').count();
    check(
      'ten expanded exchanges remain within the DOM budget',
      expandedNodes < 10000,
      `${expandedNodes} expanded DOM elements.`,
    );
    check(
      'expand affects at most the ten current exchanges',
      (await page.locator('.st-v-exchange [data-turn-detail]').count()) <= 10 &&
        (await page.locator('.st-v-exchange').count()) <= 10,
    );
    await page.evaluate(() => {
      (window as any).__stPrintCalls = 0;
      window.print = () => {
        (window as any).__stPrintCalls++;
      };
    });
    await print.click();
    check(
      'print control invokes printing for the current page',
      (await page.evaluate(() => (window as any).__stPrintCalls)) === 1,
    );
    await page.emulateMedia({ media: 'print' });
    check(
      'print layout contains only the current bounded page',
      (await page.locator('.st-v-exchange:visible').count()) <= 10,
    );
    await page.emulateMedia({ media: 'screen' });
  });
  await step('all report widths have one vertical scroll owner', async () => {
    const failures: unknown[] = [];
    for (const width of [320, 390, 768, 820, 1024, 1280, 1440])
      for (const height of [600, 1000]) {
        await page.setViewportSize({ width, height });
        const layout = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          owners: Array.from(document.querySelectorAll('*'))
            .filter((element) => {
              if (element === document.scrollingElement || element === document.body)
                return false;
              const style = getComputedStyle(element),
                node = element as HTMLElement;
              return (
                node.getClientRects().length > 0 &&
                ['auto', 'scroll'].includes(style.overflowY) &&
                node.scrollHeight > node.clientHeight + 2 &&
                node.clientHeight > 0
              );
            })
            .map((element) => ({
              tag: element.tagName,
              id: element.id,
              className: element.className,
            })),
        }));
        if (layout.width > width + 1 || layout.owners.length)
          failures.push({ viewportWidth: width, viewportHeight: height, ...layout });
      }
    check(
      '320/390/768/820/1024/1280/1440px short and tall layouts use document scrolling without clipped prose',
      failures.length === 0,
      JSON.stringify(failures),
    );
    await page.setViewportSize({ width: 390, height: 600 });
    await page.evaluate(() => scrollTo(0, 0));
    const before = await page.evaluate(() => document.scrollingElement!.scrollTop);
    await page.mouse.move(195, 450);
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(
      (before) => document.scrollingElement!.scrollTop > before,
      before,
    );
    check('mouse wheel scrolls the document while reading exchanges', true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('.st-v-open-turn').first().focus();
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.scrollingElement!.scrollTop > 0);
    check('keyboard paging scrolls the document', true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  check(
    'opened exchanges contain no caught rendering errors',
    (await page
      .locator('.st-v-error:visible,#st-viewer-status.is-error:visible')
      .count()) === 0,
    (
      await page
        .locator('.st-v-error:visible,#st-viewer-status.is-error:visible')
        .allTextContents()
    ).join('\n'),
  );
  return checks;
}
