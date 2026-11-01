import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
}

const root = join(import.meta.dir, '..');

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function readLicense(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`License check failed: ${message}`);
}

const project = readJson(join(root, 'package.json'));
const extension = readJson(join(root, 'integrations', 'vscode', 'package.json'));
const rootLicense = readLicense(join(root, 'LICENSE'));
const extensionLicense = readLicense(join(root, 'integrations', 'vscode', 'LICENSE'));
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const bunVersion = readFileSync(join(root, '.bun-version'), 'utf8').trim();

assert(project.license === 'Apache-2.0', 'root package must use Apache-2.0');
assert(extension.license === 'Apache-2.0', 'VS Code extension must use Apache-2.0');
assert(
  rootLicense.includes('Apache License') && rootLicense.includes('Version 2.0'),
  'root LICENSE is not the Apache-2.0 license text',
);
assert(extensionLicense === rootLicense, 'extension LICENSE must match the root license');

const shippedDependencies: Record<string, string> = {
  commander: 'MIT',
  'turbo-stream': 'ISC',
};
// First-party workspaces ship under Showtail's license rather than as third-party notices.
const workspaceDependencies: Record<string, string> = {
  '@showtail/agent-traces': 'packages/agent-traces',
};
const declared = Object.keys(project.dependencies ?? {}).sort();
const reviewed = [
  ...Object.keys(shippedDependencies),
  ...Object.keys(workspaceDependencies),
].sort();
assert(
  JSON.stringify(declared) === JSON.stringify(reviewed),
  'production dependency set changed; review its license and update the inventory',
);

for (const [name, directory] of Object.entries(workspaceDependencies)) {
  const manifest = readJson(join(root, directory, 'package.json'));
  assert(
    project.dependencies?.[name] === 'workspace:*' && manifest.name === name,
    `${name} must resolve to its reviewed workspace`,
  );
  assert(manifest.license === project.license, `${name} must use Showtail's license`);
  assert(
    readLicense(join(root, directory, 'LICENSE')) === rootLicense,
    `${name} LICENSE must match the root license`,
  );
}

for (const [name, expectedLicense] of Object.entries(shippedDependencies)) {
  const manifest = readJson(join(root, 'node_modules', name, 'package.json'));
  assert(manifest.license === expectedLicense, `${name} must use ${expectedLicense}`);
  assert(
    Boolean(manifest.version) &&
      notices.includes(
        `| ${manifest.name ?? name} | ${manifest.version} | ${expectedLicense} |`,
      ),
    `${name} ${manifest.version ?? '(unknown version)'} is missing from THIRD_PARTY_NOTICES.md`,
  );
}

assert(
  Object.keys(extension.dependencies ?? {}).length === 0,
  'the VSIX gained runtime dependencies; add them to the license inventory',
);
assert(
  notices.includes(`Bun ${bunVersion}`) &&
    notices.includes(`bun/blob/bun-v${bunVersion}/LICENSE.md`),
  `Bun ${bunVersion} notices or license link are missing`,
);

console.log(
  'License check passed: all distributed components have reviewed OSS licenses.',
);
