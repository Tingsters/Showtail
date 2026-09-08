/** GitHub release discovery shared by explicit and passive update checks. */
import { SHOWTAIL_VERSION } from './version.ts';

export const SHOWTAIL_RELEASE_API =
  'https://api.github.com/repos/Tingsters/Showtail/releases/latest';

const RELEASE_DOWNLOAD_PREFIX = '/Tingsters/Showtail/releases/download/';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/i;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

export interface ShowtailRelease {
  version: string;
  tag: string;
  pageUrl: string;
  assets: ReleaseAsset[];
}

export interface FetchReleaseOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  apiUrl?: string;
}

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Compare two plain MAJOR.MINOR.PATCH versions. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < left.length; i += 1) {
    const delta = left[i]! - right[i]!;
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

/** Whether `candidate` is newer than the running version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

function parseVersion(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid Showtail version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Release asset name for the running platform. */
export function binaryAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!normalizedArch) throw new Error(`Unsupported architecture: ${arch}`);
  if (platform === 'win32') {
    if (normalizedArch !== 'x64')
      throw new Error(`Unsupported Windows architecture: ${arch}`);
    return 'showtail-windows-x64.exe';
  }
  if (platform === 'darwin') return `showtail-darwin-${normalizedArch}`;
  if (platform === 'linux') return `showtail-linux-${normalizedArch}`;
  throw new Error(`Unsupported platform: ${platform}`);
}

/** Find a named release asset or throw a clear release-packaging error. */
export function requireReleaseAsset(
  release: ShowtailRelease,
  name: string,
): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Release ${release.tag} does not include ${name}.`);
  return asset;
}

/** Fetch and validate the latest stable Showtail release from GitHub. */
export async function fetchLatestRelease(
  options: FetchReleaseOptions = {},
): Promise<ShowtailRelease> {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let raw: Record<string, unknown>;
  try {
    const response = await fetchFn(
      options.apiUrl ?? process.env.SHOWTAIL_RELEASE_API_URL ?? SHOWTAIL_RELEASE_API,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Showtail/${SHOWTAIL_VERSION} update-check`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub release check failed (${response.status}).`);
    }
    raw = (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
  if (raw.draft === true || raw.prerelease === true) {
    throw new Error('GitHub returned a non-stable Showtail release.');
  }
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  parseVersion(version);
  const pageUrl = typeof raw.html_url === 'string' ? raw.html_url : '';
  const assets = Array.isArray(raw.assets)
    ? raw.assets
        .map(parseReleaseAsset)
        .filter((asset): asset is ReleaseAsset => asset !== null)
    : [];
  return { version, tag, pageUrl, assets };
}

function parseReleaseAsset(raw: unknown): ReleaseAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.name !== 'string' ||
    typeof value.browser_download_url !== 'string' ||
    typeof value.size !== 'number' ||
    !releaseDownloadUrlIsTrusted(value.browser_download_url)
  ) {
    return null;
  }
  const digest =
    typeof value.digest === 'string' ? SHA256_DIGEST.exec(value.digest) : null;
  return {
    name: value.name,
    url: value.browser_download_url,
    size: value.size,
    ...(digest ? { sha256: digest[1]!.toLowerCase() } : {}),
  };
}

/** Accept downloads only from the official repository's release path. */
export function releaseDownloadUrlIsTrusted(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'github.com' &&
      parsed.pathname.toLowerCase().startsWith(RELEASE_DOWNLOAD_PREFIX.toLowerCase())
    );
  } catch {
    return false;
  }
}
