import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  check,
  clearAuth,
  cli,
  command,
  connect,
  createScenario,
  files,
  findCommand,
  hash,
  ledger,
  provisionAuth,
  queueEmpty,
  save,
  scrub,
  snapshot,
  waitFor,
  type Provider,
  type Scenario,
} from './common.ts';
import { inspectReport } from './report.ts';

import { compareNativeRevisions, compareNativeSnapshots, nativeState } from './oracle.ts';
export { nativeState } from './oracle.ts';

class Interactive {
  raw = '';
  plain = '';
  private lastAction = -1;
  private busy = false;
  private timer: ReturnType<typeof setInterval>;
  private proc: ReturnType<typeof Bun.spawn>;
  private actions: string[] = [];
  private intents: any[] = [];
  private decoder = new TextDecoder();
  private ended = false;
  private stopped = false;
  private finished: Promise<number | null>;
  private exitWaitError: unknown;
  constructor(
    readonly s: Scenario,
    readonly provider: Provider,
    readonly sandbox: 'workspace-write' | 'danger-full-access' = 'workspace-write',
  ) {
    // Match the owner's current permission profile. Windows unelevated workspace
    // sandboxing rejects split writable roots before any test code can run.
    const args =
      provider === 'codex'
        ? [
            '--no-alt-screen',
            '--no-daemon',
            '-s',
            sandbox,
            '-a',
            'never',
            ...(process.platform === 'win32'
              ? ['-c', 'windows.sandbox="unelevated"']
              : []),
          ]
        : [];
    this.proc = Bun.spawn([findCommand(provider), ...args], {
      cwd: s.workspace,
      env: s.env,
      terminal: {
        cols: 140,
        rows: 42,
        data: (_t, data) => {
          const text = this.decoder.decode(data, { stream: true });
          this.raw += text;
          this.plain += stripVTControlCharacters(text.replace(/\x1b\[\d*C/g, ' '));
          appendFileSync(join(s.artifactDir, `${provider}-terminal.log`), scrub(text));
        },
      },
    });
    this.finished = this.proc.exited.then(
      (code) => {
        this.ended = true;
        return code;
      },
      (error) => {
        this.ended = true;
        this.exitWaitError = error;
        return null;
      },
    );
    this.timer = setInterval(() => void this.bootstrap(), 200);
  }
  private async bootstrap() {
    if (this.busy || this.ended || this.stopped) return;
    const variants: Array<[string, string, string]> =
      this.provider === 'codex'
        ? [
            ['Trust this folder?', '\r', 'trust disposable project'],
            ['Hooks need review', '\x1b[B\r', 'trust vetted temporary hooks'],
            ['Use non-admin sandbox', '\x1b[B\r', 'non-admin sandbox'],
            [
              'Would you like to run the following command?',
              '\r',
              'approve test task command',
            ],
            [
              'Would you like to make the following edits?',
              '\r',
              'approve test project edits',
            ],
          ]
        : [
            ['Choose the text style', '\r', 'terminal theme'],
            [
              'Do you want to use this API key?',
              '\x1b[A\r',
              'use existing API credential',
            ],
            ['Press Enter to continue', '\r', 'onboarding'],
            ['Yes, I trust this folder', '\x1b[B\r', 'trust disposable project'],
            ['Do you want to proceed?', '\r', 'approve test task tool'],
          ];
    for (const [needle, input, action] of variants) {
      const index = this.plain.lastIndexOf(needle);
      if (index > this.lastAction) {
        this.busy = true;
        this.lastAction = this.plain.length;
        this.actions.push(action);
        this.write(input);
        await Bun.sleep(350);
        this.busy = false;
        save(
          join(this.s.artifactDir, `${this.provider}-terminal-actions.json`),
          this.actions,
        );
        return;
      }
    }
  }
  write(text: string) {
    this.proc.terminal!.write(text);
  }
  async ready() {
    await waitFor(
      () => {
        if (this.ended) throw new Error(`Provider exited ${this.proc.exitCode}`);
        const pending = Math.max(
          ...[
            'Trust this folder?',
            'Hooks need review',
            'Set up the Codex agent sandbox',
            'Input disabled until setup completes.',
          ].map((needle) => this.plain.lastIndexOf(needle)),
        );
        const composer = this.plain.lastIndexOf('Ask Codex to do anything');
        return this.provider === 'codex'
          ? this.raw.includes('state=idle:app=codex') && composer > pending && !this.busy
          : /auto mode on|accept edits on|for shortcuts|shift\+tab to cycle/.test(
              this.plain,
            ) && !this.busy;
      },
      90_000,
      `${this.provider} interactive startup`,
    );
    await Bun.sleep(700);
  }
  async turn(text: string, timeout: number) {
    const before = nativeState(this.s, this.provider);
    const beforeIds = new Set(before.messages.map((m) => `${m.path}\0${m.id}`));
    const submittedAt = new Date().toISOString();
    const intent = {
      text,
      submittedAt,
      state: 'submitted',
      nativeId: undefined as string | undefined,
      acknowledgedAt: undefined as string | undefined,
      completedAt: undefined as string | undefined,
    };
    this.intents.push(intent);
    save(join(this.s.artifactDir, `${this.provider}-prompt-intents.json`), this.intents);
    this.write('\x1b[200~' + text + '\x1b[201~');
    await Bun.sleep(350);
    this.write('\r');
    await waitFor(
      () => {
        if (this.ended) throw new Error('Provider exited before acknowledging prompt');
        return nativeState(this.s, this.provider).messages.some(
          (m) => !beforeIds.has(`${m.path}\0${m.id}`),
        );
      },
      timeout,
      `${this.provider} prompt acknowledgement`,
    );
    const acknowledged = nativeState(this.s, this.provider).messages.find(
      (m) => !beforeIds.has(`${m.path}\0${m.id}`),
    )!;
    if (acknowledged.text !== text)
      throw new Error('Provider acknowledged different prompt text');
    Object.assign(intent, {
      state: 'acknowledged',
      nativeId: acknowledged.id,
      acknowledgedAt: new Date().toISOString(),
    });
    save(join(this.s.artifactDir, `${this.provider}-prompt-intents.json`), this.intents);
    await waitFor(
      () => {
        if (this.ended) throw new Error('Provider exited mid-turn');
        return nativeState(this.s, this.provider).completedIds.includes(acknowledged.id);
      },
      timeout,
      `${this.provider} native completion`,
    );
    const providerFailure = nativeState(this.s, this.provider).errors.find(
      (e) => e.promptId === acknowledged.id,
    );
    if (providerFailure)
      throw new Error(`UNAVAILABLE: ${providerFailure.code}: ${providerFailure.message}`);
    Object.assign(intent, { state: 'completed', completedAt: new Date().toISOString() });
    save(join(this.s.artifactDir, `${this.provider}-prompt-intents.json`), this.intents);
    // Allow the provider to flush its final Stop callback and return to the composer.
    await Bun.sleep(750);
    return {
      submittedAt,
      acknowledgedAt: intent.acknowledgedAt!,
      completedAt: intent.completedAt!,
      nativeId: acknowledged.id,
      text,
    };
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    if (!this.ended) {
      for (let i = 0; i < 2 && !this.ended; i++) {
        try {
          this.write('\x03');
        } catch (error) {
          if (!['EPIPE', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
        }
        await Bun.sleep(150);
      }
      await Promise.race([this.finished, Bun.sleep(1500)]);
      if (!this.ended)
        try {
          this.proc.kill();
        } catch (error) {
          if (!['EBADF', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
        }
      await this.finished;
    }
    if (this.exitWaitError) {
      // Some Windows ConPTY exits reject waitpid after the handle is closed.
      // Unexpected exits still fail ready/turn; teardown must reap the owned PID.
      try {
        process.kill(this.proc.pid, 0);
        process.kill(this.proc.pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      save(join(this.s.artifactDir, `${this.provider}-exit-wait.json`), {
        pid: this.proc.pid,
        error: String(this.exitWaitError),
      });
    }
    try {
      this.proc.terminal?.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
}

export interface LiveOptions {
  binary: string;
  artifactDir: string;
  repetitions?: number;
  turnTimeout?: number;
  providers?: Provider[];
  scenario?: string;
  sandbox?: 'workspace-write' | 'danger-full-access';
}
function prompts(id: string, prefix = 'calculator') {
  return [
    `Build a tiny JavaScript module for acceptance case ${id}.\nCreate ${prefix}.mjs exporting add(a, b), ${prefix}.test.mjs using node:test, and obsolete-${prefix}.txt containing old. Run tests with bun test. No dependencies.`,
    `Extend ${prefix}.mjs with subtract(a, b), add a test, and rename obsolete-${prefix}.txt to renamed-${prefix}.txt. Run bun test.`,
    'Run the tests again.',
    'Run the tests again.',
    `Delete renamed-${prefix}.txt. Demonstrate that bun test ./missing-${prefix}.test.mjs fails, then rerun the real tests successfully.`,
  ];
}

function validateNativeEvidence(
  s: Scenario,
  native: ReturnType<typeof nativeState>,
  provider?: Provider,
) {
  const records = ledger(s);
  const applied = compareNativeRevisions(native.appliedRevisions, records);
  const snapshots = compareNativeSnapshots(native.bashSnapshots, records);
  const status = (result: typeof applied) =>
    result.expected ? (result.missing.length ? 'fail' : 'pass') : 'unsupported';
  save(
    join(s.artifactDir, `native-revision-coverage${provider ? '-' + provider : ''}.json`),
    {
      applied: { ...applied, status: status(applied) },
      workspaceSnapshots: { ...snapshots, status: status(snapshots) },
    },
  );
  if (applied.expected)
    check(
      s,
      'every native applied revision retains its identity and delta',
      applied.missing.length === 0,
      JSON.stringify(applied),
    );
  if (snapshots.expected)
    check(
      s,
      'every native workspace snapshot retains its identity and delta',
      snapshots.missing.length === 0,
      JSON.stringify(snapshots),
    );
}
async function validateReport(s: Scenario, expected: string[], noSync = true) {
  const r = JSON.parse(
    (
      await cli(s, [
        'report',
        '--project',
        s.workspace,
        '--json',
        '--no-open',
        ...(noSync ? ['--no-sync'] : []),
      ])
    ).stdout,
  );
  const path = r.reportPath as string;
  const data = JSON.parse(readFileSync(join(dirname(path), 'report.json'), 'utf8'));
  const actual = data.turns.map((t: any) => t.prompt.text);
  check(
    s,
    'report human prompts match independent submissions',
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify({ expected, actual }),
  );
  check(s, 'report stays in central home', path.startsWith(s.home));
  const browser = await inspectReport(
    path,
    join(s.artifactDir, noSync ? 'browser-auto' : 'browser-sync'),
    expected,
  );
  s.checks.push(...browser.checks);
  save(join(s.artifactDir, 'checks.json'), s.checks);
  return { path, data };
}
async function ordinary(
  options: LiveOptions,
  provider: Provider,
  name: string,
  mode:
    | 'core'
    | 'no-assistant'
    | 'baseline'
    | 'catchup'
    | 'consent'
    | 'delegation'
    | 'shell'
    | 'tool-consent'
    | 'pre-consent',
) {
  const s = createScenario(options.binary, join(options.artifactDir, name));
  let host: Interactive | undefined;
  const submitted: Array<{ text: string; submittedAt: string; acknowledgedAt: string }> =
    [];
  try {
    provisionAuth(s, provider);
    if (mode !== 'baseline' && mode !== 'pre-consent')
      await connect(s, provider, mode !== 'no-assistant');
    check(
      s,
      'setup preserves existing project rules and hooks',
      Object.entries(s.protectedFiles ?? {}).every(
        ([p, digest]) => hash(readFileSync(p)) === digest,
      ),
    );
    // Fresh status is inspected before normal hook review; never grant trust programmatically.
    if (provider === 'codex' && mode !== 'baseline' && mode !== 'pre-consent') {
      const status = JSON.parse(
        (await cli(s, ['status', '--tool', 'codex', '--json'])).stdout,
      );
      save(join(s.artifactDir, 'fresh-status.json'), status);
      check(
        s,
        'fresh hook trust is disclosed',
        status.capture?.mode === 'on-demand' &&
          status.capture?.issues?.some((i: any) => i.code === 'HOOK_TRUST_REQUIRED'),
      );
    }
    if (mode === 'catchup') {
      const config =
        provider === 'codex'
          ? join(s.env.CODEX_HOME!, 'hooks.json')
          : join(s.env.CLAUDE_CONFIG_DIR!, 'settings.json');
      const value = JSON.parse(readFileSync(config, 'utf8'));
      delete value.hooks;
      writeFileSync(config, JSON.stringify(value));
    }
    const before = snapshot(s.workspace);
    const hooksBefore = Object.fromEntries(
      [...files(join(s.workspace, '.git', 'hooks')), join(s.workspace, '.git', 'config')]
        .filter(existsSync)
        .map((p) => [p, hash(readFileSync(p))]),
    );
    host = new Interactive(s, provider, options.sandbox);
    await host.ready();
    const tasks =
      mode === 'shell'
        ? [
            `For case ${name}, use a PowerShell Set-Content command with a literal file path to create shell-only.txt containing exactly observed shell state. Use a shell command rather than a structured patch or file-write tool. No dependencies.`,
          ]
        : mode === 'core'
          ? prompts(name)
          : mode === 'pre-consent'
            ? [
                'Create preconsent.txt containing before.',
                'Create afterconsent.txt containing after.',
              ]
            : mode === 'consent' || mode === 'tool-consent'
              ? [
                  `Create before.txt containing before for case ${name}.`,
                  'Create paused.txt containing paused.',
                  'Create resumed.txt containing resumed.',
                ]
              : mode === 'delegation'
                ? [
                    `For case ${name}, delegate to a subagent to create delegated.mjs exporting square(n) = n*n. Wait for the subagent, then review its result.`,
                  ]
                : [prompts(name)[0]!];
    for (let i = 0; i < tasks.length; i++) {
      if (mode === 'consent' && i === 1) await cli(s, ['setup', '--off', '--json']);
      if (mode === 'tool-consent' && i === 1) await cli(s, ['disconnect', provider]);
      if (mode === 'tool-consent' && i === 2) await connect(s, provider);
      if (mode === 'pre-consent' && i === 1) {
        await host.stop();
        await connect(s, provider);
        host = new Interactive(s, provider, options.sandbox);
        await host.ready();
      }
      if (mode === 'consent' && i === 2) await cli(s, ['setup', '--json']);
      console.log(`[live] ${name} turn ${i + 1}/${tasks.length}`);
      submitted.push(await host.turn(tasks[i]!, options.turnTimeout ?? 600_000));
      save(join(s.artifactDir, 'submitted-prompts.json'), submitted);
      save(join(s.artifactDir, `filesystem-${i + 1}.json`), snapshot(s.workspace));
      if (mode === 'core') {
        const tested = await command(
          process.execPath,
          ['test', './calculator.test.mjs'],
          s.env,
          s.workspace,
          30_000,
        );
        check(
          s,
          `actual generated tests pass turn ${i + 1}`,
          tested.code === 0,
          tested.stderr.slice(-1000),
        );
        const expression =
          i === 0 ? 'm.add(2,3)!==5' : 'm.add(2,3)!==5 || m.subtract(9,4)!==5';
        const validated = await command(
          process.execPath,
          [
            '-e',
            `const m=await import('./calculator.mjs');if(${expression})throw Error('incorrect arithmetic');`,
          ],
          s.env,
          s.workspace,
          30_000,
        );
        check(
          s,
          `independent code behavior turn ${i + 1}`,
          validated.code === 0,
          validated.stderr.slice(-500),
        );
        if (i === 0)
          check(
            s,
            'initial file created',
            existsSync(join(s.workspace, 'obsolete-calculator.txt')) &&
              readFileSync(
                join(s.workspace, 'obsolete-calculator.txt'),
                'utf8',
              ).trim() === 'old',
          );
        if (i === 1)
          check(
            s,
            'rename actually happened',
            !existsSync(join(s.workspace, 'obsolete-calculator.txt')) &&
              existsSync(join(s.workspace, 'renamed-calculator.txt')),
          );
      }
      if (
        mode !== 'baseline' &&
        mode !== 'catchup' &&
        !((mode === 'consent' || mode === 'tool-consent') && i === 1) &&
        !(mode === 'pre-consent' && i === 0)
      ) {
        const eligible = tasks
          .slice(0, i + 1)
          .filter(
            (_, j) =>
              !((mode === 'consent' || mode === 'tool-consent') && j === 1) &&
              !(mode === 'pre-consent' && j === 0),
          );
        try {
          await waitFor(
            () =>
              JSON.stringify(
                ledger(s)
                  .filter((r) => r.kind === 'prompt')
                  .map((r) => r.text),
              ) === JSON.stringify(eligible) && queueEmpty(s),
            30_000,
            'automatic capture before sync',
          );
          check(s, `automatic capture turn ${i + 1}`, true);
        } catch (error) {
          check(s, `automatic capture turn ${i + 1}`, false, String(error));
        }
      }
    }
    await host.stop();
    host = undefined;
    const native = nativeState(s, provider);
    save(join(s.artifactDir, 'native-oracle.json'), {
      messages: native.messages,
      completed: native.completed,
      applied: native.applied,
      appliedRevisions: native.appliedRevisions,
      workspaceSnapshots: native.bashSnapshots,
      inspectedContextRecords: native.contexts.length,
      children: native.children,
      sources: native.sourceFiles,
    });
    save(join(s.artifactDir, 'provider.json'), {
      provider,
      version: (
        await command(findCommand(provider), ['--version'], s.env, s.workspace)
      ).stdout.trim(),
      models: native.models,
    });
    check(
      s,
      'finished native sources are valid JSONL',
      native.parseErrors.length === 0,
      native.parseErrors.join(', '),
    );
    check(
      s,
      'native prompts match acknowledged submissions',
      JSON.stringify(native.messages.map((m) => m.text)) === JSON.stringify(tasks),
    );
    check(
      s,
      'agent never invokes Showtail',
      native.calls.every(
        (c) =>
          !/(?:^|[\s"'`])showtail(?:\.exe)?\s+(?:status|log|report|submit|hook|sync|setup)/i.test(
            c.input ?? '',
          ),
      ),
    );
    check(
      s,
      'agent never announces capture or offers a report',
      native.answers.every(
        (a) =>
          !/\bshowtail\s+(?:report|capture|logging|history)|\b(?:capture|provenance)\s+(?:is|was)\s+(?:enabled|active)/i.test(
            a,
          ),
      ),
    );
    check(
      s,
      'native model context is available for inspection',
      native.contexts.length > 0,
    );
    check(
      s,
      'normal context never loads full Showtail instructions',
      native.contexts.every(
        (c) => !/\bshowtail\s+(?:status|log|report|submit|sync)\b/.test(c),
      ),
    );
    check(
      s,
      'coding task produced files',
      JSON.stringify(snapshot(s.workspace)) !== JSON.stringify(before),
    );
    check(
      s,
      'no project-local Showtail data',
      !files(s.workspace).some((p) => /[\\/]\.showtail([\\/]|$)/.test(p)),
    );
    check(
      s,
      'project Git hooks unchanged',
      Object.entries(hooksBefore).every(
        ([p, digest]) => existsSync(p) && hash(readFileSync(p)) === digest,
      ),
    );
    const instructionFiles = files(s.workspace).filter((p) =>
      /AGENTS(?:\.override)?\.md$|CLAUDE\.md$|copilot-instructions\.md$|[\\/]hooks\.json$/i.test(
        p,
      ),
    );
    check(
      s,
      'no Showtail project instructions or callbacks',
      instructionFiles.every((p) => !/showtail/i.test(readFileSync(p, 'utf8'))),
    );
    if (mode === 'baseline') {
      check(s, 'no collector without Showtail installation', ledger(s).length === 0);
      return s;
    }
    const expected = tasks.filter(
      (_, i) =>
        !((mode === 'consent' || mode === 'tool-consent') && i === 1) &&
        !(mode === 'pre-consent' && i === 0),
    );
    if (mode === 'catchup')
      check(s, 'no automatic capture when callbacks suppressed', ledger(s).length === 0);
    else await validateReport(s, expected);
    const sourceBefore = Object.fromEntries(
      native.sourceFiles.map((p) => [p, hash(readFileSync(p))]),
    );
    const synced = JSON.parse(
      (await cli(s, ['sync', '--tool', provider, '--json'])).stdout,
    );
    check(
      s,
      'native synchronization reports no incomplete sources',
      synced.issues.length === 0,
      JSON.stringify(synced.issues),
    );
    const afterSync = ledger(s);
    if (['core', 'no-assistant', 'catchup', 'delegation'].includes(mode))
      validateNativeEvidence(s, native);
    check(
      s,
      'catch-up has exactly eligible human prompts',
      JSON.stringify(afterSync.filter((r) => r.kind === 'prompt').map((r) => r.text)) ===
        JSON.stringify(expected),
    );
    if (mode === 'shell') {
      const path = join(s.workspace, 'shell-only.txt');
      check(
        s,
        'shell task actually wrote expected content',
        existsSync(path) && readFileSync(path, 'utf8').trim() === 'observed shell state',
      );
      check(
        s,
        'shell write has captured file evidence',
        afterSync.some(
          (r) =>
            ['edit', 'audit'].includes(r.kind) &&
            r.file === path &&
            r.sha256 === hash(readFileSync(path)),
        ),
      );
    }
    if (mode === 'core') {
      const changes = afterSync.filter((r) => r.kind === 'edit');
      const required = [
        `calculator.mjs`,
        `calculator.test.mjs`,
        `obsolete-calculator.txt`,
      ];
      for (const file of required)
        check(
          s,
          `file evidence ${file}`,
          changes.some((r) => basename(r.file ?? '') === file),
        );
      check(
        s,
        'renamed file deleted',
        !existsSync(join(s.workspace, 'renamed-calculator.txt')),
      );
      check(
        s,
        'deliberate failing command has a native failed outcome',
        native.outcomes.some(
          (o) =>
            String(o.command).includes('missing-calculator.test.mjs') &&
            o.status === 'failed',
        ),
      );
    }
    if (mode === 'no-assistant')
      check(
        s,
        'capture without reporting discovery',
        !existsSync(
          join(
            provider === 'codex' ? s.env.CODEX_HOME! : s.env.CLAUDE_CONFIG_DIR!,
            'skills/showtail/SKILL.md',
          ),
        ),
      );
    if (mode === 'delegation') {
      const childRecords = afterSync.filter((r) =>
        native.childSources.some((p) => {
          const rows = readFileSync(p, 'utf8')
            .split('\n')
            .flatMap((l) => {
              try {
                return [JSON.parse(l)];
              } catch {
                return [];
              }
            });
          const id =
            provider === 'codex'
              ? rows.find((r) => r.type === 'session_meta')?.payload?.id
              : rows.find((r) => r.sessionId)?.sessionId;
          return provider === 'codex'
            ? r.native_id === id
            : r.native_id.startsWith(`${id}:agent:`);
        }),
      );
      check(s, 'native child sources actually persisted', native.childSources.length > 0);
      check(s, 'child work retained in central ledger', childRecords.length > 0);
      check(
        s,
        'delegated inputs never become human prompt cards',
        childRecords.every((r) => r.kind !== 'prompt'),
      );
      const ran = await command(
        process.execPath,
        [
          '-e',
          "const m=await import('./delegated.mjs');if(m.square(4)!==16)throw Error('bad delegated implementation');",
        ],
        s.env,
        s.workspace,
        30_000,
      );
      check(s, 'delegated implementation actually works', ran.code === 0, ran.stderr);
    }
    await validateReport(s, expected, false);
    const immutable = ledger(s).map((r) => ({ id: r.id, hash: r.hash }));
    for (let i = 0; i < 2; i++) await cli(s, ['sync', '--tool', provider, '--json']);
    check(
      s,
      'repeated sync does not append revisions',
      JSON.stringify(ledger(s).map((r) => ({ id: r.id, hash: r.hash }))) ===
        JSON.stringify(immutable),
    );
    check(
      s,
      'collection leaves native sources unchanged',
      native.sourceFiles.every((p) => hash(readFileSync(p)) === sourceBefore[p]),
    );
    check(
      s,
      'history integrity',
      JSON.parse((await cli(s, ['verify', '--json'])).stdout).ok === true,
    );
    check(s, 'collector drained', queueEmpty(s));
  } catch (error) {
    check(
      s,
      'scenario completed',
      false,
      scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
  } finally {
    try {
      if (host) await host.stop();
    } catch (error) {
      check(s, 'provider teardown', false, scrub(String(error)));
    }
    clearAuth(s);
    save(join(s.artifactDir, 'checks.json'), s.checks);
  }
  console.log(
    `[live] ${name}: ${s.checks.filter((c) => c.ok).length} passed, ${s.checks.filter((c) => !c.ok).length} failed`,
  );
  return s;
}

async function headless(
  options: LiveOptions,
  provider: Provider,
  name = `${provider}-headless`,
) {
  const s = createScenario(options.binary, join(options.artifactDir, name));
  let host: Interactive | undefined;
  try {
    provisionAuth(s, provider);
    await connect(s, provider);
    // Trust only these vetted temporary hooks through the normal host UI first.
    host = new Interactive(s, provider, options.sandbox);
    await host.ready();
    await host.stop();
    host = undefined;
    const text = `For case ${provider}-headless, create headless.mjs exporting double(n) returning n * 2. Use no dependencies.`;
    save(join(s.artifactDir, 'submitted-prompts.json'), [
      { text, submittedAt: new Date().toISOString() },
    ]);
    const args =
      provider === 'codex'
        ? [
            '--no-daemon',
            'exec',
            '--json',
            '-s',
            options.sandbox ?? 'workspace-write',
            text,
          ]
        : [
            '-p',
            text,
            '--output-format',
            'stream-json',
            '--verbose',
            '--include-hook-events',
            '--permission-mode',
            'acceptEdits',
            '--allowedTools',
            'Read,Write,Edit,Bash,PowerShell',
          ];
    const r = await command(
      findCommand(provider),
      args,
      s.env,
      s.workspace,
      options.turnTimeout ?? 600_000,
    );
    writeFileSync(join(s.artifactDir, 'headless-output.jsonl'), r.stdout);
    writeFileSync(join(s.artifactDir, 'headless-stderr.log'), r.stderr);
    const native = nativeState(s, provider);
    const failure = native.errors[0];
    if (failure) throw new Error(`UNAVAILABLE: ${failure.code}: ${failure.message}`);
    check(s, 'headless provider completed', r.code === 0, `Exit ${r.code}`);
    check(
      s,
      'headless native prompt exists',
      native.messages.some((m) => m.text === text),
    );
    check(
      s,
      'headless coding task produced file',
      existsSync(join(s.workspace, 'headless.mjs')),
    );
    const behavior = await command(
      process.execPath,
      [
        '-e',
        "const m=await import('./headless.mjs');if(m.double(7)!==14)throw Error('bad double implementation');",
      ],
      s.env,
      s.workspace,
      30_000,
    );
    check(s, 'headless implementation works', behavior.code === 0, behavior.stderr);
    let automatic = false;
    try {
      await waitFor(
        () =>
          ledger(s).some((r) => r.kind === 'prompt' && r.text === text) && queueEmpty(s),
        30_000,
        'headless automatic collection',
      );
      automatic = true;
    } catch {}
    save(join(s.artifactDir, 'phases.json'), {
      automatic: automatic ? 'pass' : 'fail',
      catchup: 'pending',
    });
    check(s, 'headless automatic capture before sync', automatic);
    if (automatic) await validateReport(s, [text]);
    const catchupStart = s.checks.length;
    await cli(s, ['sync', '--tool', provider, '--json']);
    validateNativeEvidence(s, native);
    await validateReport(s, [text], false);
    check(
      s,
      'headless catch-up complete',
      ledger(s).some((r) => r.kind === 'prompt' && r.text === text),
    );
    save(join(s.artifactDir, 'phases.json'), {
      automatic: automatic ? 'pass' : 'fail',
      catchup: s.checks.slice(catchupStart).every((c) => c.ok) ? 'pass' : 'fail',
    });
    check(
      s,
      'headless history integrity',
      JSON.parse((await cli(s, ['verify', '--json'])).stdout).ok === true,
    );
  } catch (error) {
    check(
      s,
      'headless scenario completed',
      false,
      scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
  } finally {
    try {
      if (host) await host.stop();
    } catch (error) {
      check(s, 'provider teardown', false, scrub(String(error)));
    }
    clearAuth(s);
    save(join(s.artifactDir, 'checks.json'), s.checks);
  }
  console.log(
    `[live] ${provider}-headless: ${s.checks.filter((c) => !c.ok).length} failed`,
  );
  return s;
}

async function concurrent(options: LiveOptions, name = 'concurrent') {
  const s = createScenario(options.binary, join(options.artifactDir, name));
  const hosts: Interactive[] = [];
  try {
    for (const provider of ['codex', 'claude'] as const) {
      provisionAuth(s, provider);
      await connect(s, provider);
    }
    for (const provider of ['codex', 'claude'] as const) {
      const host = new Interactive(s, provider, options.sandbox);
      hosts.push(host);
      await host.ready();
    }
    const tasks = [
      prompts('concurrent-codex', 'codex-calc')[0]!,
      prompts('concurrent-claude', 'claude-calc')[0]!,
    ];
    const submitted = await Promise.all(
      hosts.map((host, i) => host.turn(tasks[i]!, options.turnTimeout ?? 600_000)),
    );
    save(join(s.artifactDir, 'submitted-prompts.json'), submitted);
    for (const host of hosts) await host.stop();
    hosts.length = 0;
    await waitFor(
      () => ledger(s).filter((r) => r.kind === 'prompt').length === 2 && queueEmpty(s),
      30_000,
      'concurrent automatic collection',
    );
    const records = ledger(s);
    for (const provider of ['codex', 'claude'] as const)
      validateNativeEvidence(s, nativeState(s, provider), provider);
    for (const [i, provider] of (['codex', 'claude-code'] as const).entries())
      check(
        s,
        `${provider} prompt stays in its own session`,
        records.filter((r) => r.kind === 'prompt' && r.tool === provider).length === 1 &&
          records.some(
            (r) => r.kind === 'prompt' && r.tool === provider && r.text === tasks[i],
          ),
      );
    for (const prefix of ['codex-calc', 'claude-calc'])
      check(
        s,
        `concurrent ${prefix} file exists`,
        existsSync(join(s.workspace, `${prefix}.mjs`)),
      );
    const result = JSON.parse(
      (
        await cli(s, [
          'report',
          '--project',
          s.workspace,
          '--json',
          '--no-open',
          '--no-sync',
        ])
      ).stdout,
    );
    const data = JSON.parse(
      readFileSync(join(dirname(result.reportPath), 'report.json'), 'utf8'),
    );
    check(
      s,
      'concurrent report has exactly both submitted prompts',
      JSON.stringify(data.turns.map((t: any) => t.prompt.text).sort()) ===
        JSON.stringify([...tasks].sort()),
    );
    for (const prefix of ['codex-calc', 'claude-calc']) {
      const provider = prefix.startsWith('codex') ? 'codex' : 'claude-code';
      const matching = records.filter(
        (r) =>
          r.kind === 'edit' &&
          !r.tags?.includes('observed-file-state') &&
          basename(r.file ?? '') === `${prefix}.mjs`,
      );
      check(
        s,
        `${prefix} edit attribution`,
        matching.length > 0 && matching.every((r) => r.tool === provider),
      );
      const behavior = await command(
        process.execPath,
        [
          '-e',
          `const m=await import('./${prefix}.mjs');if(m.add(2,3)!==5)throw Error('bad concurrent implementation');`,
        ],
        s.env,
        s.workspace,
        30_000,
      );
      check(s, `${prefix} implementation works`, behavior.code === 0, behavior.stderr);
    }
    s.checks.push(
      ...(
        await inspectReport(
          result.reportPath,
          join(s.artifactDir, 'browser'),
          data.turns.map((t: any) => t.prompt.text),
        )
      ).checks,
    );
    check(
      s,
      'concurrent integrity',
      JSON.parse((await cli(s, ['verify', '--json'])).stdout).ok === true,
    );
    check(s, 'concurrent queue drained', queueEmpty(s));
  } catch (error) {
    check(
      s,
      'concurrent scenario completed',
      false,
      scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
  } finally {
    for (const host of hosts)
      try {
        await host.stop();
      } catch (error) {
        check(s, 'provider teardown', false, scrub(String(error)));
      }
    clearAuth(s);
    save(join(s.artifactDir, 'checks.json'), s.checks);
  }
  return s;
}

export async function runCase(
  options: LiveOptions,
  name: string,
  kind: string,
  provider?: Provider,
) {
  if (kind === 'concurrent') return concurrent(options, name);
  if (!provider || !['codex', 'claude'].includes(provider))
    throw new Error('Invalid scenario provider');
  if (kind === 'headless') return headless(options, provider, name);
  if (
    ![
      'core',
      'no-assistant',
      'baseline',
      'catchup',
      'consent',
      'delegation',
      'shell',
      'tool-consent',
      'pre-consent',
    ].includes(kind)
  )
    throw new Error('Invalid scenario kind');
  return ordinary(options, provider, name, kind as Parameters<typeof ordinary>[3]);
}

async function isolatedCase(
  options: LiveOptions,
  name: string,
  kind: string,
  provider?: Provider,
): Promise<Scenario> {
  const dir = join(options.artifactDir, name);
  mkdirSync(dir, { recursive: true });
  const resultPath = join(dir, 'result.json');
  if (existsSync(resultPath)) unlinkSync(resultPath);
  const log = openSync(join(dir, 'driver.log'), 'w', 0o600);
  console.log(`[live] starting ${name}`);
  try {
    const workerEnv = { ...process.env };
    for (const key of Object.keys(workerEnv))
      if (
        /KEY|TOKEN|SECRET|PASSWORD/i.test(key) &&
        !(key === 'ANTHROPIC_API_KEY' && (provider === 'claude' || kind === 'concurrent'))
      )
        delete workerEnv[key];
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const worker = spawn(
        process.execPath,
        [
          join(import.meta.dir, 'worker.ts'),
          JSON.stringify({ options, name, kind, provider }),
        ],
        {
          cwd: process.cwd(),
          env: workerEnv,
          stdio: ['ignore', log, log],
          windowsHide: true,
        },
      );
      worker.once('error', reject);
      worker.once('exit', (code) => resolve(code));
    });
    if (!existsSync(resultPath))
      return {
        artifactDir: dir,
        checks: [
          {
            name: 'scenario worker produced evidence',
            ok: false,
            detail: `Worker exited ${exitCode}; inspect driver.log`,
          },
        ],
      } as Scenario;
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      checks: Scenario['checks'];
      artifactDir: string;
    };
    if (exitCode !== 0 && result.checks.every((c) => c.ok))
      result.checks.push({
        name: 'scenario worker exited cleanly',
        ok: false,
        detail: `Exit ${exitCode}`,
      });
    console.log(
      `[live] ${name}: ${result.checks.filter((c) => c.ok).length} passed, ${result.checks.filter((c) => !c.ok).length} failed`,
    );
    return { artifactDir: result.artifactDir, checks: result.checks } as Scenario;
  } finally {
    closeSync(log);
  }
}

export async function runLive(options: LiveOptions) {
  const scenarios: Scenario[] = [];
  const retries: Array<{
    scenario: string;
    firstAttempt: string;
    retryAttempt: string;
    reason: string;
    passed: boolean;
  }> = [];
  const withRetry = async (
    name: string,
    run: (attemptName: string) => Promise<Scenario>,
  ) => {
    const first = await run(name);
    const failures = first.checks.filter((c) => !c.ok);
    if (
      failures.length &&
      failures.every((c) => c.detail?.includes('UNAVAILABLE: server_overloaded'))
    ) {
      console.log(
        `[live] ${name}: provider at capacity; retrying once, preserving original evidence`,
      );
      await Bun.sleep(10_000);
      const second = await run(name + '-retry-1');
      const receipt = {
        scenario: name,
        firstAttempt: first.artifactDir,
        retryAttempt: second.artifactDir,
        reason: failures[0]!.detail!,
        passed: second.checks.every((c) => c.ok),
      };
      retries.push(receipt);
      save(join(first.artifactDir, 'retry.json'), receipt);
      return second;
    }
    return first;
  };
  // Each lane's terminal and CLI traffic lives in a separate scenario process.
  await Promise.all(
    (options.providers ?? ['codex', 'claude']).map(async (provider) => {
      const modes: Array<
        [
          string,
          (
            | 'core'
            | 'no-assistant'
            | 'baseline'
            | 'catchup'
            | 'consent'
            | 'delegation'
            | 'shell'
            | 'tool-consent'
            | 'pre-consent'
          ),
        ]
      > = [
        ...Array.from(
          { length: options.repetitions ?? 3 },
          (_, i) => [`${provider}-core-${i + 1}`, 'core'] as const,
        ),
        ...[
          'no-assistant',
          'baseline',
          'catchup',
          'consent',
          'delegation',
          'shell',
          'tool-consent',
          'pre-consent',
        ].map((mode) => [`${provider}-${mode}`, mode] as any),
      ];
      for (const [name, mode] of modes) {
        if (options.scenario && !name.includes(options.scenario)) continue;
        scenarios.push(
          await withRetry(name, (attempt) =>
            isolatedCase(options, attempt, mode, provider),
          ),
        );
      }
      if (!options.scenario || `${provider}-headless`.includes(options.scenario))
        scenarios.push(
          await withRetry(`${provider}-headless`, (attempt) =>
            isolatedCase(options, attempt, 'headless', provider),
          ),
        );
    }),
  );
  if (
    (!options.providers || options.providers.length === 2) &&
    (!options.scenario || 'concurrent'.includes(options.scenario))
  )
    scenarios.push(
      await withRetry('concurrent', (attempt) =>
        isolatedCase(options, attempt, 'concurrent'),
      ),
    );
  return {
    retries,
    checks: scenarios.flatMap((s) =>
      s.checks.map((c) => ({ ...c, name: `${basename(s.artifactDir)}: ${c.name}` })),
    ),
    scenarios: scenarios.map((s) => s.artifactDir),
  };
}
