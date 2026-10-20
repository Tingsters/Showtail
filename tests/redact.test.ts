import { describe, expect, test } from 'bun:test';
import { redact } from '../src/core/redact.ts';

describe('redact', () => {
  test('scrubs common secrets', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyz12',
      'sk-abcdefghijklmnopqrstuvwx',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF123',
    ];
    for (const s of samples) {
      const { text, hits } = redact(`token: ${s}`);
      expect(hits).toBeGreaterThan(0);
      expect(text).not.toContain(s);
      expect(text).toContain('‹redacted:');
    }
  });

  test('scrubs a private key block', () => {
    const key =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj...\n-----END RSA PRIVATE KEY-----';
    const { text, hits } = redact(`here it is\n${key}\nthanks`);
    expect(hits).toBe(1);
    expect(text).not.toContain('MIIBOgIBAAJBAKj');
  });

  test('scrubs assignment-style passwords and password-in-prose', () => {
    expect(redact('PASSWORD="hunter2"').text).not.toContain('hunter2');
    expect(redact('"api_key": "abcd1234efgh"').text).not.toContain('abcd1234efgh');
    expect(redact('my password is hunter2 ok').text).not.toContain('hunter2');
  });

  test('scrubs basic-auth credentials in a URL but keeps the host', () => {
    const { text } = redact('postgres://admin:s3cr3tpw@db.example.com:5432/app');
    expect(text).not.toContain('s3cr3tpw');
    expect(text).toContain('db.example.com');
  });

  test('scrubs common PII', () => {
    const { text } = redact('email me at jane.doe@example.com or 555-123-4567');
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('555-123-4567');
  });

  test('Luhn-validates credit cards (real redacted, random kept)', () => {
    expect(redact('card 4242 4242 4242 4242').text).toContain('‹redacted: credit-card›');
    // 16 digits that fail Luhn should not be treated as a card.
    expect(redact('id 1234 1234 1234 1234').text).toContain('1234 1234 1234 1234');
  });

  test('respects enabled:false, allow-list, and a clean string', () => {
    expect(redact('sk-abcdefghijklmnopqrstuvwx', { enabled: false }).hits).toBe(0);
    const allowed = redact('key sk-abcdefghijklmnopqrstuvwx', {
      allow: ['sk-abcdefghijklmnopqrstuvwx'],
    });
    expect(allowed.hits).toBe(0);
    const clean = redact('How do I structure this parser nicely?');
    expect(clean.hits).toBe(0);
    expect(clean.text).toBe('How do I structure this parser nicely?');
  });
});

describe('redact: .env-style names and provider formats', () => {
  // Built from parts so this file never contains a real-looking literal.
  const long = (n: number) => 'Zq8'.repeat(Math.ceil(n / 3)).slice(0, n);
  const samples: [string, string][] = [
    ['DATABASE_PASSWORD=hunter22xyz', 'hunter22xyz'],
    ['SECRET_KEY = "django-insecure-abc123"', 'django-insecure-abc123'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['export GITHUB_TOKEN=abc123def456', 'abc123def456'],
    ['clientSecret: "s3cr3t-value"', 's3cr3t-value'],
    [`STRIPE_SECRET_KEY=rk_live_${long(24)}`, long(24)],
    [`sk_test_${long(24)}`, long(24)],
    [`github_pat_${long(40)}`, long(40)],
    [`glpat-${long(24)}`, long(24)],
    [`hf_${long(34)}`, long(34)],
    [`npm_${long(36)}`, long(36)],
    [`SG.${long(22)}.${long(43)}`, long(22)],
    [`ya29.${long(40)}`, long(40)],
    ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'dXNlcjpwYXNzd29yZDEyMw'],
    ['authorization: bearer abcdefgh12345678', 'abcdefgh12345678'],
    ['postgres://admin:pa:ss@db.example.com/app', 'pa:ss'],
    ['redis://:topsecretpw@cache:6379', 'topsecretpw'],
    ['password: "correct horse battery staple"', 'battery staple'],
  ];
  for (const [input, secret] of samples) {
    test(`scrubs ${input.slice(0, 28)}…`, () => {
      const { text, hits } = redact(input);
      expect(hits).toBeGreaterThan(0);
      expect(text).not.toContain(secret);
    });
  }

  test('withholds a private key block even when the END marker is missing', () => {
    const { text } = redact(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA',
    );
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  test('replaces the value in place (not the first occurrence in the match)', () => {
    expect(redact('password=pass').text).toBe('password=‹redacted: secret›');
  });

  test('does not re-redact its own placeholder', () => {
    const once = redact('PASSWORD="hunter2"').text;
    expect(redact(once).text).toBe(once);
  });

  test('allow-list is an exact match, not a substring', () => {
    const r = redact('token: sk-abcdefghijklmnopqrstuvwx', { allow: ['a'] });
    expect(r.hits).toBeGreaterThan(0);
  });

  test('matching is linear on adversarial input (1MB finishes quickly)', () => {
    for (const unit of ['a', 'a.', 'a-b_', 'x@']) {
      const input = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const start = performance.now();
      redact(input);
      expect(performance.now() - start).toBeLessThan(5000);
    }
  });
});
