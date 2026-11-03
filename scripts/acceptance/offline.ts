/** Rich, deterministic report fixture; this lane never contacts a provider. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { HistoryStore } from '../../src/core/history.ts';
import { writeGlobalConfig } from '../../src/core/globalConfig.ts';
import type { ReportCheck } from './report.ts';

function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else
        result[file.slice(root.length)] = createHash('sha256')
          .update(readFileSync(file))
          .digest('hex');
    }
  };
  walk(root);
  return result;
}

export async function runOffline(options: {
  binary: string;
  artifactDir: string;
}): Promise<{
  checks: ReportCheck[];
  reportPath: string;
  expectedPrompts: string[];
}> {
  mkdirSync(options.artifactDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'showtail-acceptance-report-'));
  const home = join(root, 'history');
  const project = join(root, 'project with spaces & %PATH% !');
  mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{}\n');
  writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), 'user owned hook\n');
  const env = {
    ...process.env,
    SHOWTAIL_HOME: home,
    SHOWTAIL_IDENTITY_NAME: 'Acceptance Tester',
    SHOWTAIL_IDENTITY_EMAIL: 'acceptance@example.com',
    SHOWTAIL_DISABLE_FIRST_RUN: '1',
    SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    COPILOT_HOME: join(root, 'copilot'),
    GEMINI_HOME: join(root, 'gemini'),
    SHOWTAIL_CODEX_BIN: join(root, 'no-codex'),
    SHOWTAIL_VSCODE_STORAGE: join(root, 'no-editor'),
  };
  for (const key of Object.keys(env)) {
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(key))
      delete (env as Record<string, string | undefined>)[key];
  }
  const expectedPrompts = [
    'Build the parser from this initial prompt.\nPreserve <literal> text & punctuation.',
    'Review the parser in a second conversation.',
    'Run the tests again.',
    'Run the tests again.',
    'Document the completed implementation at https://example.test/' +
      'a'.repeat(240) +
      '\n' +
      'Keep every part of this long human prompt visible when its exchange is expanded. '.repeat(
        5,
      ),
  ];
  const checks: ReportCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const prior = process.env.SHOWTAIL_HOME;
  const priorName = process.env.SHOWTAIL_IDENTITY_NAME;
  const priorEmail = process.env.SHOWTAIL_IDENTITY_EMAIL;
  try {
    process.env.SHOWTAIL_HOME = home;
    process.env.SHOWTAIL_IDENTITY_NAME = env.SHOWTAIL_IDENTITY_NAME;
    process.env.SHOWTAIL_IDENTITY_EMAIL = env.SHOWTAIL_IDENTITY_EMAIL;
    writeGlobalConfig({
      version: 2,
      captureEnabled: true,
      settings: { captureToolOutput: true },
    });
    using store = new HistoryStore();
    const started = Date.now() - 60_000;
    const stamp = (offset: number) => new Date(started + offset).toISOString();
    const first = store.ensureSession({
      tool: 'codex',
      nativeSessionId: 'recorded-codex',
      cwd: project,
      startedAt: stamp(0),
    });
    const second = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'recorded-claude',
      cwd: project,
      startedAt: stamp(1000),
    });
    for (let index = 0; index < expectedPrompts.length; index++) {
      const session = index === 1 ? second : first;
      const text = expectedPrompts[index]!;
      const prompt = store.append(session.id, {
        kind: 'prompt',
        origin: 'human',
        sourceId: `prompt-${index}`,
        text,
        ts: stamp(index * 5000),
      });
      const turnId = prompt.record!.turnId!;
      store.append(session.id, {
        kind: 'ai_output',
        sourceId: `reply-${index}`,
        turnId,
        text:
          index === 0
            ? Array.from(
                { length: 50 },
                (_, line) =>
                  `Explanation line ${line + 1}: this deliberately long answer checks the narration disclosure.`,
              ).join('\n')
            : 'Completed this part of the implementation.',
        model: index === 1 ? 'claude-test' : 'codex-test',
        ts: stamp(index * 5000 + 100),
      });
      store.append(session.id, {
        kind: 'edit',
        sourceId: `edit-${index}`,
        turnId,
        file: join(project, index === 1 ? 'review.ts' : 'parser.ts'),
        diff: `@@ -1 +1 @@\n-old ${index}\n+new ${index}`,
        ts: stamp(index * 5000 + 200),
      });
      if (index === 0) {
        store.append(session.id, {
          kind: 'plan',
          sourceId: 'plan',
          turnId,
          text: '# Parser plan\n1. Build a parser.\n2. Exercise failure cases.\n3. Document the result.',
          ts: stamp(300),
        });
        const failedCall = store.append(session.id, {
          kind: 'tool_call',
          sourceId: 'failed-test',
          turnId,
          text: 'Run tests\nExpected initial failure: exit code 1.',
          toolName: 'Bash',
          isError: true,
          ts: stamp(400),
        }).record!;
        const observedFile = join(project, 'shell-created.ts');
        writeFileSync(observedFile, 'Observed file state after a failed test command.\n');
        store.append(session.id, {
          kind: 'audit',
          sourceId: 'shell-state-observation',
          turnId,
          file: observedFile,
          sha256: createHash('sha256').update(readFileSync(observedFile)).digest('hex'),
          ts: new Date().toISOString(),
          tags: ['observed-file-state', 'shell-write-attempt', 'tool-outcome:failed'],
          provenance: {
            source: 'native-shell-write-observation',
            id: failedCall.sourceId!,
          },
        });
        store.append(session.id, {
          kind: 'audit',
          sourceId: 'shared-workspace-observation',
          turnId,
          file: join(project, 'shared-' + 'long-path-'.repeat(24) + '.ts'),
          diff: '@@ -1 +1 @@\n-before\n+<literal> change observed from another process',
          ts: stamp(450),
          tags: ['observed-workspace-delta', 'tool-outcome:failed'],
          provenance: { source: 'native-workspace-delta', id: failedCall.sourceId! },
        });
      }
    }
  } finally {
    for (const [key, value] of Object.entries({
      SHOWTAIL_HOME: prior,
      SHOWTAIL_IDENTITY_NAME: priorName,
      SHOWTAIL_IDENTITY_EMAIL: priorEmail,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const immutable = () => {
    const db = new Database(join(home, 'history.sqlite'), { readonly: true });
    try {
      return JSON.stringify(db.query('SELECT id,hash FROM records ORDER BY id').all());
    } finally {
      db.close();
    }
  };
  const originalRows = immutable();
  const projectBefore = JSON.stringify(tree(project));
  const cli = (args: string[], cwd = project) => {
    const result = spawnSync(resolve(options.binary), args, {
      env,
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    if (result.status !== 0)
      throw new Error(
        `Showtail ${args[0]} failed (${result.status}): ${result.stderr || result.stdout || result.error?.message}`,
      );
    return JSON.parse(result.stdout);
  };
  const firstReport = cli(['report', '--all', '--json', '--no-sync', '--no-open']);
  const reportPath = firstReport.reportPath as string;
  const data = JSON.parse(
    readFileSync(join(join(reportPath, '..'), 'report.json'), 'utf8'),
  );
  check(
    'compiled CLI creates all report formats centrally',
    ['report.html', 'report.md', 'report.json'].every((file) =>
      existsSync(join(reportPath, '..', file)),
    ) && reportPath.startsWith(home),
  );
  check(
    'structured report keeps every initial and repeated human prompt',
    JSON.stringify(data.turns.map((turn: any) => turn.prompt.text)) ===
      JSON.stringify(expectedPrompts),
  );
  check(
    'structured report has one applied revision per recorded edit',
    data.turns.reduce(
      (count: number, turn: any) =>
        count +
        turn.codeChanges.reduce(
          (sum: number, change: any) => sum + change.revisions.length,
          0,
        ),
      0,
    ) === 5,
  );
  const secondReport = cli(['report', '--all', '--json', '--no-sync', '--no-open']);
  check(
    'standalone file observations stay separate from applied revisions',
    data.fileObservations?.length === 2 &&
      data.fileObservations.some(
        (observation: any) =>
          observation.basis === 'shell-write-attempt' &&
          observation.toolOutcome === 'failed' &&
          observation.editId === undefined &&
          Boolean(observation.toolCallId),
      ) &&
      data.summary.artifacts === 5,
  );
  check(
    'persisted workspace deltas retain diffs without fabricated hashes or revisions',
    data.fileObservations?.some(
      (observation: any) =>
        observation.basis === 'workspace-delta' &&
        observation.diff?.includes('<literal> change observed from another process') &&
        observation.sha256 === undefined &&
        observation.editId === undefined,
    ) && data.summary.artifacts === 5,
  );
  const repeated = JSON.parse(
    readFileSync(join(secondReport.reportPath, '..', 'report.json'), 'utf8'),
  );
  check(
    'repeated report creation preserves prompt and revision counts',
    JSON.stringify(repeated.turns) === JSON.stringify(data.turns),
  );
  check(
    'successive reports retain separate valid artifacts',
    secondReport.reportPath !== reportPath && existsSync(reportPath),
  );
  check(
    'history integrity verifies after reporting',
    cli(['verify', '--json']).ok === true,
  );
  check('report creation preserves immutable capture rows', immutable() === originalRows);
  check(
    'report creation leaves project and Git hooks byte-for-byte intact',
    JSON.stringify(tree(project)) === projectBefore,
  );
  const submission = cli(['submit', '--all', '--json', '--no-sync']);
  const exportEvidence = join(options.artifactDir, 'export');
  mkdirSync(exportEvidence, { recursive: true });
  for (const file of ['report.html', 'report.md', 'manifest.json', 'manifest.sig'])
    copyFileSync(join(submission.exportPath, file), join(exportEvidence, file));
  check(
    'compiled CLI creates a verified central export',
    typeof submission.exportPath === 'string' && submission.exportPath.startsWith(home),
  );
  const moved = join(root, 'relocated project');
  for (const path of [project, moved]) {
    const contained = relative(resolve(root), resolve(path));
    if (contained.startsWith('..') || isAbsolute(contained))
      throw new Error('Unsafe acceptance fixture relocation');
  }
  renameSync(project, moved);
  const relocated = spawnSync(
    resolve(options.binary),
    ['report', '--all', '--json', '--no-sync', '--no-open'],
    { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  check('report creation works after source project relocation', relocated.status === 0);
  check(
    'export retains standalone HTML and signed manifest after relocation',
    ['report.html', 'report.md', 'manifest.json', 'manifest.sig'].every((file) =>
      existsSync(join(submission.exportPath, file)),
    ),
  );
  check(
    'relocated export signature and contents verify through the CLI',
    cli(['verify-submission', submission.exportPath, '--json'], root).ok === true,
  );
  const tampered = join(root, 'tampered export');
  mkdirSync(tampered);
  for (const file of ['report.html', 'report.md', 'manifest.json', 'manifest.sig'])
    copyFileSync(join(submission.exportPath, file), join(tampered, file));
  writeFileSync(
    join(tampered, 'report.html'),
    readFileSync(join(tampered, 'report.html'), 'utf8') + '\n<!-- tampered fixture -->',
  );
  const rejected = spawnSync(
    resolve(options.binary),
    ['verify-submission', tampered, '--json'],
    { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  check(
    'tampered export is rejected by independent verification',
    rejected.status !== 0 && JSON.parse(rejected.stdout).ok === false,
  );
  check(
    'export and relocation preserve immutable capture rows',
    immutable() === originalRows,
  );
  writeFileSync(
    join(options.artifactDir, 'offline-checks.json'),
    JSON.stringify({ fixtureRoot: root, reportPath, expectedPrompts, checks }, null, 2) +
      '\n',
  );
  // Deliberately retain the isolated fixture so failed runs are inspectable.
  return { checks, reportPath, expectedPrompts };
}
