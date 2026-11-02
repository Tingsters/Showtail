import { Command, CommanderError, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { dataHome, ensureDataHome } from '../core/dataHome.ts';
import {
  CONTROL_VERSION,
  HistoryStore,
  historyExists,
  pendingCount,
  workspaceRoot,
  type HistorySelection,
  type RecordInput,
} from '../core/history.ts';
import {
  automaticCaptureEnabled,
  captureIssue,
  drainPending,
  runHistoryHook,
  type CaptureEvent,
} from '../core/historyCapture.ts';
import { exportHistory, writeHistoryReport } from '../core/historyReport.ts';
import { importLegacy } from '../core/legacyImport.ts';
import {
  readGlobalConfig,
  writeGlobalConfig,
  disableToolCapture,
  enableToolCapture,
  disableToolAutoConnect,
  enableToolAutoConnect,
} from '../core/globalConfig.ts';
import {
  PLUGINS,
  connectPluginOrThrow,
  connectPlugins,
  getPlugin,
} from '../plugins/registry.ts';
import { SHOWTAIL_VERSION } from '../core/version.ts';
import { openInDefaultApp } from '../core/terminal.ts';
import { verifySubmission } from '../core/submission.ts';
import { runUpdate } from './update.ts';
import { catchUpHistory, runHistoryImport } from './historyImport.ts';
import { approvePr, previewPr } from './historySubmit.ts';
import { isEventType } from '../core/schema.ts';
import { redactHistory } from '../core/historyRedact.ts';
import { createHash } from 'node:crypto';
import {
  readMachineIdentity,
  resolveIdentity,
  slugifyEmail,
  writeMachineIdentity,
} from '../core/identity.ts';

type Options = Record<string, any>;
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
function envelope(value: object): object {
  let home: string | null = null;
  try {
    home = dataHome();
  } catch {
    /* Configuration errors also need a valid JSON envelope. */
  }
  return { schemaVersion: CONTROL_VERSION, home, ...value };
}
async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function selection(
  store: HistoryStore,
  opts: Options,
  path?: string,
): HistorySelection | undefined {
  const scopes =
    Number(!!opts.project || path !== undefined) +
    Number(!!opts.session?.length) +
    Number(opts.all === true);
  if (scopes > 1 || (opts.project && path !== undefined))
    throw new Error('SELECTION_CONFLICT: choose --project, --session, --all, or a path.');
  const filters: { tool?: string; since?: string; until?: string } = {};
  if (opts.tool) filters.tool = getPlugin(opts.tool)?.id ?? opts.tool;
  for (const key of ['since', 'until'] as const) {
    if (!opts[key]) continue;
    const timestamp = new Date(opts[key]);
    if (!Number.isFinite(timestamp.getTime())) throw new Error(`INVALID_DATE: --${key}`);
    filters[key] = timestamp.toISOString();
  }
  if (filters.since && filters.until && filters.since > filters.until)
    throw new Error('INVALID_DATE_RANGE');
  if (opts.all) return { kind: 'all', ...filters };
  if (opts.session?.length) {
    for (const id of opts.session)
      if (!store.session(id)) throw new Error(`SESSION_NOT_FOUND: ${id}`);
    return { kind: 'sessions', sessionIds: opts.session, ...filters };
  }
  if (opts.project || path !== undefined) {
    if (!(opts.project ?? path).trim()) throw new Error('EMPTY_PROJECT_SELECTOR');
    return {
      kind: 'project',
      projectId: store.resolveProject(opts.project ?? path).projectId,
      ...filters,
    };
  }
  const project = store.projectForPath(process.cwd());
  return project
    ? { kind: 'project', projectId: project.projectId, ...filters }
    : undefined;
}

async function requireSelection(
  store: HistoryStore,
  opts: Options,
  path?: string,
): Promise<HistorySelection> {
  const selected = selection(store, opts, path);
  if (selected) return selected;
  const projects = store.projects();
  if (!process.stdin.isTTY || opts.json)
    throw Object.assign(
      new Error('SELECTION_REQUIRED: choose --project, --session, or --all.'),
      { candidates: projects },
    );
  console.error('Choose the work to include:');
  projects.forEach((p, index) =>
    console.error(`${index + 1}. ${p.displayName} (${p.projectId})`),
  );
  console.error('a. All history\ns. Select a conversation');
  const answer = (await ask('Selection: ')).trim();
  if (answer.toLowerCase() === 'a') return { kind: 'all' };
  if (answer.toLowerCase() === 's') {
    const sessions = store.sessions();
    sessions.forEach((s, i) =>
      console.error(`${i + 1}. ${s.tool} ${s.startedAt} ${s.id}`),
    );
    const picked = sessions[Number(await ask('Conversation number: ')) - 1];
    if (picked) return { kind: 'sessions', sessionIds: [picked.id] };
  }
  const project = projects[Number(answer) - 1];
  if (!project) throw new Error('SELECTION_CANCELLED');
  return { kind: 'project', projectId: project.projectId };
}

function addScope(command: Command): Command {
  return command
    .option('--project <selector>', 'filter by a central project view')
    .option(
      '--session <id>',
      'include a conversation (repeatable)',
      (value, previous: string[] = []) => [...previous, value],
    )
    .option('--all', 'include all captured history')
    .option('--tool <tool>', 'filter by tool')
    .option('--since <date>', 'include work since this date')
    .option('--until <date>', 'include work through this date')
    .option('--json', 'output structured JSON');
}
function currentStore(): HistoryStore {
  if (!historyExists())
    throw new Error(
      'HISTORY_NOT_FOUND: connect a tool or import a conversation to start capturing work.',
    );
  const store = new HistoryStore();
  try {
    drainPending(store);
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}

function status(opts: Options): Record<string, any> {
  const tools = connectPlugins()
    .filter((p) => !opts.tool || p.id === getPlugin(opts.tool)?.id)
    .map((p) => {
      let state: ReturnType<typeof p.connect.status> = { connected: false };
      try {
        state = p.connect.status();
      } catch {
        /* An unavailable host is reported disconnected. */
      }
      const active =
        automaticCaptureEnabled(p.id) &&
        (state.hooksActive === true || state.captureActive === true);
      return {
        tool: p.id,
        label: p.label,
        ...state,
        mode: active ? 'automatic' : state.connected ? 'manual' : 'disconnected',
      };
    });
  let selected: HistorySelection | undefined;
  let sessions = 0;
  let projects: unknown[] = [];
  if (historyExists()) {
    using store = new HistoryStore({ readonly: true });
    selected = opts.project ? selection(store, opts) : undefined;
    sessions = store.sessions().length;
    projects = store.projects();
  }
  const selectedTool = opts.tool ? tools[0] : undefined;
  const config = readGlobalConfig() as Options;
  const log = join(dataHome(), 'logs', 'capture.jsonl');
  const issues = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-20)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { code: 'DIAGNOSTIC_INVALID' };
          }
        })
    : [];
  const selectedProject =
    selected?.kind === 'project'
      ? (projects as any[]).find((p) => p.projectId === selected.projectId)
      : undefined;
  return {
    schemaVersion: 2,
    home: dataHome(),
    historyExists: historyExists(),
    captureEnabled: config.captureEnabled ?? false,
    captureGloballyDisabled: opts.tool
      ? !automaticCaptureEnabled(opts.tool)
      : !(config.captureEnabled ?? false),
    projectId: selectedProject?.projectId ?? null,
    projectRoot: selectedProject?.projectRoot ?? null,
    sessions,
    projects,
    selection: selected ?? null,
    pendingCaptures: pendingCount(),
    issues,
    capture: selectedTool
      ? {
          tool: selectedTool.tool,
          connected: selectedTool.connected,
          hooksActive: selectedTool.hooksActive ?? false,
          mode: selectedTool.mode,
        }
      : null,
    tools,
  };
}

