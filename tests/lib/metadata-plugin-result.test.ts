import { describe, expect, it } from 'vitest';
import { metadataPluginResult } from '../../src/lib/metadataPluginResult';

describe('LANraragi plugin operation results', () => {
  it('reads the official new_tags envelope and retains existing source tags', () => {
    const result = metadataPluginResult({ success: 1, error: null, data: {
      title: 'Plugin title', new_tags: 'Artist: somebody, female:glasses',
    } }, 'source:https://example.com/g/1/abc, artist:somebody');
    expect(result).toEqual({ title: 'Plugin title', summary: undefined,
      tags: 'source:https://example.com/g/1/abc, artist:somebody, female:glasses', changed: true });
  });
  it('supports new_title/new_summary and tag arrays', () => {
    expect(metadataPluginResult({ success: 1, data: { new_title: 'Title', new_summary: 'Summary', new_tags: ['a', 'b'] } }, '').tags).toBe('a, b');
  });
  it('does not report HTTP 200 operation failures or empty results as success', () => {
    expect(() => metadataPluginResult({ success: 0, error: 'Plugin configuration missing' }, '')).toThrow('Plugin configuration missing');
    expect(metadataPluginResult({ success: 1, data: {} }, 'existing').changed).toBe(false);
  });
});
