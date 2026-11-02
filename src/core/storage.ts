/** Small filesystem helpers for user-level host registration and legacy reads. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { physicalPath } from './dataHome.ts';
export {
  isPathUnder,
  pathKey,
  toRepoRelative,
} from '@showtail/agent-traces/paths/pathUtil';

export function existingPathKey(path: string): string {
  const canonical = physicalPath(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
export function samePath(a: string, b: string): boolean {
  return existingPathKey(a) === existingPathKey(b);
}

/** Read-only project context for host configuration; never recognizes storage markers. */
export function findRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  let marker: string | null = null;
  const markers = [
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'Makefile',
  ];
  while (true) {
    if (samePath(dir, homedir())) break;
    if (existsSync(join(dir, '.git'))) return dir;
    if (!marker && markers.some((file) => existsSync(join(dir, file)))) marker = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return marker;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

export function readJsonl<T>(file: string): T[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];
}
