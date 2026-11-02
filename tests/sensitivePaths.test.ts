import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOutsideRoot, isSensitivePath } from '../src/core/sensitivePaths.ts';
describe('isSensitivePath', () => {
  const sensitive = [
    '.env',
    'app/.env.local',
    'C:\\proj\\.env.production',
    'server.pem',
    'keys/private.key',
    'id_rsa',
    '/home/u/.ssh/config',
    'C:\\Users\\u\\.aws\\credentials',
    '.npmrc',
    '.netrc',
    'infra/terraform.tfstate',
    'infra/prod.tfvars',
    'gcp/service-account-prod.json',
    'client_secret_123.json',
    '/home/u/.config/gcloud/application_default_credentials.json',
    '/home/u/.docker/config.json',
    'config/secrets.yml',
  ];
  for (const p of sensitive) {
    test(`withholds ${p}`, () => expect(isSensitivePath(p)).toBe(true));
  }
  const fine = [
    'src/index.ts',
    'README.md',
    '.env.example',
    '.env.sample',
    'docs/secrets-management.md',
    'src/keyboard.ts',
    'package.json',
    'tsconfig.json',
  ];
  for (const p of fine) {
    test(`allows ${p}`, () => expect(isSensitivePath(p)).toBe(false));
  }
});
describe('isOutsideRoot', () => {
  const root = join(tmpdir(), 'proj');
  test('inside is not outside', () => {
    expect(isOutsideRoot(root, join(root, 'src', 'a.ts'))).toBe(false);
  });
  test('parent and siblings are outside', () => {
    expect(isOutsideRoot(root, join(root, '..', 'other', 'a.ts'))).toBe(true);
    expect(isOutsideRoot(root, join(root, '..'))).toBe(true);
  });
});
