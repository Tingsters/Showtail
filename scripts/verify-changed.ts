/** Offline provider and centralized-storage verification. No accounts or project writes. */
import { spawnSync } from 'node:child_process';
const result = spawnSync(
  process.execPath,
  [
    'test',
    'tests/centralCapture.test.ts',
    'tests/centralHistory.test.ts',
    'tests/centralReaders.test.ts',
    'tests/claudeImport.test.ts',
    'tests/codexAppServer.test.ts',
    'tests/codexTranscript.test.ts',
    'tests/copilotChatTranscript.test.ts',
    'tests/copilotCliTranscript.test.ts',
    'tests/antigravityCliTranscript.test.ts',
    'tests/chatgpt.test.ts',
    'tests/gemini.test.ts',
  ],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(result.status ?? 1);
