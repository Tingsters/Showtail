import { EVENT_TYPES, type EventType } from '../types.ts';

/** True if `value` is one of the supported event types. */
export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** Human-readable, comma-separated list of valid event types. */
export function eventTypeList(): string {
  return EVENT_TYPES.join(', ');
}

/** The result of validating a single parsed event object. */
export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Validate that a parsed object has the required shape of an {@link Event}.
 * Returns a list of issues; an empty list means it is valid.
 *
 * This is intentionally lenient about optional fields and strict about the
 * required ones, so `showtail verify` can give clear, specific feedback.
 */
export function validateEvent(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof value !== 'object' || value === null) {
    return [{ field: '(root)', message: 'event is not an object' }];
  }
  const e = value as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    issues.push({ field: 'id', message: 'missing or empty id' });
  }
  if (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) {
    issues.push({ field: 'timestamp', message: 'missing or invalid ISO timestamp' });
  }
  if (typeof e.type !== 'string' || !isEventType(e.type)) {
    issues.push({
      field: 'type',
      message: `type must be one of: ${eventTypeList()}`,
    });
  }
  if (typeof e.text !== 'string') {
    issues.push({ field: 'text', message: 'missing text' });
  }
  if (typeof e.actorSlug !== 'string' || e.actorSlug.length === 0) {
    issues.push({ field: 'actorSlug', message: 'missing or empty actorSlug' });
  }
  if (e.files !== undefined && !isStringArray(e.files)) {
    issues.push({ field: 'files', message: 'files must be an array of strings' });
  }
  if (e.tags !== undefined && !isStringArray(e.tags)) {
    issues.push({ field: 'tags', message: 'tags must be an array of strings' });
  }
  // `tool` is forward-compatible: any string is accepted so older/newer trails
  // and new tools never fail validation.
  if (e.tool !== undefined && typeof e.tool !== 'string') {
    issues.push({ field: 'tool', message: 'tool must be a string' });
  }
  // `model` is likewise forward-compatible: any string, absent on older trails.
  if (e.model !== undefined && typeof e.model !== 'string') {
    issues.push({ field: 'model', message: 'model must be a string' });
  }
  return issues;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
