/** Browser assertions shared by recorded-fixture and real-session acceptance runs. */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export interface ReportCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

const canonical = (value: string) => value.replace(/\r\n?/g, '\n').trim();

function browserEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(key),
    ),
  );
}

function nativeNode(): string {
  const candidates: string[] = [];
  if (process.env.SHOWTAIL_ACCEPTANCE_NODE_BIN)
    candidates.push(process.env.SHOWTAIL_ACCEPTANCE_NODE_BIN);
  const located = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    ['node'],
    { env: process.env, encoding: 'utf8', timeout: 5000 },
  );
  candidates.push(...(located.stdout ?? '').trim().split(/\r?\n/).filter(Boolean));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA)
    candidates.push(
      join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
    );
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const probe = spawnSync(
      bin,
      ['-p', 'process.versions.bun ? "bun" : process.versions.node'],
      {
        env: { ...browserEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      },
    );
    if (probe.status === 0 && Number(probe.stdout.trim().split('.')[0]) >= 20) return bin;
  }
  throw new Error(
    'UNAVAILABLE: browser acceptance requires real Node20+; set SHOWTAIL_ACCEPTANCE_NODE_BIN (VS Code Node mode is supported).',
  );
}

async function inspectInNode(
  reportPath: string,
  artifactDir: string,
  expectedPrompts: string[],
) {
  mkdirSync(artifactDir, { recursive: true });
  const resultPath = join(artifactDir, 'node-browser-result.json');
  if (existsSync(resultPath)) unlinkSync(resultPath);
  const inputPath = join(artifactDir, 'node-browser-input.json');
  writeFileSync(
    inputPath,
    JSON.stringify({ reportPath, artifactDir, expectedPrompts, resultPath }),
  );
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'browser-worker.ts')],
    outdir: artifactDir,
    naming: 'browser-worker.cjs',
    target: 'node',
    format: 'cjs',
    external: ['playwright'],
  });
  if (!built.success) throw new Error(built.logs.map((x) => x.message).join('\n'));
  const binary = nativeNode();
  const ran = spawnSync(binary, [join(artifactDir, 'browser-worker.cjs'), inputPath], {
    env: {
      ...browserEnvironment(),
      ELECTRON_RUN_AS_NODE: '1',
      // Artifacts may be outside the checkout; resolve the installed dependency
      // from this harness, rather than from the generated worker's ancestors.
      NODE_PATH: dirname(dirname(Bun.resolveSync('playwright', import.meta.dir))),
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (ran.error) throw ran.error;
  if (!existsSync(resultPath))
    throw new Error(`Browser worker exited ${ran.status}: ${ran.stderr}`);
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    checks: ReportCheck[];
  };
  if (!Array.isArray(result.checks) || !result.checks.length)
    throw new Error('Browser worker returned no checks');
  if (ran.status !== 0 && result.checks.every((c) => c.ok))
    result.checks.push({
      name: 'browser worker exited cleanly',
      ok: false,
      detail: `Exit ${ran.status}`,
    });
  writeFileSync(
    join(artifactDir, 'browser-runtime.json'),
    JSON.stringify({ binary, nodeMode: true, exitCode: ran.status }, null, 2) + '\n',
  );
  return result;
}

export async function inspectReport(
  reportPath: string,
  artifactDir: string,
  expectedPrompts: string[],
): Promise<{ checks: ReportCheck[] }> {
  if (process.versions.bun)
    return inspectInNode(reportPath, artifactDir, expectedPrompts);
  mkdirSync(artifactDir, { recursive: true });
  for (const name of ['report.html', 'report.md', 'report.json'])
    copyFileSync(join(dirname(reportPath), name), join(artifactDir, name));
  const checks: ReportCheck[] = [];
  const errors: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const browserEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(key),
    ),
  );
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 20_000, env: browserEnv });
  } catch (error) {
    check(
      'Chromium is available for report acceptance',
      false,
      error instanceof Error ? error.message : String(error),
    );
    writeFileSync(
      join(artifactDir, 'browser-checks.json'),
      JSON.stringify({ reportPath, checks, errors }, null, 2) + '\n',
    );
    return { checks };
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    // The structured sidecar and browser are independently compared with submitted
    // prompts; a renderer dropping the first or an identical later turn fails here.
    const data = JSON.parse(
      readFileSync(join(dirname(reportPath), 'report.json'), 'utf8'),
    );
    const storedPrompts: string[] = data.turns.map((turn: any) => turn.prompt.text);
    check(
      'report JSON preserves submitted prompt sequence',
      JSON.stringify(storedPrompts.map(canonical)) ===
        JSON.stringify(expectedPrompts.map(canonical)),
      `Expected ${expectedPrompts.length} prompts; found ${storedPrompts.length}.`,
    );
    await page.goto(pathToFileURL(reportPath).href);
    check('standalone report loads', (await page.title()).startsWith('Showtail Report'));
    const turns = page.locator('#st-exchanges > details.turn');
    check(
      'browser has one card per submitted prompt',
      (await turns.count()) === expectedPrompts.length,
    );
    const expand = page.locator('#st-expand');
    if (await expand.count()) {
      await expand.click();
      check(
        'expand all opens every exchange',
        (await page.locator('details.turn:not([open])').count()) === 0,
      );
    }
    const visiblePrompts = await turns.evaluateAll((rows) =>
      rows.map((row) => {
        const full = row.querySelector('.prompt-block > .ai-text') as HTMLElement | null;
        return full
          ? full.innerText
          : (row.querySelector(':scope > summary .prompt-text')?.textContent ?? '');
      }),
    );
    check(
      'browser preserves submitted prompt text and order',
      JSON.stringify(visiblePrompts.map(canonical)) ===
        JSON.stringify(expectedPrompts.map(canonical)),
      `Compared ${visiblePrompts.length} rendered prompts, including multiline and repeated text.`,
    );

    // Exercise native disclosure controls through real clicks, including plans,
    // diffs and tool groups. Opening parents first makes nested summaries visible.
    const details = page.locator('details');
    let disclosureFailures = 0;
    const disclosureCount = await details.count();
    for (let i = 0; i < disclosureCount; i++) {
      const detail = details.nth(i);
      const summary = detail.locator(':scope > summary');
      if (!(await summary.isVisible())) continue;
      await summary.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const wasOpen = await detail.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      );
      await summary.click();
      if (
        (await detail.evaluate((element) => (element as HTMLDetailsElement).open)) ===
        wasOpen
      )
        disclosureFailures++;
      await summary.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await summary.click();
    }
    check(
      'exchange and nested disclosure controls toggle',
      disclosureFailures === 0,
      `${disclosureCount} disclosure elements examined.`,
    );

    const workspaceDeltas = (data.fileObservations ?? []).filter(
      (observation: any) => observation.basis === 'workspace-delta' && observation.diff,
    );
    if (workspaceDeltas.length) {
      const observedDiffs = page.locator('.file-observations details');
      check(
        'workspace delta has a disclosure per persisted diff',
        (await observedDiffs.count()) === workspaceDeltas.length,
      );
      for (let i = 0; i < workspaceDeltas.length; i++) {
        const disclosure = observedDiffs.nth(i);
        await disclosure.locator(':scope > summary').click();
        const visibleLines = await disclosure
          .locator('pre.diff .dline')
          .allTextContents();
        const lineText = (line: string) => line.replace(/^[ +\-] ?/, '').trim();
        check(
          'observed workspace diff remains readable with unverified authorship',
          JSON.stringify(visibleLines.map(lineText)) ===
            JSON.stringify(workspaceDeltas[i].diff.split('\n').map(lineText)) &&
            (await disclosure.locator('..').innerText()).includes('author unverified'),
        );
      }
    }

    const originalOrder = await turns.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-ts')),
    );
    const timeButton = page.locator('#st-sort [data-mode="time"]');
    const sessionButton = page.locator('#st-sort [data-mode="session"]');
    if (await timeButton.count()) {
      await timeButton.click();
      const descending = await turns.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-ts')),
      );
      check(
        'time sort reverses chronology',
        JSON.stringify(descending) === JSON.stringify([...originalOrder].reverse()),
      );
      await sessionButton.click();
      const grouped = await turns.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-session')),
      );
      const runs = grouped.filter(
        (session, index) => index === 0 || session !== grouped[index - 1],
      );
      check(
        'session sort groups each conversation once',
        new Set(runs).size === runs.length,
      );
      check(
        'session sort displays a heading per conversation',
        (await page.locator('.st-session-sep').count()) === new Set(grouped).size,
      );
      await sessionButton.click();
      const reversedGroups = await turns.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-session')),
      );
      const reversedRuns = reversedGroups.filter(
        (session, index) => index === 0 || session !== reversedGroups[index - 1],
      );
      check(
        'session sort reverses conversation order',
        JSON.stringify(reversedRuns) === JSON.stringify([...runs].reverse()),
      );
      await timeButton.click();
      if ((await timeButton.getAttribute('data-dir')) !== 'asc') await timeButton.click();
    }

    const aiToggle = page.locator('#st-ai');
    if (await aiToggle.count()) {
      await page.locator('.st-switch').click();
      const hidden = await page
        .locator('.ai-block')
        .evaluateAll((blocks) =>
          blocks.every((block) => getComputedStyle(block).display === 'none'),
        );
      check('AI visibility switch hides narration', hidden);
      await page.locator('.st-switch').click();
      check(
        'AI visibility switch restores narration',
        await page
          .locator('.ai-block')
          .evaluateAll((blocks) =>
            blocks.every((block) => getComputedStyle(block).display !== 'none'),
          ),
      );
    }

    const moreButtons = page.locator('.ai-more');
    const longBlocks = await page
      .locator('.ai-block')
      .evaluateAll(
        (blocks) =>
          blocks.filter((block) => (block as HTMLElement).scrollHeight > 18 * 16 + 24)
            .length,
      );
    const isFullMode =
      (await page.locator('#st-exchanges').getAttribute('data-ai-mode')) === 'full';
    check(
      'long narration gets a working disclosure',
      isFullMode || longBlocks === 0 || (await moreButtons.count()) >= longBlocks,
      `${longBlocks} long narration blocks; ${await moreButtons.count()} controls.`,
    );
    for (const button of await moreButtons.all()) {
      await button.click();
      check(
        'show more expands narration',
        (await button.getAttribute('aria-expanded')) === 'true',
      );
      await button.click();
      check(
        'show less collapses narration',
        (await button.getAttribute('aria-expanded')) === 'false',
      );
    }

    const badLinks = await page.locator('a[href]').evaluateAll((anchors) =>
      anchors.flatMap((anchor) => {
        const href = anchor.getAttribute('href') ?? '';
        if (href.startsWith('#'))
          return document.getElementById(decodeURIComponent(href.slice(1))) ? [] : [href];
        return /^https?:\/\//.test(href) ? [] : [href];
      }),
    );
    check(
      'links resolve inside the portable report or use HTTP',
      badLinks.length === 0,
      badLinks.join(', '),
    );
    await page.locator('details').evaluateAll((elements) => {
      for (const element of elements) (element as HTMLDetailsElement).open = true;
    });
    const diffOverflow = await page
      .locator('pre.diff')
      .evaluateAll((diffs) =>
        diffs.every((diff) =>
          ['auto', 'scroll'].includes(getComputedStyle(diff).overflowX),
        ),
      );
    check('captured diffs remain independently scrollable', diffOverflow);
    await page.screenshot({
      path: join(artifactDir, 'report-desktop.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 320, height: 800 });
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      clippedText: Array.from(
        document.querySelectorAll(
          '.prompt-text, .ai-text, .turn-detail, .code > summary',
        ),
      ).flatMap((element) => {
        const node = element as HTMLElement;
        if (!node.getClientRects().length) return [];
        return node.scrollWidth > node.clientWidth + 2 ? [node.className] : [];
      }),
    }));
    check(
      '320px report has no horizontal page overflow',
      layout.width <= layout.viewport + 1,
      JSON.stringify(layout),
    );
    check(
      '320px prose and labels are not clipped',
      layout.clippedText.length === 0,
      layout.clippedText.join(', '),
    );
    await page.screenshot({
      path: join(artifactDir, 'report-mobile.png'),
      fullPage: true,
    });

    if (await expand.count()) {
      await expand.click();
      check(
        'collapse all closes every exchange',
        (await page.locator('details.turn[open]').count()) === 0,
      );
    }
    check('report has no browser errors', errors.length === 0, errors.join('\n'));
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
    JSON.stringify({ reportPath, checks, errors }, null, 2) + '\n',
  );
  return { checks };
}