async function setup(opts: Options): Promise<object> {
  ensureDataHome();
  const config = readGlobalConfig() as Options;
  if (opts.firstRun && config.captureEnabled === false)
    return envelope({ captureEnabled: false, skipped: 'capture-paused' });
  if (opts.off) {
    writeGlobalConfig({ ...config, version: 2, captureEnabled: false });
    return envelope({ captureEnabled: false });
  }
  const now = new Date().toISOString();
  const results: object[] = [];
  for (const plugin of connectPlugins()) {
    if (!plugin.connect.detect() && !plugin.connect.prewireSafe) continue;
    if (config.autoConnectDisabledTools?.includes(plugin.cliName)) continue;
    try {
      const result = plugin.connect.autoConnect?.();
      if (result) {
        enableToolCapture(plugin.cliName, now);
        results.push({ tool: plugin.id, connected: true });
      }
    } catch {
      results.push({ tool: plugin.id, connected: false });
    }
  }
  const latest = readGlobalConfig();
  writeGlobalConfig({
    ...latest,
    version: 2,
    captureEnabled: true,
    captureSince: latest.captureSince ?? now,
    captureResumedAt:
      config.captureEnabled === false ? now : (latest.captureResumedAt ?? now),
    setupCompletedAt: now,
  });
  const identity = await resolveIdentity({
    cwd: process.cwd(),
    allowPrompt: false,
    allowGh: false,
  });
  if (identity)
    writeMachineIdentity({
      ...identity,
      slug: slugifyEmail(identity.email),
      machineId: readMachineIdentity()?.machineId ?? randomUUID(),
    });
  using store = new HistoryStore();
  return envelope({ captureEnabled: true, tools: results });
}

