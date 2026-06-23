import { describe, expect, it } from 'bun:test';
import { claudeCodePlugin } from '../src/plugins/claude-code.ts';

describe('claudeCodePlugin hooks.planFiles', () => {
  const planFiles = claudeCodePlugin.connect?.hooks?.planFiles;

  it('is a function', () => {
    expect(typeof planFiles).toBe('function');
  });

  it('returns [] for an arbitrary payload', () => {
    expect(planFiles?.({}, '/some/root')).toEqual([]);
  });

  it('returns [] for a null payload', () => {
    expect(planFiles?.(null, '/some/root')).toEqual([]);
  });
});
