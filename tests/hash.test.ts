import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256OfBytes, sha256OfFile, sha256OfString } from '../src/core/hash.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('hash', () => {
  test('sha256 of empty string is the known digest', () => {
    expect(sha256OfString('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('sha256 of "abc" is the known digest', () => {
    expect(sha256OfString('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('string and bytes hashing agree', () => {
    expect(sha256OfBytes(Buffer.from('hello'))).toBe(sha256OfString('hello'));
  });

  test('hashing a file matches hashing its contents', async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'note.txt');
      writeFileSync(file, 'show your work');
      expect(await sha256OfFile(file)).toBe(sha256OfString('show your work'));
    } finally {
      cleanup(dir);
    }
  });
});
