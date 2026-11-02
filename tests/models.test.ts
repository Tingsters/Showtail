import { describe, expect, test } from 'bun:test';
import { renderHtml, renderMarkdown } from '../src/core/report.ts';
import { labelForModel } from '../src/plugins/registry.ts';
import { cleanup, makeTempDir } from './helpers.ts';
describe('labelForModel', () => {
  test('prettifies the known model families and strips a context suffix', () => {
    expect(labelForModel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(labelForModel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(labelForModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(labelForModel('gpt-5.5')).toBe('GPT-5.5');
    expect(labelForModel('gpt-5.3-codex')).toBe('GPT-5.3 Codex');
    expect(labelForModel('o3')).toBe('o3');
    expect(labelForModel('gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    // A context-window suffix is dropped from the label.
    expect(labelForModel('claude-opus-4-8[1m]')).toBe('Opus 4.8');
  });
  test('handles ChatGPT dash-versioned / suffixed GPT slugs without truncating', () => {
    // ChatGPT dash-separates the minor version and appends variants; the old
    // label collapsed all of these to "GPT-5"/"GPT-4".
    expect(labelForModel('gpt-5-5')).toBe('GPT-5.5');
    expect(labelForModel('gpt-4-5')).toBe('GPT-4.5');
    expect(labelForModel('gpt-4o')).toBe('GPT-4o');
    expect(labelForModel('gpt-4o-mini')).toBe('GPT-4o Mini');
    expect(labelForModel('gpt-5-thinking')).toBe('GPT-5 Thinking');
    expect(labelForModel('gpt-5-5-codex')).toBe('GPT-5.5 Codex');
    // Codex's dotted form and a bare version still work.
    expect(labelForModel('gpt-5')).toBe('GPT-5');
  });
  test('normalizes the human-readable Gemini names share/Antigravity emit', () => {
    expect(labelForModel('3.5 Flash')).toBe('Gemini 3.5 Flash');
    expect(labelForModel('Gemini 3.5 Flash (Medium)')).toBe('Gemini 3.5 Flash');
  });
  test('labels new models by pattern, and falls back to the exact raw id', () => {
    // A new family/variant within a known provider still labels cleanly...
    expect(labelForModel('claude-neptune-5-0')).toBe('Neptune 5.0');
    expect(labelForModel('gemini-3-spark')).toBe('Gemini 3 Spark');
    // ...and a wholly unknown provider passes through verbatim (recorded exactly).
    expect(labelForModel('grok-3')).toBe('grok-3');
    expect(labelForModel('mistral-large-3')).toBe('mistral-large-3');
    expect(labelForModel('some-future-model-9')).toBe('some-future-model-9');
  });
});
describe('report — models', () => {});
