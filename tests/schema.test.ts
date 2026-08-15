import { describe, expect, test } from 'bun:test';
import { isEventType, validateEvent } from '../src/core/schema.ts';
import type { Event } from '../src/types.ts';

const validEvent: Event = {
  id: 'evt_abc_123',
  timestamp: '2026-06-12T14:03:00.000Z',
  type: 'prompt',
  text: 'How do I structure this parser?',
  actorSlug: 'tester-at-example-com',
};

describe('schema', () => {
  test('isEventType accepts all supported types', () => {
    for (const t of [
      'prompt',
      'ai_output',
      'artifact',
      'decision',
      'plan',
      'tool_call',
      'recap',
    ]) {
      expect(isEventType(t)).toBe(true);
    }
  });

  test('isEventType rejects unknown and removed types', () => {
    expect(isEventType('nonsense')).toBe(false);
    expect(isEventType('PROMPT')).toBe(false);
    // The old manual "judgment" types are no longer supported.
    for (const t of ['human_edit', 'reflection', 'source', 'test']) {
      expect(isEventType(t)).toBe(false);
    }
  });

  test('a well-formed event has no issues', () => {
    expect(validateEvent(validEvent)).toEqual([]);
  });

  test('missing required fields are reported', () => {
    const issues = validateEvent({ type: 'prompt' });
    const fields = issues.map((i) => i.field);
    expect(fields).toContain('id');
    expect(fields).toContain('timestamp');
    expect(fields).toContain('text');
    expect(fields).toContain('actorSlug');
  });

  test('bad type is reported', () => {
    const issues = validateEvent({ ...validEvent, type: 'banana' });
    expect(issues.some((i) => i.field === 'type')).toBe(true);
  });

  test('invalid timestamp is reported', () => {
    const issues = validateEvent({ ...validEvent, timestamp: 'not-a-date' });
    expect(issues.some((i) => i.field === 'timestamp')).toBe(true);
  });

  test('a missing or empty actorSlug is reported', () => {
    const issues = validateEvent({ ...validEvent, actorSlug: '' });
    expect(issues.some((i) => i.field === 'actorSlug')).toBe(true);
  });

  test('non-object input is reported', () => {
    expect(validateEvent(null).length).toBeGreaterThan(0);
    expect(validateEvent('string').length).toBeGreaterThan(0);
  });

  test('a well-formed tool_call event has no issues', () => {
    expect(
      validateEvent({
        ...validEvent,
        type: 'tool_call',
        toolName: 'Bash',
        isError: false,
      }),
    ).toEqual([]);
  });

  test('a well-formed recap event has no issues', () => {
    expect(
      validateEvent({
        ...validEvent,
        type: 'recap',
        text: 'Building a snake game.',
        durationMs: 53479,
        gitBranch: 'main',
        inputTokens: 4,
        outputTokens: 436,
        cacheReadTokens: 110,
        cacheCreationTokens: 55,
      }),
    ).toEqual([]);
  });

  test('wrong-typed tool_call/recap fields are reported', () => {
    const issues = validateEvent({
      ...validEvent,
      toolName: 42,
      isError: 'yes',
      durationMs: '53s',
      gitBranch: 7,
      inputTokens: '4',
    });
    const fields = issues.map((i) => i.field);
    expect(fields).toContain('toolName');
    expect(fields).toContain('isError');
    expect(fields).toContain('durationMs');
    expect(fields).toContain('gitBranch');
    expect(fields).toContain('inputTokens');
  });
});
