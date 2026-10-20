import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMatcher,
  encodedVariants,
  harvestSecretValues,
  setKnownSecretValues,
} from '../src/core/knownSecrets.ts';
import { redact } from '../src/core/redact.ts';
import {
  isOpaqueRun,
  sanitizeForShare,
  scanResidual,
  withholdOpaqueTokens,
  WITHHELD,
} from '../src/core/sanitize.ts';
import { cleanup, makeTempDir } from './helpers.ts';

/** A seeded PRNG so a "random" corpus is identical on every run (no flaky tests). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function randomToken(alphabet: string, length: number, next: () => number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE64 = BASE62 + '+/';
const BASE64URL = BASE62 + '-_';
const HEX = '0123456789abcdef';

afterEach(() => setKnownSecretValues(undefined));

describe('format drift: formats no rule has ever heard of', () => {
  test('a brand-new key format (random prefix + random body) is withheld with no rule for it', () => {
    const next = rng(42);
    let leaked = 0;
    const total = 300;
    for (let i = 0; i < total; i++) {
      // An invented provider prefix, so no pattern rule can possibly match it.
      const prefix = randomToken('abcdefghijklmnopqrstuvwxyz', 3, next) + '_';
      const key = prefix + randomToken([BASE62, BASE64URL, HEX][i % 3]!, 32, next);
      const { text } = sanitizeForShare(`here is my key ${key} please use it`);
      if (text.includes(key.slice(4))) leaked++;
    }
    expect(leaked).toBe(0);
  });

  test('random tokens in common alphabets are withheld from 32 characters up', () => {
    const next = rng(7);
    for (const alphabet of [BASE62, BASE64, BASE64URL, HEX]) {
      for (const length of [32, 40, 48, 64]) {
        let caught = 0;
        const n = 200;
        for (let i = 0; i < n; i++) {
          const token = randomToken(alphabet, length, next);
          // Exact 40-hex is a git commit id by design, so skip that one shape.
          if (alphabet === HEX && length === 40) {
            caught++;
            continue;
          }
          if (isOpaqueRun(token)) caught++;
        }
        expect(caught / n).toBeGreaterThan(0.99);
      }
    }
  });
});

describe('opaque-token filter leaves ordinary text alone', () => {
  const ordinary = [
    'How do I structure this parser so that it handles nested expressions nicely?',
    'process.env.SHOWTAIL_IDENTITY_EMAIL',
    'src/core/report/markdown.ts',
    'integrations/vscode/src/extension.ts',
    'getUserProfileDataFromServerAndCacheIt',
    'https://github.com/Tingsters/Showtail/blob/main/LICENSE',
    'commit 3f786850e387550fdab836ed7e6dc881de23001b was the last good one',
    'id 550e8400-e29b-41d4-a716-446655440000',
    'released v0.14.1 on 2026-10-20T12:34:56.789Z',
    'showtail-darwin-arm64 and showtail-windows-x64.exe',
    'claude-haiku-4-5-20251001',
    'a_very_long_snake_case_function_name_for_parsing',
    'sha256:' + 'a'.repeat(32) + 'b'.repeat(32),
  ];
  for (const sample of ordinary) {
    test(`keeps: ${sample.slice(0, 50)}`, () => {
      expect(withholdOpaqueTokens(sample).text).toBe(sample);
    });
  }

  test('withholds a pasted key but keeps the sentence around it', () => {
    const key = 'Zq8Xk2Lm9Pw4Rt7Vb3Nc6Hd1Fs5Gj0Ya';
    const { text, hits } = withholdOpaqueTokens(`use ${key} for the call`);
    expect(hits).toBe(1);
    expect(text).toBe(`use ${WITHHELD} for the call`);
  });
});

describe('known-value masking: the same secret in any encoding', () => {
  // Deliberately NOT in any provider's format.
  const secret = 'plain-passphrase-is-not-a-key-shape';
  test('raw, URL-encoded, base64, base64url, JSON-escaped and truncated forms', () => {
    setKnownSecretValues([secret]);
    const base64 = Buffer.from(secret).toString('base64');
    const forms = [
      secret,
      encodeURIComponent(secret + '/x y'),
      base64,
      base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      JSON.stringify(secret + '"q').slice(1, -1),
      secret.slice(0, 12),
      secret.slice(-12),
    ];
    for (const form of forms) {
      const { text, hits } = redact(`prefix ${form} suffix`);
      expect(hits).toBeGreaterThan(0);
      expect(text).not.toContain(form.slice(0, 12));
    }
  });

  test('capture-time redaction masks a known value even when no rule matches it', () => {
    setKnownSecretValues(['correct-horse-battery-staple']);
    const { text } = redact('the db password is "correct-horse-battery-staple" ok');
    expect(text).not.toContain('correct-horse');
  });

  test('variants cover the encodings and skip anything too short to be safe', () => {
    expect(encodedVariants('abcdefgh12345678').length).toBeGreaterThanOrEqual(3);
    expect(encodedVariants('abc').length).toBe(0);
  });

  test('matching stays fast with many secrets over 1MB of text', () => {
    const next = rng(3);
    const values = Array.from({ length: 60 }, () => randomToken(BASE62, 32, next));
    const matcher = buildMatcher(values);
    const text =
      ('word '.repeat(10) + values[7] + ' ').repeat(2000) + 'x'.repeat(900_000);
    const start = performance.now();
    const out = matcher.mask(text, '‹x›');
    expect(performance.now() - start).toBeLessThan(3000);
    expect(out.hits).toBe(2000);
  });
});

describe('harvesting the values a machine actually holds', () => {
  test('reads secret-named env vars, .env files and credential files; skips noise', () => {
    const home = makeTempDir();
    const proj = makeTempDir();
    try {
      mkdirSync(join(home, '.aws'), { recursive: true });
      writeFileSync(
        join(home, '.aws', 'credentials'),
        '[default]\naws_access_key_id = AKIAEXAMPLE000000000\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
      );
      writeFileSync(
        join(home, '.npmrc'),
        '//registry.npmjs.org/:_authToken=npm-token-value-1234567890\n',
      );
      writeFileSync(
        join(proj, '.env'),
        'export DB_URL="postgres://u:s3cretPassw0rd@db/x"\nDEBUG=true\nPORT=3000\nNAME=short\n',
      );
      writeFileSync(
        join(proj, '.env.example'),
        'API_KEY=this-should-not-be-read-12345\n',
      );

      const values = harvestSecretValues({
        env: {
          OPENAI_API_KEY: 'sk-live-from-the-environment-0001',
          SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', // a path, not a secret
          NODE_ENV: 'production', // not a secret name
          MY_TOKEN: 'true', // trivial
          SESSION_KEY: 'plainword', // weak name + not random
          WEAK_AUTH: 'Ab3dEf9hJk', // weak name + random-looking
        },
        dirs: [proj],
        home,
      });

      expect(values).toContain('sk-live-from-the-environment-0001');
      expect(values).toContain('Ab3dEf9hJk');
      expect(values).toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(values).toContain('npm-token-value-1234567890');
      expect(values).toContain('postgres://u:s3cretPassw0rd@db/x');
      expect(values).not.toContain('/tmp/ssh-agent.sock');
      expect(values).not.toContain('production');
      expect(values).not.toContain('true');
      expect(values).not.toContain('plainword');
      expect(values).not.toContain('short'); // under the minimum length
      expect(values).not.toContain('this-should-not-be-read-12345'); // a template file
    } finally {
      cleanup(home);
      cleanup(proj);
    }
  });
});

describe('sanitizeForShare is a gate, not a suggestion', () => {
  test('a committed config cannot switch it off', () => {
    const key = 'sk-' + 'a1B2c3D4'.repeat(4);
    const out = sanitizeForShare(`k=${key}`, { enabled: false, secrets: false });
    expect(out.text).not.toContain(key);
  });

  test('it fails closed: an internal error withholds everything', () => {
    const boom = {
      get custom(): string[] {
        throw new Error('rule load failed');
      },
    };
    const out = sanitizeForShare('sk-abcdefghijklmnopqrstuvwx', boom as never);
    expect(out.text).toBe(WITHHELD);
  });

  test('PII and keyword context are handled alongside the opaque filter', () => {
    const { text } = sanitizeForShare('mail jane@example.com, DB_PASSWORD=hunter22xyz');
    expect(text).not.toContain('jane@example.com');
    expect(text).not.toContain('hunter22xyz');
  });
});

describe('the independent second scanner', () => {
  test('finds what a broken sanitiser would have left behind', () => {
    const kinds = (t: string) => scanResidual(t).map((f) => f.kind);
    expect(kinds('-----BEGIN RSA PRIVATE KEY-----')).toContain('private-key');
    expect(kinds('key sk-proj-abcdefghijklmnop')).toContain('provider-prefix');
    expect(kinds('PASSWORD=hunter22xyz')).toContain('assigned-secret');
    expect(kinds('postgres://u:pw1234@db.example.com/x')).toContain('url-credentials');
    expect(kinds('Authorization: Bearer abcdefghijklmnop')).toContain('bearer');
    expect(kinds('token Zq8Xk2Lm9Pw4Rt7Vb3Nc6Hd1Fs5Gj0Ya12')).toContain('opaque-token');
  });

  test('also finds a known value even in an encoding no pattern knows', () => {
    setKnownSecretValues(['an-entirely-custom-credential']);
    const encoded = Buffer.from('an-entirely-custom-credential').toString('base64');
    expect(scanResidual(`blob ${encoded}`).map((f) => f.kind)).toContain('known-secret');
  });

  test('is quiet on clean, already-sanitised text and on sha256 hashes', () => {
    const clean = sanitizeForShare(
      'Added a parser. DB_PASSWORD=hunter22xyz mail jane@example.com sk-abcdefghijklmnopqrstuvwx',
    ).text;
    expect(scanResidual(clean)).toEqual([]);
    expect(scanResidual('file sha256:' + 'ab12'.repeat(16))).toEqual([]);
  });

  test('reports labels and counts only, never the value', () => {
    const findings = scanResidual('PASSWORD=hunter22xyz');
    expect(JSON.stringify(findings)).not.toContain('hunter22xyz');
  });
});

describe('placeholders never create false findings', () => {
  test('text after a withheld/redacted marker is not mistaken for its value', () => {
    // After the marker is removed, "token=" must not swallow the next word.
    expect(scanResidual(`token=${WITHHELD} and then some ordinary words`)).toEqual([]);
    expect(scanResidual('password: ‹redacted: secret› remember to rotate it')).toEqual(
      [],
    );
    expect(scanResidual(`api_key = ${WITHHELD}\nnext line of the explanation`)).toEqual(
      [],
    );
  });
});
