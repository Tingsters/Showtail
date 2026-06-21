import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  machineIdentityPath,
  readMachineIdentity,
  resolveIdentity,
  slugifyEmail,
  writeMachineIdentity,
} from '../src/core/identity.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('slugifyEmail', () => {
  test('turns an email into a filesystem-safe, stable folder key', () => {
    expect(slugifyEmail('alice@example.com')).toBe('alice-at-example-com');
    expect(slugifyEmail('bob@school.edu')).toBe('bob-at-school-edu');
  });

  test('is case-insensitive and collapses unusual characters', () => {
    expect(slugifyEmail('Alice@Example.COM')).toBe('alice-at-example-com');
    expect(slugifyEmail('a.b+tag@x.co')).toBe('a-b-tag-at-x-co');
    // GitHub noreply addresses slug cleanly too.
    expect(slugifyEmail('12345+alice@users.noreply.github.com')).toBe(
      '12345-alice-at-users-noreply-github-com',
    );
  });
});

describe('resolveIdentity', () => {
  test('honors the explicit env override first (no subprocess)', async () => {
    const prevEmail = process.env.SHOWTAIL_IDENTITY_EMAIL;
    const prevName = process.env.SHOWTAIL_IDENTITY_NAME;
    process.env.SHOWTAIL_IDENTITY_EMAIL = 'over@ride.dev';
    process.env.SHOWTAIL_IDENTITY_NAME = 'Over Ride';
    try {
      const id = await resolveIdentity({ cwd: process.cwd(), allowPrompt: false });
      expect(id?.email).toBe('over@ride.dev');
      expect(id?.name).toBe('Over Ride');
    } finally {
      process.env.SHOWTAIL_IDENTITY_EMAIL = prevEmail;
      process.env.SHOWTAIL_IDENTITY_NAME = prevName;
    }
  });

  test('returns undefined when nothing is resolvable and prompting is off', async () => {
    const prevEmail = process.env.SHOWTAIL_IDENTITY_EMAIL;
    const prevG = process.env.GIT_CONFIG_GLOBAL;
    const prevS = process.env.GIT_CONFIG_SYSTEM;
    delete process.env.SHOWTAIL_IDENTITY_EMAIL;
    // Neutralize the developer's global git identity so `git config user.email`
    // yields nothing — otherwise it would resolve their real email here.
    const dir = makeTempDir();
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'no-such-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'no-such-gitconfig');
    try {
      const id = await resolveIdentity({ cwd: dir, allowPrompt: false, allowGh: false });
      expect(id).toBeUndefined();
    } finally {
      process.env.SHOWTAIL_IDENTITY_EMAIL = prevEmail;
      if (prevG === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevG;
      if (prevS === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prevS;
      cleanup(dir);
    }
  });
});

describe('machine identity cache', () => {
  test('round-trips through the SHOWTAIL_IDENTITY_HOME-scoped file', () => {
    const home = makeTempDir();
    const prev = process.env.SHOWTAIL_IDENTITY_HOME;
    process.env.SHOWTAIL_IDENTITY_HOME = home;
    try {
      expect(readMachineIdentity()).toBeNull();
      writeMachineIdentity({
        email: 'm@x.dev',
        name: 'M',
        slug: 'm-at-x-dev',
        machineId: 'machine-1',
      });
      expect(existsSync(join(home, 'identity.json'))).toBe(true);
      expect(machineIdentityPath()).toBe(join(home, 'identity.json'));
      const cached = readMachineIdentity();
      expect(cached?.slug).toBe('m-at-x-dev');
      expect(cached?.machineId).toBe('machine-1');
    } finally {
      if (prev === undefined) delete process.env.SHOWTAIL_IDENTITY_HOME;
      else process.env.SHOWTAIL_IDENTITY_HOME = prev;
      cleanup(home);
    }
  });
});
