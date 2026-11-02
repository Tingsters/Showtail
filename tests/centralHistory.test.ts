import { fixture, tree } from './centralHelpers.ts';
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HistoryStore, digest } from '../src/core/history.ts';
import { dataHome } from '../src/core/dataHome.ts';
import {
  captureTranscript,
  commitCapture,
  drainPending,
  runHistoryHook,
} from '../src/core/historyCapture.ts';
import {
  buildHistoryReport,
  exportHistory,
  writeHistoryReport,
} from '../src/core/historyReport.ts';
import { importLegacy } from '../src/core/legacyImport.ts';
import { writeGlobalConfig } from '../src/core/globalConfig.ts';
import { verifySubmission } from '../src/core/submission.ts';
import { approvePr, previewPr, type GhRunner } from '../src/commands/historySubmit.ts';

describe('central history', () => {
  test('status and home are read-only and storage is cwd independent', () =>
    fixture(({ home, cli, dir }) => {
      expect(JSON.parse(cli(['home', '--json']).stdout).home).toBe(home);
      expect(cli(['status', '--json', '--tool', 'claude']).code).toBe(0);
      expect(existsSync(home)).toBe(false);
      expect(JSON.parse(cli(['home', '--json'], undefined, dir).stdout).home).toBe(home);
    }));
  test('rejects relative home overrides and legacy home trails before writing', () =>
    fixture(({ home }) => {
      process.env.SHOWTAIL_HOME = 'relative-home';
      expect(() => dataHome()).toThrow('absolute');
      process.env.SHOWTAIL_HOME = home;
      mkdirSync(home);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ trailId: 'trl_old' }));
      expect(() => new HistoryStore()).toThrow('LEGACY_HOME_CONFLICT');
      expect(existsSync(join(home, 'history.sqlite'))).toBe(false);
    }));
  test('capture deduplication and corrections are transactional and hash chained', () =>
    fixture(({ project }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'claude-code',
        nativeSessionId: 'thread',
        cwd: project,
      });
      const first = store.append(session.id, {
        kind: 'prompt',
        sourceId: 'p1',
        text: 'Build it',
      });
      expect(
        store.append(session.id, { kind: 'prompt', sourceId: 'p1', text: 'Build it' })
          .inserted,
      ).toBe(false);
      store.append(session.id, {
        kind: 'ai_output',
        sourceId: 'reply',
        text: 'Draft',
        turnId: first.record!.id,
      });
      store.append(session.id, {
        kind: 'ai_output',
        sourceId: 'reply',
        text: 'Completed',
        turnId: first.record!.id,
      });
      expect(store.records().map((r) => r.text)).toEqual(['Build it', 'Completed']);
      expect(store.records({ kind: 'all' }, { includeSuperseded: true })).toHaveLength(3);
      expect(store.verify().ok).toBe(true);
      store.query("UPDATE objects SET content='changed' WHERE content='Completed'").run();
      expect(store.verify().ok).toBe(false);
    }));
  test('folderless work and missing native IDs are preserved', async () =>
    fixture(async () => {
      writeGlobalConfig({
        version: 2,
        captureEnabled: true,
        captureSince: '2026-01-01T00:00:00Z',
      });
      await runHistoryHook(
        'user-prompt',
        { prompt: 'Think through this', timestamp: '2026-11-01T12:00:00Z' },
        'claude-code',
      );
      using store = new HistoryStore();
      expect(store.sessions()).toHaveLength(1);
      expect(store.records()[0]!.text).toBe('Think through this');
      expect(store.projects()).toHaveLength(0);
    }));
  test('live hooks reconcile replies without duplicating prompts or equal later turns', async () =>
    fixture(async ({ project }) => {
      writeGlobalConfig({
        version: 2,
        captureEnabled: true,
        captureSince: '2026-01-01T00:00:00Z',
      });
      await runHistoryHook(
        'user-prompt',
        {
          session_id: 'same',
          prompt: 'Again',
          cwd: project,
          turn_id: 'r1',
          timestamp: '2026-11-01T12:00:00Z',
        },
        'claude-code',
      );
      using store = new HistoryStore();
      const session = store.sessions()[0]!;
      const transcript = {
        messages: [
          {
            role: 'user',
            text: 'Again',
            sourceId: 'native-user-1',
            timestamp: '2026-11-01T12:00:00Z',
          },
          {
            role: 'assistant',
            text: 'Done',
            sourceId: 'reply1',
            timestamp: '2026-11-01T12:00:01Z',
          },
          {
            role: 'user',
            text: 'Again',
            sourceId: 'native-user-2',
            timestamp: '2026-11-01T12:00:02Z',
          },
        ],
      };
      captureTranscript(store, session, transcript);
      captureTranscript(store, session, transcript);
      expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(2);
      expect(store.records().filter((r) => r.kind === 'ai_output')).toHaveLength(1);
      expect(store.verify().ok).toBe(true);
    }));
  test('projects are views and reassignment never rewrites capture records', () =>
    fixture(({ dir, project }) => {
      using store = new HistoryStore();
      const other = join(dir, 'other');
      mkdirSync(other);
      writeFileSync(join(other, 'package.json'), '{}');
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'views',
        cwd: project,
      });
      const prompt = store.append(session.id, {
        kind: 'prompt',
        text: 'Change both',
      }).record!;
      store.append(session.id, {
        kind: 'edit',
        file: join(project, 'a.ts'),
        diff: '+ a',
      });
      store.append(session.id, { kind: 'edit', file: join(other, 'b.ts'), diff: '+ b' });
      expect(store.projects()).toHaveLength(2);
      for (const p of store.projects())
        expect(store.records({ kind: 'project', projectId: p.projectId })).toHaveLength(
          3,
        );
      const before = store.records().map((r) => r.hash);
      store.assign(prompt.id, [store.projects()[0]!.projectId]);
      expect(store.records().map((r) => r.hash)).toEqual(before);
      expect(
        store.records({ kind: 'project', projectId: store.projects()[1]!.projectId }),
      ).toHaveLength(0);
      const moved = join(dir, 'moved');
      store.relinkProject(store.projects()[0]!.projectId, moved);
      expect(store.projects()[0]!.roots).toContain(moved);
    }));
  test('redacts structured content and withholds tool output before persistence', () =>
    fixture(({ project, home }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'privacy',
        cwd: project,
      });
      store.append(session.id, {
        kind: 'prompt',
        text: 'My password=VerySecretPassword123',
      });
      store.append(session.id, {
        kind: 'conversation_event',
        conversationEvent: {
          sequence: 1,
          type: 'tool_result',
          toolName: 'Bash',
          stdout: 'PRIVATE_OUTPUT',
          content: 'PRIVATE_OUTPUT',
        },
      });
      const all = JSON.stringify(store.records());
      expect(all).not.toContain('VerySecretPassword123');
      expect(all).not.toContain('PRIVATE_OUTPUT');
      expect(
        store.query("SELECT 1 FROM objects WHERE content LIKE '%PRIVATE_OUTPUT%'").get(),
      ).toBeNull();
      expect(
        store.append(session.id, {
          kind: 'edit',
          file: join(home, 'config.json'),
          diff: '+ self',
        }).inserted,
      ).toBe(false);
      expect(
        store.append(session.id, {
          kind: 'edit',
          file: join(project, '.env'),
          diff: '+ secret',
        }).inserted,
      ).toBe(false);
    }));
  test('reports and submissions work with deleted source folders and contain no workspace links', () =>
    fixture(({ project }) => {
      using store = new HistoryStore();
      const s = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'report',
        cwd: project,
      });
      store.append(s.id, { kind: 'prompt', text: 'Build a parser' });
      store.append(s.id, {
        kind: 'edit',
        file: join(project, 'parser.ts'),
        diff: '+ parse()',
      });
      const p = store.projects()[0]!;
      const selection = { kind: 'project' as const, projectId: p.projectId };
      const before = tree(project);
      const report = writeHistoryReport(store, selection);
      expect(tree(project)).toEqual(before);
      expect(report.reportPath.startsWith(store.home)).toBe(true);
      expect(readFileSync(report.reportPath, 'utf8')).not.toContain(
        'href="../../parser.ts',
      );
      rmSync(project, { recursive: true });
      // Existing captured content does not require the source folder to exist.
      expect(buildHistoryReport(store, selection).turns[0]!.codeChanges[0]!.diff).toBe(
        '+ parse()',
      );
      const exported = exportHistory(store, selection);
      expect(verifySubmission(exported.dir).ok).toBe(true);
      expect(readFileSync(join(exported.dir, 'report.html'), 'utf8')).not.toContain(
        project,
      );
    }));
  test('real CLI captures, reports, submits, and verifies without touching a project or .git', () =>
    fixture(({ project, cli }) => {
      mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), 'untouched');
      const before = tree(project);
      const logged = cli(['log', '-x', 'Make a small parser', '--json']);
      expect(logged.code).toBe(0);
      const report = cli(['report', '--json', '--no-open', '--no-sync']);
      expect(report.code).toBe(0);
      expect(JSON.parse(report.stdout).projectId).toBeDefined();
      expect(cli(['submit', '--json', '--no-sync']).code).toBe(0);
      expect(cli(['verify', '--json']).code).toBe(0);
      expect(cli(['guard', 'check', '--staged']).code).toBe(0);
      expect(tree(project)).toEqual(before);
      expect(existsSync(join(project, '.showtail'))).toBe(false);
    }));
  test('report requires an explicit selection outside known projects', () =>
    fixture(({ cli, dir }) => {
      expect(cli(['log', '-x', 'One prompt']).code).toBe(0);
      const failed = cli(['report', '--json', '--no-sync'], undefined, dir);
      expect(JSON.parse(failed.stdout).errorCode).toBe('SELECTION_REQUIRED');
      expect(cli(['report', '--all', '--json', '--no-sync'], undefined, dir).code).toBe(
        0,
      );
    }));
  test('ending a manual session starts a fresh conversation for the next prompt', () =>
    fixture(({ cli }) => {
      const first = JSON.parse(
        cli(['log', '--text', 'First task', '--json']).stdout,
      ).sessionId;
      expect(cli(['end', '--json']).code).toBe(0);
      const second = JSON.parse(
        cli(['log', '--text', 'Second task', '--json']).stdout,
      ).sessionId;
      expect(second).not.toBe(first);
      using store = new HistoryStore();
      expect(store.session(first)!.endedAt).toBeDefined();
      expect(store.sessions()).toHaveLength(2);
    }));
  test('malformed provider filenames remain unresolved evidence and never become project views', () =>
    fixture(({ project }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'bad-path',
        cwd: project + '\ncommand text',
      });
      expect(session.cwd).toBeNull();
      store.append(session.id, { kind: 'prompt', text: 'Review the recorded changes' });
      const record = store.append(session.id, {
        kind: 'edit',
        file: project + '\npassword=SuperPrivateValue123',
        diff: '+ preserved change',
      }).record!;
      expect(record.file).toBeUndefined();
      expect(record.unresolvedPath).toBe(true);
      expect(JSON.stringify(record)).not.toContain('SuperPrivateValue123');
      expect(store.projects()).toHaveLength(0);
      expect(() => store.registerProject(project + '\ncommand text')).toThrow(
        'INVALID_PROJECT_PATH',
      );
      store
        .query('INSERT INTO projects VALUES (?,?)')
        .run('prj_invalid', 'Old malformed path');
      store
        .query('INSERT INTO project_roots VALUES (?,?,?,1)')
        .run('prj_invalid', project + '\ncommand text', 'legacy-invalid');
      expect(store.projects()).toHaveLength(0);
      const report = buildHistoryReport(store, { kind: 'all' });
      expect(report.turns[0]!.codeChanges[0]!.path).toBe('Unresolved provider file 1');
      expect(report.turns[0]!.codeChanges[0]!.diff).toBe('+ preserved change');
      expect(store.verify().ok).toBe(true);
    }));
  test('automatic pause prevents both live writes and pending replay', async () =>
    fixture(async ({ project }) => {
      writeGlobalConfig({ version: 2, captureEnabled: false });
      await runHistoryHook(
        'user-prompt',
        { session_id: 'paused', cwd: project, prompt: 'Do not store' },
        'claude-code',
      );
      expect(existsSync(join(dataHome(), 'history.sqlite'))).toBe(false);
    }));
  test('installer setup preserves a global pause and explicit setup stays outside projects', () =>
    fixture(({ project, cli }) => {
      const before = tree(project);
      expect(cli(['setup', '--off', '--json']).code).toBe(0);
      const result = cli(['setup', '--first-run', '--json']);
      expect(JSON.parse(result.stdout)).toMatchObject({
        captureEnabled: false,
        skipped: 'capture-paused',
      });
      expect(cli(['setup', '--yes', '--json']).code).toBe(0);
      expect(tree(project)).toEqual(before);
      expect(JSON.parse(cli(['status', '--json']).stdout).captureEnabled).toBe(true);
    }));
  test('unknown schemas are refused without resetting existing data', () =>
    fixture(() => {
      {
        using store = new HistoryStore();
        store.db.exec('PRAGMA user_version=999');
      }
      expect(() => new HistoryStore()).toThrow('HISTORY_NEWER_THAN_BINARY');
    }));
  test('legacy dry-run is read-only, import dedupes ledger projections, and reruns preserve originals', () =>
    fixture(({ dir, home }) => {
      const old = join(dir, 'old-cli', 'ledger', 'sessions', 'led_old');
      mkdirSync(old, { recursive: true });
      const when = '2026-10-01T10:00:00Z';
      writeFileSync(
        join(old, 'session.json'),
        JSON.stringify({
          id: 'led_old',
          tool: 'claude-code',
          nativeSessionId: 'native-old',
          startedAt: when,
        }),
      );
      writeFileSync(
        join(old, 'records.jsonl'),
        JSON.stringify({
          id: 'old-prompt',
          kind: 'prompt',
          tool: 'claude-code',
          ts: when,
          text: 'Original work',
          sourceId: 'native-prompt',
        }) + '\n',
      );
      const project = join(dir, 'legacy-project');
      const base = join(project, '.showtail');
      const author = join(base, 'authors', 'student');
      mkdirSync(join(author, 'journal', 'machine'), { recursive: true });
      writeFileSync(
        join(base, 'config.json'),
        JSON.stringify({
          version: 5,
          trailId: 'trl_legacy',
          project: 'Legacy assignment',
        }),
      );
      writeFileSync(join(author, 'author.json'), JSON.stringify({ name: 'Student' }));
      writeFileSync(
        join(author, 'sessions.json'),
        JSON.stringify([
          {
            id: 'old-session',
            nativeSessionId: 'native-old',
            tool: 'claude-code',
            startedAt: when,
          },
        ]),
      );
      const hash = digest('Original work');
      mkdirSync(join(base, 'objects', hash.slice(0, 2)), { recursive: true });
      writeFileSync(
        join(base, 'objects', hash.slice(0, 2), hash.slice(2)),
        'Original work',
      );
      writeFileSync(
        join(author, 'journal', 'machine', '0001.log'),
        JSON.stringify({
          v: 1,
          id: 'project-prompt',
          kind: 'event',
          type: 'prompt',
          ts: when,
          conv: 'old-session',
          sourceId: 'native-prompt',
          refs: [`sha256:${hash}`],
        }) + '\n',
      );
      const paths = [join(dir, 'old-cli'), project];
      const originals = paths.map(tree);
      expect(importLegacy(paths, { dryRun: true }).records).toBe(2);
      expect(existsSync(home)).toBe(false);
      expect(importLegacy(paths).imported).toBe(1);
      expect(importLegacy(paths).imported).toBe(0);
      expect(paths.map(tree)).toEqual(originals);
      using store = new HistoryStore();
      expect(store.records()).toHaveLength(1);
      expect(store.resolveProject('trl_legacy').displayName).toBe('Legacy assignment');
      expect(store.verify().ok).toBe(true);
    }));
  test('legacy corrections preserve both versions and invalid references are rejected before writes', () =>
    fixture(({ dir }) => {
      const sessionDir = join(dir, 'old', 'sessions', 'session');
      mkdirSync(sessionDir, { recursive: true });
      const ts = '2026-10-01T10:00:00Z';
      writeFileSync(
        join(sessionDir, 'session.json'),
        JSON.stringify({
          id: 'session',
          tool: 'claude-code',
          nativeSessionId: 'revised',
          startedAt: ts,
        }),
      );
      const records = [
        { id: 'first', kind: 'ai_output', sourceId: 'reply', ts, text: 'Draft' },
        {
          id: 'final',
          kind: 'ai_output',
          sourceId: 'reply',
          ts,
          text: 'Final',
          supersedesRecordId: 'first',
          transcriptFinal: true,
        },
      ];
      writeFileSync(
        join(sessionDir, 'records.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n'),
      );
      const original = tree(join(dir, 'old'));
      expect(importLegacy([join(dir, 'old')]).imported).toBe(2);
      expect(importLegacy([join(dir, 'old')]).imported).toBe(0);
      using store = new HistoryStore();
      expect(store.records().map((r) => r.text)).toEqual(['Final']);
      expect(store.records({ kind: 'all' }, { includeSuperseded: true })).toHaveLength(2);
      expect(store.verify().ok).toBe(true);
      expect(tree(join(dir, 'old'))).toEqual(original);
      // Validate all source records before the destination receives any of them.
      records.push({
        ...records[0]!,
        id: 'invalid',
        supersedesRecordId: 'missing',
      } as (typeof records)[0]);
      writeFileSync(
        join(sessionDir, 'records.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n'),
      );
      expect(() => importLegacy([join(dir, 'old')])).toThrow(
        'LEGACY_CORRECTION_PREDECESSOR_MISSING',
      );
      expect(store.records({ kind: 'all' }, { includeSuperseded: true })).toHaveLength(2);
    }));
  test('same-named files in different projects remain distinct in a shared turn', () =>
    fixture(({ dir, project }) => {
      const other = join(dir, 'other-project');
      mkdirSync(other);
      writeFileSync(join(other, 'package.json'), '{}');
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'same-names',
        cwd: project,
      });
      store.append(session.id, { kind: 'prompt', text: 'Update both packages' });
      store.append(session.id, {
        kind: 'edit',
        file: join(project, 'index.ts'),
        diff: '+ first',
      });
      store.append(session.id, {
        kind: 'edit',
        file: join(other, 'index.ts'),
        diff: '+ second',
      });
      const changes = buildHistoryReport(store, { kind: 'all' }).turns[0]!.codeChanges;
      expect(changes).toHaveLength(2);
      expect(new Set(changes.map((change) => change.path)).size).toBe(2);
    }));
  test('PR preview never posts and approval refuses changed reports', () =>
    fixture(({ project }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'pr',
        cwd: project,
      });
      store.append(session.id, { kind: 'prompt', text: 'Make a parser' });
      const calls: string[][] = [];
      const gh: GhRunner = (args) => {
        calls.push(args);
        return {
          status: 0,
          stderr: '',
          stdout:
            args[0] === 'repo'
              ? '{"visibility":"PUBLIC"}'
              : '{"url":"https://github.com/example/project/pull/1"}',
        };
      };
      const selection = { kind: 'all' as const };
      const preview = previewPr(store, selection, {
        pr: '1',
        repo: 'example/project',
        gh,
      });
      expect(preview.publicAndPermanent).toBe(true);
      expect(calls.some((a) => a.includes('comment'))).toBe(false);
      store.append(session.id, { kind: 'prompt', text: 'Another change' });
      expect(() => approvePr(store, String(preview.code), gh)).toThrow(
        'PR_REPORT_CHANGED',
      );
      expect(calls.some((a) => a.includes('comment'))).toBe(false);
    }));
  test('PR approval posts exactly the reviewed body once and tampered exports never post', () =>
    fixture(({ project }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({
        tool: 'cli',
        nativeSessionId: 'approved-pr',
        cwd: project,
      });
      store.append(session.id, { kind: 'prompt', text: 'Build a parser' });
      const posts: string[] = [];
      const gh: GhRunner = (args, _cwd, input) => {
        if (args.includes('comment')) {
          posts.push(input!);
          return {
            status: 0,
            stdout: 'https://github.com/example/project/pull/1#issuecomment-1',
            stderr: '',
          };
        }
        return {
          status: 0,
          stderr: '',
          stdout:
            args[0] === 'repo'
              ? '{"visibility":"PRIVATE"}'
              : '{"url":"https://github.com/example/project/pull/1"}',
        };
      };
      const preview = previewPr(
        store,
        { kind: 'all' },
        { pr: '1', repo: 'example/project', gh },
      );
      expect(posts).toHaveLength(0);
      expect(() => approvePr(store, 'wrong-code', gh)).toThrow('PR_APPROVAL_INVALID');
      approvePr(store, String(preview.code), gh);
      expect(posts).toEqual([String(preview.comment)]);
      expect(() => approvePr(store, String(preview.code), gh)).toThrow(
        'PR_APPROVAL_INVALID',
      );
      const next = previewPr(
        store,
        { kind: 'all' },
        { pr: '1', repo: 'example/project', gh },
      );
      writeFileSync(
        join(String(next.exportPath), 'report.html'),
        'Modified after preview',
      );
      expect(() => approvePr(store, String(next.code), gh)).toThrow('PR_REPORT_CHANGED');
      expect(posts).toHaveLength(1);
    }));
});
