import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureInterruptedError } from '../src/core/captureGuard.ts';
import {
  appendLedgerRecord,
  ensureLedgerSegments,
  ensureLedgerSession,
  markLedgerSegmentPlaced,
  markPlaced,
  readLedgerIndex,
  readLedgerSession,
} from '../src/core/ledger.ts';
import { ensureMachineId } from '../src/core/identity.ts';
import {
  clearOtherLedgerProjections,
  ProjectionTargetIdentityMismatchError,
  removeOtherLedgerProjections,
} from '../src/core/projectionRouting.ts';
import { pruneProvisionalTrail } from '../src/core/provisionalTrail.ts';
import { CONFIG_VERSION, pathsForRoot, writeJson } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

const GITATTRIBUTES = `# Showtail stores content-addressed objects; keep bytes byte-exact.
* -text
`;

const GITIGNORE = `state.json
reports/
diag/

# Keep journal segments committable even when the project ignores *.log.
!authors/**/journal/**/*.log
`;

interface Fixture {
  root: string;
  home: string;
  machineId: string;
  trailId: string;
  ledgerSessionId: string;
  journalFile: string;
}

let previousHome: string | undefined;
let cleanupDirs: string[];

beforeEach(() => {
  previousHome = process.env.SHOWTAIL_HOME;
  cleanupDirs = [];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = previousHome;
  for (const dir of cleanupDirs.reverse()) cleanup(dir);
});

