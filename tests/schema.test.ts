import { describe, expect, test } from 'bun:test';
import { isEventType, validateEvent } from '../src/core/schema.ts';
import type { Event } from '../src/types.ts';

const validEvent: Event = {
  id: 'evt_abc_123',
  timestamp: '2026-06-12T14:03:00.000Z',
  type: 'prompt',
  text: 'How do I structure this parser?',
  actor: 'student',
};

describe('schema', () => {
  test('isEventType accepts all supported types', () => {
    for (const t of [
      'prompt',
      'ai_output',
      'human_edit',
      'decision',
      'reflection',
      'source',
      'test',
      'artifact',
    ]) {
      expect(isEventType(t)).toBe(true);
    }
  });

  test('isEventType rejects unknown types', () => {
    expect(isEventType('nonsense')).toBe(false);
    expect(isEventType('PROMPT')).toBe(false);
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
    expect(fields).toContain('actor');
  });

  test('bad type is reported', () => {
    const issues = validateEvent({ ...validEvent, type: 'banana' });
    expect(issues.some((i) => i.field === 'type')).toBe(true);
  });

  test('invalid timestamp is reported', () => {
    const issues = validateEvent({ ...validEvent, timestamp: 'not-a-date' });
    expect(issues.some((i) => i.field === 'timestamp')).toBe(true);
  });

  test('actor other than student is reported', () => {
    const issues = validateEvent({ ...validEvent, actor: 'teacher' });
    expect(issues.some((i) => i.field === 'actor')).toBe(true);
  });

  test('non-object input is reported', () => {
    expect(validateEvent(null).length).toBeGreaterThan(0);
    expect(validateEvent('string').length).toBeGreaterThan(0);
  });
});
