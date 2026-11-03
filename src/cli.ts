#!/usr/bin/env bun
export {};
// Keep observation callbacks independent of the full CLI module graph.
if (process.argv[2] === 'hook') {
  const { observerMain } = await import('./core/passiveObserver.ts');
  await observerMain(process.argv.slice(3));
} else if (process.argv[2] === '_collect') {
  try {
    const { collectObservations } = await import('./core/passiveCollector.ts');
    await collectObservations();
  } catch {
    /* A detached observer must never disturb the coding host. */
  }
} else {
  const { runHistoryCli } = await import('./commands/historyCli.ts');
  await runHistoryCli();
}
