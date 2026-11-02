import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, tree } from './centralHelpers.ts';
import { canonical, digest, HistoryStore } from '../src/core/history.ts';
import {
  prepareRepair,
  applyRepair,
  backupHistory,
  repairPreview,
} from '../src/core/historyRepair.ts';
import { auditHistory } from '../src/core/historyAudit.ts';
import { buildHistoryReport, exportHistory } from '../src/core/historyReport.ts';
import { captureTranscript } from '../src/core/historyCapture.ts';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { parseCodexRollout } from '../src/core/codexTranscript.ts';
import { renderHtml } from '../src/core/report/html.ts';
import { renderMarkdown } from '../src/core/report/markdown.ts';
import { verifySubmission } from '../src/core/submission.ts';
const at = '2026-10-23T04:53:11.000Z';

// Reproduce a valid pre-fix capture, whose hook had no origin metadata. Later
// fixes must leave these original bytes and the original hash chain unchanged.
function oldPrompt(store: HistoryStore, sid: string, text: string, ts = at) {
  const record = store.append(sid, {
    kind: 'prompt',
    text,
    origin: 'human',
    ts,
    sourceId: 'old:' + ts + ':' + store.records().length,
  }).record!;
  const raw = store.query('SELECT * FROM records WHERE id=?').get(record.id) as any;
  const payload = JSON.parse(raw.payload);
  delete payload.origin;
  const header = {
    id: raw.id,
    sessionId: raw.session_id,
    sequence: raw.seq,
    ts: raw.ts,
    capturedAt: raw.captured_at,
    kind: raw.kind,
    turnId: raw.turn_id,
    sourceId: raw.source_id,
    payload,
    prev: raw.prev,
    supersedesId: raw.supersedes_id,
    redacted: raw.redacted,
  };
  store
    .query('UPDATE records SET payload=?,hash=? WHERE id=?')
    .run(canonical(payload), digest(canonical(header)), record.id);
  return store.record(record.id)!;
}

