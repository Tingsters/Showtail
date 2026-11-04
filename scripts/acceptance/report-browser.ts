/** Independent content oracle and real-browser inspection of portable reports. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit, type Page } from 'playwright';
import type { DecodedViewerHtml } from '../../src/core/report/viewerCodec.ts';
import type {
  ViewerIndex,
  ViewerItem,
  ViewerTurn,
} from '../../src/core/report/viewerTypes.ts';
import type { ReportData } from '../../src/types.ts';
import { inspectEmbeddedContent, type ReportCheck } from './report-content.ts';
import { inspectVisibleParity } from './report-parity.ts';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function openSection(page: Page, scope: string) {
  const selector = `.st-v-nav-link[data-scope=${JSON.stringify(scope)}]:visible`;
  if (!(await page.locator(selector).count()))
    await page.locator('#st-viewer-menu > summary').click();
  await page.locator(selector).first().click();
}

/** Recover page expectations from complete logical text and byte descriptors. */
function textPages(decoded: DecodedViewerHtml, refId: string): string[] {
  const text = decoded.texts.get(refId)!;
  let at = 0;
  return decoded.index.textStore.refs[refId]!.pages.map((pageId) => {
    const start = at,
      bytes = decoded.index.textStore.pages[pageId]!.bytes;
    let used = 0;
    while (used < bytes && at < text.length) {
      const point = text.codePointAt(at)!;
      const width = point > 0xffff ? 2 : 1;
      used += Buffer.byteLength(text.slice(at, at + width), 'utf8');
      at += width;
    }
    if (used !== bytes) throw new Error('Page descriptor splits a UTF8 character');
    return text.slice(start, at);
  });
}

async function activeContent(page: Page) {
  await page.waitForFunction(() => {
    const active = (window as any).ShowtailViewer.active,
      selected = active.state.item;
    return (
      !selected ||
      document.querySelector(
        `[data-item-id="${CSS.escape(selected)}"] [data-text-ref][data-loaded="true"]`,
      )
    );
  });
  const target = await page.evaluate(() => {
    const active = (window as any).ShowtailViewer.active,
      state = active.state;
    const turn = [...active.manifest.turns, ...active.manifest.unlinked].find(
      (turn: any) => turn.id === state.selected,
    );
    const item = state.item
      ? (document.querySelector(
          `[data-item-id="${CSS.escape(state.item)}"] [data-text-ref]`,
        ) as HTMLElement | null)
      : null;
    const ref =
      state.textRef ||
      (state.item
        ? (item?.dataset.textRef ?? active.manifest.items[state.item]?.textRef)
        : turn?.promptRef);
    return { id: state.selected, ref, page: state.textPage };
  });
  const content = page
    .locator(
      `.st-v-exchange[data-turn-id=${JSON.stringify(target.id)}] [data-text-ref=${JSON.stringify(target.ref)}][data-text-page="${target.page}"][data-loaded="true"]`,
    )
    .first();
  await content.waitFor();
  return content;
}

async function visibleText(page: Page): Promise<string> {
  const content = await activeContent(page);
  return content.evaluate((content) => {
    const body = content.querySelector('.st-v-text') ?? content;
    const pre = body.querySelector('pre.st-v-diff') ?? body;
    const rows = pre.querySelectorAll('.st-v-diff-line');
    return rows.length
      ? Array.from(rows, (row) =>
          row.textContent === '\u200b' ? '' : (row.textContent ?? ''),
        ).join('\n')
      : ((pre as HTMLElement).innerText ?? pre.textContent ?? '');
  });
}

const plainWords = (text: string = '') =>
  text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ')
    .toLowerCase();

async function downloadedText(page: Page, ref: string): Promise<string> {
  const button = page
    .locator(`[data-download-ref=${JSON.stringify(ref)}]:visible`)
    .first();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const path = await download.path();
  if (!path) throw new Error('Captured text download is unavailable');
  const text = readFileSync(path, 'utf8');
  await download.delete();
  return text;
}

