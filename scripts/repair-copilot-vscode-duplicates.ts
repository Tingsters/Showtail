import {
  applyCopilotVscodeDuplicateRepair,
  planCopilotVscodeDuplicateRepair,
} from '../src/internal/repairCopilotVscodeDuplicates.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const root = args.find((arg) => !arg.startsWith('--')) ?? process.cwd();

try {
  const plan = planCopilotVscodeDuplicateRepair(root);
  console.log(`Guarded repair target: ${plan.root}`);
  console.log(`  false Copilot CLI prompts: ${plan.counts.falseCliPrompts}`);
  console.log(`  result-linked manual prompts: ${plan.counts.linkedManualPrompts}`);
  console.log(`  nearby manual prompts: ${plan.counts.nearbyManualPrompts}`);
  console.log(`  obsolete logging tool calls: ${plan.counts.obsoleteToolCalls}`);
  console.log(`  total entries: ${plan.counts.total}`);

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to back up and repair the journal.');
  } else {
    const result = applyCopilotVscodeDuplicateRepair(root);
    console.log(
      `Removed ${result.removed} entries and appended repair marker ${result.markerId}.`,
    );
    console.log(`Journal backup: ${result.backupDir}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
