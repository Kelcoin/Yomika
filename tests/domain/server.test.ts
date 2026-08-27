import { describe, expect, it } from 'vitest';

import { createServerIdentity, normalizeServerUrl } from '../../src/domain/server';

describe('server identity', () => {
  it('normalizes HTTP URLs without paths used as API endpoints', () => {
    expect(normalizeServerUrl('HTTPS://Example.COM:443/')).toBe('https://example.com');
    expect(normalizeServerUrl('http://example.com:3000/lrr/')).toBe('http://example.com:3000/lrr');
  });

  it('rejects unsupported protocols, embedded credentials, query, and fragments', () => {
    for (const value of ['file:///tmp/a', 'https://user:pass@example.com', 'https://example.com?a=1', 'https://example.com/#x']) {
      expect(() => normalizeServerUrl(value)).toThrow();
    }
  });

  it('creates a stable opaque scope that excludes path and secret', async () => {
    const first = await createServerIdentity({ name: 'Home', baseUrl: 'https://example.com/lrr', apiKey: 'secret-a' });
    const second = await createServerIdentity({ name: 'Home', baseUrl: 'https://example.com/other', apiKey: 'secret-b' });

    expect(first.scopeId).toBe(second.scopeId);
    expect(first.scopeId).toMatch(/^scope_[a-f0-9]{32}$/);
    expect(first.scopeId).not.toContain('example');
    expect(first).not.toHaveProperty('apiKey');
  });
});
