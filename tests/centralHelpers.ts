import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest } from '../src/core/history.ts';
const CLI = resolve(import.meta.dir, '../src/cli.ts');
export async function fixture(
  fn: (f: {
    dir: string;
    home: string;
    project: string;
    cli: (
      args: string[],
      input?: string,
      cwd?: string,
    ) => { code: number | null; stdout: string; stderr: string };
  }) => unknown,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `showtail-test-${process.pid}-central-`));
  const home = join(dir, 'data');
  const project = join(dir, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{}');
  const prior = process.env.SHOWTAIL_HOME;
  process.env.SHOWTAIL_HOME = home;
  const cli = (args: string[], input?: string, cwd = project) => {
    const r = spawnSync(process.execPath, ['run', CLI, ...args], {
      cwd,
      input,
      env: {
        ...process.env,
        SHOWTAIL_HOME: home,
        SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
        CODEX_HOME: join(dir, 'tool-codex'),
        CLAUDE_CONFIG_DIR: join(dir, 'tool-claude'),
        COPILOT_HOME: join(dir, 'tool-copilot'),
        GEMINI_HOME: join(dir, 'tool-gemini'),
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  try {
    await fn({ dir, home, project, cli });
  } finally {
    if (prior === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = prior;
    if (
      !resolve(dir).startsWith(resolve(tmpdir())) ||
      !dir.includes(`showtail-test-${process.pid}-central-`)
    )
      throw new Error('Invalid fixture cleanup path');
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
export function tree(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(path.length)] = digest(readFileSync(p).toString('base64'));
    }
  };
  walk(path);
  return out;
}
