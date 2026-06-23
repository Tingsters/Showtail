/**
 * LLM-driven live verification (Tier B).
 *
 * For each hook-based connect tool installed on this machine, this:
 *  1. creates a throwaway project and connects the tool *with hooks*,
 *  2. drives the real tool headlessly (no human) to edit a file,
 *  3. reads the resulting `.showtail` trail and checks the capture actually
 *     happened (prompt logged, file snapshotted, and — where the tool exposes a
 *     transcript — the AI reply reconciled).
 *
 * What passes is written to the verification ledger (matrix-verification.json),
 * which the claims test reads in CI to confirm every hook-driven `full` cell was
 * certified for real at least once. Nothing here runs in CI — it needs the tool
 * binaries and a live model; `showtail matrix --verify-live` runs it on demand.
 */
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
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { getPluginById } from '../plugins/registry.ts';
import { testIdFor } from './capabilityMatrix.ts';

/** Absolute path to this CLI's entry, so a child's hooks call *this* build. */
const CLI = join(import.meta.dir, '..', 'cli.ts');

export interface LiveResult {
  integration: string;
  available: boolean;
  ok: boolean;
  toolVersion?: string;
  /** Capability ids certified by this run (e.g. 'live-capture-hooks'). */
  certified: string[];
  error?: string;
}

/** Quote one argument for a shell command line (args here carry no quotes). */
function quoteArg(s: string): string {
  return /[^A-Za-z0-9_./:\\-]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function sh(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
    shell?: boolean;
  } = {},
) {
  // Windows tool launchers (claude.cmd / codex.cmd) need a shell to resolve, but
  // spawnSync with `shell:true` and an args array does NOT quote args — a prompt
  // with spaces gets truncated at the first word. So when using a shell we build
  // and pass a single, explicitly quoted command line instead.
  const useShell = opts.shell ?? false;
  const command = useShell ? [cmd, ...args].map(quoteArg).join(' ') : cmd;
  const spawnArgs = useShell ? [] : args;
  const res = spawnSync(command, spawnArgs, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 240_000,
    shell: useShell,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    code: res.status ?? 1,
    error: res.error,
  };
}

/** `bun run <CLI> ...` for driving Showtail itself from the harness. */
function showtail(dir: string, args: string[], env?: NodeJS.ProcessEnv) {
  return sh(process.execPath, ['run', CLI, ...args], { cwd: dir, env });
}

/**
 * Write a `showtail` shim onto a fresh bin dir and return it. The host tool's
 * installed hooks invoke a bare `showtail` from PATH; the shim routes that to
 * this worktree's CLI so a live run exercises the code under test, not a globally
 * installed Showtail.
 */
function makeShimBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'showtail-shim-'));
  // POSIX shim.
  writeFileSync(
    join(bin, 'showtail'),
    `#!/bin/sh\nexec "${process.execPath}" run "${CLI}" "$@"\n`,
    {
      mode: 0o755,
    },
  );
  // Windows shim (hooks run through cmd.exe).
  writeFileSync(
    join(bin, 'showtail.cmd'),
    `@echo off\r\n"${process.execPath}" run "${CLI}" %*\r\n`,
  );
  return bin;
}

/** Identity + PATH env so a child tool's hooks run non-interactively. */
function childEnv(shimBin: string): NodeJS.ProcessEnv {
  const home = join(tmpdir(), 'showtail-live-identity');
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    PATH: `${shimBin}${delimiter}${process.env.PATH ?? ''}`,
    SHOWTAIL_IDENTITY_EMAIL: process.env.SHOWTAIL_IDENTITY_EMAIL ?? 'live@example.com',
    SHOWTAIL_IDENTITY_NAME: process.env.SHOWTAIL_IDENTITY_NAME ?? 'Live Verifier',
    SHOWTAIL_IDENTITY_HOME: process.env.SHOWTAIL_IDENTITY_HOME ?? home,
  };
}

/** Read the JSON report Showtail wrote into `dir`. */
function readReport(dir: string): any {
  showtail(dir, ['report', '--format', 'json']);
  const reportsDir = join(dir, '.showtail', 'reports');
  if (!existsSync(reportsDir)) throw new Error('no report produced');
  const file = readdirSync(reportsDir).find((f) => f.endsWith('.json'));
  if (!file) throw new Error('no JSON report');
  return JSON.parse(readFileSync(join(reportsDir, file), 'utf8'));
}

function toolVersion(bin: string): string | undefined {
  const r = sh(bin, ['--version'], { timeoutMs: 20_000, shell: true });
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : undefined;
}

