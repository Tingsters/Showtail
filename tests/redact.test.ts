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