export async function runHistoryCli(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name('showtail')
    .description(
      'Show your work. One private history in ~/.showtail; project folders stay untouched.',
    )
    .version(SHOWTAIL_VERSION, '-v, --version')
    .exitOverride();
  program.configureOutput({
    writeErr: (text) => {
      if (!argv.includes('--json')) process.stderr.write(text);
    },
  });
  program
    .command('home')
    .description('Locate your Showtail folder')
    .option('--open', 'open the folder')
    .option('--json')
    .action((opts) => {
      const home = opts.open ? ensureDataHome() : dataHome();
      if (opts.open) openInDefaultApp(home);
      if (opts.json) print(envelope({}));
      else console.log(home);
    });
  program
    .command('setup')
    .description('Connect detected tools at user scope and enable capture')
    .option('--off', 'pause automatic capture globally')
    .addOption(new Option('--first-run').hideHelp())
    .option('--yes', 'run without prompts')
    .option('--json')
    .action(async (opts) => {
      const result = await setup(opts);
      if (opts.json) print(result);
      else
        console.log(
          `${(result as Options).captureEnabled ? 'Automatic capture enabled.' : 'Automatic capture paused.'}\nStorage: ${dataHome()}\nProject folders are untouched.`,
        );
    });
  for (const name of ['status', 'capabilities'])
    program
      .command(name)
      .description('Show central history and capture state')
      .option('--tool <tool>')
      .option('--project <selector>')
      .option('--json')
      .option('--verbose-json')
      .action((opts) => {
        const result = status(opts);
        if (opts.json || opts.verboseJson) print(result);
        else
          console.log(
            `Storage: ${result.home}\nConversations: ${result.sessions}\nAutomatic capture: ${result.captureEnabled ? 'enabled' : 'paused'}\n${result.tools.map((t: any) => `${t.label}: ${t.mode}`).join('\n')}`,
          );
      });
  const projects = program
    .command('projects [selector]')
    .description('List or resolve optional project views')
    .option('--json')
    .option('--verbose-json')
    .action((selector, opts) => {
      if (!historyExists()) {
        print(envelope({ state: 'catalog', projects: [] }));
        return;
      }
      using store = new HistoryStore({ readonly: true });
      if (selector) {
        const view = store.resolveProject(selector);
        print(envelope({ state: 'selected', selection: view }));
      } else {
        const views = store.projects();
        if (opts.json || opts.verboseJson)
          print(envelope({ state: 'catalog', projects: views }));
        else
          for (const p of views)
            console.log(`${p.projectId}  ${p.displayName}  ${p.projectRoot ?? ''}`);
      }
    });
  projects
    .command('add <path>')
    .description('Save a project view without modifying its folder')
    .option('--name <name>')
    .option('--json')
    .action((path, opts) => {
      using store = new HistoryStore();
      const p = store.registerProject(workspaceRoot(resolve(path)), opts.name);
      if (opts.json) print(envelope(p));
      else console.log(`${p.projectId}  ${p.displayName}`);
    });
  projects
    .command('assign <work-id>')
    .description('Override project membership for a conversation or turn')
    .requiredOption('--to <project-ids...>')
    .option('--json')
    .action((id, opts) => {
      using store = currentStore();
      store.assign(id, opts.to);
      print(envelope({ assigned: id, projectIds: opts.to }));
    });
  projects
    .command('relink <project-id> <path>')
    .description('Associate a moved folder with its existing view')
    .option('--json')
    .action((id, path) => {
      using store = currentStore();
      print(envelope(store.relinkProject(id, resolve(path))));
    });
  addScope(program.command('sessions').description('List captured conversations'))
    .option('--unassigned', 'show conversations with unassigned work')
    .action((opts) => {
      if (!historyExists()) {
        print(envelope({ sessions: [] }));
        return;
      }
      using store = new HistoryStore({ readonly: true });
      const scoped = selection(
        store,
        !opts.project && !opts.session?.length && !opts.all
          ? { ...opts, all: true }
          : opts,
      )!;
      const records = store.records(scoped);
      const ids = new Set(records.map((r) => r.sessionId));
      let sessions = store.sessions().filter((s) => ids.has(s.id));
      if (opts.unassigned)
        sessions = sessions.filter((s) =>
          records.some(
            (r) =>
              r.sessionId === s.id &&
              !store
                .query('SELECT 1 FROM turn_projects WHERE turn_id=?')
                .get(r.turnId ?? r.id),
          ),
        );
      if (opts.json) print(envelope({ sessions }));
      else for (const s of sessions) console.log(`${s.id}  ${s.tool}  ${s.startedAt}`);
    });
  addScope(
    program
      .command('report [path]')
      .description('Generate a private report from selected history'),
  )
    .option('--format <format>', 'html, md, or json', 'html')
    .option('--open')
    .option('--no-open')
    .option('--no-sync')
    .option('--title <title>')
    .option('--author <author>')
    .option('--ai <mode>', 'full, collapsed, or off', 'collapsed')
    .option('--no-ai')
    .action(async (path, opts) => {
      using store = currentStore();
      const scoped = await requireSelection(store, opts, path);
      if (opts.sync !== false) await catchUpHistory(store);
      if (!['html', 'md', 'json'].includes(opts.format))
        throw new Error('INVALID_REPORT_FORMAT');
      const result = writeHistoryReport(store, scoped, {
        ...opts,
        ai: opts.ai === false ? 'off' : opts.ai,
      });
      const reportPath =
        opts.format === 'md'
          ? result.markdownPath
          : opts.format === 'json'
            ? result.jsonPath
            : result.reportPath;
      const project =
        scoped.kind === 'project' ? store.resolveProject(scoped.projectId) : undefined;
      if (opts.open === true) openInDefaultApp(reportPath);
      if (opts.json)
        print(
          envelope({
            selection: scoped,
            projectId: project?.projectId ?? null,
            projectRoot: project?.projectRoot ?? null,
            reportPath,
            summary: result.data.summary,
          }),
        );
      else console.log(`Private report: ${reportPath}`);
    });
  addScope(
    program
      .command('submit [path]')
      .description('Create a sanitized, signed submission inside Showtail'),
  )
    .option('--title <title>')
    .option('--no-sync')
    .option('--open')
    .option('--pr [number-or-url]')
    .option('--repo <owner/repo>')
    .option('--preview')
    .option('--approve <code>')
    .action(async (path, opts) => {
      using store = currentStore();
      if (opts.approve) {
        const result = approvePr(store, opts.approve);
        if (opts.json) print(result);
        else console.log(`Posted: ${(result as any).url}`);
        return;
      }
      const scoped = await requireSelection(store, opts, path);
      if (opts.sync !== false) await catchUpHistory(store);
      if (opts.pr) {
        const result = previewPr(store, scoped, opts);
        if (opts.json) print(result);
        else {
          console.log(result.comment);
          console.log(`\nValues withheld: ${result.withheld}`);
          if (result.publicAndPermanent)
            console.log('This comment will be public and permanent.');
          console.log(
            `Nothing posted. To approve this exact text: showtail submit --pr --approve ${result.code}`,
          );
        }
      } else {
        const result = exportHistory(store, scoped, opts);
        if (opts.open) openInDefaultApp(join(result.dir, 'report.html'));
        if (opts.json)
          print(
            envelope({
              exportId: result.exportId,
              exportPath: result.dir,
              reportPath: join(result.dir, 'report.html'),
              withheld: result.manifest.withheld,
            }),
          );
        else
          console.log(
            `Submission: ${join(result.dir, 'report.html')}\nValues withheld: ${result.manifest.withheld.total}`,
          );
      }
    });
  program
    .command('verify')
    .description('Check central content, references, and history integrity')
    .option('--project <selector>')
    .option('--json')
    .action((opts) => {
      using store = new HistoryStore({ readonly: true });
      const project = opts.project ? store.resolveProject(opts.project) : undefined;
      const result = store.verify();
      const output = envelope({
        ...result,
        projectId: project?.projectId ?? null,
        projectRoot: project?.projectRoot ?? null,
        meaning: 'Internal integrity only; does not prove authorship or completeness.',
      });
      if (opts.json) print(output);
      else {
        for (const c of result.checks) console.log(`${c.ok ? 'OK' : 'FAIL'} ${c.name}`);
        console.log(
          'Internal integrity only; does not prove authorship or completeness.',
        );
      }
      if (!result.ok) process.exitCode = 1;
    });
  program
    .command('verify-submission [directory]')
    .description('Verify a signed submission')
    .option('--json')
    .action((dir, opts) => {
      if (!dir && historyExists()) {
        using store = new HistoryStore({ readonly: true });
        dir = store.meta('lastExport');
      }
      if (!dir) throw new Error('SUBMISSION_REQUIRED: pass a submission directory.');
      const result = verifySubmission(resolve(dir));
      if (opts.json) print(envelope(result));
      else
        console.log(
          result.ok ? 'Submission integrity verified.' : result.problems.join('\n'),
        );
      if (!result.ok) process.exitCode = 1;
    });
  program
    .command('connect <tool>')
    .description('Connect a tool for this user; never writes project configuration')
    .option('--user', 'user scope (the only supported scope)')
    .option('--no-hooks')
    .option('--no-extension')
    .option('--yes')
    .option('--force')
    .option('--managed-refresh')
    .action(async (name, opts) => {
      const plugin = connectPluginOrThrow(name);
      await plugin.connect.install({ ...opts, user: true, project: false });
      if (opts.hooks === false) {
        disableToolCapture(plugin.cliName);
        disableToolAutoConnect(plugin.cliName);
      } else {
        enableToolCapture(plugin.cliName);
        enableToolAutoConnect(plugin.cliName);
      }
      const config = readGlobalConfig();
      writeGlobalConfig({
        ...config,
        version: 2,
        captureEnabled: config.captureEnabled ?? true,
        captureSince: config.captureSince ?? new Date().toISOString(),
      });
      console.log(`History: ${dataHome()}`);
    });
  program
    .command('disconnect <tool>')
    .description('Stop capture and remove user-level registration; history is retained')
    .option('--user')
    .action(async (name) => {
      const plugin = connectPluginOrThrow(name);
      disableToolCapture(plugin.cliName);
      disableToolAutoConnect(plugin.cliName);
      await plugin.connect.uninstall({ user: true, all: false });
      console.log(`Capture stopped. History remains in ${dataHome()}.`);
    });
  const imports = program
    .command('import')
    .description('Import conversations or old Showtail data');
  imports
    .command('legacy')
    .requiredOption(
      '--from <path>',
      'old ledger, project, or .showtail directory (repeatable)',
      (v, prior: string[] = []) => [...prior, v],
    )
    .option('--dry-run')
    .option(
      '--recover-damaged',
      'recover readable journal rows with unverified provenance and an audit; retain originals',
    )
    .option('--json')
    .action((opts) => {
      const result = importLegacy(opts.from, opts);
      if (opts.json) print(envelope(result));
      else
        console.log(
          `${opts.dryRun ? 'Preview' : 'Imported'}: ${result.imported ?? result.records} records, ${result.duplicates ?? 0} duplicates.\nOriginals unchanged.`,
        );
    });
  for (const plugin of PLUGINS.filter((p) => p.import || p.migration)) {
    const cmd = imports
      .command(`${plugin.cliName} [source]`)
      .aliases(plugin.aliases.filter((a) => a !== plugin.cliName))
      .description(`Import ${plugin.label} into central history`)
      .option('--file <path>')
      .option('--list')
      .option('--paste')
      .option('--clipboard')
      .option('--yes')
      .option('--date <date>')
      .option('--model <model>')
      .option('--session <id>')
      .option('--no-responses')
      .option('--auto')
      .option('--quiet')
      .option('--json');
    cmd.action(async (source, opts) => {
      const result = await runHistoryImport(plugin.cliName, source, {
        ...opts,
        withResponses: opts.responses,
      });
      if (opts.json) print(result);
      else if (!opts.quiet) console.log(JSON.stringify(result));
    });
  }
  program
    .command('start')
    .description('Start a manual work session')
    .option('--label <label>')
    .option('--json')
    .action((opts) => {
      using store = new HistoryStore();
      const s = store.ensureSession({
        tool: 'cli',
        nativeSessionId: `manual:${randomUUID()}`,
        cwd: process.cwd(),
      });
      store.setMeta('manualSession', s.id);
      if (opts.label) store.setMeta(`sessionLabel:${s.id}`, opts.label);
      if (opts.json) print(envelope(s));
      else console.log(s.id);
    });
  program
    .command('end')
    .description('End the current manual session')
    .option('--session <id>')
    .option('--json')
    .action((opts) => {
      using store = currentStore();
      const id = opts.session ?? store.meta('manualSession');
      if (!id || !store.session(id)) throw new Error('SESSION_NOT_FOUND');
      store.endSession(id);
      if (store.meta('manualSession') === id) store.setMeta('manualSession', '');
      if (opts.json) print(envelope({ sessionId: id }));
      else console.log(`Ended ${id}.`);
    });
  program
    .command('log')
    .description('Record a prompt, decision, or note centrally')
    .option('-x, --text <text>')
    .option('-t, --type <type>', 'event type', 'prompt')
    .option('--tool <tool>', 'source tool', 'cli')
    .option('-s, --session <id>')
    .option('--json')
    .action(async (opts) => {
      if (!isEventType(opts.type) || opts.type === 'artifact')
        throw new Error('INVALID_EVENT_TYPE');
      const text = opts.text ?? (await Bun.stdin.text());
      using store = new HistoryStore();
      const id = opts.session ?? store.meta('manualSession');
      const session = id ? store.session(id) : undefined;
      if (opts.session && !session) throw new Error('SESSION_NOT_FOUND');
      const s =
        session ??
        store.ensureSession({
          tool: opts.tool,
          nativeSessionId: `manual:${randomUUID()}`,
          cwd: process.cwd(),
        });
      if (!opts.session) store.setMeta('manualSession', s.id);
      const result = store.append(s.id, { kind: opts.type, text });
      if (opts.json) print(envelope({ sessionId: s.id, record: result.record }));
      else console.log(result.record?.id);
    });
  program
    .command('artifact <file>')
    .description('Record a file hash without writing to the project')
    .option('--session <id>')
    .option('--tool <tool>', 'source tool', 'cli')
    .option('--json')
    .action((file, opts) => {
      using store = new HistoryStore();
      const session = opts.session
        ? store.session(opts.session)
        : store.ensureSession({
            tool: opts.tool,
            nativeSessionId: `manual:${randomUUID()}`,
            cwd: process.cwd(),
          });
      if (!session) throw new Error('SESSION_NOT_FOUND');
      const path = resolve(file);
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      const result = store.append(session.id, { kind: 'edit', file: path, sha256 });
      if (opts.json) print(envelope({ record: result.record }));
      else console.log(result.record?.id ?? 'File excluded by capture policy.');
    });
  program
    .command('trace <file>')
    .description('Find centrally recorded changes to a file')
    .option('--json')
    .option('--format <format>')
    .action((file, opts) => {
      using store = new HistoryStore({ readonly: true });
      const path = resolve(file);
      const records = store.records().filter((r) => r.file && resolve(r.file) === path);
      if (opts.json || opts.format === 'json') print(envelope({ records }));
      else for (const r of records) console.log(`${r.ts} ${r.sessionId} ${r.id}`);
    });
  program
    .command('redact')
    .description('Rescan stored content or apply a declared privacy rewrite')
    .option('--pattern <regex>')
    .option('--rescan')
    .option('--dry-run')
    .option('--yes')
    .option('--json')
    .action((opts) => {
      using store = currentStore();
      const result = redactHistory(store, {
        pattern: opts.pattern,
        apply: !opts.dryRun && (!opts.pattern || opts.yes === true),
      });
      if (opts.json) print(envelope(result));
      else
        console.log(
          `${result.applied ? 'Redacted' : 'Preview'}: ${result.values} values in ${result.objects} content objects.`,
        );
    });
  program
    .command('update')
    .description('Update the Showtail executable')
    .option('--check')
    .option('--auto-check <on|off>')
    .option('--json')
    .action(async (opts) => {
      await runUpdate(opts);
    });
  const guard = program.command('guard', { hidden: true });
  guard
    .command('check')
    .option('--staged')
    .option('--pushing')
    .allowUnknownOption()
    .action(() => {});
  program
    .command('hook <event>', { hidden: true })
    .option('--tool <tool>', 'provider', 'claude-code')
    .action(async (event, opts) => {
      try {
        if (
          !['session-start', 'user-prompt', 'post-edit', 'stop', 'session-end'].includes(
            event,
          )
        )
          return;
        const raw = await Bun.stdin.text();
        await runHistoryHook(
          event as CaptureEvent,
          raw.trim() ? JSON.parse(raw) : {},
          opts.tool,
        );
      } catch {
        captureIssue('CAPTURE_FAILED', opts.tool);
      } finally {
        if (['antigravity-cli', 'antigravity-ide'].includes(opts.tool))
          console.log(
            event === 'stop' || opts.tool === 'antigravity-ide'
              ? '{"decision":"allow"}'
              : '{}',
          );
      }
    });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes('--json'))
      print(
        envelope({
          ok: false,
          errorCode: /^[A-Z_]+(?=:)/.exec(message)?.[0] ?? 'COMMAND_FAILED',
          message,
          candidates: (error as any)?.candidates,
        }),
      );
    else console.error(message);
  }
}
