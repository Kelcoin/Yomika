import { describe, expect, it } from 'vitest';

import { md5, normalizeReadoshiServerUrl, readoshiServerScope } from '../../src/lib/readoshiScope';

describe('readoshi server scope', () => {
  it('matches md5 reference vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('derives the worker serverScope from a normalized server URL', () => {
    expect(normalizeReadoshiServerUrl('https://lrr.example.com/api/')).toBe('https://lrr.example.com/api');
    expect(readoshiServerScope('https://lrr.example.com/api/')).toBe(md5('https://lrr.example.com/api'));
  });
});