export async function inspectViewerReport(
  reportPath: string,
  artifactDir: string,
  expectedPrompts: string[],
): Promise<{ checks: ReportCheck[] }> {
  mkdirSync(artifactDir, { recursive: true });
  const checks: ReportCheck[] = [],
    errors: string[] = [],
    requests: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const data = JSON.parse(
    readFileSync(join(dirname(reportPath), 'report.json'), 'utf8'),
  ) as ReportData;
  const html = readFileSync(reportPath, 'utf8');
  let content: ReturnType<typeof inspectEmbeddedContent>;
  try {
    content = inspectEmbeddedContent(data, html, expectedPrompts);
    checks.push(...content.checks);
  } catch (error) {
    check(
      'embedded content is complete and independently decodable',
      false,
      String(error),
    );
    return { checks };
  }
  const { index, decoded } = content;
  const isolated = join(artifactDir, 'html-only');
  mkdirSync(isolated, { recursive: true });
  const portable = join(isolated, 'report.html');
  copyFileSync(reportPath, portable);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(key),
    ),
  );
  const engine = process.env.SHOWTAIL_ACCEPTANCE_BROWSER ?? 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(engine))
    throw new Error('SHOWTAIL_ACCEPTANCE_BROWSER must be chromium, firefox, or webkit');
  const cpuRate = Number(process.env.SHOWTAIL_ACCEPTANCE_CPU_RATE ?? 1);
  if (!Number.isFinite(cpuRate) || cpuRate < 1 || cpuRate > 20)
    throw new Error('SHOWTAIL_ACCEPTANCE_CPU_RATE must be between 1 and 20');
  if (cpuRate !== 1 && engine !== 'chromium')
    throw new Error('CPU throttling acceptance requires Chromium CDP');
  const browser = await { chromium, firefox, webkit }[engine]!.launch({
    headless: true,
    timeout: 20000,
    env,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'America/Los_Angeles',
    offline: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const observedCsp: Array<{
    directive: string;
    uri: string;
    source: string;
    line: number;
    phase: string;
  }> = [];
  await page.addInitScript(() => {
    (window as any).__stAcceptanceCsp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      const record = {
        directive: event.effectiveDirective,
        uri: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
        phase: (window as any).__stAcceptancePhase ?? '',
      };
      (window as any).__stAcceptanceCsp.push(record);
      console.debug('__SHOWTAIL_ACCEPTANCE_CSP__' + JSON.stringify(record));
    });
  });
  const cdp = engine === 'chromium' ? await context.newCDPSession(page) : undefined;
  if (cpuRate !== 1 && cdp) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  }
  const performanceMetrics: Record<string, number> = {};
  const heap = async (label: string) => {
    if (!cdp) return;
    await cdp.send('HeapProfiler.collectGarbage');
    const usage = await cdp.send('Runtime.getHeapUsage');
    performanceMetrics[label] = usage.usedSize;
  };
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.text().startsWith('__SHOWTAIL_ACCEPTANCE_CSP__')) {
      observedCsp.push(
        JSON.parse(message.text().slice('__SHOWTAIL_ACCEPTANCE_CSP__'.length)),
      );
      return;
    }
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(new URL(request.url()).origin);
  });
  let maxNodes = 0,
    maxRows = 0,
    runtime = '';
  let cspDiagnostics: unknown[] = [];
  const screenshot = async (path: string) => {
    await page.evaluate(() => {
      (window as any).__stAcceptancePhase = 'screenshot';
    });
    try {
      await page.screenshot({ path, fullPage: true });
    } finally {
      await page.evaluate(() => {
        (window as any).__stAcceptancePhase = '';
      });
    }
  };
  const measure = async () => {
    const m = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      rows: document.querySelectorAll('#st-viewer-list .st-v-open-turn[data-turn-id]')
        .length,
    }));
    maxNodes = Math.max(maxNodes, m.nodes);
    maxRows = Math.max(maxRows, m.rows);
  };
  const navigate = async (
    turn: ViewerTurn,
    item?: ViewerItem,
    textPage = 0,
    textRef?: string,
  ) => {
    const hash = new URLSearchParams({
      view: turn.unlinked ? 'unlinked' : 'prompts',
      turn: turn.id,
      textPage: String(textPage),
      ...(item ? { item: item.id } : {}),
      ...(textRef ? { textRef } : {}),
    });
    await page.evaluate((value) => {
      location.hash = value;
    }, hash.toString());
    await page.waitForFunction(
      ({ id, itemId, textPage }) => {
        const active = (window as any).ShowtailViewer.active;
        return (
          active.state.selected === id &&
          active.state.item === itemId &&
          active.state.textPage === textPage
        );
      },
      { id: turn.id, itemId: item?.id ?? null, textPage },
    );
    return visibleText(page);
  };
  try {
    const started = Date.now();
    await page.goto(pathToFileURL(portable).href);
    await page.locator('.st-v-app[data-ready="true"]').waitFor();
    runtime = (await page.locator('.st-v-app').getAttribute('data-runtime')) ?? '';
    const readyMs = Date.now() - started;
    check(
      'viewer initializes timestamps to the browser timezone',
      (await page.locator('#st-viewer-zone').inputValue()) === 'America/Los_Angeles',
    );
    await page.locator('#st-viewer-filters > summary').click();
    performanceMetrics.readyMs = readyMs;
    await heap('initialMainHeapBytes');
    check(
      'HTML-only copy opens offline without supporting files',
      (await page.title()).startsWith('Showtail Report') && requests.length === 0,
    );
    check(
      'first timeline page becomes usable within ten seconds',
      readyMs < 10000,
      `${readyMs} ms.`,
    );
    await measure();
    performanceMetrics.initialDomNodes = maxNodes;
    check(
      'initial report DOM stays below eight hundred elements',
      maxNodes < 800,
      `${maxNodes} initial elements.`,
    );
    await openSection(page, 'prompts');
    const sortSamples: number[] = [];
    for (let n = 0; n < 30; n++)
      sortSamples.push(
        await page.evaluate((n) => {
          const started = performance.now(),
            input = document.getElementById(
              n % 2 ? 'st-viewer-session' : 'st-viewer-sort',
            ) as HTMLSelectElement;
          input.value =
            n % 2
              ? n % 4 === 1
                ? (input.options[1]?.value ?? '')
                : ''
              : n % 4 === 0
                ? 'oldest'
                : 'newest';
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return performance.now() - started;
        }, n),
      );
    performanceMetrics.metadataFilterSortP95Ms = sortSamples.sort((a, b) => a - b)[
      Math.ceil(sortSamples.length * 0.95) - 1
    ]!;
    await page.locator('#st-viewer-session').selectOption('');
    await page.locator('#st-viewer-group').selectOption('time');
    await page.locator('#st-viewer-sort').selectOption('oldest');
    const seen: string[] = [];
    for (let n = 0; n <= Math.ceil(index.turns.length / 10); n++) {
      seen.push(
        ...(await page
          .locator('#st-viewer-list .st-v-open-turn[data-turn-id]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-turn-id')!))),
      );
      await measure();
      if (await page.locator('#st-viewer-list-next').isDisabled()) break;
      await page.locator('#st-viewer-list-next').click();
    }
    const chronological = [...index.turns].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
    check(
      'all timeline pages expose every prompt once in chronological order',
      same(
        seen,
        chronological.map((turn) => turn.id),
      ),
      `${seen.length}/${index.turns.length} prompts traversed.`,
    );
    if (index.turns.length) {
      await page.locator('#st-viewer-sort').selectOption('newest');
      const descending = await page
        .locator('#st-viewer-list .st-v-open-turn[data-turn-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-turn-id')));
      check(
        'newest sort covers the full dataset',
        same(
          descending,
          [...index.turns]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, 10)
            .map((turn) => turn.id),
        ),
      );
      await page.locator('#st-viewer-sort').selectOption('oldest');
      const first = chronological[0]!,
        last = chronological[chronological.length - 1]!;
      const detailStarted = Date.now();
      await page.locator('#st-viewer-list .st-v-open-turn[data-turn-id]').first().focus();
      await page.keyboard.press('Enter');
      const opened = await visibleText(page);
      check(
        'initial exchange has no caught activity rendering errors',
        (await page
          .locator('.st-v-error:visible,#st-viewer-status.is-error:visible')
          .count()) === 0,
        (
          await page
            .locator('.st-v-error:visible,#st-viewer-status.is-error:visible')
            .allTextContents()
        ).join('\n'),
      );
      performanceMetrics.firstDetailMs = Date.now() - detailStarted;
      check(
        'keyboard opens the selected prompt and moves focus to its detail',
        plainWords(opened) === plainWords(textPages(decoded, first.promptRef!)[0]) &&
          (await page
            .locator(`.st-v-exchange[data-turn-id=${JSON.stringify(first.id)}]`)
            .evaluate((node) => node.contains(document.activeElement))),
      );
      check(
        'last prompt remains accessible through its stable URL',
        plainWords(await navigate(last)) ===
          plainWords(textPages(decoded, last.promptRef!)[0]),
      );
      const candidates: Array<{ turn: ViewerTurn; item?: ViewerItem; ref: string }> = [];
      for (const turn of [...index.turns, ...index.unlinked]) {
        if (turn.promptRef) candidates.push({ turn, ref: turn.promptRef });
        if (turn.recapRef) candidates.push({ turn, ref: turn.recapRef });
        for (const id of turn.itemIds) {
          const item = index.items[id]!;
          if (item.textRef) candidates.push({ turn, item, ref: item.textRef });
          if (item.resultRef) candidates.push({ turn, item, ref: item.resultRef });
          for (const ref of item.rawRefs ?? []) candidates.push({ turn, item, ref });
        }
      }
      const largest = [...candidates].sort(
        (a, b) =>
          decoded.index.textStore.refs[b.ref]!.bytes -
          decoded.index.textStore.refs[a.ref]!.bytes,
      )[0];
      const revision = [...candidates]
        .reverse()
        .find((candidate) => candidate.item?.kind === 'revision');
      for (const selected of [largest, revision].filter(Boolean) as typeof candidates) {
        const pages = textPages(decoded, selected.ref);
        let correct = true;
        const limit = Math.min(pages.length, 64);
        const itemStarted = Date.now();
        const firstPageText = await navigate(
          selected.turn,
          selected.item,
          0,
          selected.ref,
        );
        if (selected.item?.kind === 'revision') correct &&= firstPageText === pages[0];
        correct &&=
          (await downloadedText(page, selected.ref)) === decoded.texts.get(selected.ref);
        if (
          selected.item?.kind === 'revision' &&
          performanceMetrics.firstDiffMs === undefined
        )
          performanceMetrics.firstDiffMs = Date.now() - itemStarted;
        for (let p = 1; p < limit; p++) {
          await page
            .locator(`[data-text-next=${JSON.stringify(selected.ref)}]:visible`)
            .first()
            .click();
          const shown = await visibleText(page);
          if (selected.item?.kind === 'revision') correct &&= shown === pages[p];
          await measure();
        }
        if (pages.length > limit) {
          const shown = await navigate(
            selected.turn,
            selected.item,
            pages.length - 1,
            selected.ref,
          );
          if (selected.item?.kind === 'revision')
            correct &&= shown === pages[pages.length - 1];
        }
        check(
          selected.item?.kind === 'revision'
            ? 'revision diff pages preserve exact recorded text'
            : 'large captured content uses exact bounded text pages',
          correct,
          `${limit}${pages.length > limit ? ' plus last' : ''}/${pages.length} pages inspected.`,
        );
        if (
          selected.item?.kind === 'revision' &&
          /\.[cm]?[jt]sx?$/i.test(selected.item.path ?? '') &&
          pages[0]!.length < 4096 &&
          /^\+const\b/m.test(pages[0]!)
        )
          check(
            'ordinary captured TypeScript diffs keep selective syntax highlighting',
            (await (await activeContent(page)).locator('.tok-kw').count()) > 0,
          );
        check(
          'opened text stays within the page byte and line limits',
          await (
            await activeContent(page)
          ).evaluate(
            (pre) =>
              new TextEncoder().encode(pre.textContent ?? '').byteLength <=
                32 * 1024 + 500 && pre.querySelectorAll('.st-v-diff-line').length <= 200,
          ),
        );
      }
      checks.push(...(await inspectVisibleParity(page, data, index, decoded)));
      await openSection(page, 'prompts');
      await page.locator('#st-viewer-filters').evaluate((element) => {
        (element as HTMLDetailsElement).open = true;
      });
      await page.locator('#st-viewer-group').selectOption('time');
      await page.locator('#st-viewer-sort').selectOption('oldest');
      // An exact late-body suffix exercises full content, beyond prompt previews and current DOM.
      let lateSearch:
        | { candidate: (typeof candidates)[number]; query: string }
        | undefined;
      for (const candidate of [...candidates].reverse()) {
        const text = decoded.texts.get(candidate.ref)!;
        if (text.length <= 220) continue;
        const explicit = text.match(/SHOWTAIL_LATE_SEARCH_[A-Z0-9_]+/);
        const query =
          explicit?.[0] ??
          text
            .slice(220)
            .split(/\r?\n/)
            .reverse()
            .map((line) => line.trim().slice(-70))
            .find((line) => line.length >= 12);
        const metadata = [
          candidate.turn.preview,
          ...candidate.turn.itemIds.map((id) => {
            const item = index.items[id]!;
            return [
              item.preview,
              item.title,
              item.path,
              item.sourceId,
              item.recordId,
              item.id,
              JSON.stringify(item.nativeEvents ?? []),
            ].join('\n');
          }),
        ].join('\n');
        if (query && !metadata.includes(query)) {
          lateSearch = { candidate, query };
          break;
        }
      }
      if (lateSearch) {
        const { candidate: late, query } = lateSearch;
        await openSection(page, late.turn.unlinked ? 'unlinked' : 'prompts');
        const searchStarted = Date.now();
        await page.locator('#st-viewer-search').fill(query);
        await page.waitForFunction(
          () => {
            const search = (window as any).ShowtailViewer.active.state.search;
            return (
              search &&
              Object.values(search.matches).some((ids) => (ids as unknown[]).length > 0)
            );
          },
          undefined,
          { timeout: 120000 },
        );
        performanceMetrics.searchFirstHitMs = Date.now() - searchStarted;
        await page.waitForFunction(
          () => {
            const active = (window as any).ShowtailViewer.active;
            return active.state.search && !active.state.searching;
          },
          undefined,
          { timeout: 120000 },
        );
        performanceMetrics.searchCompletionMs = Date.now() - searchStarted;
        check(
          'full-history search finds text beyond visible prompt previews',
          (await page
            .locator(
              `#st-viewer-list .st-v-open-turn[data-turn-id=${JSON.stringify(late.turn.id)}]`,
            )
            .count()) === 1,
          'Searched recorded body text, including late content.',
        );
        await page
          .locator(
            `#st-viewer-list .st-v-open-turn[data-turn-id=${JSON.stringify(late.turn.id)}]`,
          )
          .click();
        const shown = await visibleText(page);
        const selection = await page.evaluate(() => ({
          item: (window as any).ShowtailViewer.active.state.item,
          page: (window as any).ShowtailViewer.active.state.textPage,
          ref: (window as any).ShowtailViewer.active.state.textRef,
        }));
        const selectedRef =
          selection.ref ||
          (selection.item ? index.items[selection.item]?.textRef : late.turn.promptRef);
        const expectedPages = selectedRef ? textPages(decoded, selectedRef) : [];
        const matchAt = selectedRef
          ? decoded.texts.get(selectedRef)!.toLowerCase().indexOf(query.toLowerCase())
          : -1;
        let chars = 0;
        const hitPage = expectedPages.findIndex((text) => {
          chars += text.length;
          return matchAt >= 0 && matchAt < chars;
        });
        check(
          'search result opens its matching recorded item and text page',
          hitPage >= 0 &&
            selection.page === hitPage &&
            (selection.item && index.items[selection.item]?.kind === 'revision'
              ? shown === expectedPages[hitPage]
              : plainWords(shown) === plainWords(expectedPages[hitPage]!)),
          JSON.stringify({
            page: selection.page,
            expectedPage: hitPage,
            matchingItem: matchAt >= 0,
          }),
        );
        await page.locator('#st-viewer-search').fill('');
      }
      await page.locator('#st-viewer-zone').focus();
      await page.locator('#st-viewer-zone').selectOption('UTC');
      check(
        'timezone control updates rendered timestamps',
        (await page.locator('#st-viewer-zone').inputValue()) === 'UTC',
      );
    }
    await measure();
    const navigationCount = Number(process.env.SHOWTAIL_ACCEPTANCE_NAVIGATIONS ?? 0);
    if (
      !Number.isSafeInteger(navigationCount) ||
      navigationCount < 0 ||
      navigationCount > 1000
    )
      throw new Error('SHOWTAIL_ACCEPTANCE_NAVIGATIONS must be between 0 and 1000');
    if (navigationCount && index.turns.length) {
      for (let n = 0; n < navigationCount; n++) {
        await navigate(index.turns[n % index.turns.length]!);
        await page
          .locator(
            `.st-v-exchange[data-turn-id=${JSON.stringify(index.turns[n % index.turns.length]!.id)}] .st-v-open-turn`,
          )
          .click();
      }
      performanceMetrics.navigationCycles = navigationCount;
    }
    await heap('steadyMainHeapBytes');
    const cache = await page.evaluate(() =>
      (window as any).ShowtailViewer.active.stats(),
    );
    check(
      'live timeline and DOM remain bounded while browsing',
      maxRows <= 10 && maxNodes <= 10000,
      `${maxRows} timeline rows; ${maxNodes} DOM elements maximum.`,
    );
    check(
      'decoded worker cache remains within sixteen MiB',
      cache.cachedBytes <= 16 * 1024 * 1024 && cache.peakCachedBytes <= 16 * 1024 * 1024,
      JSON.stringify(cache),
    );
    const badLinks = await page
      .locator('a[href]')
      .evaluateAll((anchors) =>
        anchors
          .map((a) => a.getAttribute('href') ?? '')
          .filter((href) => !href.startsWith('#') && !/^https?:\/\//.test(href)),
      );
    check(
      'portable report contains no project-relative file links',
      badLinks.length === 0,
    );
    await screenshot(join(artifactDir, 'report-desktop.png'));
    await page.setViewportSize({ width: 320, height: 800 });
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    check(
      '320px report has no horizontal page overflow',
      layout.width <= layout.viewport + 1,
      JSON.stringify(layout),
    );
    await screenshot(join(artifactDir, 'report-mobile.png'));
    check('report does not make network requests', requests.length === 0);
    const violations = observedCsp;
    const factoryLine =
      html
        .split('\n')
        .findIndex((line) => line.includes('var element = document.createElement(tag)')) +
      1;
    cspDiagnostics =
      engine === 'webkit'
        ? violations.filter(
            (event) =>
              // WebKit's native select renderer emits a style-src-attr warning even for
              // document.createElement('select') in an otherwise style-free document.
              // Its exact source line must be our trusted factory, not captured markup.
              (event.directive === 'style-src-attr' &&
                event.source === 'file' &&
                event.line === factoryLine) ||
              // Playwright's WebKit screenshot preparation injects `body {}` (line 5).
              (event.directive === 'style-src-elem' &&
                event.source === '' &&
                event.line === 5 &&
                event.phase === 'screenshot'),
          )
        : [];
    const styleDiagnostic =
      "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
    let remainingDiagnostics = cspDiagnostics.length;
    const unexpectedErrors = errors.filter((message) => {
      if (message === styleDiagnostic && remainingDiagnostics > 0) {
        remainingDiagnostics--;
        return false;
      }
      return true;
    });
    check(
      'report has no unexpected browser errors',
      unexpectedErrors.length === 0,
      unexpectedErrors.join('\n'),
    );
    if (cspDiagnostics.length)
      check(
        'WebKit native-control and screenshot CSP diagnostics are identified separately',
        remainingDiagnostics === 0 && violations.length === cspDiagnostics.length,
        `${cspDiagnostics.length} source-verified engine/automation diagnostics; CSP remains enforced.`,
      );
    const fallback = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    try {
      await fallback.addInitScript(() => {
        Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
      });
      const p = await fallback.newPage();
      await p.goto(pathToFileURL(portable).href);
      await p
        .locator('.st-v-app[data-ready="true"][data-runtime="main-thread"]')
        .waitFor();
      await openSection(p, 'prompts');
      if (index.turns.length) {
        await p.locator('#st-viewer-list .st-v-open-turn[data-turn-id]').first().click();
        await visibleText(p);
      }
      check(
        'worker-disabled browser can open embedded content',
        !index.turns.length ||
          (await p.locator('[data-text-ref][data-loaded="true"]').count()) > 0,
      );
    } finally {
      await fallback.close();
    }
    if (index.turns.length) {
      const lateFailure = await browser.newContext({
        offline: true,
        serviceWorkers: 'block',
      });
      try {
        await lateFailure.addInitScript(() => {
          const NativeWorker = window.Worker;
          class FailingAfterInit extends NativeWorker {
            private failed = false;
            postMessage(message: any, ...options: any[]) {
              if (!this.failed && message.type !== 'init' && message.type !== 'chunk') {
                this.failed = true;
                queueMicrotask(() =>
                  this.dispatchEvent(
                    new ErrorEvent('error', {
                      message: 'Synthetic worker failure after initialization',
                      cancelable: true,
                    }),
                  ),
                );
                return;
              }
              return (NativeWorker.prototype.postMessage as any).call(
                this,
                message,
                ...options,
              );
            }
          }
          Object.defineProperty(window, 'Worker', {
            value: FailingAfterInit,
            configurable: true,
          });
        });
        const p = await lateFailure.newPage();
        await p.goto(pathToFileURL(portable).href);
        await p.locator('.st-v-app[data-ready="true"]').waitFor();
        await openSection(p, 'prompts');
        await p.locator('#st-viewer-list .st-v-open-turn[data-turn-id]').first().click();
        const text = await visibleText(p);
        await p.locator('.st-v-app[data-runtime="main-thread"]').waitFor();
        const first = [...index.turns].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp),
        )[0]!;
        check(
          'worker failure after initialization replays content loading through fallback',
          plainWords(text) === plainWords(textPages(decoded, first.promptRef!)[0]),
        );
      } finally {
        await lateFailure.close();
      }
    }
    const noJs = await browser.newContext({ javaScriptEnabled: false, offline: true });
    try {
      const p = await noJs.newPage();
      await p.goto(pathToFileURL(portable).href);
      check(
        'JavaScript-disabled report gives a readable overview and explicit guidance',
        (await p.locator('noscript').isVisible()) &&
          (await p.locator('#st-report-app > ol:last-of-type > li').count()) ===
            Math.min(25, index.turns.length),
      );
    } finally {
      await noJs.close();
    }
  } catch (error) {
    check(
      'browser inspection completed',
      false,
      error instanceof Error ? error.message : String(error),
    );
    await page
      .screenshot({ path: join(artifactDir, 'report-failure.png'), fullPage: true })
      .catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }
  writeFileSync(
    join(artifactDir, 'browser-checks.json'),
    JSON.stringify(
      {
        reportPath,
        checks,
        errors,
        metrics: { maxNodes, maxRows, engine, cpuRate, runtime, ...performanceMetrics },
        networkRequests: requests,
        cspDiagnostics,
      },
      null,
      2,
    ) + '\n',
  );
  return { checks };
}
