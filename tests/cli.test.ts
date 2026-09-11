import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHOWTAIL_VERSION } from '../src/core/version.ts';
import { VSCODE_EXTENSION_ID } from '../src/core/vscodeExtension.ts';
import { cleanup, envWithHome, makeTempDir, readJsonReport, runCli } from './helpers.ts';

/** Run the real CLI (through bun) in a given directory. */
const run = runCli;

/** A VS Code CLI stub that records whether disconnect consent existed on entry. */
function disconnectConsentProbeCli(dir: string, marker: string): string {
  const checker = join(dir, 'check-disconnect-consent.ts');
  const globalConfigUrl = pathToFileURL(
    join(import.meta.dir, '..', 'src', 'core', 'globalConfig.ts'),
  ).href;
  writeFileSync(
    checker,
    [
      `import { writeFileSync } from 'node:fs';`,
      `import { readGlobalConfig, toolCaptureGloballyDisabled } from '${globalConfigUrl}';`,
      `const cfg = readGlobalConfig();`,
      `const stopped = toolCaptureGloballyDisabled('copilot') && cfg.autoConnectDisabledTools?.includes('copilot') === true;`,
      `writeFileSync(${JSON.stringify(marker)}, stopped ? 'stopped' : 'missing', 'utf8');`,
      '',
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    const cli = join(dir, 'consent-probe.cmd');
    writeFileSync(
      cli,
      [
        '@echo off',
        `"${process.execPath}" run "${checker}"`,
        'if /I "%~1"=="--list-extensions" goto showtail_probe_list',
        'exit /b 7',
        ':showtail_probe_list',
        `echo ${VSCODE_EXTENSION_ID}`,
        'exit /b 0',
        '',
      ].join('\r\n'),
      'utf8',
    );
    return cli;
  }

  const cli = join(dir, 'consent-probe.sh');
  writeFileSync(
    cli,
    [
      '#!/bin/sh',
      `"${process.execPath}" run "${checker}"`,
      `if [ "$1" = "--list-extensions" ]; then printf '%s\\n' '${VSCODE_EXTENSION_ID}'; exit 0; fi`,
      'exit 7',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(cli, 0o755);
  return cli;
}

describe('cli (end-to-end acceptance sequence)', () => {
  test('runs the full documented workflow successfully', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Demo Project\n');

      // init
      let r = run(dir, ['track', '--project', 'Demo']);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);

      // start
      r = run(dir, ['start']);
      expect(r.code).toBe(0);

      // log prompt
      r = run(dir, ['log', '--type', 'prompt', '--text', 'Help me plan the project']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Logged prompt');

      // log an AI response
      r = run(dir, [
        'log',
        '--type',
        'ai_output',
        '--text',
        'Start with the CLI entry point',
      ]);
      expect(r.code).toBe(0);

      // artifact
      r = run(dir, ['artifact', 'README.md']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Recorded artifact: README.md');

      // trace
      r = run(dir, ['trace', 'README.md']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Provenance trail for: README.md');

      // trace --format json
      r = run(dir, ['trace', 'README.md', '--format', 'json']);
      expect(r.code).toBe(0);
      const traced = JSON.parse(r.stdout);
      expect(traced.path).toBe('README.md');
      expect(traced.artifacts.length).toBe(1);

      // report
      r = run(dir, ['report']);
      expect(r.code).toBe(0);
      const reports = readdirSync(join(dir, '.showtail', 'reports'));
      expect(reports.some((f) => f.endsWith('.md'))).toBe(true);

      // report --format json
      r = run(dir, ['report', '--format', 'json']);
      expect(r.code).toBe(0);
      expect(
        readdirSync(join(dir, '.showtail', 'reports')).some((f) => f.endsWith('.json')),
      ).toBe(true);

      // verify
      r = run(dir, ['verify']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('All checks passed.');
    } finally {
      cleanup(dir);
    }
  });

  test('log with an invalid type exits non-zero with a helpful message', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['track']);
      const r = run(dir, ['log', '--type', 'banana', '--text', 'hi']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('valid --type');
    } finally {
      cleanup(dir);
    }
  });

  test('commands before init give a clear not-initialized error', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['start']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('No Showtail project trail exists for this folder yet.');
    } finally {
      cleanup(dir);
    }
  });

  test('--no-hooks and disconnect persist opt-outs until a hooks-on reconnect', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const env = envWithHome(home);

      const disconnected = run(dir, ['disconnect', 'codex'], { env });
      expect(disconnected.code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
          .autoConnectDisabledTools,
      ).toContain('codex');
      expect(
        JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).captureDisabledTools,
      ).toContain('codex');

      const connected = run(dir, ['connect', 'codex', '--project', '--no-hooks'], {
        env,
      });
      expect(connected.code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
          .autoConnectDisabledTools,
      ).toContain('codex');
      expect(
        JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).captureDisabledTools,
      ).toContain('codex');

      const automatic = run(dir, ['connect', 'codex', '--project', '--yes'], { env });
      expect(automatic.code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
          .autoConnectDisabledTools,
      ).not.toContain('codex');
      expect(
        JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).captureDisabledTools,
      ).not.toContain('codex');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('managed integration refresh cannot clear or overwrite a machine-wide stop', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const env = {
        ...envWithHome(join(home, 'global')),
        CODEX_HOME: join(home, 'codex'),
      };
      expect(run(dir, ['connect', 'codex', '--project', '--yes'], { env }).code).toBe(0);
      const hooks = join(dir, '.codex', 'hooks.json');
      expect(readFileSync(hooks, 'utf8')).toContain('showtail hook');
      expect(run(dir, ['disconnect', 'codex'], { env }).code).toBe(0);
      expect(readFileSync(hooks, 'utf8')).not.toContain('showtail hook');

      const refresh = run(
        dir,
        ['connect', 'codex', '--project', '--yes', '--managed-refresh'],
        { env },
      );
      expect(refresh.code).toBe(4);
      expect(refresh.stderr).toContain('Managed refresh skipped');
      expect(readFileSync(hooks, 'utf8')).not.toContain('showtail hook');
      expect(
        JSON.parse(readFileSync(join(home, 'global', 'config.json'), 'utf8'))
          .captureDisabledTools,
      ).toContain('codex');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('managed integration refresh honors a scoped disconnect opt-out', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const env = {
        ...envWithHome(join(home, 'global')),
        CODEX_HOME: join(home, 'codex'),
      };
      expect(run(dir, ['connect', 'codex', '--project', '--yes'], { env }).code).toBe(0);
      const hooks = join(dir, '.codex', 'hooks.json');
      expect(readFileSync(hooks, 'utf8')).toContain('showtail hook');

      expect(run(dir, ['disconnect', 'codex', '--project'], { env }).code).toBe(0);
      const config = JSON.parse(
        readFileSync(join(home, 'global', 'config.json'), 'utf8'),
      );
      expect(config.autoConnectDisabledTools).toContain('codex');
      expect(config.captureDisabledTools ?? []).not.toContain('codex');

      const refresh = run(
        dir,
        ['connect', 'codex', '--project', '--yes', '--managed-refresh'],
        { env },
      );
      expect(refresh.code).toBe(4);
      expect(readFileSync(hooks, 'utf8')).not.toContain('showtail hook');

      expect(run(dir, ['connect', 'codex', '--project', '--yes'], { env }).code).toBe(0);
      expect(readFileSync(hooks, 'utf8')).toContain('showtail hook');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('bare disconnect persists consent before native extension removal starts', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const marker = join(home, 'disconnect-consent.txt');
      const env = {
        ...envWithHome(join(home, 'global')),
        SHOWTAIL_VSCODE_CLI: disconnectConsentProbeCli(home, marker),
      };

      const disconnected = run(dir, ['disconnect', 'copilot'], { env });

      expect(disconnected.code).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('stopped');
      expect(disconnected.stdout).toContain(
        'Automatic capture is off for GitHub Copilot',
      );
      expect(disconnected.stdout).toContain('Warning:');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('bare disconnect removes project and user capture', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const codexHome = join(home, 'codex');
      const env = { ...envWithHome(join(home, 'global')), CODEX_HOME: codexHome };

      expect(run(dir, ['connect', 'codex', '--user', '--yes'], { env }).code).toBe(0);
      expect(run(dir, ['connect', 'codex', '--project', '--yes'], { env }).code).toBe(0);
      expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
      expect(existsSync(join(dir, '.codex', 'hooks.json'))).toBe(true);

      const disconnected = run(dir, ['disconnect', 'codex'], { env });

      expect(disconnected.code).toBe(0);
      expect(disconnected.stdout).toContain('Automatic capture is off for OpenAI Codex');
      expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
      expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).not.toContain(
        'showtail hook',
      );
      expect(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8')).not.toContain(
        'showtail hook',
      );
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('bare disconnect stops stale Codex hooks in every project until reconnect', () => {
    const workspace = makeTempDir();
    const home = makeTempDir();
    const projectA = join(workspace, 'project-a');
    const projectB = join(workspace, 'project-b');
    try {
      mkdirSync(projectA, { recursive: true });
      mkdirSync(projectB, { recursive: true });
      const env = {
        ...envWithHome(join(home, 'global')),
        CODEX_HOME: join(home, 'codex'),
      };
      expect(run(projectA, ['track', '--project', 'A'], { env }).code).toBe(0);
      expect(run(projectB, ['track', '--project', 'B'], { env }).code).toBe(0);
      expect(
        run(projectA, ['connect', 'codex', '--project', '--yes'], { env }).code,
      ).toBe(0);
      expect(
        run(projectB, ['connect', 'codex', '--project', '--yes'], { env }).code,
      ).toBe(0);

      const projectBHooks = join(projectB, '.codex', 'hooks.json');
      expect(readFileSync(projectBHooks, 'utf8')).toContain('showtail hook');

      const disconnected = run(projectA, ['disconnect', 'codex'], { env });
      expect(disconnected.code).toBe(0);
      expect(disconnected.stdout).toContain('Automatic capture is off for OpenAI Codex');
      // A command in project A cannot find and physically remove project B's hook.
      expect(readFileSync(projectBHooks, 'utf8')).toContain('showtail hook');

      const status = run(projectB, ['status', '--json', '--tool', 'codex'], { env });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual(
        expect.objectContaining({
          capture: {
            tool: 'codex',
            mode: 'disconnected',
            connected: false,
            hooksActive: false,
          },
          tools: [
            expect.objectContaining({
              tool: 'codex',
              connected: false,
              hooksActive: false,
              captureActive: false,
            }),
          ],
        }),
      );

      const blockedPrompt = 'this stale project hook must not capture';
      expect(
        run(projectB, ['hook', 'user-prompt', '--tool', 'codex'], {
          env,
          input: JSON.stringify({ cwd: projectB, prompt: blockedPrompt }),
        }).code,
      ).toBe(0);
      expect(
        run(projectB, ['report', '--format', 'json', '--no-sync'], { env }).code,
      ).toBe(0);
      expect(JSON.stringify(readJsonReport(projectB))).not.toContain(blockedPrompt);

      expect(
        run(projectB, ['connect', 'codex', '--project', '--yes'], { env }).code,
      ).toBe(0);
      const resumedPrompt = 'capture resumes after an explicit reconnect';
      expect(
        run(projectB, ['hook', 'user-prompt', '--tool', 'codex'], {
          env,
          input: JSON.stringify({ cwd: projectB, prompt: resumedPrompt }),
        }).code,
      ).toBe(0);
      expect(
        run(projectB, ['report', '--format', 'json', '--no-sync'], { env }).code,
      ).toBe(0);
      expect(JSON.stringify(readJsonReport(projectB))).toContain(resumedPrompt);
    } finally {
      cleanup(workspace);
      cleanup(home);
    }
  });

  test('track rejects a missing path instead of creating a typo directory', () => {
    const dir = makeTempDir();
    try {
      const missing = join(dir, 'does-not-exist');
      const r = run(dir, ['track', missing, '--json']);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          errorCode: 'PATH_NOT_FOUND',
          nextAction: 'choose-existing-path',
        }),
      );
      expect(existsSync(missing)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('text can be piped via stdin when --text is omitted', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['track']);
      const res = run(dir, ['log', '--type', 'prompt'], {
        input: 'How do parsers tokenize input?',
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Logged prompt');
    } finally {
      cleanup(dir);
    }
  });

  test('status, sessions, and end report the session lifecycle', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['track']);
      run(dir, ['start', '--label', 'lap one']);
      run(dir, ['log', '--type', 'prompt', '--text', 'plan it']);

      // status: open session with its event count and a connected-tools section
      let r = run(dir, ['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('lap one');
      expect(r.stdout).toContain('1 event');
      expect(r.stdout).toContain('Connected tools');

      // status --json: machine-readable, exposes hooksActive for the skill
      r = run(dir, ['status', '--json']);
      expect(r.code).toBe(0);
      const status = JSON.parse(r.stdout);
      expect(status.session.label).toBe('lap one');
      expect(status.session.events).toBe(1);
      expect(typeof status.hooksActive).toBe('boolean');
      expect(status.update).toMatchObject({
        currentVersion: SHOWTAIL_VERSION,
        updateAvailable: false,
      });

      // sessions: lists the one session and marks it current
      r = run(dir, ['sessions']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('lap one');
      expect(r.stdout).toContain('current session');

      // end: closes it; a following status reports no open session
      r = run(dir, ['end']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Closed session');
      r = run(dir, ['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No open session');
    } finally {
      cleanup(dir);
    }
  });

  test('--help groups commands under labeled sections', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['--help']);
      expect(r.code).toBe(0);
      for (const heading of [
        'Manual capture (optional):',
        'Review your trail:',
        'Connect your tools:',
        'Maintain Showtail:',
        // Tracking is automatic now, so there is no "Get started" step; the manual
        // setup/track commands live under this optional group instead.
        'Manage tracking (optional):',
      ]) {
        expect(r.stdout).toContain(heading);
      }
      // Tracking turns on automatically — no getting-started commands are shown.
      expect(r.stdout).not.toContain('Get started:');
      expect(r.stdout).toContain(
        'Normal flow: open your project, work with your AI tool, then run `showtail report`.',
      );
      expect(r.stdout.indexOf('Review your trail:')).toBeLessThan(
        r.stdout.indexOf('Manual capture (optional):'),
      );
      // The unified integration verbs replace the old per-tool groups.
      expect(r.stdout).toContain('connect');
      expect(r.stdout).toContain('update');
      expect(r.stdout).toContain('disconnect');
      // `matrix` is a maintainer/informational command — hidden from help, still runnable.
      expect(r.stdout).not.toMatch(/^\s+matrix\b/m);
      expect(run(dir, ['matrix', '--json']).code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('project review help exposes explicit path operands for agents', () => {
    const dir = makeTempDir();
    try {
      const status = run(dir, ['status', '--help']);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain('Usage: showtail status [options] [path]');
      expect(status.stdout).toContain('startup capture-mode probe');
      expect(status.stdout).toContain('<absolute-project-path>');

      const report = run(dir, ['report', '--help']);
      expect(report.code).toBe(0);
      expect(report.stdout).toContain('Usage: showtail report [options] [path]');
      expect(report.stdout).toContain(
        'showtail report <absolute-project-path> --json --no-open',
      );

      const verify = run(dir, ['verify', '--help']);
      expect(verify.code).toBe(0);
      expect(verify.stdout).toContain('Usage: showtail verify [options] [path]');
      expect(verify.stdout).toContain('showtail verify <absolute-project-path> --json');
      expect(verify.stdout).toContain('confirm the returned root');
    } finally {
      cleanup(dir);
    }
  });

  test('update preferences are available without initializing a project', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const r = run(dir, ['update', '--auto-check', 'off', '--json'], {
        env: envWithHome(home),
      });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        status: 'configured',
        automaticChecks: false,
      });
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