function seedPristineTrail(root = makeTempDir()): Fixture {
  const home = makeTempDir();
  cleanupDirs.push(root, home);
  process.env.SHOWTAIL_HOME = home;

  const machineId = ensureMachineId();
  const ledger = ensureLedgerSession({
    tool: 'codex',
    nativeSessionId: 'native-session-1',
    machineId,
    cwd: root,
  });
  const trailId = 'trl_provisional_test';
  const paths = pathsForRoot(root);
  for (const dir of [paths.base, paths.authorsDir, paths.objectsDir, paths.reportsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeJson(paths.config, {
    version: CONFIG_VERSION,
    createdAt: '2026-09-10T00:00:00.000Z',
    anchor: root,
    anchorKind: 'cwd',
    initialization: {
      mode: 'automatic',
      evidence: 'cwd',
      ledgerSessionId: ledger.id,
    },
    trailId,
    settings: {
      git: false,
      captureAiOutput: true,
      captureCode: true,
      captureToolCalls: true,
      redact: { enabled: true, secrets: true, pii: true },
    },
  });
  writeFileSync(join(paths.base, '.gitattributes'), GITATTRIBUTES);
  writeFileSync(join(paths.base, '.gitignore'), GITIGNORE);

  const slug = 'student_example.com';
  const authorDir = join(paths.authorsDir, slug);
  mkdirSync(join(authorDir, 'sessions'), { recursive: true });
  mkdirSync(join(authorDir, 'journal', machineId), { recursive: true });
  writeJson(join(authorDir, 'author.json'), {
    slug,
    email: 'student@example.com',
    name: 'Student',
    createdAt: '2026-09-10T00:00:00.000Z',
  });
  writeJson(join(authorDir, 'sessions', `${machineId}.json`), [
    {
      id: 'ses_repo_1',
      startedAt: '2026-09-10T00:00:00.000Z',
      tool: 'codex',
      nativeSessionId: 'native-session-1',
      machineId,
    },
  ]);

  const content = 'Build the project';
  const digest = createHash('sha256').update(content).digest('hex');
  const objectDir = join(paths.objectsDir, digest.slice(0, 2));
  mkdirSync(objectDir, { recursive: true });
  writeFileSync(join(objectDir, digest.slice(2)), content);
  const journalFile = join(authorDir, 'journal', machineId, '0001.log');
  writeFileSync(
    journalFile,
    `${JSON.stringify({
      v: 1,
      kind: 'event',
      id: 'evt_prompt_1',
      ts: '2026-09-10T00:00:00.000Z',
      type: 'prompt',
      tool: 'codex',
      conv: 'ses_repo_1',
      actorSlug: slug,
      refs: [`sha256:${digest}`],
      batch: `ledger:${ledger.id}`,
    })}\n`,
  );
  writeJson(paths.state, {
    currentSessionId: 'ses_repo_1',
    currentAuthorSlug: slug,
    currentPromptId: 'evt_prompt_1',
    turnByNativeSession: { 'native-session-1': 'evt_prompt_1' },
  });
  markPlaced(ledger.id, trailId, root);

  return {
    root,
    home,
    machineId,
    trailId,
    ledgerSessionId: ledger.id,
    journalFile,
  };
}

function initGitRepo(root: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'student@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Student'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
}

describe('pruneProvisionalTrail', () => {
  test('restores a claimed trail and preserves placement when consent changes', async () => {
    const fixture = seedPristineTrail();
    const session = readLedgerSession(fixture.ledgerSessionId)!;
    const continueCapture = (): boolean =>
      !readdirSync(fixture.root).some((name) => name.startsWith('.showtail.prune-'));

    await expect(
      clearOtherLedgerProjections(session, undefined, { continueCapture }),
    ).rejects.toBeInstanceOf(CaptureInterruptedError);

    expect(existsSync(join(fixture.root, '.showtail', 'config.json'))).toBe(true);
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith('.showtail.prune-')),
    ).toEqual([]);
    expect(readFileSync(fixture.journalFile, 'utf8')).toContain('evt_prompt_1');
    expect(readLedgerSession(fixture.ledgerSessionId)?.targets).toContainEqual({
      trailId: fixture.trailId,
      path: fixture.root,
    });
  });

  test('finishes placement cleanup when consent changes after pruning commits', async () => {
    const fixture = seedPristineTrail();
    const session = readLedgerSession(fixture.ledgerSessionId)!;
    const continueCapture = (): boolean => {
      const entries = readdirSync(fixture.root);
      return (
        existsSync(join(fixture.root, '.showtail')) ||
        entries.some((name) => name.startsWith('.showtail.prune-'))
      );
    };

    await expect(
      clearOtherLedgerProjections(session, undefined, { continueCapture }),
    ).resolves.toEqual([fixture.root]);

    expect(existsSync(join(fixture.root, '.showtail'))).toBe(false);
    expect(readLedgerSession(fixture.ledgerSessionId)).toEqual(
      expect.objectContaining({ status: 'inbox', targets: [] }),
    );
    expect(readLedgerIndex().sessions[fixture.ledgerSessionId]).toEqual([]);
  });

  test('finishes fallback cleanup when consent changes after its first rewrite', async () => {
    const fixture = seedPristineTrail();
    const report = join(fixture.root, '.showtail', 'reports', 'report.html');
    writeFileSync(report, '<html>keep this trail</html>');
    const session = readLedgerSession(fixture.ledgerSessionId)!;
    const continueCapture = (): boolean =>
      existsSync(fixture.journalFile) &&
      readFileSync(fixture.journalFile, 'utf8').includes('evt_prompt_1');

    await expect(
      clearOtherLedgerProjections(session, undefined, { continueCapture }),
    ).resolves.toEqual([fixture.root]);

    expect(existsSync(report)).toBe(true);
    expect(readFileSync(fixture.journalFile, 'utf8')).not.toContain('evt_prompt_1');
    expect(
      JSON.parse(
        readFileSync(
          join(
            fixture.root,
            '.showtail',
            'authors',
            'student_example.com',
            'sessions',
            `${fixture.machineId}.json`,
          ),
          'utf8',
        ),
      ),
    ).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(fixture.root, '.showtail', 'state.json'), 'utf8')),
    ).toEqual({
      currentSessionId: null,
      currentAuthorSlug: 'student_example.com',
      currentPromptId: null,
      turnByNativeSession: {},
    });
    expect(readLedgerSession(fixture.ledgerSessionId)).toEqual(
      expect.objectContaining({ status: 'inbox', targets: [] }),
    );
    expect(readLedgerIndex().sessions[fixture.ledgerSessionId]).toEqual([]);
  });

  test('removes vacated sessions from each owning machine shard', async () => {
    const fixture = seedPristineTrail();
    const report = join(fixture.root, '.showtail', 'reports', 'report.html');
    writeFileSync(report, '<html>keep this trail</html>');
    const authorDir = join(fixture.root, '.showtail', 'authors', 'student_example.com');
    const otherMachineId = 'machine-other';
    const localSessionsFile = join(authorDir, 'sessions', `${fixture.machineId}.json`);
    const otherSessionsFile = join(authorDir, 'sessions', `${otherMachineId}.json`);
    writeJson(localSessionsFile, [
      {
        id: 'ses_repo_1',
        startedAt: '2026-09-10T00:00:00.000Z',
        tool: 'codex',
        nativeSessionId: 'native-session-1',
        machineId: fixture.machineId,
      },
      {
        id: 'ses_local_keep',
        startedAt: '2026-09-10T00:00:00.000Z',
        tool: 'codex',
        nativeSessionId: 'local-session',
        machineId: fixture.machineId,
      },
    ]);
    writeJson(otherSessionsFile, [
      {
        id: 'ses_repo_other',
        startedAt: '2026-09-10T00:00:00.000Z',
        tool: 'codex',
        nativeSessionId: 'native-session-1',
        machineId: otherMachineId,
      },
      {
        id: 'ses_remote_keep',
        startedAt: '2026-09-10T00:00:00.000Z',
        tool: 'codex',
        nativeSessionId: 'remote-session',
        machineId: otherMachineId,
      },
    ]);
    writeFileSync(
      fixture.journalFile,
      `${readFileSync(fixture.journalFile, 'utf8')}${JSON.stringify({
        v: 1,
        kind: 'event',
        id: 'evt_prompt_other',
        ts: '2026-09-10T00:01:00.000Z',
        type: 'prompt',
        tool: 'codex',
        conv: 'ses_repo_other',
        actorSlug: 'student_example.com',
        batch: `ledger:${fixture.ledgerSessionId}`,
      })}\n`,
    );
    writeJson(join(fixture.root, '.showtail', 'state.json'), {
      currentSessionId: 'ses_repo_other',
      currentAuthorSlug: 'student_example.com',
      currentPromptId: 'evt_prompt_other',
      turnByNativeSession: { 'native-session-1': 'evt_prompt_other' },
    });

    const session = readLedgerSession(fixture.ledgerSessionId)!;
    await expect(clearOtherLedgerProjections(session)).resolves.toEqual([fixture.root]);

    expect(
      (JSON.parse(readFileSync(localSessionsFile, 'utf8')) as Array<{ id: string }>).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(['ses_local_keep']);
    expect(
      (JSON.parse(readFileSync(otherSessionsFile, 'utf8')) as Array<{ id: string }>).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(['ses_remote_keep']);
    expect(
      JSON.parse(readFileSync(join(fixture.root, '.showtail', 'state.json'), 'utf8')),
    ).toEqual({
      currentSessionId: null,
      currentAuthorSlug: 'student_example.com',
      currentPromptId: null,
      turnByNativeSession: {},
    });
  });

  test('legacy cleanup revalidates trail identity at its commit boundary', () => {
    const fixture = seedPristineTrail();
    const session = readLedgerSession(fixture.ledgerSessionId)!;
    const configFile = join(fixture.root, '.showtail', 'config.json');

    expect(() =>
      removeOtherLedgerProjections(session, undefined, {
        onBeforeLegacyProjectionCommit: () => {
          const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<
            string,
            unknown
          >;
          config.trailId = 'trl_replacement_at_legacy_commit';
          writeJson(configFile, config);
        },
      }),
    ).toThrow(ProjectionTargetIdentityMismatchError);

    expect(readFileSync(fixture.journalFile, 'utf8')).toContain('evt_prompt_1');
    expect(readLedgerSession(fixture.ledgerSessionId)?.targets).toContainEqual({
      trailId: fixture.trailId,
      path: fixture.root,
    });
  });

  test('legacy cleanup aborts when the session becomes segmented before commit', () => {
    const fixture = seedPristineTrail();
    const session = readLedgerSession(fixture.ledgerSessionId)!;

    expect(() =>
      removeOtherLedgerProjections(session, undefined, {
        onBeforeLegacyProjectionCommit: () => {
          appendLedgerRecord(session.id, {
            kind: 'prompt',
            tool: 'codex',
            text: 'new segmented work',
          });
          const [segment] = ensureLedgerSegments(session).segments;
          markLedgerSegmentPlaced(session.id, segment!.id, fixture.trailId, fixture.root);
        },
      }),
    ).toThrow('gained segmented records');

    expect(readFileSync(fixture.journalFile, 'utf8')).toContain('evt_prompt_1');
    expect(ensureLedgerSegments(session).segments[0]).toEqual(
      expect.objectContaining({
        status: 'placed',
        targets: [{ trailId: fixture.trailId, path: fixture.root }],
      }),
    );
  });

  test('prunes an uncommitted automatic trail containing only its creator session', async () => {
    const fixture = seedPristineTrail();

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result).toEqual({
      pruned: true,
      reason: 'pruned',
      trailId: fixture.trailId,
    });
    expect(existsSync(fixture.root)).toBe(true);
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(false);
  });

  test('refuses a caller that does not match automatic initialization metadata', async () => {
    const fixture = seedPristineTrail();

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: 'led_someone_else',
    });

    expect(result.reason).toBe('ledger-session-mismatch');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('refuses configuration changed after automatic initialization', async () => {
    const fixture = seedPristineTrail();
    const configFile = join(fixture.root, '.showtail', 'config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    config.project = 'Renamed by the student';
    writeJson(configFile, config);

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result.reason).toBe('config-modified');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('refuses a trail added to the git index', async () => {
    const fixture = seedPristineTrail();
    execFileSync('git', ['init', '--quiet'], { cwd: fixture.root });
    execFileSync('git', ['add', '--', '.showtail/config.json'], { cwd: fixture.root });

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result.reason).toBe('git-tracked');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('refuses a nested trail added to its parent repository index', async () => {
    const repo = makeTempDir();
    cleanupDirs.push(repo);
    const project = join(repo, 'project');
    mkdirSync(project);
    const fixture = seedPristineTrail(project);
    initGitRepo(repo);
    execFileSync('git', ['add', '--', 'project/.showtail/config.json'], { cwd: repo });

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result.reason).toBe('git-tracked');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('refuses a nested trail preserved only in parent repository history', async () => {
    const repo = makeTempDir();
    cleanupDirs.push(repo);
    const project = join(repo, 'project');
    mkdirSync(project);
    const fixture = seedPristineTrail(project);
    initGitRepo(repo);
    const configPath = 'project/.showtail/config.json';
    execFileSync('git', ['add', '--', configPath], { cwd: repo });
    execFileSync('git', ['commit', '--quiet', '-m', 'record trail'], { cwd: repo });
    execFileSync('git', ['rm', '--quiet', '--cached', '--', configPath], { cwd: repo });
    execFileSync('git', ['commit', '--quiet', '-m', 'stop tracking trail'], {
      cwd: repo,
    });

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result.reason).toBe('git-tracked');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('restores a trail added to git immediately before the prune claim', async () => {
    const fixture = seedPristineTrail();
    execFileSync('git', ['init', '--quiet'], { cwd: fixture.root });
    let racedGitCheck = false;

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
      testHooks: {
        beforeClaim: () => {
          execFileSync('git', ['add', '--', '.showtail/config.json'], {
            cwd: fixture.root,
          });
          racedGitCheck = true;
        },
      },
    });

    expect(racedGitCheck).toBe(true);
    expect(result).toEqual({
      pruned: false,
      reason: 'git-tracked',
      trailId: fixture.trailId,
    });
    expect(existsSync(join(fixture.root, '.showtail', 'config.json'))).toBe(true);
    expect(
      execFileSync('git', ['ls-files', '--', '.showtail/config.json'], {
        cwd: fixture.root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.showtail/config.json');
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith('.showtail.prune-')),
    ).toEqual([]);
  });

  test('waits for an in-flight parent repository index update before pruning', async () => {
    const repo = makeTempDir();
    cleanupDirs.push(repo);
    const project = join(repo, 'project');
    mkdirSync(project);
    const fixture = seedPristineTrail(project);
    initGitRepo(repo);
    const configPath = 'project/.showtail/config.json';
    const digest = execFileSync('git', ['hash-object', '-w', configPath], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    let updater: ReturnType<typeof spawn> | undefined;
    let updateDone: Promise<number | null> | undefined;
    let lockObserved = false;

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
      testHooks: {
        beforeClaim: async () => {
          updater = spawn('git', ['update-index', '--index-info'], {
            cwd: repo,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          updateDone = new Promise((resolve, reject) => {
            updater!.once('error', reject);
            updater!.once('close', resolve);
          });
          const lockPath = join(repo, '.git', 'index.lock');
          const deadline = Date.now() + 1_000;
          while (!existsSync(lockPath) && Date.now() <= deadline) await delay(5);
          expect(existsSync(lockPath)).toBe(true);
        },
        onGitIndexLock: () => {
          lockObserved = true;
          updater!.stdin!.end(`100644 ${digest}\t${configPath}\n`);
        },
      },
    });

    expect(await updateDone).toBe(0);
    expect(lockObserved).toBe(true);
    expect(result.reason).toBe('git-tracked');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
    expect(
      execFileSync('git', ['ls-files', '--', configPath], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
    ).toBe(configPath);
  });

  test('refuses a generated report or an unknown file', async () => {
    const fixture = seedPristineTrail();
    writeFileSync(join(fixture.root, '.showtail', 'reports', 'report.html'), '<html>');

    const reportResult = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });
    expect(reportResult.reason).toBe('report-present');

    cleanup(join(fixture.root, '.showtail', 'reports'));
    mkdirSync(join(fixture.root, '.showtail', 'reports'));
    writeFileSync(join(fixture.root, '.showtail', 'notes.txt'), 'keep me');
    const unknownResult = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });
    expect(unknownResult.reason).toBe('unknown-file');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('refuses journal data from another ledger session', async () => {
    const fixture = seedPristineTrail();
    const entry = JSON.parse(readFileSync(fixture.journalFile, 'utf8')) as Record<
      string,
      unknown
    >;
    entry.batch = 'ledger:other-session';
    writeFileSync(fixture.journalFile, `${JSON.stringify(entry)}\n`);

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result.reason).toBe('unrelated-trail-data');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('refuses when another ledger session points at the trail', async () => {
    const fixture = seedPristineTrail();
    const other = ensureLedgerSession({
      tool: 'claude-code',
      nativeSessionId: 'native-session-2',
      cwd: fixture.root,
    });
    markPlaced(other.id, fixture.trailId, fixture.root);

    const result = await pruneProvisionalTrail({
      root: fixture.root,
      ledgerSessionId: fixture.ledgerSessionId,
    });

    expect(result.reason).toBe('other-ledger-placement');
    expect(existsSync(join(fixture.root, '.showtail'))).toBe(true);
  });

  test('restores data written while the trail is quarantined for pruning', async () => {
    const fixture = seedPristineTrail();
    const racedFile = 'concurrent-writer.txt';
    let wroteDuringClaim = false;
    const watcher = watch(fixture.root, () => {
      if (wroteDuringClaim) return;
      const quarantine = readdirSync(fixture.root).find((name) =>
        name.startsWith('.showtail.prune-'),
      );
      if (!quarantine) return;
      writeFileSync(join(fixture.root, quarantine, racedFile), 'keep this data');
      wroteDuringClaim = true;
    });

    let result;
    try {
      result = await pruneProvisionalTrail({
        root: fixture.root,
        ledgerSessionId: fixture.ledgerSessionId,
      });
    } finally {
      watcher.close();
    }

    expect(wroteDuringClaim).toBe(true);
    expect(result).toEqual(
      expect.objectContaining({
        pruned: false,
        reason: 'trail-changed-during-check',
        trailId: fixture.trailId,
      }),
    );
    expect(readFileSync(join(fixture.root, '.showtail', racedFile), 'utf8')).toBe(
      'keep this data',
    );
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith('.showtail.prune-')),
    ).toEqual([]);
  });
});