interface DriveSpec {
  /** Binary to probe/drive (e.g. 'claude', 'codex'). */
  bin: string;
  /** `connect` args installing hooks at project scope. */
  connectArgs: string[];
  /** Build the argv that drives the tool to edit the seeded file. */
  driveArgs: (prompt: string) => string[];
  /** Capability certified only if an AI reply is reconciled (transcript tools). */
  replyCap?: string;
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

/** Resolve the GitHub Copilot CLI exe (versioned dir), else fall back to PATH. */
function resolveCopilotBin(): string {
  const cliDir = join(LOCALAPPDATA, 'github-copilot-sdk', 'cli');
  if (existsSync(cliDir)) {
    for (const v of readdirSync(cliDir).sort().reverse()) {
      const p = join(cliDir, v, 'copilot.exe');
      if (existsSync(p)) return p;
    }
  }
  return 'copilot';
}

/** Resolve the Antigravity CLI (`agy`) exe, else fall back to PATH. */
function resolveAgyBin(): string {
  const p = join(LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  return existsSync(p) ? p : 'agy';
}

const SPECS: Record<string, DriveSpec> = {
  'claude-code': {
    bin: 'claude',
    connectArgs: ['connect', 'claude', '--project'],
    driveArgs: (prompt) => [
      '-p',
      prompt,
      '--permission-mode',
      'bypassPermissions',
      '--max-turns',
      '6',
    ],
    replyCap: 'auto-ai-output-capture',
  },
  codex: {
    bin: 'codex',
    connectArgs: ['connect', 'codex', '--project', '--yes'],
    // exec = non-interactive; workspace-write lets it edit files; the temp
    // project isn't a git repo, so skip that guard.
    driveArgs: (prompt) => [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      prompt,
    ],
  },
  'copilot-cli': {
    bin: resolveCopilotBin(),
    connectArgs: ['connect', 'copilot-cli', '--project'],
    driveArgs: (prompt) => ['-p', prompt, '--allow-all'],
  },
  'antigravity-cli': {
    bin: resolveAgyBin(),
    connectArgs: ['connect', 'antigravity-cli', '--project'],
    driveArgs: (prompt) => ['-p', prompt, '--dangerously-skip-permissions'],
  },
};

/** Drive one tool live and report which capabilities it actually delivered. */
export function verifyToolLive(integration: string): LiveResult {
  const spec = SPECS[integration];
  const result: LiveResult = { integration, available: false, ok: false, certified: [] };
  if (!spec) {
    result.error = 'no live driver for this integration';
    return result;
  }
  if (!getPluginById(integration)?.connect?.detect()) {
    result.error = `${spec.bin} not detected on this machine`;
    return result;
  }
  result.available = true;
  result.toolVersion = toolVersion(spec.bin);

  const dir = mkdtempSync(join(tmpdir(), `showtail-live-${integration}-`));
  const shim = makeShimBin();
  try {
    const env = childEnv(shim);
    showtail(dir, ['init', '--project', 'Live'], env);
    const connect = showtail(dir, spec.connectArgs, env);
    if (connect.code !== 0)
      throw new Error(`connect failed: ${connect.stderr || connect.stdout}`);

    // Seed a file and ask the tool to EDIT it, so capture flows through the
    // file-editing tool the hooks match (Edit/apply_patch) rather than a shell
    // command the model might otherwise use to create a new file.
    const marker = 'banana-' + integration;
    writeFileSync(join(dir, 'notes.txt'), 'REPLACE THIS LINE\n');
    const prompt = `Use your file-editing tool to edit the existing file notes.txt so its entire contents become exactly the word ${marker}. Do not use shell commands; do not ask questions; just make the edit.`;
    const drive = sh(spec.bin, spec.driveArgs(prompt), {
      cwd: dir,
      env,
      timeoutMs: 300_000,
      shell: true,
    });
    if (drive.error) throw new Error(`could not run ${spec.bin}: ${drive.error.message}`);

    const report = readReport(dir);
    const blob = JSON.stringify(report);
    const capturedPrompt = (report.turns?.length ?? 0) > 0 || blob.includes(marker);
    const capturedArtifact = (report.summary?.artifacts ?? 0) >= 1;
    const capturedReply =
      report.turns?.some((t: any) => (t.aiOutputs?.length ?? 0) > 0) ?? false;

    // Certify each capability by the signal that actually proves it, so a tool
    // that captures prompts live but not edits (or vice-versa) certifies only
    // what it really delivered. This is what keeps a `full` cell honest.
    const certified = new Set<string>();
    if (capturedPrompt) {
      certified.add('live-capture-hooks'); // a hook fired and logged through Showtail
      certified.add('auto-prompt-capture');
    }
    if (capturedArtifact) {
      certified.add('live-capture-hooks');
      certified.add('auto-file-capture');
    }
    if (spec.replyCap && capturedReply) certified.add(spec.replyCap);

    result.certified = [...certified];
    result.ok = certified.size > 0;
    if (!capturedPrompt || !capturedArtifact) {
      result.error = `partial capture (prompt=${capturedPrompt} artifact=${capturedArtifact}); drive exit ${drive.code}: ${drive.stderr.slice(0, 300)}`;
    }
    return result;
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
}

export const LIVE_INTEGRATIONS = Object.keys(SPECS);

export interface LiveVerifyReport {
  results: LiveResult[];
  certifiedTestIds: string[];
}

/** Drive every available hook tool and return per-tool results + certified ids. */
export function runLiveVerification(only?: string[]): LiveVerifyReport {
  const integrations = (only && only.length ? only : LIVE_INTEGRATIONS).filter(
    (i) => SPECS[i],
  );
  const results = integrations.map(verifyToolLive);
  const certifiedTestIds: string[] = [];
  for (const r of results) {
    for (const cap of r.certified) certifiedTestIds.push(testIdFor(cap, r.integration));
  }
  return { results, certifiedTestIds };
}