test('Claude preserves image/text prompts and explicit human quotations; drops provider envelopes', () =>
  fixture(() => {
    const rows = [
      {
        type: 'user',
        uuid: 'image',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: {
          content: [
            { type: 'text', text: 'Explain this diagram' },
            { type: 'image', source: { type: 'base64', data: '' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'quote',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: {
          content: '<agent-message>Here is a wrapper I want explained</agent-message>',
        },
      },
      {
        type: 'user',
        uuid: 'worker',
        origin: { kind: 'peer' },
        promptSource: 'system',
        message: { content: '<agent-message from="worker">model output</agent-message>' },
      },
      {
        type: 'user',
        uuid: 'command',
        message: { content: '<local-command-stdout>Current Plan</local-command-stdout>' },
      },
    ];
    const t = parseClaudeTranscript(rows.map((r) => JSON.stringify(r)).join('\n'), '.');
    expect(t.messages.filter((m) => m.role === 'user').map((m) => m.sourceId)).toEqual([
      'image',
      'quote',
    ]);
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'image-thread',
    });
    captureTranscript(store, session, t);
    expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(2);
    expect(buildHistoryReport(store, { kind: 'all' }).turns).toHaveLength(2);
  }));

test('current Codex rollouts use typed items, stable IDs, clean diffs and decisions', () =>
  fixture(({ project }) => {
    const wrap = (item: any, i: number) => ({
      timestamp: `2026-10-23T04:53:${String(i + 11).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: 'item_completed', thread_id: 'native', turn_id: 'turn', item },
    });
    const rows = [
      { type: 'session_meta', payload: { id: 'native' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'AGENTS chrome must not be imported' }],
        },
      },
      wrap(
        {
          type: 'UserMessage',
          id: 'u',
          content: [{ type: 'text', text: 'Fix the report' }],
        },
        0,
      ),
      wrap(
        {
          type: 'AgentMessage',
          id: 'a',
          content: [{ type: 'Text', text: 'I will fix it.' }],
          phase: 'final_answer',
        },
        1,
      ),
      wrap(
        {
          type: 'FileChange',
          id: 'e',
          status: 'completed',
          changes: {
            [join(project, 'index.ts')]: {
              type: 'update',
              unified_diff: '@@ -1 +1 @@\n-old\n+new',
            },
          },
        },
        2,
      ),
      wrap(
        {
          type: 'UserMessage',
          id: 'd',
          content: [
            {
              type: 'text',
              text: '<send_user_message_question_reply>\n[{"answer":"Recover history","question":"Recovery?"}]\n</send_user_message_question_reply>',
            },
          ],
        },
        3,
      ),
    ];
    const t = parseCodexRollout(rows.map((r) => JSON.stringify(r)).join('\n'), project, {
      includeOutsideEdits: true,
    });
    expect(t.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      'Fix the report',
    ]);
    expect(t.messages.find((m) => m.role === 'user')!.sourceId).toBe(
      'codex:user:native:item:u',
    );
    expect(t.messages.find((m) => m.role === 'assistant')!.text).toBe('I will fix it.');
    expect(t.messages.find((m) => m.role === 'edit')!.edits![0]!.diff).toContain('+ new');
    expect(t.messages.some((m) => m.role === 'decision')).toBe(true);
    expect(JSON.stringify(t)).not.toContain('AGENTS chrome');
  }));

test('repair preserves raw captures while fixing harness turns, attribution, counts, revisions and orphans', () =>
  fixture(async ({ dir, project }) => {
    mkdirSync(join(project, '.git'));
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'legacy',
      cwd: project,
      authorId: 'legacy:fixture',
      authorName: 'E2E',
    });
    const prompt = oldPrompt(store, session.id, 'Build the report');
    const handoff = oldPrompt(
      store,
      session.id,
      '<agent-message from="worker">[Subagent hand-back] model output</agent-message>',
      '2026-10-23T04:54:00.000Z',
    );
    for (const [i, diff] of ['- old\n+ one', '- one\n+ two'].entries())
      store.append(session.id, {
        kind: 'edit',
        file: join(project, 'index.ts'),
        diff,
        turnId: handoff.id,
        ts: `2026-10-23T04:55:0${i}.000Z`,
      });
    const orphan = store.ensureSession({ tool: 'cli', nativeSessionId: 'path-only' });
    store.append(orphan.id, {
      kind: 'edit',
      file: join(project, 'orphan.ts'),
      diff: '+ orphan',
    });
    for (let i = 0; i < 4; i++) {
      const audit = store.ensureSession({ tool: 'cli', nativeSessionId: 'audit:' + i });
      store.append(audit.id, { kind: 'audit', text: 'Routing marker' });
    }
    const original = JSON.stringify(
      store.query('SELECT * FROM records ORDER BY id').all(),
    );
    const projectBefore = tree(project);
    expect(store.verify().ok).toBe(true);
    const plan = await prepareRepair(
      store,
      { kind: 'all' },
      { authorMaps: ['legacy:fixture=current'] },
    );
    expect(repairPreview(plan).changes.recordOverlays).toBeGreaterThan(0);
    const backup = backupHistory(store);
    using copied = new Database(backup, { readonly: true });
    expect((copied.query('SELECT count(*) AS n FROM records').get() as any).n).toBe(
      store.records().length,
    );
    applyRepair(store, plan);
    expect(JSON.stringify(store.query('SELECT * FROM records ORDER BY id').all())).toBe(
      original,
    );
    expect(store.verify().ok).toBe(true);
    expect(tree(project)).toEqual(projectBefore);
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.schemaVersion).toBe(3);
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]!.prompt.id).toBe(prompt.id);
    expect(report.turns[0]!.codeChanges[0]!.revisions).toHaveLength(2);
    expect(report.unattributedWork).toHaveLength(1);
    expect(report.summary.sessions).toBe(2);
    expect(report.contributors.some((c) => c.name === 'E2E')).toBe(false);
    expect(auditHistory(store, { kind: 'all' }).quality.harnessPrompts).toBe(0);
    const html = renderHtml(report),
      md = renderMarkdown(report);
    expect(html).toContain('2 captured revisions');
    expect(md).toContain('Revision 2');
    expect(html).toContain('Work without a linked prompt');
    expect(JSON.stringify(report.unattributedWork)).not.toContain('"prompt":');
    const second = await prepareRepair(
      store,
      { kind: 'all' },
      { authorMaps: ['legacy:fixture=current'] },
    );
    const receiptCount = (
      store.query('SELECT count(*) AS n FROM repair_receipts').get() as any
    ).n;
    expect(applyRepair(store, second).changed).toBe(0);
    expect(
      (store.query('SELECT count(*) AS n FROM repair_receipts').get() as any).n,
    ).toBe(receiptCount);
    const exported = exportHistory(store, { kind: 'all' });
    expect(verifySubmission(exported.dir).ok).toBe(true);
  }));

test('explicit recovery binds legacy and ancestor prompts, keeps repeated prompts, and is idempotent', () =>
  fixture(async ({ dir, project }) => {
    mkdirSync(join(project, '.git'));
    const path = join(dir, 'native.jsonl');
    const parentPath = join(dir, 'parent.jsonl');
    writeFileSync(
      parentPath,
      JSON.stringify({
        type: 'user',
        uuid: 'opening',
        sessionId: 'parent',
        timestamp: at,
        origin: { kind: 'human' },
        message: { content: 'Build a better PR system' },
      }),
    );
    writeFileSync(
      path,
      [
        {
          type: 'user',
          sessionId: 'child',
          uuid: 'opening',
          timestamp: at,
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { content: 'Build a better PR system' },
        },
        {
          type: 'user',
          sessionId: 'child',
          uuid: 'again-1',
          timestamp: '2026-10-23T05:00:00.000Z',
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { content: 'continue' },
        },
        {
          type: 'user',
          sessionId: 'child',
          uuid: 'again-2',
          timestamp: '2026-10-23T05:01:00.000Z',
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { content: 'continue' },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    using store = new HistoryStore();
    const parent = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'parent',
      cwd: dir,
      transcriptPath: parentPath,
    });
    const opening = oldPrompt(store, parent.id, 'Build a better PR system');
    const child = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'child',
      cwd: project,
      transcriptPath: path,
    });
    oldPrompt(store, child.id, 'continue', '2026-10-23T05:00:00.000Z');
    const p = store.registerProject(project);
    const selection = { kind: 'project' as const, projectId: p.projectId };
    const before = JSON.stringify(store.query('SELECT * FROM records ORDER BY id').all());
    const plan = await prepareRepair(store, selection, {
      backfill: true,
      includeTurns: [opening.id],
    });
    expect(JSON.stringify(store.query('SELECT * FROM records ORDER BY id').all())).toBe(
      before,
    );
    expect(plan.bindings.some((b) => b.ancestor)).toBe(true);
    expect(plan.recoveries).toHaveLength(2);
    applyRepair(store, plan);
    expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(3);
    const report = buildHistoryReport(store, selection);
    expect(report.turns.map((t) => t.prompt.text)).toEqual([
      'Build a better PR system',
      'continue',
      'continue',
    ]);
    expect(report.coverage!.sources.find((s) => s.sessionId === child.id)!.status).toBe(
      'reconciled',
    );
    const second = await prepareRepair(store, selection, {
      backfill: true,
      includeTurns: [opening.id],
    });
    expect(applyRepair(store, second).changed).toBe(0);
    expect(store.verify().ok).toBe(true);
  }));

test('audit and dry-run CLI are read-only, and degraded capture stays visible', () =>
  fixture(({ cli, home, project }) => {
    {
      using store = new HistoryStore();
      const s = store.ensureSession({
        tool: 'codex',
        nativeSessionId: 'unavailable',
        cwd: project,
        transcriptPath: join(home, 'missing.jsonl'),
      });
      store.append(s.id, { kind: 'prompt', text: 'Real work' });
    }
    const before = tree(home);
    expect(cli(['audit', '--all', '--json']).code).toBe(0);
    expect(cli(['repair', '--all', '--dry-run', '--json']).code).toBe(0);
    expect(
      Object.fromEntries(
        Object.entries(tree(home)).filter(([p]) => !/-wal$|-shm$/.test(p)),
      ),
    ).toEqual(
      Object.fromEntries(Object.entries(before).filter(([p]) => !/-wal$|-shm$/.test(p))),
    );
    using store = new HistoryStore({ readonly: true });
    expect(auditHistory(store, { kind: 'all' }).coverage.sources[0]!.status).toBe(
      'unavailable',
    );
  }));

test('worktree capture keeps one stable project and parent-folder follow-ups retain focus', () =>
  fixture(({ dir, project }) => {
    mkdirSync(join(project, '.git', 'worktrees', 'feature'), { recursive: true });
    writeFileSync(join(project, '.git', 'worktrees', 'feature', 'commondir'), '../..');
    const worktree = join(dir, 'feature');
    mkdirSync(worktree);
    writeFileSync(
      join(worktree, '.git'),
      'gitdir: ' + join(project, '.git', 'worktrees', 'feature'),
    );
    using store = new HistoryStore();
    const main = store.registerProject(project);
    const linked = store.registerProject(worktree);
    expect(linked.projectId).toBe(main.projectId);
    expect(linked.projectRoot).toBe(project);
    const session = store.ensureSession({
      tool: 'codex',
      nativeSessionId: 'worktree',
      cwd: worktree,
    });
    store.append(session.id, { kind: 'prompt', text: 'Implement the change', ts: at });
    store.append(session.id, {
      kind: 'edit',
      file: join(worktree, 'index.ts'),
      diff: '+ change',
      ts: at,
    });
    store.append(session.id, {
      kind: 'prompt',
      text: 'Why does this work?',
      context: { cwd: dir },
      ts: '2026-10-23T05:00:00Z',
    });
    expect(
      store
        .records({ kind: 'project', projectId: main.projectId })
        .filter((r) => r.kind === 'prompt'),
    ).toHaveLength(2);
  }));

test('ambiguous historical matches remain partial and never collapse genuine repeated prompts', () =>
  fixture(async ({ dir, project }) => {
    const path = join(dir, 'repeat.jsonl');
    writeFileSync(
      path,
      ['a', 'b']
        .map((uuid) =>
          JSON.stringify({
            type: 'user',
            uuid,
            sessionId: 'repeat',
            timestamp: at,
            promptSource: 'typed',
            origin: { kind: 'human' },
            message: { content: 'continue' },
          }),
        )
        .join('\n'),
    );
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'repeat',
      cwd: project,
      transcriptPath: path,
    });
    oldPrompt(store, session.id, 'continue');
    oldPrompt(store, session.id, 'continue');
    const plan = await prepareRepair(store, { kind: 'all' }, { backfill: true });
    expect(plan.recoveries[0]!.ambiguous).toBe(2);
    applyRepair(store, plan);
    expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(2);
    expect(store.sourceReads()[0]!.status).toBe('partial');
    expect(store.verify().ok).toBe(true);
  }));
import { cpSync } from 'node:fs';
import { importLegacy } from '../src/core/legacyImport.ts';

test('legacy metadata overlays survive ledger deduplication and can be restored from archived evidence', () =>
  fixture(async ({ dir, home, project }) => {
    const ledger = join(dir, 'old-cli', 'ledger', 'sessions', 'old');
    mkdirSync(ledger, { recursive: true });
    writeFileSync(
      join(ledger, 'session.json'),
      JSON.stringify({
        id: 'old',
        tool: 'claude-code',
        nativeSessionId: 'native',
        startedAt: at,
      }),
    );
    writeFileSync(
      join(ledger, 'records.jsonl'),
      [
        {
          id: 'p',
          kind: 'prompt',
          ts: at,
          text: 'Make the change',
          sourceId: 'native-p',
        },
        {
          id: 'a',
          kind: 'ai_output',
          ts: at,
          text: 'Here is the change',
          sourceId: 'native-a',
          turnKey: 'p',
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    const base = join(project, '.showtail');
    const author = join(base, 'authors', 'student');
    mkdirSync(join(author, 'journal', 'machine'), { recursive: true });
    writeFileSync(
      join(base, 'config.json'),
      JSON.stringify({ version: 5, trailId: 'legacy-fixture' }),
    );
    writeFileSync(join(author, 'author.json'), JSON.stringify({ name: 'Student' }));
    writeFileSync(
      join(author, 'sessions.json'),
      JSON.stringify([
        {
          id: 'old-session',
          tool: 'claude-code',
          nativeSessionId: 'native',
          startedAt: at,
        },
      ]),
    );
    writeFileSync(
      join(author, 'journal', 'machine', '0001.log'),
      [
        {
          v: 1,
          id: 'project-p',
          kind: 'event',
          type: 'prompt',
          conv: 'old-session',
          ts: at,
          sourceId: 'native-p',
          textPreview: 'Make the change',
        },
        {
          v: 1,
          id: 'project-a',
          kind: 'event',
          type: 'ai_output',
          conv: 'old-session',
          ts: at,
          sourceId: 'native-a',
          textPreview: 'Here is the change',
        },
        {
          v: 1,
          id: 'enrich',
          kind: 'enrichment',
          type: 'enrichment',
          ts: at,
          enrichment: {
            overlays: [
              {
                targetEventId: 'project-a',
                model: 'claude-example',
                sourceId: 'provider-answer',
                turnId: 'project-p',
              },
            ],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    importLegacy([join(dir, 'old-cli'), project]);
    using store = new HistoryStore();
    expect(store.records().filter((r) => r.kind === 'ai_output')).toHaveLength(1);
    expect(store.record('a')!.model).toBe('claude-example');
    expect(store.record('a')!.turnId).toBe('p');
    expect(store.verify().ok).toBe(true);
    // Model the already-installed older importer: original rows, no metadata view.
    store.query('DELETE FROM record_overlays').run();
    store.query('DELETE FROM repair_receipts').run();
    const archive = join(home, 'legacy-backups', 'upgrade-0.21.0');
    const archived = join(archive, 'fixture');
    mkdirSync(archive, { recursive: true });
    cpSync(base, archived, { recursive: true });
    writeFileSync(
      join(archive, 'archive-map.json'),
      JSON.stringify([
        { source: base, destinationRelative: 'legacy-backups/upgrade-0.21.0/fixture' },
      ]),
    );
    using fresh = new HistoryStore();
    const plan = await prepareRepair(fresh, { kind: 'all' });
    expect(
      plan.overlays.some((o) => o.id === 'a' && o.patch.model === 'claude-example'),
    ).toBe(true);
    applyRepair(fresh, plan);
    expect(fresh.record('a')!.model).toBe('claude-example');
    expect(fresh.verify().ok).toBe(true);
    fresh
      .query("UPDATE record_overlays SET patch=? WHERE record_id='a'")
      .run(JSON.stringify({ model: 'tampered' }));
    expect(fresh.verify().ok).toBe(false);
  }));
test('backfill binds relative and absolute edit aliases without duplicating a captured edit', () =>
  fixture(async ({ dir, project }) => {
    const path = join(dir, 'edits.jsonl');
    const file = join(project, 'index.ts');
    writeFileSync(
      path,
      [
        {
          type: 'user',
          uuid: 'native-u',
          sessionId: 'edit-thread',
          timestamp: at,
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { content: 'Edit the file' },
        },
        {
          type: 'assistant',
          uuid: 'native-a',
          timestamp: at,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'native-edit',
                name: 'Edit',
                input: { file_path: file, old_string: 'old', new_string: 'new' },
              },
            ],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'edit-thread',
      cwd: project,
      transcriptPath: path,
    });
    oldPrompt(store, session.id, 'Edit the file');
    store.append(session.id, {
      kind: 'edit',
      file,
      diff: '- old\n+ new',
      sourceId: 'native-edit#index.ts',
      ts: at,
      provenance: { source: 'legacy-ledger:fixture', id: 'edit' },
    });
    const plan = await prepareRepair(store, { kind: 'all' }, { backfill: true });
    expect(plan.bindings.some((b) => b.sourceId === 'native-edit#' + file)).toBe(true);
    applyRepair(store, plan);
    const edits = store.records().filter((r) => r.kind === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.provenance!.id).toBe('edit');
    expect(store.verify().ok).toBe(true);
  }));
test('queued submission timestamps reconcile the original hook instead of inventing a second prompt', () =>
  fixture(async ({ dir, project }) => {
    const path = join(dir, 'queued.jsonl');
    writeFileSync(
      path,
      [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: at,
          content: 'Ship the change',
        },
        {
          type: 'user',
          uuid: 'queued',
          sessionId: 'queued-thread',
          timestamp: '2026-10-23T05:10:00.000Z',
          origin: { kind: 'human' },
          promptSource: 'queued',
          message: { content: 'Ship the change' },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'queued-thread',
      cwd: project,
      transcriptPath: path,
    });
    const original = oldPrompt(store, session.id, 'Ship the change');
    const plan = await prepareRepair(store, { kind: 'all' }, { backfill: true });
    expect(plan.bindings.some((b) => b.recordId === original.id)).toBe(true);
    applyRepair(store, plan);
    expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(1);
    expect(store.verify().ok).toBe(true);
  }));
test('a failed repair rolls back both receipts and the effective record view', () =>
  fixture(async ({ project }) => {
    using store = new HistoryStore();
    const s = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'rollback',
      cwd: project,
    });
    oldPrompt(store, s.id, 'Do the work');
    oldPrompt(
      store,
      s.id,
      '<agent-message from="worker">model output</agent-message>',
      '2026-10-23T05:00:00Z',
    );
    const before = JSON.stringify(store.query('SELECT * FROM records ORDER BY id').all());
    const plan = await prepareRepair(store, { kind: 'all' });
    plan.bindings.push({
      sessionId: s.id,
      sourceId: 'invalid-fixture-binding',
      recordId: 'absent',
      ancestor: false,
      previousId: null,
    });
    expect(() => applyRepair(store, plan)).toThrow();
    expect(JSON.stringify(store.query('SELECT * FROM records ORDER BY id').all())).toBe(
      before,
    );
    expect(
      (store.query('SELECT count(*) AS n FROM repair_receipts').get() as any).n,
    ).toBe(0);
    expect(auditHistory(store, { kind: 'all' }).quality.harnessPrompts).toBe(1);
    expect(store.verify().ok).toBe(true);
  }));

test('repair refuses source aliases changed by concurrent capture', () =>
  fixture(async ({ dir, project }) => {
    const path = join(dir, 'concurrent.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'user',
        uuid: 'native',
        sessionId: 'concurrent',
        timestamp: at,
        origin: { kind: 'human' },
        message: { content: 'Original prompt' },
      }),
    );
    using store = new HistoryStore();
    const s = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'concurrent',
      cwd: project,
      transcriptPath: path,
    });
    oldPrompt(store, s.id, 'Original prompt');
    const plan = await prepareRepair(store, { kind: 'all' }, { backfill: true });
    store.append(s.id, {
      kind: 'prompt',
      text: 'New capture',
      sourceId: 'native',
      ts: at,
    });
    expect(() => applyRepair(store, plan)).toThrow('REPAIR_SOURCE_CHANGED');
    expect(store.verify().ok).toBe(true);
  }));
import { runHistoryHook } from '../src/core/historyCapture.ts';
import { writeGlobalConfig } from '../src/core/globalConfig.ts';

test('live hooks preserve provider origin and never count plain peer text as student input', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({
      version: 2,
      captureEnabled: true,
      captureSince: '2026-01-01T00:00:00Z',
    });
    const base = {
      session_id: 'hook-origin',
      cwd: project,
      timestamp: '2026-11-01T12:00:00Z',
    };
    await runHistoryHook(
      'user-prompt',
      { ...base, prompt: 'Please approve this change', origin: { kind: 'peer' } },
      'claude-code',
    );
    await runHistoryHook(
      'user-prompt',
      { ...base, prompt: 'Injected context with no envelope', isMeta: true },
      'claude-code',
    );
    await runHistoryHook(
      'user-prompt',
      {
        ...base,
        prompt: '<agent-message>Please explain this format</agent-message>',
        origin: { kind: 'human' },
        promptSource: 'typed',
      },
      'claude-code',
    );
    using store = new HistoryStore();
    expect(store.records().filter((r) => r.kind === 'prompt')).toHaveLength(1);
    expect(store.records().filter((r) => r.kind === 'tool_call')).toHaveLength(2);
    expect(buildHistoryReport(store, { kind: 'all' }).turns).toHaveLength(1);
    expect(store.verify().ok).toBe(true);
  }));
test('native per-turn workspaces override a session last seen in another project', () =>
  fixture(({ dir, project }) => {
    mkdirSync(join(project, '.git'));
    const other = join(dir, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    using store = new HistoryStore();
    const s = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'moving',
      cwd: other,
    });
    const transcript = parseClaudeTranscript(
      [
        {
          type: 'user',
          uuid: 'first',
          sessionId: 'moving',
          timestamp: at,
          cwd: project,
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { content: 'Plan the first project' },
        },
        {
          type: 'user',
          uuid: 'second',
          sessionId: 'moving',
          timestamp: '2026-10-23T06:00:00Z',
          cwd: other,
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { content: 'Now plan the other project' },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
      other,
    );
    captureTranscript(store, s, transcript);
    const selected = store.registerProject(project);
    expect(
      buildHistoryReport(store, {
        kind: 'project',
        projectId: selected.projectId,
      }).turns.map((t) => t.prompt.text),
    ).toEqual(['Plan the first project']);
  }));

test('unlinked provider user text remains visible without becoming an invented prompt', () =>
  fixture(() => {
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'codex',
      nativeSessionId: 'unlinked-text',
    });
    store.append(session.id, {
      kind: 'conversation_event',
      sourceId: 'raw-user',
      conversationEvent: {
        type: 'user_text',
        sequence: 0,
        sourceId: 'raw-user',
        text: 'An unlinked recorded message',
      },
    });
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.turns).toHaveLength(0);
    expect(renderHtml(report)).toContain('An unlinked recorded message');
    expect(renderMarkdown(report)).toContain('An unlinked recorded message');
  }));
